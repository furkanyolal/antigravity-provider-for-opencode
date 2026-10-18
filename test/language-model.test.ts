import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"

import { createAntigravityLanguageModel, runAgy } from "../src/language-model.js"
import type { SpawnFn } from "../src/spawn.js"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"

// ===== Mock spawn construct (same shape the old fetch-wrapper tests used) =====

function fakeSpawn(
  stdoutChunks: string[],
  stderrText: string,
  exitCode: number | null,
  captured: { cmd?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv | undefined } = {},
): SpawnFn {
  return (cmd, args, options) => {
    captured.cmd = cmd
    captured.args = args
    captured.env = options.env ?? undefined
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable | null
      stderr: Readable | null
      kill: (signal?: NodeJS.Signals) => boolean
    }
    proc.stdout = Readable.from(stdoutChunks.map((c) => Buffer.from(c, "utf8")))
    proc.stderr = Readable.from([Buffer.from(stderrText, "utf8")])
    proc.kill = () => true
    queueMicrotask(() => proc.emit("exit", exitCode, null))
    return {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: new Promise<number | null>((resolve) => {
        proc.once("exit", (code) => resolve(code as number | null))
      }),
      kill: proc.kill,
    }
  }
}

function textPrompt(text: string): LanguageModelV3CallOptions["prompt"] {
  return [{ role: "user", content: [{ type: "text", text }] }]
}

async function collectStream(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = []
  for await (const part of stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) parts.push(part)
  return parts
}

const SUCCESS_LINE =
  '{"event":"result","result":{"conversation_id":"x","status":"SUCCESS","response":"ok","usage":{"input_tokens":1,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0}}}\n'

describe("runAgy", () => {
  it("spawns `agy -p <prompt> --model <slug> --output-format stream-json`", async () => {
    const captured: { cmd?: string; args?: readonly string[] } = {}
    const spawnFn = fakeSpawn([SUCCESS_LINE], "", 0, captured)
    await runAgy({ binary: "/usr/local/bin/agy", prompt: "Hello world", slug: "claude-sonnet-4-6", spawnFn })
    expect(captured.cmd).toBe("/usr/local/bin/agy")
    expect(captured.args).toEqual(["-p", "Hello world", "--model", "claude-sonnet-4-6", "--output-format", "stream-json"])
  })

  it("returns the terminal result event, ignoring step_update fragments", async () => {
    const spawnFn = fakeSpawn(
      [
        '{"event":"init","conversation_id":"x"}\n',
        '{"event":"step_update","step_update":{"state":"DONE","text_delta":"partial "}}\n',
        '{"event":"result","result":{"status":"SUCCESS","response":"Hello world, this is the complete answer.","usage":{"input_tokens":10,"output_tokens":7,"thinking_tokens":0,"cache_read_tokens":0}}}\n',
      ],
      "",
      0,
    )
    const result = await runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn })
    expect(result.status).toBe("SUCCESS")
    expect(result.response).toBe("Hello world, this is the complete answer.")
    expect(result.usage?.input_tokens).toBe(10)
    expect(result.usage?.output_tokens).toBe(7)
  })

  it("flushes a trailing partial NDJSON line with no trailing newline", async () => {
    const tailLine =
      '{"event":"result","result":{"status":"SUCCESS","response":"complete answer","usage":{"input_tokens":3,"output_tokens":2}}}'
    const spawnFn = fakeSpawn([tailLine], "", 0)
    const result = await runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn })
    expect(result.response).toBe("complete answer")
  })

  it("throws AgySpawnError when the stream ends without a result event", async () => {
    const spawnFn = fakeSpawn(['{"event":"init","conversation_id":"x"}\n'], "no result event", 1)
    await expect(
      runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn }),
    ).rejects.toThrow(/no result event|exited with code/)
  })

  it("throws AgyParseError on a non-JSON line", async () => {
    const spawnFn = fakeSpawn(["garbage line\n", SUCCESS_LINE], "", 0)
    await expect(runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn })).rejects.toThrow(
      /non-JSON/,
    )
  })

  it("strips subscription-only env vars from the spawned env", async () => {
    process.env["ANTIGRAVITY_API_KEY"] = "should-be-stripped"
    process.env["PATH"] = "/usr/bin"
    try {
      const captured: { env?: NodeJS.ProcessEnv } = {}
      const spawnFn = fakeSpawn([SUCCESS_LINE], "", 0, captured)
      await runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn })
      expect(captured.env?.["ANTIGRAVITY_API_KEY"]).toBeUndefined()
      expect(captured.env?.["PATH"]).toBe("/usr/bin")
    } finally {
      delete process.env["ANTIGRAVITY_API_KEY"]
    }
  })

  it("falls back to accumulated non-thinking step_update text_deltas when result.response is empty", async () => {
    const spawnFn = fakeSpawn(
      [
        '{"event":"step_update","step_update":{"state":"DONE","step_type":"thinking","text_delta":"pondering... "}}\n',
        '{"event":"step_update","step_update":{"state":"DONE","step_type":"agent_response","text_delta":"Hello "}}\n',
        '{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"agent_response","text_delta":"ignored, not DONE"}}\n',
        '{"event":"step_update","step_update":{"state":"DONE","step_type":"agent_response","text_delta":"world."}}\n',
        '{"event":"result","result":{"status":"SUCCESS","response":"","usage":{"input_tokens":5,"output_tokens":3}}}\n',
      ],
      "",
      0,
    )
    const result = await runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn })
    expect(result.response).toBe("Hello world.")
  })

  it("leaves result.response as-is (empty) when there are no DONE, non-thinking text_deltas to fall back on", async () => {
    const spawnFn = fakeSpawn(
      [
        '{"event":"step_update","step_update":{"state":"DONE","step_type":"agent_response","usage":{"output_tokens":292}}}\n',
        '{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}\n',
        '{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n',
      ],
      "",
      0,
    )
    const result = await runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn })
    expect(result.response).toBe("")
    expect(result.denied_actions).toEqual([{ action: "command", display_name: "RunCommand" }])
  })

  it("kills the child when the abort signal fires", async () => {
    let killedWith: NodeJS.Signals | undefined
    const spawnFn: SpawnFn = () => {
      const proc = new EventEmitter() as EventEmitter & { stdout: Readable | null; stderr: Readable | null }
      proc.stdout = Readable.from([])
      proc.stderr = Readable.from([])
      return {
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: new Promise(() => {}),
        kill: (signal?: NodeJS.Signals) => {
          killedWith = signal
          return true
        },
      }
    }
    const ctrl = new AbortController()
    ctrl.abort()
    void runAgy({ binary: "/x", prompt: "hi", slug: "gemini-3.1-pro-high", spawnFn, signal: ctrl.signal }).catch(
      () => {},
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(killedWith).toBe("SIGTERM")
  })
})

describe("createAntigravityLanguageModel", () => {
  it("reports specificationVersion v3 and the antigravity provider", () => {
    const model = createAntigravityLanguageModel({
      modelID: "gemini-3.1-pro-high",
      resolveBinary: async () => "/x",
    })
    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("antigravity")
    expect(model.modelId).toBe("gemini-3.1-pro-high")
  })

  describe("doGenerate", () => {
    it("returns the full response text with finishReason stop and usage", async () => {
      const spawnFn = fakeSpawn(
        ['{"event":"result","result":{"status":"SUCCESS","response":"complete answer","usage":{"input_tokens":10,"output_tokens":7,"thinking_tokens":2,"cache_read_tokens":1}}}\n'],
        "",
        0,
      )
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      const result = await model.doGenerate({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)
      expect(result.content).toEqual([{ type: "text", text: "complete answer" }])
      expect(result.finishReason.unified).toBe("stop")
      expect(result.usage.inputTokens.total).toBe(10)
      expect(result.usage.outputTokens.total).toBe(7)
      expect(result.usage.outputTokens.reasoning).toBe(2)
      expect(result.usage.inputTokens.cacheRead).toBe(1)
    })

    it("throws when agy reports a non-SUCCESS status", async () => {
      const spawnFn = fakeSpawn(
        ['{"event":"result","result":{"status":"ERROR","error":"cloud outage"}}\n'],
        "",
        0,
      )
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      await expect(model.doGenerate({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)).rejects.toThrow(
        "cloud outage",
      )
    })

    it("propagates the auth-missing guard from resolveBinary", async () => {
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => {
          throw new Error("No antigravity session is configured")
        },
      })
      await expect(model.doGenerate({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)).rejects.toThrow(
        "No antigravity session is configured",
      )
    })

    it("surfaces agy's denied_actions as an explanatory message instead of blank text", async () => {
      // `agy` is its own agentic CLI with its own tool system; in headless
      // `-p` mode it auto-denies any tool-permission request and reports
      // SUCCESS with an empty response and `denied_actions` populated.
      const spawnFn = fakeSpawn(
        [
          '{"event":"result","result":{"status":"SUCCESS","response":"","usage":{"input_tokens":10,"output_tokens":5},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n',
        ],
        "",
        0,
      )
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      const result = await model.doGenerate({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)
      const text = (result.content[0] as { text: string }).text
      expect(text.length).toBeGreaterThan(0)
      expect(text).toContain("RunCommand")
      expect(text).toContain("headless")
    })

    it("flattens a multi-message prompt to a single joined text string sent to agy", async () => {
      const captured: { args?: readonly string[] } = {}
      const spawnFn = fakeSpawn([SUCCESS_LINE], "", 0, captured)
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      const prompt: LanguageModelV3CallOptions["prompt"] = [
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ]
      await model.doGenerate({ prompt } as LanguageModelV3CallOptions)
      expect(captured.args?.[1]).toBe("Be concise.\nHello")
    })
  })

  describe("doStream", () => {
    it("emits stream-start, a single text-start/delta/end, then finish", async () => {
      const spawnFn = fakeSpawn(
        ['{"event":"result","result":{"status":"SUCCESS","response":"Hello world, this is the complete answer.","usage":{"input_tokens":10,"output_tokens":7}}}\n'],
        "",
        0,
      )
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      const { stream } = await model.doStream({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)
      const parts = await collectStream(stream)
      expect(parts.map((p) => p.type)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"])
      const delta = parts.find((p) => p.type === "text-delta") as { delta: string }
      expect(delta.delta).toBe("Hello world, this is the complete answer.")
      const finish = parts.find((p) => p.type === "finish") as { finishReason: { unified: string } }
      expect(finish.finishReason.unified).toBe("stop")
    })

    it("surfaces agy's denied_actions as an explanatory text-delta instead of blank text", async () => {
      const spawnFn = fakeSpawn(
        [
          '{"event":"result","result":{"status":"SUCCESS","response":"","usage":{"input_tokens":10,"output_tokens":5},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n',
        ],
        "",
        0,
      )
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      const { stream } = await model.doStream({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)
      const parts = await collectStream(stream)
      expect(parts.map((p) => p.type)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"])
      const delta = parts.find((p) => p.type === "text-delta") as { delta: string }
      expect(delta.delta).toContain("RunCommand")
    })

    it("emits an error stream part on non-SUCCESS status instead of throwing", async () => {
      const spawnFn = fakeSpawn(['{"event":"result","result":{"status":"ERROR","error":"cloud outage"}}\n'], "", 0)
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      const { stream } = await model.doStream({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)
      const parts = await collectStream(stream)
      expect(parts[0]!.type).toBe("stream-start")
      expect(parts[1]!.type).toBe("error")
      expect((parts[1] as { error: Error }).error.message).toContain("cloud outage")
    })

    it("kills the child when the stream is cancelled mid-flight", async () => {
      let killedWith: NodeJS.Signals | undefined
      const spawnFn: SpawnFn = () => {
        const proc = new EventEmitter() as EventEmitter & { stdout: Readable | null; stderr: Readable | null }
        proc.stdout = Readable.from([])
        proc.stderr = Readable.from([])
        return {
          stdout: proc.stdout,
          stderr: proc.stderr,
          exited: new Promise(() => {}),
          kill: (signal?: NodeJS.Signals) => {
            killedWith = signal
            return true
          },
        }
      }
      const model = createAntigravityLanguageModel({
        modelID: "gemini-3.1-pro-high",
        resolveBinary: async () => "/x",
        spawnFn,
      })
      const { stream } = await model.doStream({ prompt: textPrompt("hi") } as LanguageModelV3CallOptions)
      const reader = stream.getReader()
      await reader.read()
      await reader.cancel()
      expect(killedWith).toBe("SIGTERM")
    })
  })
})

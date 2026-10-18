import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"

import { discoverModels } from "../src/model-discovery.js"
import type { SpawnFn } from "../src/spawn.js"

function fakeSpawn(stdoutText: string, exitCode: number | null = 0): SpawnFn {
  return (_cmd, args, _options) => {
    const proc = new EventEmitter() as EventEmitter & { stdout: Readable | null; stderr: Readable | null }
    proc.stdout = Readable.from([Buffer.from(stdoutText, "utf8")])
    proc.stderr = Readable.from(["Fetching available models...\n"])
    void args
    return {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: Promise.resolve(exitCode),
      kill: () => true,
    }
  }
}

const REAL_OUTPUT = [
  "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
  "gemini-4-argon-high\tGemini 4 Argon (High)",
  "claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n")

describe("discoverModels", () => {
  it("parses tab-separated slug/name pairs from stdout", async () => {
    const models = await discoverModels({ binary: "/usr/local/bin/agy", spawnFn: fakeSpawn(REAL_OUTPUT) })
    expect(models).toEqual([
      { slug: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
      { slug: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
      { slug: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
      { slug: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ])
  })

  it("ignores blank lines and lines without a tab", async () => {
    const output = "\n\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n\nsome stray line with no tab\n"
    const models = await discoverModels({ binary: "/x", spawnFn: fakeSpawn(output) })
    expect(models).toEqual([{ slug: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }])
  })

  it("throws when the output has no parseable model lines", async () => {
    await expect(discoverModels({ binary: "/x", spawnFn: fakeSpawn("\n") })).rejects.toThrow(
      /no parseable model list/,
    )
  })

  it("passes --model-less `models` subcommand to the binary", async () => {
    let capturedArgs: readonly string[] = []
    const spawnFn: SpawnFn = (cmd, args, options) => {
      capturedArgs = args
      return fakeSpawn(REAL_OUTPUT)(cmd, args, options)
    }
    await discoverModels({ binary: "/x", spawnFn })
    expect(capturedArgs).toEqual(["models"])
  })
})

// Builds a plain AI-SDK-v3 `LanguageModelV3` whose `doGenerate`/`doStream`
// spawn `agy` directly and translate its NDJSON events into AI SDK stream
// parts. No HTTP request of any kind is made — this is the V2 replacement
// for V1's `auth.loader` fetch override, which had to hijack the built-in
// "google" provider's `fetch` because V1 couldn't register a new provider at
// all. V2 lets a plugin register its own first-class provider (see
// plugin.ts), so this module only has to implement the model, not fake a
// wire format for an API the plugin never actually calls.
//
// `ctx.aisdk.hook("sdk"/"language", ...)` (see plugin.ts) is what wires a
// `LanguageModelV3` built here into opencode's model-calling machinery
// without ever going through a real HTTP client.

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"

import { defaultSpawn, type SpawnedProcess, type SpawnFn } from "./spawn.js"
import { subscriptionOnlyEnv } from "./env.js"
import { preflight } from "./cli.js"
import { AgyNotInstalledError, AgyParseError, AgySpawnError } from "./errors.js"
import { PROVIDER_ID } from "./constants.js"
import type { ModelSlug } from "./types.js"

export type AgyUsage = {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
}

export type AgyEvent =
  | { event: "init"; conversation_id: string }
  | {
      event: "step_update"
      step_update: { state: string; text_delta?: string; usage?: AgyUsage }
    }
  | {
      event: "result"
      result: { status: string; response?: string; error?: string; usage?: AgyUsage }
    }

export type AgyResult = Extract<AgyEvent, { event: "result" }>["result"]

function isAgyEvent(value: unknown): value is AgyEvent {
  if (!value || typeof value !== "object") return false
  const e = value as { event?: unknown }
  return e.event === "init" || e.event === "step_update" || e.event === "result"
}

// Drain stderr with bounded memory: tee each chunk to process.stderr so the
// operator can see live progress, keep only the last `STDERR_CAPTURE_LIMIT`
// bytes for the error message.
const STDERR_CAPTURE_LIMIT = 4 * 1024

async function drainStderr(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return ""
  const chunks: Buffer[] = []
  let captured = 0
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    process.stderr.write(buf)
    if (captured < STDERR_CAPTURE_LIMIT) {
      const remaining = STDERR_CAPTURE_LIMIT - captured
      chunks.push(buf.length > remaining ? buf.subarray(0, remaining) : buf)
      captured += buf.length
    }
  }
  return Buffer.concat(chunks).toString("utf8")
}

export type RunAgyOptions = {
  binary: string
  prompt: string
  slug: ModelSlug
  spawnFn?: SpawnFn
  signal?: AbortSignal
  /** Lets the caller observe (and kill) the spawned process, e.g. on stream cancellation. */
  onChild?: (child: SpawnedProcess) => void
}

// Spawns `agy -p <prompt> --model <slug> --output-format stream-json` and
// returns its terminal `result` event. We intentionally do NOT surface
// `step_update` text_delta as partial output: thinking models split their
// response across a thinking step and an answer step, and the DONE-state
// text_delta of the answer step can be partial or out-of-order. The
// authoritative full text is always `result.response`.
export async function runAgy(opts: RunAgyOptions): Promise<AgyResult> {
  const child = (opts.spawnFn ?? defaultSpawn)(
    opts.binary,
    ["-p", opts.prompt, "--model", opts.slug, "--output-format", "stream-json"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: subscriptionOnlyEnv(),
      timeout: 5 * 60 * 1000,
      // Escalate to SIGKILL if agy traps SIGTERM so the 5-min timeout
      // actually fires instead of waiting for the child to voluntarily exit.
      killSignal: "SIGKILL",
      signal: opts.signal,
    },
  )
  opts.onChild?.(child)

  const stderrPromise = drainStderr(child.stderr)
  if (opts.signal?.aborted) child.kill("SIGTERM")

  if (!child.stdout) throw new AgyParseError("", "agy produced no stdout stream")

  let buffer = ""
  const decoder = new TextDecoder()
  for await (const chunk of child.stdout) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    buffer += text

    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new AgyParseError(line, `agy emitted non-JSON line: ${line.slice(0, 120)}`)
      }
      if (!isAgyEvent(parsed)) continue
      if (parsed.event === "result") return parsed.result
    }
  }

  // Stream ended. Flush a trailing partial line: per the NDJSON spec a
  // trailing newline is recommended but not required, and `agy` has been
  // observed to omit it on the final result event.
  if (buffer.trim().length > 0) {
    const tail = buffer.trim()
    try {
      const parsed = JSON.parse(tail)
      if (isAgyEvent(parsed) && parsed.event === "result") return parsed.result
    } catch {
      // fall through to the exit-code error below
    }
  }

  const exitCode = await child.exited
  const stderr = await stderrPromise
  throw new AgySpawnError(exitCode, stderr || `agy exited with code ${exitCode ?? "unknown"} (no result event)`)
}

function promptToText(prompt: LanguageModelV3Prompt): string {
  const parts: string[] = []
  for (const message of prompt) {
    if (message.role === "system") {
      if (message.content.length > 0) parts.push(message.content)
      continue
    }
    for (const part of message.content) {
      if (part.type === "text") parts.push(part.text)
    }
  }
  return parts.join("\n")
}

function toUsage(usage: AgyUsage | undefined): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage?.input_tokens,
      noCache: undefined,
      cacheRead: usage?.cache_read_tokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.output_tokens,
      text: usage?.output_tokens,
      reasoning: usage?.thinking_tokens,
    },
  }
}

function resultError(result: AgyResult): Error {
  return new Error(result.error ?? `agy status: ${result.status}`)
}

// Re-runs `preflight()` on every call, mirroring V1's `auth.loader` guard
// (which ran on every chat request, not just once at plugin load). The
// factory module (ai-sdk-factory.ts) has no access to the plugin's `ctx`,
// so unlike plugin.ts's own `ctx.aisdk.hook("language", ...)` override this
// default cannot also check the live integration connection; the provider's
// `activation: "auto"` + `integrationID` catalog gating (see plugin.ts)
// already keeps the model out of the picker before any connection exists.
export async function defaultResolveBinary(): Promise<string> {
  try {
    const ok = await preflight()
    return ok.binary
  } catch (err) {
    if (err instanceof AgyNotInstalledError) {
      throw new AgyNotInstalledError(
        err.platform,
        `${err.message}\n\nAntigravity auth is configured but the binary is missing. Use "Install Antigravity CLI" above to reinstall.`,
      )
    }
    throw err
  }
}

export type CreateLanguageModelOptions = {
  modelID: ModelSlug
  /** Resolves the agy binary path, verifying auth + install state on every call. Defaults to `defaultResolveBinary`. */
  resolveBinary?: () => Promise<string>
  spawnFn?: SpawnFn
}

export function createAntigravityLanguageModel(opts: CreateLanguageModelOptions): LanguageModelV3 {
  const resolveBinary = opts.resolveBinary ?? defaultResolveBinary
  return {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
    modelId: opts.modelID,
    // We flatten every prompt part to text before calling agy, so no native
    // URL media type is forwarded without a download/conversion step.
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const binary = await resolveBinary()
      const prompt = promptToText(options.prompt)
      const result = await runAgy({
        binary,
        prompt,
        slug: opts.modelID,
        spawnFn: opts.spawnFn,
        signal: options.abortSignal,
      })
      if (result.status !== "SUCCESS") throw resultError(result)
      return {
        content: [{ type: "text", text: result.response ?? "" }],
        finishReason: { unified: "stop", raw: "STOP" },
        usage: toUsage(result.usage),
        warnings: [],
      }
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const binary = await resolveBinary()
      const prompt = promptToText(options.prompt)
      let child: SpawnedProcess | undefined

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          try {
            const result = await runAgy({
              binary,
              prompt,
              slug: opts.modelID,
              spawnFn: opts.spawnFn,
              signal: options.abortSignal,
              onChild: (c) => {
                child = c
              },
            })
            if (result.status !== "SUCCESS") {
              controller.enqueue({ type: "error", error: resultError(result) })
              controller.close()
              return
            }
            const id = "0"
            controller.enqueue({ type: "text-start", id })
            controller.enqueue({ type: "text-delta", id, delta: result.response ?? "" })
            controller.enqueue({ type: "text-end", id })
            controller.enqueue({
              type: "finish",
              usage: toUsage(result.usage),
              finishReason: { unified: "stop", raw: "STOP" },
            })
            controller.close()
          } catch (err) {
            controller.enqueue({ type: "error", error: err })
            controller.close()
          }
        },
        // Consumer-driven cancellation (e.g. the user cancels mid-response)
        // is independent of `options.abortSignal` and must be handled here
        // so the child doesn't linger until the 5-minute spawn timeout.
        cancel() {
          try {
            child?.kill("SIGTERM")
          } catch {
            /* already gone */
          }
        },
      })

      return { stream }
    },
  }
}

export { AgyParseError, AgySpawnError }

// Live model discovery via `agy models`, so the catalog this plugin
// exposes always matches whatever the installed `agy` actually supports
// instead of a hardcoded snapshot going stale when Google ships a new
// model generation (observed in practice: a plugin shipped with
// `gemini-3.6-flash-high` etc. against an `agy` build that had already
// moved on to `gemini-4-argon-medium` etc., and every chat turn failed
// with agy's own "model not recognized" error).

import { defaultSpawn, type SpawnFn } from "./spawn.js"
import { subscriptionOnlyEnv } from "./env.js"
import { preflight } from "./cli.js"
import { AgyParseError, AgySpawnError } from "./errors.js"

export type DiscoveredModel = { slug: string; name: string }

export type DiscoverModelsOptions = {
  spawnFn?: SpawnFn
  /** Already-resolved agy binary path; skips a redundant preflight() when provided. */
  binary?: string
}

// `agy models` prints a human progress line ("Fetching available
// models...") to stderr and one clean `<slug>\t<Display Name>` line per
// model to stdout — no header, no other stdout noise to filter.
export async function discoverModels(opts: DiscoverModelsOptions = {}): Promise<DiscoveredModel[]> {
  const binary = opts.binary ?? (await preflight()).binary
  const child = (opts.spawnFn ?? defaultSpawn)(binary, ["models"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: subscriptionOnlyEnv(),
    timeout: 30_000,
    killSignal: "SIGKILL",
  })
  if (!child.stdout) throw new AgyParseError("", "agy produced no stdout stream for `agy models`")

  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of child.stdout) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
  }

  const models = buffer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): DiscoveredModel | undefined => {
      const tab = line.indexOf("\t")
      if (tab < 0) return undefined
      const slug = line.slice(0, tab).trim()
      const name = line.slice(tab + 1).trim()
      return slug && name ? { slug, name } : undefined
    })
    .filter((model): model is DiscoveredModel => model !== undefined)

  if (models.length > 0) return models

  const exitCode = await child.exited
  throw new AgySpawnError(exitCode, "agy models returned no parseable model list")
}

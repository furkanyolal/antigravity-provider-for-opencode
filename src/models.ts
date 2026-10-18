// Domain data for Antigravity models, and the conversion into opencode
// V2's `Model.Info` schema shape (from `@opencode/schema/model`,
// re-exported by `@opencode/plugin`).
//
// `MODEL_DEFS` below is curated, precise metadata for the models known at
// the time this plugin was written. The live catalog plugin.ts actually
// registers comes from `agy models` (see model-discovery.ts), not this
// list directly: Google renames/retires model generations over time (a
// plugin shipped with a hardcoded snapshot stops working the moment `agy`
// moves past it — every chat turn fails with agy's own "model not
// recognized" error), so `toModelInfoListFromDiscovered` matches each
// *discovered* slug against this table for precise capabilities and falls
// back to `inferModelDef`'s family-prefix heuristics for any slug Google
// ships after this list was last updated. `MODEL_DEFS` itself is also
// used as-is as the pre-connect fallback catalog, so `/models` shows
// something reasonable before the first successful `agy models` call.
//
// Conservative defaults sourced from the Antigravity docs (models.md) and
// the gemini-cli CCPA fallbacks. No cost tiers are declared: the
// subscription bills the user, not the per-token API, and an empty `cost`
// array is the more honest V2 shape than fabricating a $0 tier.

import { Model, type Provider } from "@opencode/plugin"
import type { DiscoveredModel } from "./model-discovery.js"
import type { ModelDef, ModelSlug } from "./types.js"

export const MODEL_DEFS: readonly ModelDef[] = [
  {
    slug: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash (High)",
    family: "gemini-flash",
    reasoning: true,
    toolcall: true,
    acceptsImages: true,
    contextLimit: 1_000_000,
    outputLimit: 65_536,
    releaseDate: "2026-07-21",
  },
  {
    slug: "gemini-3.6-flash-medium",
    name: "Gemini 3.6 Flash (Medium)",
    family: "gemini-flash",
    reasoning: true,
    toolcall: true,
    acceptsImages: true,
    contextLimit: 1_000_000,
    outputLimit: 65_536,
    releaseDate: "2026-07-21",
  },
  {
    slug: "gemini-3.5-flash-medium",
    name: "Gemini 3.5 Flash (Medium)",
    family: "gemini-flash",
    reasoning: true,
    toolcall: true,
    acceptsImages: true,
    contextLimit: 1_000_000,
    outputLimit: 65_536,
    releaseDate: "2026-05-19",
  },
  {
    slug: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    family: "gemini-pro",
    reasoning: true,
    toolcall: true,
    acceptsImages: true,
    contextLimit: 1_000_000,
    outputLimit: 65_536,
    releaseDate: "2026-05-19",
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    family: "claude-sonnet",
    reasoning: true,
    toolcall: true,
    acceptsImages: true,
    contextLimit: 200_000,
    outputLimit: 8_192,
    releaseDate: "2026-05-19",
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Thinking)",
    family: "claude-opus",
    reasoning: true,
    toolcall: true,
    acceptsImages: true,
    contextLimit: 200_000,
    outputLimit: 8_192,
    releaseDate: "2026-05-19",
  },
  {
    slug: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    family: "gpt-oss",
    reasoning: true,
    toolcall: false,
    acceptsImages: false,
    contextLimit: 128_000,
    outputLimit: 8_192,
    releaseDate: "2026-05-19",
  },
]

export const MODEL_SLUGS: readonly ModelSlug[] = MODEL_DEFS.map((def) => def.slug)

const KNOWN_BY_SLUG: ReadonlyMap<string, ModelDef> = new Map(MODEL_DEFS.map((def) => [def.slug, def]))

// Best-effort metadata for a slug `agy models` reports that isn't in
// MODEL_DEFS yet (a newer model generation). Family-prefix heuristics,
// not an attempt to track every real limit precisely — accurate enough
// for the model picker and for opencode's own context-window bookkeeping
// to not be wildly wrong, which is all a fallback needs to be.
export function inferModelDef(discovered: DiscoveredModel): ModelDef {
  const known = KNOWN_BY_SLUG.get(discovered.slug)
  if (known) return known
  const { slug, name } = discovered
  const isClaude = slug.startsWith("claude-")
  const isGemini = slug.startsWith("gemini-")
  const isGptOss = slug.startsWith("gpt-oss-")
  const family = isClaude
    ? (slug.match(/^claude-(opus|sonnet|haiku)/)?.[1] ?? "claude")
    : isGemini
      ? (slug.match(/^gemini-[\d.]+-(\w+)/)?.[1] ?? "gemini")
      : isGptOss
        ? "gpt-oss"
        : "antigravity"
  return {
    slug,
    name,
    family: `antigravity-${family}`,
    reasoning: true,
    toolcall: !isGptOss,
    acceptsImages: isClaude || isGemini,
    contextLimit: isClaude ? 200_000 : isGptOss ? 128_000 : 1_000_000,
    outputLimit: isGemini ? 65_536 : 8_192,
  }
}

function toModelInfo(def: ModelDef, providerID: Provider.ID): Model.Info {
  const id = Model.ID.make(def.slug)
  return {
    id,
    modelID: id,
    providerID,
    name: def.name,
    family: Model.Family.make(def.family),
    capabilities: {
      tools: def.toolcall,
      input: def.acceptsImages ? ["text", "image"] : ["text"],
      output: ["text"],
      temperature: true,
    },
    variants: [],
    time: { released: def.releaseDate ? Date.parse(def.releaseDate) : 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: def.contextLimit, output: def.outputLimit },
  }
}

/** The static, curated catalog — used as the fallback before the first successful `agy models` call. */
export function toModelInfoList(providerID: Provider.ID): Model.Info[] {
  return MODEL_DEFS.map((def) => toModelInfo(def, providerID))
}

/** The live catalog: `agy models`' own slugs, with precise metadata where known and inferred metadata otherwise. */
export function toModelInfoListFromDiscovered(discovered: readonly DiscoveredModel[], providerID: Provider.ID): Model.Info[] {
  return discovered.map((model) => toModelInfo(inferModelDef(model), providerID))
}

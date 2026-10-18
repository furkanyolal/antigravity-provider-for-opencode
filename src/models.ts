// Domain data for the 7 Antigravity models, and the conversion into
// opencode V2's `Model.Info` schema shape (from `@opencode/schema/model`,
// re-exported by `@opencode/plugin`).
//
// Conservative defaults sourced from the Antigravity docs (models.md) and
// the gemini-cli CCPA fallbacks. No cost tiers are declared: the
// subscription bills the user, not the per-token API, and an empty `cost`
// array is the more honest V2 shape than fabricating a $0 tier.

import { Model, type Provider } from "@opencode/plugin"
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
    time: { released: Date.parse(def.releaseDate) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: def.contextLimit, output: def.outputLimit },
  }
}

export function toModelInfoList(providerID: Provider.ID): Model.Info[] {
  return MODEL_DEFS.map((def) => toModelInfo(def, providerID))
}

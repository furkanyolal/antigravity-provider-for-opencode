// Lightweight domain types for the plugin. The opencode V2 model/provider
// shapes (`Model.Info`, `Provider.Info`) come straight from `@opencode/plugin`
// (re-exported `@opencode/schema`); this file only holds the plugin's own
// model-slug union and the flat domain data used to build those V2 records.

export type ModelSlug =
  | "gemini-3.6-flash-high"
  | "gemini-3.6-flash-medium"
  | "gemini-3.5-flash-medium"
  | "gemini-3.1-pro-high"
  | "claude-sonnet-4-6"
  | "claude-opus-4-6"
  | "gpt-oss-120b-medium"

export type ModelDef = {
  slug: ModelSlug
  name: string
  family: string
  reasoning: boolean
  toolcall: boolean
  /** Whether the model accepts image input in addition to text. */
  acceptsImages: boolean
  contextLimit: number
  outputLimit: number
  /** ISO date (YYYY-MM-DD) the model became available. */
  releaseDate: string
}

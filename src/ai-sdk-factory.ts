// A minimal, real AI-SDK-v3 provider factory. opencode's built-in
// `opencode.provider.dynamic` plugin registers an unscoped `ctx.aisdk.hook("sdk", ...)`
// that unconditionally tries to resolve *any* `aisdk:`-prefixed provider
// package and dies (aborting the whole hook chain, including hooks
// registered by other plugins) if it cannot — so the package string in
// plugin.ts's `Provider.Info.package` must point at a real, importable
// module exporting a `create*`-named factory, not a symbolic placeholder.
//
// This factory exists to satisfy that resolution. The actual model plugin.ts
// hands opencode comes from its own `ctx.aisdk.hook("language", ...)`
// (which can check the live integration connection before every call);
// this factory's `languageModel()` is only a fallback for the rare case
// that hook doesn't run.
import { createAntigravityLanguageModel } from "./language-model.js"
import type { ModelSlug } from "./types.js"

export function createAntigravityProvider() {
  return {
    languageModel(modelID: string) {
      return createAntigravityLanguageModel({ modelID: modelID as ModelSlug })
    },
  }
}

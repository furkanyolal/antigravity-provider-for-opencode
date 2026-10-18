// Entry point for the Antigravity provider plugin. opencode V2's plugin
// loader expects a default export built with `Plugin.define({ id, setup })`
// (see https://opencode.ai/v2/docs/build/plugins). The implementation lives
// in src/plugin.ts so this file stays a pure re-export.

import { Plugin } from "@opencode/plugin"
import { setup } from "./plugin.js"
import { PROVIDER_ID } from "./constants.js"

const AntigravityProviderPlugin = Plugin.define({
  id: PROVIDER_ID,
  setup,
})

export default AntigravityProviderPlugin
export { AntigravityProviderPlugin }

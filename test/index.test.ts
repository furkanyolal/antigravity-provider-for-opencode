import { describe, expect, it } from "bun:test"
import plugin, { AntigravityProviderPlugin } from "../src/index.js"
import { setup } from "../src/plugin.js"
import { PROVIDER_ID } from "../src/constants.js"

describe("plugin entry point", () => {
  it("default export is the AntigravityProviderPlugin", () => {
    expect(plugin).toBe(AntigravityProviderPlugin)
  })

  it("uses Plugin.define's { id, setup } shape, not a V1 hooks function", () => {
    expect(plugin.id).toBe(PROVIDER_ID)
    expect(plugin.setup).toBe(setup)
  })
})

// V2 plugin setup. Registers:
//
//   1. An "antigravity" integration with three connect methods ("Install
//      Antigravity CLI", "Sign in with Google", "Use existing Antigravity
//      session") — the V2 replacement for V1's `auth.methods`.
//   2. An "antigravity" provider carrying the 6 Antigravity models,
//      gated on that integration having an active connection
//      (`activation: "auto"` + `integrationID`) — the V2 replacement for
//      V1's `provider.models` hook.
//   3. `ctx.aisdk.hook("sdk"/"language", ...)`, scoped to the
//      "antigravity" provider, which hands opencode a `LanguageModelV3`
//      whose `doGenerate`/`doStream` spawn `agy` directly. This is the V2
//      replacement for V1's `auth.loader` fetch override: unlike V1 (which
//      had to hijack the built-in "google" provider's `fetch` because it
//      could not register a new BUNDLED_PROVIDERS entry), V2 lets a plugin
//      register its own provider and its own model implementation, so no
//      HTTP request of any kind is made — see language-model.ts.
//
// Every connect method is backed by `preflight()`/`install()` from cli.ts
// and install.ts, unchanged from V1: those modules only talk to the `agy`
// subprocess and have no opencode-API-version dependency at all.

import type { Plugin } from "@opencode/plugin"
import { Credential, Integration, Provider } from "@opencode/plugin"

import { preflight } from "./cli.js"
import { install, installInstructionsForPlatform } from "./install.js"
import { createAntigravityLanguageModel } from "./language-model.js"
import { toModelInfoList, AI_SDK_PACKAGE } from "./models.js"
import { AgyAuthMissingError, AgyNotInstalledError } from "./errors.js"
import { PROVIDER_ID, PROVIDER_NAME } from "./constants.js"

// Dummy placeholder: the real OAuth session lives entirely inside `agy`'s
// own OS-keyring-backed session, never in opencode's credential store (see
// SECURITY.md). This URL is never actually navigated to by opencode; it
// only satisfies the OAuth-method schema's required `url` field.
const OAUTH_PLACEHOLDER_URL = "https://accounts.google.com/o/oauth/v2/auth?provider=antigravity"

const SIGNIN_INSTRUCTIONS =
  "Run `agy -p \"test\"` in a terminal first to complete the Google sign-in. " +
  "The Antigravity CLI opens the browser, completes OAuth, and stores the refresh token " +
  "in the OS keyring (Apple Keychain / Linux Secret Service / Windows Credential Manager). " +
  "After a successful sign-in, return to opencode and confirm the session."

const EXISTING_INSTRUCTIONS =
  "Use this if you have already signed in via the Antigravity CLI in another terminal. " +
  'Verify by running `agy -p "test"` — if it returns a response without an auth error, ' +
  "the session is active and you can continue."

function placeholderCredential(methodID: string): Credential.OAuth {
  return {
    type: "oauth",
    methodID: Integration.MethodID.make(methodID),
    refresh: "antigravity-managed",
    access: "antigravity-managed",
    expires: Date.now() + 3600 * 1000,
  }
}

export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  await ctx.integration.transform((editor) => {
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: "install", type: "oauth", label: "Install Antigravity CLI" },
      authorize: async () => {
        const proc = install()
        await proc.exited
        const ok = await preflight().catch(() => null)
        if (!ok) {
          throw new Error(`Install did not produce a runnable agy binary.\n\n${installInstructionsForPlatform()}`)
        }
        return {
          url: OAUTH_PLACEHOLDER_URL,
          instructions: "Run the official install command, then confirm the session.",
          mode: "auto",
          callback: Promise.resolve(placeholderCredential("install")),
        }
      },
    })

    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: "signin", type: "oauth", label: "Sign in with Google (run `agy` first)" },
      authorize: async () => {
        await preflight()
        return {
          url: OAUTH_PLACEHOLDER_URL,
          instructions: SIGNIN_INSTRUCTIONS,
          mode: "auto",
          callback: Promise.resolve(placeholderCredential("signin")),
        }
      },
    })

    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { id: "existing", type: "oauth", label: "Use existing Antigravity session" },
      authorize: async () => {
        await preflight()
        return {
          url: OAUTH_PLACEHOLDER_URL,
          instructions: EXISTING_INSTRUCTIONS,
          mode: "auto",
          callback: Promise.resolve(placeholderCredential("existing")),
        }
      },
    })
  })

  const providerID = Provider.ID.make(PROVIDER_ID)
  await ctx.provider.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: PROVIDER_NAME,
        // "auto" gates catalog visibility on the "antigravity" integration
        // having an active connection — the V2 equivalent of V1's
        // auth.loader throwing AgyAuthMissingError when no auth is
        // configured, but expressed as "don't list it" instead of "list it,
        // then fail on first use".
        activation: "auto",
        integrationID: Integration.ID.make(PROVIDER_ID),
        package: AI_SDK_PACKAGE,
      },
      models: toModelInfoList(providerID),
    })
  })

  // Every model call re-checks both the integration connection and the
  // agy binary itself, mirroring V1's auth.loader guard (which ran on
  // every chat request, not just once at plugin load).
  const resolveBinary = async (): Promise<string> => {
    const connection = await ctx.integration.connection.active(PROVIDER_ID)
    if (!connection) {
      throw new AgyAuthMissingError("No antigravity session is configured. Run /connect antigravity first.")
    }
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

  await ctx.aisdk.hook(
    "sdk",
    (evt) => {
      // The "sdk" step only needs to produce a truthy value; the real
      // model implementation is supplied by the "language" hook below, so
      // this object is never actually used.
      evt.sdk = {}
    },
    { providerID: PROVIDER_ID },
  )

  await ctx.aisdk.hook(
    "language",
    (evt) => {
      evt.language = createAntigravityLanguageModel({
        modelID: (evt.model.modelID ?? evt.model.id) as never,
        resolveBinary,
      })
    },
    { providerID: PROVIDER_ID },
  )
}

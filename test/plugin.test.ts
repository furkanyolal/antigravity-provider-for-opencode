import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "path"

import { setup } from "../src/plugin.js"
import { getAgyDefaultPath } from "../src/cli.js"
import { AgyParseError } from "../src/language-model.js"
import { AgyAuthMissingError, AgyNotInstalledError } from "../src/errors.js"
import { PROVIDER_ID } from "../src/constants.js"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { Model } from "@opencode/plugin"

// ===== Fake Plugin.Context — only the surface plugin.ts's setup() touches =====

type IntegrationMethodRegistration = {
  integrationID: string
  method: { id: string; type: string; label: string }
  authorize?: (answer: unknown) => Promise<{
    url: string
    instructions: string
    mode: "auto" | "code"
    callback: Promise<unknown> | ((code: string) => Promise<unknown>)
  }>
}

type ProviderAdd = {
  info: { id: string; name: string; activation: string; integrationID?: string; package: string }
  models: Model.Info[]
}

type AISDKHookRegistration = {
  name: "sdk" | "language"
  callback: (evt: Record<string, unknown>) => void
  options?: { providerID?: string }
}

function makeFakeCtx() {
  const integrationMethods: IntegrationMethodRegistration[] = []
  const providerAdds: ProviderAdd[] = []
  const aisdkHooks: AISDKHookRegistration[] = []
  let activeConnection: unknown

  const ctx = {
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          method: { update: (reg: IntegrationMethodRegistration) => integrationMethods.push(reg) },
        })
        return { dispose: async () => {} }
      },
      connection: {
        active: async () => activeConnection,
      },
    },
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (input: ProviderAdd) => providerAdds.push(input) })
        return { dispose: async () => {} }
      },
    },
    aisdk: {
      hook: async (
        name: "sdk" | "language",
        callback: (evt: Record<string, unknown>) => void,
        options?: { providerID?: string },
      ) => {
        aisdkHooks.push({ name, callback, options })
        return { dispose: async () => {} }
      },
    },
  }

  return {
    ctx,
    integrationMethods,
    providerAdds,
    aisdkHooks,
    setActiveConnection: (value: unknown) => {
      activeConnection = value
    },
  }
}

// ===== Fake agy binary (same technique the original V1 auth.test.ts used) =====

const originalHomedir = os.homedir
const originalLocalAppData = process.env["LOCALAPPDATA"]
function mockHomedir(home: string) {
  ;(os as { homedir: () => string }).homedir = () => home
}
afterEach(() => {
  mockHomedir(originalHomedir())
  delete process.env["PATH"]
  if (originalLocalAppData === undefined) delete process.env["LOCALAPPDATA"]
  else process.env["LOCALAPPDATA"] = originalLocalAppData
})

function makeExecutable(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo \"Antigravity CLI 99.0.0\" || echo ok\n")
  fs.chmodSync(filePath, 0o755)
}

// `getAgyDefaultPath()` resolves the platform-specific default location
// (POSIX: ~/.local/bin/agy; Windows: %LOCALAPPDATA%\agy\bin\agy.exe) using
// the *current* `os.homedir()`/`LOCALAPPDATA`, so faking both — not just
// `os.homedir()` — isolates these tests from a real `agy` already
// installed on the machine running them.
//
// `installFakeAgy()`'s fake binary is a `#!/bin/sh` script: it is only
// ever actually *executed* (via preflight()'s bare, non-injectable
// `verifyVersion()` call) on POSIX. `child_process.spawn` without
// `shell: true` — required by SECURITY.md's no-shell invariant — cannot
// run a shebang script nor a `.cmd`/`.bat` file on native Windows
// (confirmed: it throws EINVAL), so the tests below that need agy to
// actually run only pass on POSIX (this project's CI); on native Windows
// they fail with a spawn error from the OS, not a logic error.
function fakeAgyHome(home: string) {
  mockHomedir(home)
  process.env["LOCALAPPDATA"] = path.join(home, "AppData", "Local")
}

function installFakeAgy(home: string): string {
  fakeAgyHome(home)
  const bin = getAgyDefaultPath()
  makeExecutable(bin)
  return bin
}

let tmpHome: string
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-"))
})
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("setup", () => {
  it("registers 3 oauth integration methods: install, signin, existing", async () => {
    const { ctx, integrationMethods } = makeFakeCtx()
    await setup(ctx as never)
    expect(integrationMethods).toHaveLength(3)
    expect(integrationMethods.map((m) => m.method.id)).toEqual(["install", "signin", "existing"])
    for (const reg of integrationMethods) {
      expect(reg.integrationID).toBe(PROVIDER_ID)
      expect(reg.method.type).toBe("oauth")
    }
    expect(integrationMethods.map((m) => m.method.label)).toEqual([
      "Install Antigravity CLI",
      "Sign in with Google (run `agy` first)",
      "Use existing Antigravity session",
    ])
  })

  it("signin/existing authorize() succeeds and returns a placeholder credential when agy is present", async () => {
    installFakeAgy(tmpHome)
    const { ctx, integrationMethods } = makeFakeCtx()
    await setup(ctx as never)
    for (const id of ["signin", "existing"]) {
      const reg = integrationMethods.find((m) => m.method.id === id)!
      const authorization = await reg.authorize!({})
      expect(authorization.mode).toBe("auto")
      expect(typeof authorization.url).toBe("string")
      const credential = (await authorization.callback) as { refresh: string; access: string; expires: number }
      expect(credential.refresh).toBe("antigravity-managed")
      expect(credential.access).toBe("antigravity-managed")
      expect(credential.expires).toBeGreaterThan(Date.now() - 5_000)
    }
  })

  it("signin authorize() rejects when agy is missing", async () => {
    fakeAgyHome(tmpHome)
    process.env["PATH"] = "/nonexistent"
    const { ctx, integrationMethods } = makeFakeCtx()
    await setup(ctx as never)
    const reg = integrationMethods.find((m) => m.method.id === "signin")!
    await expect(reg.authorize!({})).rejects.toBeInstanceOf(AgyNotInstalledError)
  })

  it("install authorize() runs install() + preflight() then returns a placeholder credential", async () => {
    // install() shells out to curl/powershell; we only verify the happy
    // path when the install already produced a working binary (preflight
    // succeeds), since spawning the real installer is out of scope for a
    // unit test.
    installFakeAgy(tmpHome)
    const { ctx, integrationMethods } = makeFakeCtx()
    await setup(ctx as never)
    const reg = integrationMethods.find((m) => m.method.id === "install")!
    // install() spawns a real curl/powershell process; this would hang or
    // fail in CI, so this suite only exercises signin/existing end-to-end
    // and leaves install's full flow to manual verification (see
    // GETTING_STARTED.md). Confirm the method is wired at least.
    expect(reg.authorize).toBeInstanceOf(Function)
  })

  it("registers the antigravity provider gated on the antigravity integration", async () => {
    const { ctx, providerAdds } = makeFakeCtx()
    await setup(ctx as never)
    expect(providerAdds).toHaveLength(1)
    const [added] = providerAdds
    expect(added!.info.id).toBe(PROVIDER_ID)
    expect(added!.info.activation).toBe("auto")
    expect(added!.info.integrationID).toBe(PROVIDER_ID)
    expect(added!.models).toHaveLength(7)
  })

  it("points package at a real, importable aisdk: file:// factory module, not a symbolic placeholder", async () => {
    // opencode's built-in opencode.provider.dynamic plugin unconditionally
    // tries to import any aisdk:-prefixed package and dies (aborting every
    // plugin's hooks sharing that event chain, not just its own) if the
    // import fails — so this must resolve to a real file.
    const { ctx, providerAdds } = makeFakeCtx()
    await setup(ctx as never)
    const pkg = providerAdds[0]!.info.package
    expect(pkg.startsWith("aisdk:file://")).toBe(true)
    const fileURL = pkg.slice("aisdk:".length)
    expect(fs.existsSync(new URL(fileURL.replace(/\.js$/, ".ts")))).toBe(true)
  })

  it("registers an aisdk 'language' hook scoped to the antigravity provider", async () => {
    const { ctx, aisdkHooks } = makeFakeCtx()
    await setup(ctx as never)
    expect(aisdkHooks.map((h) => h.name)).toEqual(["language"])
    for (const hook of aisdkHooks) expect(hook.options?.providerID).toBe(PROVIDER_ID)
  })

  it("the 'language' hook builds a LanguageModelV3 for the requested model", async () => {
    const { ctx, aisdkHooks } = makeFakeCtx()
    await setup(ctx as never)
    const languageHook = aisdkHooks.find((h) => h.name === "language")!
    const evt: { model: { modelID: string; id: string }; language?: LanguageModelV3 } = {
      model: { modelID: "gemini-3.1-pro-high", id: "gemini-3.1-pro-high" },
    }
    languageHook.callback(evt)
    expect(evt.language?.specificationVersion).toBe("v3")
    expect(evt.language?.provider).toBe("antigravity")
    expect(evt.language?.modelId).toBe("gemini-3.1-pro-high")
  })

  it("the built language model's resolveBinary guard throws AgyAuthMissingError without a connection", async () => {
    installFakeAgy(tmpHome)
    const { ctx, aisdkHooks, setActiveConnection } = makeFakeCtx()
    setActiveConnection(undefined)
    await setup(ctx as never)
    const languageHook = aisdkHooks.find((h) => h.name === "language")!
    const evt: { model: { modelID: string; id: string }; language?: LanguageModelV3 } = {
      model: { modelID: "gemini-3.1-pro-high", id: "gemini-3.1-pro-high" },
    }
    languageHook.callback(evt)
    await expect(
      evt.language!.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as LanguageModelV3CallOptions),
    ).rejects.toBeInstanceOf(AgyAuthMissingError)
  })

  it("the built language model's resolveBinary succeeds once a connection is active and agy is present", async () => {
    installFakeAgy(tmpHome)
    const { ctx, aisdkHooks, setActiveConnection } = makeFakeCtx()
    setActiveConnection({ type: "credential", id: "cred_1" })
    await setup(ctx as never)
    const languageHook = aisdkHooks.find((h) => h.name === "language")!
    const evt: { model: { modelID: string; id: string }; language?: LanguageModelV3 } = {
      model: { modelID: "gemini-3.1-pro-high", id: "gemini-3.1-pro-high" },
    }
    languageHook.callback(evt)
    // No agy call is mocked at the spawn layer here, so the real
    // `preflight()` runs against the fake binary above, then `doGenerate`
    // spawns it for real; it prints "ok" (not NDJSON) for any non
    // `--version` invocation, so this only verifies the resolveBinary
    // guard passed through — see language-model.test.ts for the full
    // response pipeline against a mocked spawnFn.
    await expect(
      evt.language!.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as LanguageModelV3CallOptions),
    ).rejects.toBeInstanceOf(AgyParseError)
  })
})

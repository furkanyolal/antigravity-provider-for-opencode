# antigravity-provider-for-opencode

Opencode plugin that exposes the [Google Antigravity CLI](https://antigravity.google) (`agy`) as a multi-model provider. Use your Google AI Pro / Ultra subscription to access Gemini 3.x, Claude Sonnet 4.6, Claude Opus 4.6, and GPT-OSS 120B through opencode.

> **Unofficial integration.** This plugin shells out to Google's first-party `agy` binary. See [SECURITY.md](./SECURITY.md) for the threat model and [antigravity.google/terms](https://antigravity.google/terms) for the Google Terms of Service that apply.

## Status

**Pre-release.** The plugin is functional but the API surface is still being finalized. Expect breaking changes before 1.0.

## Models

| Slug | Display name | Notes |
|---|---|---|
| `antigravity/gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | Reasoning-on, fast |
| `antigravity/gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | Default reasoning |
| `antigravity/gemini-3.5-flash-medium` | Gemini 3.5 Flash (Medium) | Fallback when 3.6 unavailable |
| `antigravity/gemini-3.1-pro-high` | Gemini 3.1 Pro (High) | Deep reasoning |
| `antigravity/claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | Anthropic via Google routing |
| `antigravity/claude-opus-4-6` | Claude Opus 4.6 (Thinking) | Anthropic via Google routing |
| `antigravity/gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | Open-source model |

All models report `cost: 0` because the user's subscription is billed by Google, not per-token.

## Install

### 1. Install the Antigravity CLI

The plugin requires the `agy` binary on your `PATH`. Install it with the official one-liner for your platform:

- **macOS / Linux**: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- **Windows (PowerShell)**: `irm https://antigravity.google/cli/install.ps1 | iex`
- **Windows (CMD)**: `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd`

The `agy` binary manages its own OAuth session via your OS keyring (Apple Keychain / Linux Secret Service / Windows Credential Manager). There is no port to bind and no callback URL to forward.

### 2. Sign in once

```bash
agy
```

This opens a browser to Google's OAuth flow. After approving, the credentials are cached in the OS keyring and reused silently on subsequent calls.

### 3. Register the plugin with opencode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/absolute/path/to/antigravity-provider-for-opencode"
  ]
}
```

(Or use the package name `"antigravity-provider-for-opencode"` once installed via npm.)

### 4. Connect

In opencode:

```
/connect
→ Antigravity
→ Use existing Antigravity session
```

Then select a model:

```
/model antigravity/gemini-3.1-pro-high
```

> **Version note:** this README describes the opencode V2 plugin (`Plugin.define`,
> its own `antigravity` provider and integration). Earlier releases targeted
> opencode V1, where the plugin attached to the built-in `google` provider
> instead (`/model google/gemini-3.1-pro-high`). See
> [CHANGELOG.md](./CHANGELOG.md) for the V1→V2 migration notes.

### Requirements

The plugin requires **`agy` >= 1.1.8** (released 2026-06-09). Earlier versions do not implement the `--output-format stream-json` flag that the plugin relies on for NDJSON streaming. The preflight verifies this and surfaces an actionable `AgyNotInstalledError` with upgrade instructions.

For Google AI Pro / Ultra subscribers, OAuth happens via `agy`'s built-in browser flow. The plugin does not see the refresh token — it lives in the OS keyring (Apple Keychain / Linux Secret Service / Windows Credential Manager).

## Architecture

```
┌──────────────────┐
│   opencode TUI   │
└────────┬─────────┘
         │ plugin contract (Plugin.define)
         ▼
┌──────────────────────────────────────────┐
│  antigravity-provider-for-opencode       │
│                                          │
│  • registers its own "antigravity"       │
│    provider + integration via            │
│    ctx.provider / ctx.integration        │
│  • ctx.aisdk.hook("sdk"/"language")      │
│    hands opencode a plain LanguageModelV3 │
│    whose doGenerate/doStream:             │
│      - locate & preflight agy binary     │
│      - spawn "agy -p ... --output-format │
│        stream-json" via Process.spawn    │
│      - parse NDJSON → AI SDK stream parts │
│      - strip subscription-only env vars  │
└────────┬─────────────────────────────────┘
         │ subprocess (NDJSON stdout) — no HTTP request is ever made
         ▼
┌──────────────────┐
│  Antigravity CLI │
│  (agy, first-    │
│   party Google)  │
└────────┬─────────┘
         │ OAuth session via OS keyring
         ▼
     Google backend
```

opencode V1 could not register a new provider, so an earlier version of this
plugin attached to the built-in `google` provider and overrode its `fetch`.
opencode V2 lets a plugin register its own provider and its own
`LanguageModelV3` implementation directly (via `ctx.aisdk.hook`), so the
current version never touches the `google` provider, the AI SDK's `fetch`
option, or any Generative Language API wire format at all.

## Acknowledgments

This plugin is adapted from the Swift implementation in [Sentient-OS-Labs/sentient-os](https://github.com/Sentient-OS-Labs/sentient-os) (`Sentient OS macOS/Cloud/Provider/AntigravityProvider.swift`). The security model is informed by [SECURITY_AUDIT.md §11](https://github.com/Sentient-OS-Labs/sentient-os/blob/main/SECURITY_AUDIT.md), which contains the same threat analysis with macOS-specific hardening.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

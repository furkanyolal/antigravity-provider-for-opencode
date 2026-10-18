import { describe, expect, it } from "bun:test"
import { Provider } from "@opencode/plugin"
import { PROVIDER_ID } from "../src/constants.js"
import { MODEL_DEFS, MODEL_SLUGS, toModelInfoList } from "../src/models.js"

const providerID = Provider.ID.make(PROVIDER_ID)

describe("MODEL_DEFS", () => {
  it("contains exactly 7 models", () => {
    expect(MODEL_DEFS).toHaveLength(7)
    expect(MODEL_SLUGS).toHaveLength(7)
  })

  it("every model has a non-empty name, family, and positive limits", () => {
    for (const def of MODEL_DEFS) {
      expect(def.name.length).toBeGreaterThan(0)
      expect(def.family.length).toBeGreaterThan(0)
      expect(def.contextLimit).toBeGreaterThan(0)
      expect(def.outputLimit).toBeGreaterThan(0)
    }
  })

  it("reasoning is true for every model (slug names already encode the level)", () => {
    for (const def of MODEL_DEFS) expect(def.reasoning).toBe(true)
  })

  it("Gemini and Claude families accept image input", () => {
    for (const def of MODEL_DEFS) {
      if (def.slug.startsWith("gemini-") || def.slug.startsWith("claude-")) {
        expect(def.acceptsImages).toBe(true)
      }
    }
  })

  it("GPT-OSS does not declare image attachment (text-only)", () => {
    const gpt = MODEL_DEFS.find((def) => def.slug === "gpt-oss-120b-medium")!
    expect(gpt.acceptsImages).toBe(false)
    expect(gpt.toolcall).toBe(false)
  })

  it("claude models have 200k context window", () => {
    expect(MODEL_DEFS.find((d) => d.slug === "claude-sonnet-4-6")!.contextLimit).toBe(200_000)
    expect(MODEL_DEFS.find((d) => d.slug === "claude-opus-4-6")!.contextLimit).toBe(200_000)
  })

  it("gemini-3.6-flash and 3.5-flash share the gemini-flash family", () => {
    expect(MODEL_DEFS.find((d) => d.slug === "gemini-3.6-flash-high")!.family).toBe("gemini-flash")
    expect(MODEL_DEFS.find((d) => d.slug === "gemini-3.6-flash-medium")!.family).toBe("gemini-flash")
    expect(MODEL_DEFS.find((d) => d.slug === "gemini-3.5-flash-medium")!.family).toBe("gemini-flash")
  })

  it("claude-sonnet and claude-opus have distinct families", () => {
    expect(MODEL_DEFS.find((d) => d.slug === "claude-sonnet-4-6")!.family).toBe("claude-sonnet")
    expect(MODEL_DEFS.find((d) => d.slug === "claude-opus-4-6")!.family).toBe("claude-opus")
  })
})

describe("toModelInfoList", () => {
  const models = toModelInfoList(providerID)

  it("produces one Model.Info per ModelSlug with matching id", () => {
    expect(models).toHaveLength(MODEL_DEFS.length)
    const ids = models.map((m) => String(m.id)).toSorted()
    const slugs = [...MODEL_SLUGS].toSorted()
    expect(ids).toEqual(slugs)
  })

  it("stamps the antigravity providerID on every model", () => {
    for (const model of models) expect(model.providerID).toBe(providerID)
  })

  it("preserves name, family, status, and release time from ModelDef", () => {
    const def = MODEL_DEFS.find((d) => d.slug === "gemini-3.1-pro-high")!
    const mapped = models.find((m) => String(m.id) === def.slug)!
    expect(mapped.name).toBe(def.name)
    expect(String(mapped.family)).toBe(def.family)
    expect(mapped.status).toBe("active")
    expect(mapped.time.released).toBe(Date.parse(def.releaseDate))
  })

  it("declares no cost tiers (subscription-billed, not per-token)", () => {
    for (const model of models) expect(model.cost).toEqual([])
  })

  it("enables every model", () => {
    for (const model of models) expect(model.enabled).toBe(true)
  })

  it("maps capabilities.input to text+image or text-only per acceptsImages", () => {
    const imageModel = models.find((m) => String(m.id) === "gemini-3.1-pro-high")!
    const textOnly = models.find((m) => String(m.id) === "gpt-oss-120b-medium")!
    expect(imageModel.capabilities.input).toEqual(["text", "image"])
    expect(textOnly.capabilities.input).toEqual(["text"])
  })

  it("maps toolcall to capabilities.tools", () => {
    const gpt = models.find((m) => String(m.id) === "gpt-oss-120b-medium")!
    const gemini = models.find((m) => String(m.id) === "gemini-3.1-pro-high")!
    expect(gpt.capabilities.tools).toBe(false)
    expect(gemini.capabilities.tools).toBe(true)
  })

  it("carries limit.context and limit.output from ModelDef", () => {
    const def = MODEL_DEFS.find((d) => d.slug === "claude-opus-4-6")!
    const mapped = models.find((m) => String(m.id) === def.slug)!
    expect(mapped.limit.context).toBe(def.contextLimit)
    expect(mapped.limit.output).toBe(def.outputLimit)
  })
})


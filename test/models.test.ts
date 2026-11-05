import { describe, expect, it } from "vitest"
import { Provider } from "@opencode/plugin"
import { matchesFilter, toCatalogModel, toModelInfo } from "../src/models.js"
import type { CatalogEntry } from "../src/api.js"

const entry: CatalogEntry = {
  id: "deepseek/deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  context_length: 1_000_000,
  maxOutputTokens: 393_000,
  inputModalities: ["text", "image"],
  minimumPlan: "individual-goat",
  reasoningEfforts: ["low", "high", "off"],
  pricing: { inputCost: 0.2, outputCost: 1.1, cacheReadCost: 0.02, cacheWriteCost: 0.3 },
  display: { label: "DeepSeek V4.1 Flash", group: "DeepSeek", order: 10 },
}

describe("catalog model mapping", () => {
  it("maps the live catalog fields", () => {
    const model = toCatalogModel(entry)
    expect(model).toBeDefined()
    expect(model?.name).toBe("DeepSeek V4.1 Flash")
    expect(model?.contextWindow).toBe(1_000_000)
    expect(model?.maxOutputTokens).toBe(131_072)
    expect(model?.input).toEqual(["text", "image"])
    expect(model?.reasoning).toEqual(["low", "high"])
    expect(model?.anthropic).toBe(false)
  })

  it("detects Anthropic models through behavior profiles and ids", () => {
    const claude = toCatalogModel({
      id: "claude-sonnet-5-5",
      behaviorProfile: "anthropic-prefix-bound-v1",
      context_length: 1_000_000,
      minimumPlan: "individual-goat",
      display: { group: "Anthropic" },
    })
    expect(claude?.anthropic).toBe(true)
  })

  it("drops hidden and typesafe entries", () => {
    expect(toCatalogModel({ id: "typesafe/foo" } as CatalogEntry)).toBeUndefined()
    expect(toCatalogModel({ id: "hidden", hidden: true } as CatalogEntry)).toBeUndefined()
  })

  it("filters Anthropic, include and exclude prefixes", () => {
    const model = toCatalogModel(entry)!
    expect(matchesFilter(model, { includeAnthropic: false, includePremium: false, include: [], exclude: [] })).toBe(true)
    expect(matchesFilter(model, { includeAnthropic: false, includePremium: false, include: [], exclude: ["deepseek/"] })).toBe(false)
    expect(matchesFilter(model, { includeAnthropic: false, includePremium: false, include: ["x-ai/"], exclude: [] })).toBe(false)
  })
})

describe("model info", () => {
  const providerID = Provider.ID.make("commandcode")

  it("creates variants, limits and cost", () => {
    const model = toCatalogModel(entry)!
    const info = toModelInfo(providerID, model, {
      anthropicBaseURL: "https://api.commandcode.ai/provider/v1",
      includeAnthropic: false,
    })
    expect(info.limit.context).toBe(1_000_000)
    expect(info.limit.output).toBe(131_072)
    expect(info.capabilities.tools).toBe(true)
    expect(info.capabilities.input).toEqual(["text", "image"])
    expect(info.variants.map((variant) => variant.id)).toEqual(["low", "high"])
    expect(info.cost[0]?.input).toBe(0.2)
    expect(info.package).toBeUndefined()
  })

  it("routes Anthropic models through the Anthropic package", () => {
    const model = toCatalogModel({
      id: "claude-sonnet-5-5",
      behaviorProfile: "anthropic-prefix-bound-v1",
      context_length: 1_000_000,
    })!
    const info = toModelInfo(providerID, model, {
      anthropicBaseURL: "https://api.commandcode.ai/provider/v1",
      includeAnthropic: true,
    })
    expect(info.package).toBe("@opencode/ai/providers/anthropic-compatible")
    expect(info.settings?.baseURL).toBe("https://api.commandcode.ai/provider/v1")
  })
})

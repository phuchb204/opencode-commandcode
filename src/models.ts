import { Model, Provider } from "@opencode/plugin"
import type { CatalogEntry } from "./api.js"

export const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"
export const ANTHROPIC_COMPATIBLE = "@opencode/ai/providers/anthropic-compatible"

export interface CatalogModel {
  id: string
  name: string
  group: string
  description?: string
  order: number
  contextWindow: number
  maxOutputTokens: number
  input: string[]
  reasoning: string[]
  pricing?: NonNullable<CatalogEntry["pricing"]>
  minimumPlan?: string
  category?: string
  behaviorProfile?: string
  aliases: string[]
  anthropic: boolean
  zdr: boolean
}

export interface ModelFilterOptions {
  includeAnthropic: boolean
  includePremium: boolean
  include: string[]
  exclude: string[]
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positive(value: unknown): number | undefined {
  const n = finite(value)
  return n !== undefined && n > 0 ? n : undefined
}

export function isAnthropicEntry(entry: CatalogEntry): boolean {
  const id = typeof entry.id === "string" ? entry.id.toLowerCase() : ""
  const profile = typeof entry.behaviorProfile === "string" ? entry.behaviorProfile.toLowerCase() : ""
  const group = typeof entry.display?.group === "string" ? entry.display.group.toLowerCase() : ""
  return id.startsWith("claude-") || profile.startsWith("anthropic-") || group === "anthropic"
}

export function toCatalogModel(entry: CatalogEntry): CatalogModel | undefined {
  if (!entry || typeof entry.id !== "string" || entry.id.trim().length === 0) return undefined
  if (entry.id.startsWith("typesafe/")) return undefined
  if ((entry as { hidden?: boolean }).hidden === true) return undefined

  const contextWindow = positive(entry.context_length) ?? 200_000
  const declaredOutput = positive(entry.maxOutputTokens) ?? 0
  const maxOutputTokens = Math.max(1024, Math.min(declaredOutput > 0 ? declaredOutput : 32_768, 131_072, contextWindow))

  const reasoning = [...new Set(
    (Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : [])
      .filter((value): value is string => typeof value === "string" && value.length > 0 && value !== "off"),
  )]

  const modalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : []
  const input = ["text", ...(modalities.includes("image") ? ["image"] : [])]

  const display = entry.display && typeof entry.display === "object" ? entry.display : {}
  const name = typeof display.label === "string" && display.label.length > 0
    ? display.label
    : typeof entry.name === "string" && entry.name.length > 0
      ? entry.name
      : entry.id
  const group = typeof display.group === "string" && display.group.length > 0 ? display.group : "Models"
  const order = finite(display.order) ?? 10_000

  return {
    id: entry.id,
    name,
    group,
    description: typeof display.description === "string" ? display.description : undefined,
    order,
    contextWindow,
    maxOutputTokens,
    input,
    reasoning,
    pricing: entry.pricing,
    minimumPlan: entry.minimumPlan,
    category: entry.category,
    behaviorProfile: entry.behaviorProfile,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    anthropic: isAnthropicEntry(entry),
    zdr: entry.zdr === true,
  }
}

export function matchesFilter(model: CatalogModel, options: ModelFilterOptions): boolean {
  if (model.anthropic && !options.includeAnthropic) return false
  if (options.exclude.some((prefix) => prefix.length > 0 && model.id.startsWith(prefix))) return false
  if (options.include.length > 0 && !options.include.some((prefix) => model.id.startsWith(prefix))) return false
  return true
}

export function sortModels(models: CatalogModel[]): CatalogModel[] {
  return [...models].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order
    if (left.group !== right.group) return left.group.localeCompare(right.group)
    return left.name.localeCompare(right.name)
  })
}

export function toModelInfo(
  providerID: Provider.ID,
  model: CatalogModel,
  options: { anthropicBaseURL: string; includeAnthropic: boolean },
): Model.Info {
  const base = Model.Info.default(providerID, Model.ID.make(model.id))
  const pricing = model.pricing
  const cost: Model.Info["cost"] = pricing
    ? [{
        input: (pricing.inputCost ?? 0) as never,
        output: (pricing.outputCost ?? 0) as never,
        cache: {
          read: (pricing.cacheReadCost ?? 0) as never,
          write: (pricing.cacheWriteCost ?? 0) as never,
        },
      }]
    : []

  const variants: Model.Info["variants"] = model.reasoning.map((effort) => ({
    id: Model.VariantID.make(effort),
    settings: { reasoningEffort: effort },
  }))

  const anthropic = model.anthropic && options.includeAnthropic

  return {
    ...base,
    name: model.name,
    package: anthropic ? ANTHROPIC_COMPATIBLE : undefined,
    settings: anthropic ? { baseURL: options.anthropicBaseURL } : undefined,
    capabilities: {
      tools: true,
      input: model.input,
      output: ["text"],
    },
    variants,
    time: { released: 0 },
    cost,
    status: "active",
    enabled: true,
    limit: {
      context: model.contextWindow,
      output: model.maxOutputTokens,
    },
  }
}

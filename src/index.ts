/**
 * Command Code for OpenCode v2.
 *
 * The server part owns four jobs:
 *  1. resolve the Command Code key from the local CLI login or environment;
 *  2. read the account's plan and the live model catalog;
 *  3. reconcile OpenCode's `commandcode` provider so only models the account
 *     can actually use are selectable;
 *  4. expose a small status/refresh RPC for the desktop settings page.
 *
 * It deliberately works with the provider that already exists in
 * `opencode.json` or comes from models.dev: OpenCode applies config-provided
 * provider models after plugin provider transforms, but model transforms run
 * last. Adding/removing individual models there is the reliable seam.
 */

import { Plugin, Provider } from "@opencode/plugin"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  CommandCodeApi,
  DEFAULT_API_BASE,
  resolveAuth,
  safeError,
  type AuthResult,
  type CatalogEntry,
  type Credits,
  type Subscription,
  type UsageSummary,
} from "./api.js"
import { matchesFilter, sortModels, toCatalogModel, toModelInfo, type CatalogModel } from "./models.js"
import { normalizePlanId, planAllows, planLabel, planMonthlyCredits, type PlanID } from "./plan.js"
import { CommandCodeRpc, type Snapshot, type SnapshotSync } from "./rpc.js"

const PROVIDER_ID = "commandcode"
const PROVIDER_NAME = "Command Code"
const PLUGIN_VERSION = "1.0.0"
const CACHE_DIR = join(homedir(), ".cache", "opencode", "commandcode")
const CACHE_FILE = join(CACHE_DIR, "catalog.json")
const STORAGE_KEY = "apiKey"

interface Config {
  apiKey?: string
  authFile?: string
  baseURL: string
  plan: string
  includeAnthropic: boolean
  includePremium: boolean
  include: string[]
  exclude: string[]
  refreshIntervalMs: number
  requestTimeoutMs: number
  zdr: boolean
}

interface CacheFile {
  savedAt?: number
  catalogVersion?: string
  planId?: string
  entries?: CatalogEntry[]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function numberOption(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback
}

function readConfig(options: Record<string, unknown>): Config {
  return {
    apiKey: typeof options.apiKey === "string" && options.apiKey.trim().length > 0 ? options.apiKey.trim() : undefined,
    authFile: typeof options.authFile === "string" && options.authFile.trim().length > 0 ? options.authFile.trim() : undefined,
    baseURL: typeof options.baseURL === "string" && options.baseURL.trim().length > 0
      ? options.baseURL.trim().replace(/\/+$/, "")
      : DEFAULT_API_BASE,
    plan: typeof options.plan === "string" && options.plan.trim().length > 0 ? options.plan.trim() : "auto",
    includeAnthropic: options.includeAnthropic === true,
    includePremium: options.includePremium === true,
    include: stringArray(options.include),
    exclude: stringArray(options.exclude),
    refreshIntervalMs: numberOption(options.refreshIntervalMs, 300_000, 60_000),
    requestTimeoutMs: numberOption(options.requestTimeoutMs, 20_000, 2_000),
    zdr: options.zdr === true,
  }
}

/**
 * The RPC output validator rejects `undefined` (it is not a JSON value).
 * Strip undefined keys recursively before a snapshot crosses the wire.
 */
function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item)) as T
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = jsonSafe(item)
    }
    return out as T
  }
  return value
}

export default Plugin.define({
  id: PROVIDER_ID,
  async setup(ctx) {
    const config = readConfig(ctx.options as Record<string, unknown>)
    const apiBase = config.baseURL.replace(/\/+$/, "")
    const providerBaseURL = apiBase.endsWith("/provider/v1") ? apiBase : `${apiBase}/provider/v1`
    const startedAt = Date.now()

    const state: {
      auth: AuthResult
      storedKey?: string
      subscription?: Subscription
      credits?: Credits
      usage?: UsageSummary
      entries: CatalogEntry[]
      models: CatalogModel[]
      planId?: PlanID
      catalogAt: number
      catalogVersion?: string
      catalogError?: string
      catalogSource: string
      lastError?: string
      sync: SnapshotSync
      snapshot: Snapshot
      ready: boolean
      refreshing?: Promise<void>
      timer?: ReturnType<typeof setInterval>
      registration?: {
        // RpcRegistration is generic over the contract; erased here because the
        // contract is only needed for the status/refresh methods.
        events: { emit: (name: string, data: Record<string, unknown>) => Promise<void> }
        dispose: () => Promise<void>
      } | any
    } = {
      auth: { source: "none" },
      entries: [],
      models: [],
      catalogAt: 0,
      catalogSource: "none",
      sync: { state: "idle", at: 0, added: 0, removed: 0, updated: 0 },
      ready: false,
      snapshot: {
        ok: false,
        version: PLUGIN_VERSION,
        auth: { source: "none" },
        plan: { label: "Auto" },
        catalog: { count: 0, total: 0, fetchedAt: 0, source: "none" },
        models: [],
        sync: { state: "idle", at: 0, added: 0, removed: 0, updated: 0 },
        baseURL: providerBaseURL,
        includeAnthropic: config.includeAnthropic,
        refreshedAt: 0,
        startedAt,
      },
    }

    function rebuildModels(): void {
      const currentPlan = state.planId
      const models = state.entries
        .map(toCatalogModel)
        .filter((model): model is CatalogModel => model !== undefined)
        .filter((model) => matchesFilter(model, {
          includeAnthropic: config.includeAnthropic,
          includePremium: config.includePremium,
          include: config.include,
          exclude: config.exclude,
        }))
        .filter((model) => config.includePremium || planAllows(currentPlan, model.minimumPlan))
      state.models = sortModels(models)
    }

    async function providerKey(): Promise<string | undefined> {
      try {
        const listed = await ctx.provider.list() as unknown as { data?: Provider.Info[] }
        const provider = Array.isArray(listed?.data)
          ? listed.data.find((entry) => entry.id === PROVIDER_ID)
          : undefined
        const key = provider?.settings?.apiKey
        return typeof key === "string" && key.length > 0 ? key : undefined
      } catch {
        return undefined
      }
    }

    async function loadStoredKey(): Promise<void> {
      try {
        const value = await ctx.storage.get(STORAGE_KEY)
        if (typeof value === "string" && value.trim().length > 0) {
          state.storedKey = value.trim()
          console.log("[commandcode] loaded API key from plugin storage")
        }
      } catch (error) {
        console.warn(`[commandcode] could not read the stored API key: ${safeError(error)}`)
      }
    }

    async function loadCache(): Promise<void> {
      try {
        const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8")) as CacheFile
        if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return
        state.entries = parsed.entries
        state.catalogAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0
        state.catalogVersion = typeof parsed.catalogVersion === "string" ? parsed.catalogVersion : undefined
        state.catalogSource = "cache"
        if (config.plan !== "auto") state.planId = normalizePlanId(config.plan)
        else if (parsed.planId) state.planId = normalizePlanId(parsed.planId)
        state.ready = true
        rebuildModels()
        console.log(`[commandcode] loaded ${state.models.length}/${state.entries.length} cached models`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.warn(`[commandcode] could not read catalog cache: ${safeError(error)}`)
        }
      }
    }

    async function saveCache(): Promise<void> {
      try {
        await mkdir(CACHE_DIR, { recursive: true })
        await writeFile(CACHE_FILE, JSON.stringify({
          savedAt: state.catalogAt,
          catalogVersion: state.catalogVersion,
          planId: state.planId,
          entries: state.entries,
        }), "utf8")
      } catch (error) {
        console.warn(`[commandcode] could not write catalog cache: ${safeError(error)}`)
      }
    }

    function buildWindows(credits: Credits | undefined, planId: PlanID | undefined, subscription: Subscription | undefined) {
      const five = credits?.windowLimits?.fiveHour
      const weekly = credits?.windowLimits?.weekly
      const block = credits?.credits ?? {}
      const monthlyRemaining = typeof block.monthlyCredits === "number" ? block.monthlyCredits : undefined
      const purchased = typeof block.purchasedCredits === "number" ? block.purchasedCredits : 0
      const free = typeof block.freeCredits === "number" ? block.freeCredits : 0
      const planCap = planMonthlyCredits(planId)
      const totalRemaining = monthlyRemaining !== undefined ? monthlyRemaining + purchased + free : undefined
      const monthlyCap = planCap !== undefined && totalRemaining !== undefined
        ? Math.max(planCap, monthlyRemaining ?? 0) + purchased + free
        : undefined
      const monthlyUsed = monthlyCap !== undefined && totalRemaining !== undefined
        ? Math.max(0, monthlyCap - totalRemaining)
        : undefined
      const periodEnd = subscription?.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : undefined

      const window = (value: { used?: number; cap?: number; exceeded?: boolean; resetAt?: string | number } | undefined) => {
        if (!value) return undefined
        const percent = typeof value.used === "number" && typeof value.cap === "number" && value.cap > 0
          ? (value.used / value.cap) * 100
          : undefined
        return {
          used: value.used,
          cap: value.cap,
          percent,
          exceeded: value.exceeded === true,
          resetAt: value.resetAt,
        }
      }

      return {
        fiveHour: window(five),
        weekly: window(weekly),
        monthly: monthlyCap !== undefined && totalRemaining !== undefined
          ? {
              used: monthlyUsed,
              cap: monthlyCap,
              percent: monthlyUsed !== undefined && monthlyCap > 0 ? (monthlyUsed / monthlyCap) * 100 : undefined,
              exceeded: false,
              resetAt: Number.isFinite(periodEnd) ? periodEnd : undefined,
              remaining: totalRemaining,
              purchased,
              free,
            }
          : undefined,
      }
    }

    function buildSnapshot(): Snapshot {
      const subscription = state.subscription
      const credits = state.credits
      const block = credits?.credits ?? {}
      const purchased = typeof block.purchasedCredits === "number" ? block.purchasedCredits : 0
      const free = typeof block.freeCredits === "number" ? block.freeCredits : 0
      const monthlyRemaining = typeof block.monthlyCredits === "number" ? block.monthlyCredits : undefined
      const totalRemaining = monthlyRemaining !== undefined ? monthlyRemaining + purchased + free : undefined

      return {
        ok: state.models.length > 0,
        version: PLUGIN_VERSION,
        auth: {
          source: state.auth.source,
          path: state.auth.path,
          userName: state.auth.userName,
          error: state.auth.error,
        },
        plan: {
          id: state.planId,
          rawId: subscription?.planId,
          label: state.planId ? planLabel(state.planId) : "Auto",
          status: subscription?.status,
          currentPeriodEnd: subscription?.currentPeriodEnd,
          cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd === true,
        },
        credits: credits
          ? {
              monthlyRemaining,
              purchased,
              free,
              totalRemaining,
              belowThreshold: block.belowThreshold === true,
              threshold: block.creditThreshold,
            }
          : undefined,
        windows: buildWindows(credits, state.planId, subscription),
        usage: state.usage
          ? {
              totalCost: state.usage.totalCost,
              totalCredits: state.usage.totalCredits,
              totalTokens: state.usage.totalTokens,
              totalTokensIn: state.usage.totalTokensIn,
              totalTokensOut: state.usage.totalTokensOut,
              totalCount: state.usage.totalCount,
              completedCount: state.usage.completedCount,
              failedCount: state.usage.failedCount,
              successRate: state.usage.successRate,
              periodStart: state.usage.periodStart,
              periodBasis: state.usage.periodBasis,
            }
          : undefined,
        catalog: {
          count: state.models.length,
          total: state.entries.length,
          fetchedAt: state.catalogAt,
          version: state.catalogVersion,
          error: state.catalogError,
          source: state.catalogSource,
        },
        models: state.models.map((model) => ({
          id: model.id,
          name: model.name,
          group: model.group,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          input: model.input,
          reasoning: model.reasoning,
          minimumPlan: model.minimumPlan,
          anthropic: model.anthropic,
        })),
        sync: state.sync,
        baseURL: providerBaseURL,
        includeAnthropic: config.includeAnthropic,
        refreshedAt: Date.now(),
        startedAt,
        error: state.lastError,
      }
    }

    async function refresh(reason: string): Promise<void> {
      if (state.refreshing) return state.refreshing
      state.refreshing = (async () => {
        const fallbackKey = await providerKey()
        const auth = await resolveAuth({ apiKey: config.apiKey, authFile: config.authFile }, fallbackKey, state.storedKey)
        state.auth = auth
        if (!auth.apiKey) {
          state.lastError = auth.error ?? "Command Code API key is not available"
          state.snapshot = jsonSafe(buildSnapshot())
          return
        }

        const api = new CommandCodeApi({
          apiKey: auth.apiKey,
          baseURL: config.baseURL,
          timeoutMs: config.requestTimeoutMs,
          zdr: config.zdr,
        })

        const subscriptionResult = await Promise.allSettled([api.subscription()])
        const subscription = subscriptionResult[0].status === "fulfilled" ? subscriptionResult[0].value?.data : undefined
        if (config.plan === "auto") {
          state.planId = normalizePlanId(subscription?.planId) ?? state.planId
        } else {
          state.planId = normalizePlanId(config.plan) ?? state.planId
        }
        if (subscription) state.subscription = subscription

        const orgId = subscription?.orgId ?? undefined
        const since = subscription?.currentPeriodStart
        const [creditsResult, usageResult, catalogResult] = await Promise.allSettled([
          api.credits(orgId),
          api.usage(orgId, since),
          api.catalog(),
        ])

        if (creditsResult.status === "fulfilled") state.credits = creditsResult.value
        if (usageResult.status === "fulfilled") state.usage = usageResult.value?.data

        if (catalogResult.status === "fulfilled") {
          const entries = catalogResult.value
          if (entries.length > 0) {
            state.entries = entries
            state.catalogAt = Date.now()
            state.catalogVersion = undefined
            state.catalogSource = "live"
            state.catalogError = undefined
            state.ready = true
            await saveCache()
          } else {
            state.catalogError = "Command Code returned an empty model catalog"
          }
        } else {
          state.catalogError = safeError(catalogResult.reason)
        }

        rebuildModels()

        state.lastError = undefined
        if (state.catalogError) {
          state.lastError = state.catalogError
        } else if (state.models.length === 0) {
          state.lastError = "No Command Code models are available for this plan"
        } else if (creditsResult.status === "rejected") {
          state.lastError = safeError(creditsResult.reason)
        }

        try {
          await ctx.provider.reload()
          await ctx.model.reload()
        } catch (error) {
          state.lastError = safeError(error)
        }

        state.snapshot = jsonSafe(buildSnapshot())
        await state.registration?.events.emit("updated", { at: Date.now() }).catch(() => undefined)
        console.log(
          `[commandcode] ${reason}: ${state.models.length}/${state.entries.length} models, plan=${state.planId ?? "unknown"}`,
        )
      })().catch((error) => {
        state.lastError = safeError(error)
        state.snapshot = jsonSafe(buildSnapshot())
        console.warn(`[commandcode] refresh failed: ${state.lastError}`)
      }).finally(() => {
        state.refreshing = undefined
      })
      return state.refreshing
    }

    await loadStoredKey()
    await loadCache()

    await ctx.provider.transform((editor) => {
      const providerID = Provider.ID.make(PROVIDER_ID)
      const existing = editor.get(PROVIDER_ID)
      if (existing) {
        editor.update(PROVIDER_ID, (provider) => {
          provider.name = PROVIDER_NAME
          provider.activation = "enabled"
          provider.package = "@opencode/ai/providers/openai-compatible"
          provider.settings = {
            ...provider.settings,
            baseURL: providerBaseURL,
            ...(state.auth.apiKey ? { apiKey: state.auth.apiKey } : {}),
          }
        })
        return
      }
      if (!state.auth.apiKey) return
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: PROVIDER_NAME,
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: providerBaseURL,
            apiKey: state.auth.apiKey,
          },
        },
        models: [],
      })
    })

    await ctx.model.transform((editor) => {
      if (!state.ready) {
        state.sync = { state: "empty", at: Date.now(), added: 0, removed: 0, updated: 0 }
        return
      }
      const providerID = Provider.ID.make(PROVIDER_ID)
      const live = new Map(state.models.map((model) => [model.id, model]))
      const current = editor.list(PROVIDER_ID)
      let added = 0
      let removed = 0
      let updated = 0

      for (const model of current) {
        if (!live.has(model.modelID)) {
          editor.remove(PROVIDER_ID, model.modelID)
          removed += 1
        }
      }

      for (const model of state.models) {
        const existed = current.some((candidate) => candidate.modelID === model.id)
        const info = toModelInfo(providerID, model, {
          anthropicBaseURL: providerBaseURL,
          includeAnthropic: config.includeAnthropic,
        })
        editor.update(PROVIDER_ID, model.id, (draft) => {
          draft.name = info.name
          draft.limit = info.limit
          draft.capabilities = info.capabilities as never
          draft.variants = info.variants as never
          draft.time = info.time
          draft.cost = info.cost as never
          draft.status = info.status
          draft.enabled = true
          draft.package = info.package
          if (info.settings) draft.settings = { ...(draft.settings ?? {}), ...info.settings }
        })
        if (existed) updated += 1
        else added += 1
      }

      state.sync = {
        state: "applied",
        at: Date.now(),
        added,
        removed,
        updated,
      }
    })

    state.registration = await ctx.rpc.register(CommandCodeRpc, {
      status: async () => state.snapshot,
      refresh: async () => {
        await refresh("rpc")
        return state.snapshot
      },
      setKey: async (input) => {
        const value = (input as { apiKey?: unknown } | undefined)?.apiKey
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error("API key is empty")
        }
        const key = value.trim()
        const probe = new CommandCodeApi({
          apiKey: key,
          baseURL: config.baseURL,
          timeoutMs: config.requestTimeoutMs,
          zdr: config.zdr,
        })
        try {
          await probe.subscription()
        } catch (error) {
          return jsonSafe({
            ...state.snapshot,
            ok: false,
            error: `Command Code rejected this key: ${safeError(error)}`,
          })
        }
        await ctx.storage.set(STORAGE_KEY, key)
        state.storedKey = key
        if (state.refreshing) await state.refreshing
        await refresh("key")
        return state.snapshot
      },
      clearKey: async () => {
        await ctx.storage.remove(STORAGE_KEY)
        state.storedKey = undefined
        if (state.refreshing) await state.refreshing
        await refresh("key")
        return state.snapshot
      },
    })

    state.timer = setInterval(() => {
      void refresh("timer")
    }, config.refreshIntervalMs)

    void refresh("startup")

    console.log(`[commandcode] plugin active (base=${providerBaseURL}, plan=${config.plan})`)

    return async () => {
      if (state.timer) clearInterval(state.timer)
      await state.registration?.dispose().catch(() => undefined)
    }
  },
})



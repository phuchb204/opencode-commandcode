import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const DEFAULT_AUTH_FILE = join(homedir(), ".commandcode", "auth.json")

export type AuthSource = "config" | "plugin" | "environment" | "command-code-cli" | "provider" | "none"

export interface AuthResult {
  apiKey?: string
  source: AuthSource
  path?: string
  userName?: string
  userId?: string
  authenticatedAt?: string
  error?: string
}

export interface AuthOptions {
  apiKey?: string
  authFile?: string
}

export interface CatalogEntry {
  id: string
  name?: string
  object?: string
  owned_by?: string
  category?: string
  behaviorProfile?: string
  context_length?: number
  maxOutputTokens?: number | null
  inputModalities?: string[]
  minimumPlan?: string
  reasoningEfforts?: string[]
  aliases?: string[]
  zdr?: boolean
  pricing?: {
    inputCost?: number
    outputCost?: number
    cacheReadCost?: number
    cacheWriteCost?: number
    cacheWrite1hCost?: number
  }
  display?: {
    label?: string
    description?: string
    group?: string
    badge?: string | null
    notice?: string | null
    order?: number
  }
}

export interface Subscription {
  id?: string
  status?: string
  userId?: string
  orgId?: string | null
  planId?: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd?: boolean
  cancelAt?: string
  canceledAt?: string
}

export interface Credits {
  credits?: {
    monthlyCredits?: number
    purchasedCredits?: number
    freeCredits?: number
    belowThreshold?: boolean
    creditThreshold?: number
  }
  windowLimits?: {
    fiveHour?: Window
    weekly?: Window
  }
}

export interface Window {
  used?: number
  cap?: number
  exceeded?: boolean
  resetAt?: string | number
}

export interface UsageSummary {
  totalCost?: number
  totalCredits?: number
  totalMonthlyCredits?: number
  totalPurchasedCredits?: number
  totalTokens?: number
  totalTokensIn?: number
  totalTokensOut?: number
  totalCount?: number
  completedCount?: number
  failedCount?: number
  successRate?: number
  periodStart?: string
  periodBasis?: string
}

export class CommandCodeError extends Error {
  readonly status?: number
  readonly code?: string
  readonly detail?: string

  constructor(message: string, status?: number, code?: string, detail?: string) {
    super(message)
    this.name = "CommandCodeError"
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2))
  return value
}

function trimKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Resolve the Command Code key in the same order the Codex-style local tools
 * use: explicit option, a key saved from the settings page, environment, the
 * CLI login file, then an existing OpenCode provider entry.
 */
export async function resolveAuth(options: AuthOptions, providerKey?: string, storedKey?: string): Promise<AuthResult> {
  const configured = trimKey(options.apiKey)
  if (configured) return { apiKey: configured, source: "config" }

  const stored = trimKey(storedKey)
  if (stored) return { apiKey: stored, source: "plugin" }

  const env = trimKey(process.env.COMMANDCODE_API_KEY) ?? trimKey(process.env.CMD_API_KEY)
  if (env) return { apiKey: env, source: "environment" }

  const path = expandHome(options.authFile || DEFAULT_AUTH_FILE)
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      apiKey?: unknown
      userName?: string
      userId?: string
      authenticatedAt?: string
    }
    const key = trimKey(parsed.apiKey)
    if (key) {
      return {
        apiKey: key,
        source: "command-code-cli",
        path,
        userName: parsed.userName,
        userId: parsed.userId,
        authenticatedAt: typeof parsed.authenticatedAt === "string" ? parsed.authenticatedAt : undefined,
      }
    }
    if (trimKey(providerKey)) return { apiKey: trimKey(providerKey), source: "provider", path }
    return { source: "none", path, error: `No apiKey in ${path}` }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (trimKey(providerKey)) return { apiKey: trimKey(providerKey), source: "provider", path }
    return {
      source: "none",
      path,
      error:
        code === "ENOENT"
          ? `Command Code is not signed in (${path})`
          : `Cannot read Command Code auth file: ${safeError(error)}`,
    }
  }
}

export function safeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return `${code ? `${code}: ` : ""}${error.message}`.slice(0, 1200)
  }
  return String(error).slice(0, 1200)
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, value)
  }
  const text = query.toString()
  return text.length > 0 ? `${path}?${text}` : path
}

/**
 * Minimal authenticated client for Command Code's provider/billing API.
 * Only Node built-ins are used so the server plugin can run from the OpenCode
 * server without extra runtime dependencies.
 */
export class CommandCodeApi {
  readonly baseURL: string
  readonly timeoutMs: number
  readonly zdr: boolean
  private readonly apiKey: string

  constructor(options: { apiKey: string; baseURL?: string; timeoutMs?: number; zdr?: boolean }) {
    this.apiKey = options.apiKey
    this.baseURL = (options.baseURL || DEFAULT_API_BASE).replace(/\/+$/, "")
    this.timeoutMs = Math.max(2_000, options.timeoutMs ?? 20_000)
    this.zdr = options.zdr === true
  }

  private async get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = `${this.baseURL}${withQuery(path, params)}`
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": "opencode-commandcode/1.0",
    }
    if (this.zdr) headers["x-cmd-zdr"] = "1"

    let response: Response
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError") {
        throw new CommandCodeError(`Command Code request timed out: ${path}`, 504, "TIMEOUT")
      }
      throw new CommandCodeError(`Command Code request failed: ${safeError(error)}`, 502, "TRANSPORT")
    }

    const text = await response.text()
    let payload: unknown
    try {
      payload = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const body = payload as
        | { error?: { message?: string; code?: string; type?: string }; message?: string; code?: string }
        | undefined
      const detail =
        body?.error?.message ?? body?.message ?? (text.length > 0 ? text.slice(0, 800) : response.statusText)
      const code =
        body?.error?.code ??
        body?.code ??
        body?.error?.type ??
        (response.status === 401
          ? "AUTH"
          : response.status === 403
            ? "FORBIDDEN"
            : response.status === 429
              ? "RATE_LIMIT"
              : "HTTP_ERROR")
      throw new CommandCodeError(
        `Command Code ${path} failed (${response.status}): ${detail}`,
        response.status,
        String(code),
        detail,
      )
    }

    return payload as T
  }

  async subscription(): Promise<{ success?: boolean; data?: Subscription }> {
    return this.get("/alpha/billing/subscriptions")
  }

  async credits(orgId?: string | null): Promise<Credits> {
    return this.get("/alpha/billing/credits", { orgId: orgId ?? undefined })
  }

  async usage(orgId?: string | null, since?: string): Promise<{ data?: UsageSummary }> {
    return this.get("/alpha/usage/summary", { orgId: orgId ?? undefined, since })
  }

  async catalog(): Promise<CatalogEntry[]> {
    const payload = await this.get<{ data?: CatalogEntry[]; models?: CatalogEntry[] } | CatalogEntry[]>(
      "/provider/v1/models",
      { view: "client" },
    )
    if (Array.isArray(payload)) return payload
    if (Array.isArray(payload?.data)) return payload.data
    if (Array.isArray(payload?.models)) return payload.models
    return []
  }
}

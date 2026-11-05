/**
 * Command Code plan helpers.
 *
 * The catalog publishes a `minimumPlan` for every model. OpenCode does not
 * understand Command Code's plan names, so the plugin filters the catalog
 * before exposing it. Keep this list in the same order Command Code uses:
 * a later plan includes every earlier plan.
 */
export const PLAN_ORDER = [
  "individual-go",
  "individual-goat",
  "individual-pro",
  "individual-max",
  "individual-provider",
] as const

export type PlanID = (typeof PLAN_ORDER)[number]

export const PLAN_LABELS: Record<string, string> = {
  "individual-go": "Go",
  "individual-go-v1": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
}

/** Plan-level monthly credit pool, used only to render a usage percentage. */
export const PLAN_MONTHLY_CREDITS: Record<string, number> = {
  "individual-go": 10,
  "individual-go-v1": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
}

const ALIASES: Record<string, PlanID> = {
  go: "individual-go",
  "individual-go": "individual-go",
  goat: "individual-goat",
  "individual-goat": "individual-goat",
  pro: "individual-pro",
  "individual-pro": "individual-pro",
  max: "individual-max",
  "individual-max": "individual-max",
  "max-10x": "individual-max",
  "max-20x": "individual-max",
  provider: "individual-provider",
  "individual-provider": "individual-provider",
}

export function normalizePlanId(value: unknown): PlanID | undefined {
  if (typeof value !== "string") return undefined
  return ALIASES[value.trim().toLowerCase()]
}

export function planLabel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "Unknown"
  const normalized = normalizePlanId(value)
  return PLAN_LABELS[normalized ?? value] ?? value
}

export function planMonthlyCredits(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const normalized = normalizePlanId(value)
  return PLAN_MONTHLY_CREDITS[value] ?? (normalized ? PLAN_MONTHLY_CREDITS[normalized] : undefined)
}

/**
 * A model is available when its minimum plan is at or below the current plan.
 *
 * Unknown plans and unknown minimums fail open: hiding a model is worse than
 * showing one that the API rejects with a clear `MODEL_NOT_IN_PLAN` message.
 */
export function planAllows(current: PlanID | undefined, minimum: unknown): boolean {
  if (!current) return true
  if (typeof minimum !== "string" || minimum.length === 0) return true
  const min = normalizePlanId(minimum)
  if (!min) return true
  return PLAN_ORDER.indexOf(min) <= PLAN_ORDER.indexOf(current)
}

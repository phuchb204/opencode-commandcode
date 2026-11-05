import { Rpc } from "@opencode/plugin/rpc"

export interface SnapshotModel {
  id: string
  name: string
  group: string
  contextWindow: number
  maxOutputTokens: number
  input: string[]
  reasoning: string[]
  minimumPlan?: string
  anthropic: boolean
}

export interface SnapshotAuth {
  source: string
  path?: string
  userName?: string
  error?: string
}

export interface SnapshotPlan {
  id?: string
  rawId?: string
  label: string
  status?: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd?: boolean
}

export interface SnapshotCredits {
  monthlyRemaining?: number
  purchased?: number
  free?: number
  totalRemaining?: number
  belowThreshold?: boolean
  threshold?: number
}

export interface SnapshotWindow {
  used?: number
  cap?: number
  percent?: number
  exceeded?: boolean
  resetAt?: string | number
}

export interface SnapshotWindows {
  fiveHour?: SnapshotWindow
  weekly?: SnapshotWindow
  monthly?: SnapshotWindow
}

export interface SnapshotUsage {
  totalCost?: number
  totalCredits?: number
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

export interface SnapshotSync {
  state: "idle" | "applied" | "unchanged" | "empty" | "error" | "disabled" | "deferred"
  at: number
  added: number
  removed: number
  updated: number
  error?: string
}

export interface Snapshot {
  ok: boolean
  version: string
  auth: SnapshotAuth
  plan: SnapshotPlan
  credits?: SnapshotCredits
  windows?: SnapshotWindows
  usage?: SnapshotUsage
  catalog: {
    count: number
    total: number
    fetchedAt: number
    version?: string
    error?: string
    source: string
  }
  models: SnapshotModel[]
  sync: SnapshotSync
  baseURL: string
  includeAnthropic: boolean
  refreshedAt: number
  startedAt: number
  error?: string
}

const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const snapshotOutput = {
  type: "object",
  additionalProperties: true,
} as const

const keyInput = {
  type: "object",
  properties: {
    apiKey: { type: "string" },
  },
  required: ["apiKey"],
  additionalProperties: false,
} as const

/**
 * RPC contract shared by the server part and the desktop GUI. Both sides
 * import this file through the package's `./rpc` export.
 */
export const CommandCodeRpc = Rpc.define({
  id: "commandcode",
  methods: {
    status: {
      input: emptyInput,
      output: snapshotOutput,
    },
    refresh: {
      input: emptyInput,
      output: snapshotOutput,
    },
    setKey: {
      input: keyInput,
      output: snapshotOutput,
    },
    clearKey: {
      input: emptyInput,
      output: snapshotOutput,
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          at: { type: "number" },
        },
        required: ["at"],
        additionalProperties: false,
      },
    },
  },
})

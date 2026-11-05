import { Plugin, SettingsPage, type Context } from "@opencode/plugin/gui"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"

import { CommandCodeRpc, type Snapshot } from "./rpc.js"

const ACCENT = "#4f8cff"

const panel = {
  border: "1px solid rgba(127,127,127,0.22)",
  "border-radius": "10px",
  background: "rgba(127,127,127,0.045)",
} as const

const muted = { opacity: 0.66 } as const

const button = {
  border: "1px solid rgba(127,127,127,0.28)",
  "border-radius": "8px",
  background: "rgba(127,127,127,0.10)",
  color: "inherit",
  padding: "7px 12px",
  "font-size": "12px",
  "font-weight": 600,
  cursor: "pointer",
} as const

function money(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "—"
}

function percent(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—"
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  try {
    return JSON.stringify(cause) ?? String(cause)
  } catch {
    return String(cause)
  }
}

function tokens(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return String(value)
}

function dateTime(value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "—"
  const date = typeof value === "number" ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

function Meter(props: { label: string; percent?: number; detail: string; title?: string }) {
  const width = () => `${Math.max(0, Math.min(100, props.percent ?? 0))}%`
  const tone = () => ((props.percent ?? 0) >= 90 ? "#ef4444" : (props.percent ?? 0) >= 70 ? "#f59e0b" : ACCENT)
  return (
    <div title={props.title} style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "font-size": "12px" }}>
        <span>{props.label}</span>
        <span style={{ opacity: 0.7 }}>{props.detail}</span>
      </div>
      <div style={{ height: "6px", "border-radius": "999px", background: "rgba(127,127,127,0.18)" }}>
        <div
          style={{
            height: "100%",
            width: width(),
            "border-radius": "999px",
            background: tone(),
            transition: "width 200ms ease",
          }}
        />
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ ...panel, padding: "12px 14px", display: "flex", "flex-direction": "column", gap: "3px" }}>
      <div style={{ ...muted, "font-size": "11px", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
        {props.label}
      </div>
      <div style={{ "font-size": "18px", "font-weight": 650, "line-height": 1.2 }}>{props.value}</div>
      <Show when={props.hint}>
        <div style={{ ...muted, "font-size": "11px" }}>{props.hint}</div>
      </Show>
    </div>
  )
}

function Page(props: { ctx: Context }) {
  const t = (key: string, params?: Record<string, string | number>) => {
    const raw = props.ctx.t(key) ?? key
    if (!params) return raw
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""))
  }
  const [data, setData] = createSignal<Snapshot | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [keyInput, setKeyInput] = createSignal("")
  const [keyBusy, setKeyBusy] = createSignal(false)
  const [keyMessage, setKeyMessage] = createSignal<string | null>(null)
  const [keyOk, setKeyOk] = createSignal(false)

  const rpc = () => props.ctx.client.rpc(CommandCodeRpc)

  async function load(): Promise<void> {
    try {
      const next = (await rpc().status({})) as Snapshot
      setData(next)
      setError(null)
      // The server registers the RPC before its first catalog fetch finishes.
      // On a cold start the first status can be the empty placeholder snapshot;
      // pull once instead of waiting for the 60s poll.
      if (next.refreshedAt === 0 && next.catalog.count === 0 && !busy()) void refresh()
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  async function refresh(): Promise<void> {
    setBusy(true)
    try {
      const next = (await rpc().refresh({})) as Snapshot
      setData(next)
      setError(null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  async function saveKey(): Promise<void> {
    const value = keyInput().trim()
    if (value.length === 0) return
    setKeyBusy(true)
    setKeyMessage(null)
    try {
      const next = (await rpc().setKey({ apiKey: value })) as Snapshot
      setData(next)
      if (next.auth.source !== "plugin") {
        setKeyOk(false)
        setKeyMessage(next.error ?? t("commandcode.apiKeyRejected"))
        return
      }
      setKeyInput("")
      setKeyOk(true)
      setKeyMessage(t("commandcode.apiKeySaved"))
    } catch (cause) {
      setKeyOk(false)
      setKeyMessage(errorText(cause))
    } finally {
      setKeyBusy(false)
    }
  }

  async function clearKey(): Promise<void> {
    setKeyBusy(true)
    setKeyMessage(null)
    try {
      const next = (await rpc().clearKey({})) as Snapshot
      setData(next)
      setKeyOk(true)
      setKeyMessage(t("commandcode.apiKeyCleared"))
    } catch (cause) {
      setKeyOk(false)
      setKeyMessage(errorText(cause))
    } finally {
      setKeyBusy(false)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), 60_000)
    onCleanup(() => clearInterval(timer))
  })

  const filtered = createMemo(() => {
    const text = query().trim().toLowerCase()
    const models = data()?.models ?? []
    if (text.length === 0) return models
    return models.filter((model) =>
      model.id.toLowerCase().includes(text) ||
      model.name.toLowerCase().includes(text) ||
      model.group.toLowerCase().includes(text)
    )
  })

  const headerCell = {
    padding: "8px 8px",
    "font-weight": 600,
    background: "var(--v2-background-bg-layer-01, #242424)",
  } as const

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px", "padding": "48px 0 28px" }}>
      <div style={{ display: "flex", "align-items": "flex-start", "justify-content": "space-between", gap: "16px" }}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
          <h2 class="settings-tab-title" style={{ margin: 0 }}>
            {t("commandcode.title")}
          </h2>
          <span class="text-11-regular text-v2-text-text-muted">
            {t("commandcode.subtitle")}
          </span>
        </div>
        <button
          type="button"
          style={{ ...button, opacity: busy() ? 0.55 : 1 }}
          disabled={busy()}
          onClick={() => void refresh()}
        >
          {busy() ? t("commandcode.refreshing") : t("commandcode.refresh")}
        </button>
      </div>

      <Show when={error()}>
        <div
          style={{
            ...panel,
            padding: "10px 12px",
            "border-color": "rgba(239,68,68,0.45)",
            background: "rgba(239,68,68,0.08)",
            "font-size": "12px",
          }}
        >
          {error()}
        </div>
      </Show>

      <Show when={data()} fallback={<div style={{ ...panel, padding: "16px", ...muted }}>{t("commandcode.loading")}</div>}>
        {(() => {
          const snapshot = data()!
          return (
            <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
              <Show when={!snapshot.ok && snapshot.error}>
                <div
                  style={{
                    ...panel,
                    padding: "10px 12px",
                    "border-color": "rgba(245,158,11,0.45)",
                    background: "rgba(245,158,11,0.08)",
                    "font-size": "12px",
                  }}
                >
                  {snapshot.error}
                </div>
              </Show>

              <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(170px, 1fr))", gap: "10px" }}>
                <Stat
                  label={t("commandcode.plan")}
                  value={snapshot.plan.label}
                  hint={snapshot.plan.cancelAtPeriodEnd
                    ? t("commandcode.ends", { date: dateTime(snapshot.plan.currentPeriodEnd) })
                    : snapshot.plan.currentPeriodEnd
                      ? t("commandcode.renews", { date: dateTime(snapshot.plan.currentPeriodEnd) })
                      : snapshot.plan.status}
                />
                <Stat
                  label={t("commandcode.credits")}
                  value={money(snapshot.credits?.monthlyRemaining)}
                  hint={snapshot.credits
                    ? t("commandcode.creditsHint", {
                        purchased: money(snapshot.credits.purchased),
                        free: money(snapshot.credits.free),
                      })
                    : undefined}
                />
                <Stat
                  label={t("commandcode.models")}
                  value={`${snapshot.catalog.count}`}
                  hint={t("commandcode.modelsHint", { total: snapshot.catalog.total })}
                />
                <Stat
                  label={t("commandcode.updated")}
                  value={dateTime(snapshot.refreshedAt).split(", ").slice(-1)[0] ?? "—"}
                  hint={snapshot.auth.userName ?? snapshot.auth.source}
                />
              </div>

              <div style={{ ...panel, padding: "14px", display: "flex", "flex-direction": "column", gap: "8px" }}>
                <div style={{ "font-size": "13px", "font-weight": 650 }}>{t("commandcode.apiKey")}</div>
                <div style={{ ...muted, "font-size": "11px" }}>{t("commandcode.apiKeyHint")}</div>
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
                  <input
                    type="password"
                    autocomplete="new-password"
                    spellcheck={false}
                    value={keyInput()}
                    onInput={(event) => setKeyInput(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveKey()
                    }}
                    placeholder={t("commandcode.apiKeyPlaceholder")}
                    style={{
                      flex: "1 1 220px",
                      "min-width": "180px",
                      border: "1px solid rgba(127,127,127,0.28)",
                      "border-radius": "8px",
                      background: "rgba(127,127,127,0.06)",
                      color: "inherit",
                      padding: "7px 10px",
                      "font-size": "12px",
                      outline: "none",
                    }}
                  />
                  <button
                    type="button"
                    style={{ ...button, opacity: keyBusy() || keyInput().trim().length === 0 ? 0.5 : 1 }}
                    disabled={keyBusy() || keyInput().trim().length === 0}
                    onClick={() => void saveKey()}
                  >
                    {keyBusy() ? t("commandcode.apiKeySaving") : t("commandcode.apiKeySave")}
                  </button>
                  <button
                    type="button"
                    style={{ ...button, opacity: keyBusy() || snapshot.auth.source !== "plugin" ? 0.5 : 1 }}
                    disabled={keyBusy() || snapshot.auth.source !== "plugin"}
                    onClick={() => void clearKey()}
                  >
                    {t("commandcode.apiKeyClear")}
                  </button>
                </div>
                <Show when={keyMessage()}>
                  <div style={{ "font-size": "11px", color: keyOk() ? "#22c55e" : "#ef4444" }}>{keyMessage()}</div>
                </Show>
                <div style={{ ...muted, "font-size": "11px" }}>
                  {t("commandcode.apiKeyCurrent", { source: snapshot.auth.source })}
                </div>
              </div>

              <div style={{ ...panel, padding: "14px", display: "flex", "flex-direction": "column", gap: "12px" }}>
                <div style={{ "font-size": "13px", "font-weight": 650 }}>{t("commandcode.windows")}</div>
                <Meter
                  label={t("commandcode.fiveHour")}
                  percent={snapshot.windows?.fiveHour?.percent}
                  detail={percent(snapshot.windows?.fiveHour?.percent)}
                  title={snapshot.windows?.fiveHour
                    ? `${snapshot.windows.fiveHour.used ?? "—"} / ${snapshot.windows.fiveHour.cap ?? "—"}`
                    : undefined}
                />
                <Meter
                  label={t("commandcode.weekly")}
                  percent={snapshot.windows?.weekly?.percent}
                  detail={percent(snapshot.windows?.weekly?.percent)}
                  title={snapshot.windows?.weekly
                    ? `${snapshot.windows.weekly.used ?? "—"} / ${snapshot.windows.weekly.cap ?? "—"}`
                    : undefined}
                />
                <Meter
                  label={t("commandcode.monthly")}
                  percent={snapshot.windows?.monthly?.percent}
                  detail={percent(snapshot.windows?.monthly?.percent)}
                  title={snapshot.windows?.monthly
                    ? `${money(snapshot.windows.monthly.used)} / ${money(snapshot.windows.monthly.cap)}`
                    : undefined}
                />
              </div>

              <div style={{ ...panel, overflow: "hidden" }}>
                <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "12px", padding: "12px 14px" }}>
                  <div>
                    <div style={{ "font-size": "13px", "font-weight": 650 }}>{t("commandcode.catalog")}</div>
                    <div style={{ ...muted, "font-size": "11px", "margin-top": "2px" }}>
                      {t("commandcode.catalogHint", {
                        count: snapshot.catalog.count,
                        total: snapshot.catalog.total,
                        plan: snapshot.plan.label,
                      })}
                    </div>
                  </div>
                  <input
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    placeholder={t("commandcode.search")}
                    style={{
                      width: "220px",
                      "max-width": "42vw",
                      border: "1px solid rgba(127,127,127,0.28)",
                      "border-radius": "8px",
                      background: "rgba(127,127,127,0.06)",
                      color: "inherit",
                      padding: "7px 10px",
                      "font-size": "12px",
                      outline: "none",
                    }}
                  />
                </div>
                <div style={{ "max-height": "420px", overflow: "auto", "border-top": "1px solid rgba(127,127,127,0.18)" }}>
                  <table style={{ width: "100%", "border-collapse": "collapse", "font-size": "12px" }}>
                    <thead style={{ position: "sticky", top: 0, background: "var(--v2-background-bg-layer-01, #242424)", "z-index": 1 }}>
                      <tr style={{ "text-align": "left", ...muted }}>
                        <th style={{ ...headerCell, padding: "8px 14px" }}>{t("commandcode.model")}</th>
                        <th style={headerCell}>{t("commandcode.group")}</th>
                        <th style={headerCell}>{t("commandcode.context")}</th>
                        <th style={headerCell}>{t("commandcode.output")}</th>
                        <th style={{ ...headerCell, padding: "8px 14px" }}>{t("commandcode.effort")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={filtered()}>
                        {(model) => (
                          <tr style={{ "border-top": "1px solid rgba(127,127,127,0.12)" }}>
                            <td style={{ padding: "7px 14px" }}>
                              <div style={{ "font-weight": 550 }}>{model.name}</div>
                              <div style={{ ...muted, "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace", "font-size": "10px" }}>
                                {model.id}
                              </div>
                            </td>
                            <td style={{ padding: "7px 8px", opacity: 0.75 }}>{model.group}</td>
                            <td style={{ padding: "7px 8px", opacity: 0.75 }}>{tokens(model.contextWindow)}</td>
                            <td style={{ padding: "7px 8px", opacity: 0.75 }}>{tokens(model.maxOutputTokens)}</td>
                            <td style={{ padding: "7px 14px", opacity: 0.75 }}>
                              {model.reasoning.length > 0 ? model.reasoning.join(" · ") : "—"}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <Show when={filtered().length === 0}>
                    <div style={{ padding: "18px 14px", ...muted, "font-size": "12px" }}>
                      {t("commandcode.noModels")}
                    </div>
                  </Show>
                </div>
              </div>

              <div style={{ ...muted, "font-size": "11px", display: "flex", "flex-wrap": "wrap", gap: "12px" }}>
                <span>{t("commandcode.source")}: {snapshot.auth.source}{snapshot.auth.path ? ` (${snapshot.auth.path})` : ""}</span>
                <span>{snapshot.baseURL}</span>
                <span>{t("commandcode.cache")}: {snapshot.catalog.source}</span>
                <Show when={snapshot.sync.state !== "idle"}>
                  <span>
                    {t("commandcode.sync")}: {snapshot.sync.state} (+{snapshot.sync.added} / -{snapshot.sync.removed} / ~{snapshot.sync.updated})
                  </span>
                </Show>
              </div>
            </div>
          )
        })()}
      </Show>
    </div>
  )
}

export default Plugin.define({
  i18n: {
    en: {
      "commandcode.title": "Command Code",
      "commandcode.subtitle": "Plan-aware models, quota and live catalog",
      "commandcode.refresh": "Refresh",
      "commandcode.refreshing": "Refreshing…",
      "commandcode.loading": "Loading Command Code status…",
      "commandcode.plan": "Plan",
      "commandcode.credits": "Credits left",
      "commandcode.models": "Models",
      "commandcode.modelsHint": "{total} models in the live catalog",
      "commandcode.updated": "Updated",
      "commandcode.apiKey": "API key",
      "commandcode.apiKeyHint": "Use this instead of the Command Code CLI login. Stored locally in OpenCode plugin storage.",
      "commandcode.apiKeyPlaceholder": "Command Code API key",
      "commandcode.apiKeySave": "Save key",
      "commandcode.apiKeySaving": "Saving…",
      "commandcode.apiKeyClear": "Clear saved key",
      "commandcode.apiKeySaved": "API key saved; catalog refreshed.",
      "commandcode.apiKeyRejected": "Command Code did not accept this key.",
      "commandcode.apiKeyCleared": "Saved key removed; using the CLI login or environment.",
      "commandcode.apiKeyCurrent": "Current source: {source}",
      "commandcode.windows": "Usage windows",
      "commandcode.fiveHour": "5 hours",
      "commandcode.weekly": "Weekly",
      "commandcode.monthly": "Monthly",
      "commandcode.catalog": "Catalog",
      "commandcode.catalogHint": "{count} usable · {total} in catalog",
      "commandcode.search": "Search models",
      "commandcode.model": "Model",
      "commandcode.group": "Group",
      "commandcode.context": "Context",
      "commandcode.output": "Output",
      "commandcode.effort": "Reasoning",
      "commandcode.noModels": "No models match this search.",
      "commandcode.source": "Auth",
      "commandcode.cache": "Catalog source",
      "commandcode.sync": "Last sync",
      "commandcode.ends": "Ends {date}",
      "commandcode.renews": "Renews {date}",
      "commandcode.creditsHint": "Purchased {purchased} · Free {free}",
    },
    vi: {
      "commandcode.title": "Command Code",
      "commandcode.subtitle": "Model theo plan, quota và catalog trực tiếp",
      "commandcode.refresh": "Làm mới",
      "commandcode.refreshing": "Đang làm mới…",
      "commandcode.loading": "Đang tải trạng thái Command Code…",
      "commandcode.plan": "Gói",
      "commandcode.credits": "Credit còn lại",
      "commandcode.models": "Model",
      "commandcode.modelsHint": "{total} model trong catalog trực tiếp",
      "commandcode.updated": "Cập nhật",
      "commandcode.apiKey": "API key",
      "commandcode.apiKeyHint": "Dùng key này thay cho login Command Code CLI. Key được lưu cục bộ trong plugin storage của OpenCode.",
      "commandcode.apiKeyPlaceholder": "Nhập Command Code API key",
      "commandcode.apiKeySave": "Lưu key",
      "commandcode.apiKeySaving": "Đang lưu…",
      "commandcode.apiKeyClear": "Xóa key đã lưu",
      "commandcode.apiKeySaved": "Đã lưu API key và refresh catalog.",
      "commandcode.apiKeyRejected": "Command Code không chấp nhận key này.",
      "commandcode.apiKeyCleared": "Đã xóa key đã lưu; quay lại dùng CLI login hoặc environment.",
      "commandcode.apiKeyCurrent": "Nguồn hiện tại: {source}",
      "commandcode.windows": "Hạn mức sử dụng",
      "commandcode.fiveHour": "5 giờ",
      "commandcode.weekly": "Tuần",
      "commandcode.monthly": "Tháng",
      "commandcode.catalog": "Danh sách model",
      "commandcode.catalogHint": "{count} model dùng được · {total} trong catalog",
      "commandcode.search": "Tìm model",
      "commandcode.model": "Model",
      "commandcode.group": "Nhóm",
      "commandcode.context": "Context",
      "commandcode.output": "Output",
      "commandcode.effort": "Reasoning",
      "commandcode.noModels": "Không có model khớp.",
      "commandcode.source": "Xác thực",
      "commandcode.cache": "Nguồn catalog",
      "commandcode.sync": "Đồng bộ",
      "commandcode.ends": "Kết thúc {date}",
      "commandcode.renews": "Gia hạn {date}",
      "commandcode.creditsHint": "Đã mua {purchased} · Free {free}",
    },
  },
  setup(ctx) {
    ctx.add(SettingsPage, () => ({
      id: "commandcode",
      title: ctx.t("commandcode.title"),
      entries: [
        { id: "overview", title: ctx.t("commandcode.title"), description: ctx.t("commandcode.subtitle") },
        { id: "models", title: ctx.t("commandcode.catalog"), description: ctx.t("commandcode.search") },
      ],
      render: () => <Page ctx={ctx} />,
    }))
  },
})

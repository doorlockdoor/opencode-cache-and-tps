/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Message, AssistantMessage } from "@opencode-ai/sdk"
import { createMemo, createSignal, createEffect, onMount, onCleanup, Show, For, untrack } from "solid-js"
import { PLUGIN_VERSION } from "../_version"
import { balanceProviders, getBalanceProvider, type BalanceDetail, type BalanceDetailKey, type BalanceEntry, type BalanceProvider } from "../balance-providers"
import { createT, type Translation } from "../i18n"
import { num } from "../tokens"
import { aggregatePerf, currentModelKey, EMPTY_PERF, type PerfStats } from "../perf"
import { collectTokenDist, type TokenDist } from "../dist"
import { collectUsage } from "../stats"
import { shallowEqual, createThrottledBumper } from "../util"
import { FALLBACK, MAX_SAT, desaturateTo, dimColor, fmt, fmtCost, fmtMs, progressBar, truncateVisual, visualWidth, visualPadEnd } from "../ui"
import { formatBalanceText } from "../currency"
import { KV_PREFIX, type PanelApi, type PanelSignals } from "./panel-api"

const MIN_PANEL_WIDTH = 20
// part 事件 → data 重算的节流间隔（前沿+尾沿）：重算上限 10Hz，延迟 ≤100ms
const PART_THROTTLE_MS = 100
const DEFAULT_PANEL_WIDTH = 26

/** ── layout measurement constants (visual columns) ── */
const LABEL_GAP = 1        // label（如 "Hit"）后面的空格
const BAR_BRACKETS = 2     // "[" + "]" 包围进度条
const BAR_GAP = 1          // "]" 后面的空格
const PCT_FIXED_WIDTH = 5  // "XX.X%" 固定 5 字符宽度
const HEADER_PREFIX = 2    // 折叠态标题行：▶/▼ 图标 + 后面的空格
const UNIT_GAP = 1         // 计量单位前的空格（如 "tok"）

const BALANCE_DETAIL_LABELS: Record<BalanceDetailKey, keyof Translation> = {
  plan: "balDetailPlan",
  used: "balDetailUsed",
  remaining: "balDetailRemaining",
  window: "balDetailWindow",
  reset: "balDetailReset",
  codeReview: "balDetailCodeReview",
  credits: "balDetailCredits",
  resetCredits: "balDetailResetCredits",
}

export function TokenCachePanel(props: {
  theme: TuiThemeCurrent
  api: PanelApi
  sessionId: string
  signals: PanelSignals
}): JSX.Element {
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(true)
  const [detailOpen, setDetailOpen] = createSignal(true)
  const [modelOpen, setModelOpen] = createSignal(true)
  const [distOpen, setDistOpen] = createSignal(false)
  const [skillsOpen, setSkillsOpen] = createSignal(true)
  const [perfOpen, setPerfOpen] = createSignal(true)
  const [balanceOpen, setBalanceOpen] = createSignal(false)
  let boxEl: any

  // 侧边栏可见性通知：本面板挂载 ⇒ 宿主侧边栏可见（固定占用 42 列输入框宽度）
  createEffect(() => {
    props.signals.setSidebarVisible(true)
    onCleanup(() => props.signals.setSidebarVisible(false))
  })

  // ── shared signals (de-structured so internal code is unchanged) ──
  const {
    currencySymbol, setCurrencySymbol,
    exchangeRate, setExchangeRate,
    langCode,
    sectionDetail, setSectionDetail,
    sectionModel, setSectionModel,
    sectionDist, setSectionDist,
    sectionSkills, setSectionSkills,
    sectionPerf, setSectionPerf,
    perfModelFilter, setPerfModelFilter,
    sectionBalance, setSectionBalance,
    balanceRefresh,
    balanceProviderId, setBalanceProviderId,
    setAutoBalance,
    balanceUnsupported, setBalanceUnsupported,
    balanceState,
    balanceCurrency, setBalanceCurrency,
    borderVisible, setBorderVisible,
  } = props.signals

  // ── reactive translation (follows langCode signal) ──
  const t = createT(() => langCode())

  const formatBalanceDuration = (seconds: number, fallback = ""): string => {
    if (!Number.isFinite(seconds)) return ""
    let remaining = Math.max(0, Math.round(seconds))
    const days = Math.floor(remaining / 86400)
    remaining %= 86400
    const hours = Math.floor(remaining / 3600)
    remaining %= 3600
    const minutes = Math.floor(remaining / 60)
    const parts: string[] = []
    if (days > 0) parts.push(`${days}${t("balDay")}`)
    if (hours > 0 && parts.length < 2) parts.push(`${hours}${t("balHour")}`)
    if (minutes > 0 && parts.length < 2) parts.push(`${minutes}${t("balMinute")}`)
    return parts.join(langCode() === "en" ? " " : "") || fallback
  }

  const formatBalanceDetailValue = (detail: BalanceDetail): string => {
    if (detail.value === "unlimited") return t("balUnlimited")
    if (detail.key !== "reset") return detail.value
    return formatBalanceDuration(Number(detail.value), t("balResetSoon")) || detail.value
  }

  const formatBalanceDetailLabel = (detail: BalanceDetail): string => {
    const label = t(BALANCE_DETAIL_LABELS[detail.key])
    if (detail.windowSeconds === undefined) return label
    const window = formatBalanceDuration(detail.windowSeconds)
    return window ? `${label} (${window})` : label
  }

  // ── scan session messages reactively ──
  // SolidJS createMemo re-evaluates whenever the underlying
  // api.state.session state changes — no event listener needed.

  // ── distribution cache ────────────────────────────────────────
  // When data() re-computes before api.state.part() is warm (e.g. after
  // a view switch), hasDistData flips to false and the distribution
  // block disappears.  Keep the last valid snapshot so the UI stays
  // stable until the next successful computation arrives.
  const [lastDist, setLastDist] = createSignal<TokenDist>({
    system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0,
    output: 0, reasoning: 0, apiOutput: 0, apiInput: 0, stepCost: 0, stepCount: 0,
  })
  const [lastHasDist, setLastHasDist] = createSignal(false)

  // ── performance snapshot ──────────────────────────────────────
  // 与 dist 相同的防闪烁策略：part() 重新水合前 hasPerf 短暂翻 false；
  // 保留最近有效性能聚合与 KV 快照让 UI 稳定；lastPerfModelKey 记录快照的
  // 过滤上下文（null=全局，模型切换后旧快照不复用）。
  const [lastPerf, setLastPerf] = createSignal<PerfStats>({ ...EMPTY_PERF })
  const [lastHasPerf, setLastHasPerf] = createSignal(false)
  const [lastPerfModelKey, setLastPerfModelKey] = createSignal<string | null>(null)

  const [dataSignal, setDataSignal] = createSignal<any>({
    hitRate: 0, read: 0, write: 0, freshInput: 0, output: 0,
    cost: 0, saved: 0, model: "", inputRate: 0, cacheReadRate: 0, cacheWriteRate: 0,
    hasPricing: false, hasData: false, trend: 0, hasTrendData: false,
    providerName: "", sessionHitRate: 0,
    dist: { system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0, output: 0, reasoning: 0, apiOutput: 0, apiInput: 0, stepCost: 0, stepCount: 0 },
    hasDistData: false,
    perf: { ...EMPTY_PERF },
    hasPerf: false,
    perfCtx: "",
    skills: [] as { name: string; tokens: number }[],
    hasSkills: false,
  })
  const [refreshTick, setRefreshTick] = createSignal(0)
  // ── token distribution (in-process via api.state.part) ──
  const [partVersion, setPartVersion] = createSignal(0)

  // 当前 provider 显示名（余额查询状态为共享信号，见 PanelSignals.balanceState）
  const providerName = createMemo(() => getBalanceProvider(balanceProviderId()).name)

  // 自动切换余额 provider 已移到各壳的常驻层（V1: tui()；V2: app 插槽 RuntimeRoot），
  // 避免侧边栏隐藏时失效；唯一实现在 src/balance.ts 的 syncAutoBalance。
  // override 的自动清理同样在常驻层（V2 RuntimeRoot / V1 sidebar slot）。

  createEffect(() => {
    const sid = props.signals.overrideSessionId() ?? props.sessionId
    // 双通道驱动：partVersion（part/消息事件）承担高频增量；refreshTick（仅
    // session.updated）承担 session 级聚合变化。重算成本已由 dist.ts 指纹缓存
    // 摊平，但节流仍是第一道闸（聚合循环本身 O(消息数)，不必跑在事件频率上）。
    void refreshTick()
    void partVersion()

    // 自然追踪 messages 和 provider（SDK 数据就绪时自动重新执行）
    const msgs = props.api.state.session.messages(sid) as Message[]
    const session = typeof props.api.state.session.get === "function"
      ? props.api.state.session.get(sid)
      : undefined

    // 性能过滤：开关在 effect 外读取（响应式，切换即重算）；上下文键为当前
    // 模型指纹，空串表示全局不过滤（含开关开启但模型不可知的退化）。
    const perfFilterOn = props.signals.perfModelFilter()
    const perfCtxKey = perfFilterOn ? (currentModelKey(props.api, sid) ?? "") : ""

    // 用量/命中率统一口径（src/stats.ts）：累计优先 Session 聚合字段，
    // 缺失（旧版 SDK）降级为消息遍历累加；命中率取最后两条有 token 的消息。
    const usage = collectUsage(msgs, session)
    const { input, read, write, output, cost } = usage
    const pid = usage.providerID, mid = usage.modelID

    let saved = 0, inputRate = 0, cacheReadRate = 0, cacheWriteRate = 0
    if (read > 0 && pid && mid && Array.isArray(props.api.state.provider)) for (const provider of props.api.state.provider) {
      if (provider.id !== pid) continue
      const model = provider.models[mid]; if (!model?.cost) continue
      inputRate = num(model.cost.input); cacheReadRate = num(model.cost.cache?.read); cacheWriteRate = num(model.cost.cache?.write)
      if (inputRate > cacheReadRate) saved = (read * (inputRate - cacheReadRate)) / 1_000_000
      break
    }
    // 面板内部口径：无命中率数据时按 0 展示（底栏用 -1 表示无数据）
    const hitRate = usage.hitRate >= 0 ? usage.hitRate : 0
    // 总命中率分母含缓存写（业界口径：read / (input+read+write)）
    const freshTotal = input + read + write, sessionHitRate = freshTotal > 0 ? (read / freshTotal) * 100 : 0
    const model = mid.split("/").pop() ?? mid, hasPricing = inputRate > 0 || cacheReadRate > 0 || cacheWriteRate > 0
    const hasTrendData = usage.hasTrend
    const trend = hasTrendData ? usage.hitRate - usage.prevHitRate : 0, providerName = pid || ""

    // untrack 只包裹已知触发死锁的 API；分布/性能聚合已抽为纯函数，回退快照
    // 同样只在 untrack 内读取（避免响应式依赖成环）。
    const distData = untrack(() => {
      try {
        const { dist, hasDistData, skills } = collectTokenDist(props.api, msgs, session)
        const perf = aggregatePerf(props.api, msgs, { modelKey: perfCtxKey || undefined })
        // 回退快照的有效性取决于过滤上下文：上下文一致时（part() 重新水合等
        // 瞬态）沿用最近有效快照保持面板稳定；模型切换后上下文变化即不复用。
        // perfCtxKey ""=全局（null 键）。
        const snapKey = perfCtxKey || null
        const fallbackOk = perf.hasPerf || (lastPerfModelKey() === snapKey && lastHasPerf())
        return {
          finalDist: hasDistData ? dist : lastDist(), finalHasDist: hasDistData || lastHasDist(),
          finalPerf: fallbackOk ? (perf.hasPerf ? perf : lastPerf()) : EMPTY_PERF,
          finalHasPerf: fallbackOk,
          perfCtx: perfCtxKey,
          skills,
        }
      } catch {
        // SDK 形状漂移等意外错误：回落最近一次有效快照，保持面板稳定
        return {
          finalDist: lastDist(), finalHasDist: lastHasDist(),
          finalPerf: lastPerf(), finalHasPerf: lastHasPerf(),
          perfCtx: "",
          skills: [] as { name: string; tokens: number }[],
        }
      }
    })

    setDataSignal({
      hitRate, read, write, freshInput: input, output, cost, saved, model,
      inputRate, cacheReadRate, cacheWriteRate, hasPricing,
      hasData: read > 0 || write > 0 || input > 0 || output > 0 || cost > 0,
      trend, hasTrendData, providerName, sessionHitRate,
      dist: distData.finalDist, hasDistData: distData.finalHasDist,
      perf: distData.finalPerf, hasPerf: distData.finalHasPerf,
      perfCtx: distData.perfCtx,
      skills: distData.skills, hasSkills: distData.skills.length > 0,
    })
  })

  const data = createMemo(() => {
    return dataSignal()
  })

  const balanceDetails = createMemo(() => balanceState().data?.find((entry) => entry.details)?.details ?? [])

  // Persist the last valid distribution so that data() can fall back
  // to it while api.state.part() is re-hydrating after a view switch.
  // 浅比较去重：内容多数不变时跳过信号写入与 KV 快照（lastDist 读取在 untrack 内）。
  createEffect(() => {
    const d = data()
    if (d.hasDistData && !untrack(() => shallowEqual(lastDist(), d.dist))) {
      setLastDist({ ...d.dist })
      setLastHasDist(true)
      // Also persist across component remounts (view switches)
      try { props.api.kv.set(`${KV_PREFIX}.dist_snapshot`, { ...d.dist }) } catch {}
    }
    if (d.hasPerf && !untrack(() => shallowEqual(lastPerf(), d.perf) && lastPerfModelKey() === (d.perfCtx || null))) {
      setLastPerf({ ...d.perf })
      setLastPerfModelKey(d.perfCtx || null)
      setLastHasPerf(true)
      // 快照携带过滤上下文：不同模型（或全局⇄过滤）的缓存不互相污染
      try { props.api.kv.set(`${KV_PREFIX}.perf_snapshot`, { ...d.perf, modelKey: d.perfCtx || null }) } catch {}
    }
  })

  // Persist fold state to api.kv
  const persistFold = (key: string, val: boolean) => {
    try { props.api.kv.set(`${KV_PREFIX}.${key}`, val) } catch {}
  }

  onMount(() => {
    // Reset panelWidth on (re)mount so the layout uses a clean
    // default until onSizeChange measures the live box dimensions.
    setPanelWidth(DEFAULT_PANEL_WIDTH)

    // Restore fold state from persisted storage (non-critical — fire and forget)
    try {
      setOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.open`, false)))
      setDetailOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.detail`, true)))
      setModelOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.model`, true)))
      setDistOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.dist`, false)))
      setSkillsOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.skills`, true)))
      setPerfOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.perf`, true)))
      setBalanceOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.balance.open`, false)))
    } catch {}

    // Restore user config (currency, rate, section visibility).
    // Try synchronously first (kv is usually ready on mount), fall back to
    // polling if the module was reloaded and kv hasn't initialised yet.
    const doRestore = () => {
      try {
        const sym = props.api.kv.get<string>(`${KV_PREFIX}.currency`)
        const rate = props.api.kv.get<number>(`${KV_PREFIX}.rate`)
        if (typeof sym === "string") setCurrencySymbol(sym)
        if (typeof rate === "number" && rate > 0) setExchangeRate(rate)
        const balCur = props.api.kv.get<string>(`${KV_PREFIX}.balance_currency`)
        if (typeof balCur === "string") setBalanceCurrency(balCur)
        // Restore balance provider (fall back to default when unknown)
        const savedProvider = props.api.kv.get<string>(`${KV_PREFIX}.balance.provider`)
        if (typeof savedProvider === "string" && balanceProviders.some((p) => p.id === savedProvider)) {
          setBalanceProviderId(savedProvider)
          setBalanceUnsupported(false)
        }
        // Restore auto-switch (default on)
        const savedAuto = props.api.kv.get<boolean>(`${KV_PREFIX}.balance.auto`)
        if (typeof savedAuto === "boolean") setAutoBalance(savedAuto)
        // Migrate legacy DeepSeek key (cache_panel.ds_key → cache_panel.balance.deepseek.key)
        const legacyKey = props.api.kv.get<string>(`${KV_PREFIX}.ds_key`, "")
        if (legacyKey) {
          const dsKey = props.api.kv.get<string>(`${KV_PREFIX}.balance.deepseek.key`, "")
          if (!dsKey) props.api.kv.set(`${KV_PREFIX}.balance.deepseek.key`, legacyKey)
          props.api.kv.set(`${KV_PREFIX}.ds_key`, "")
        }
        // 恢复的 provider 可能与默认值不同，强制重新查询
        props.signals.setBalanceRefresh(props.signals.balanceRefresh() + 1)
        setSectionDetail(Boolean(props.api.kv.get(`${KV_PREFIX}.section.detail`, true)))
        setSectionModel(Boolean(props.api.kv.get(`${KV_PREFIX}.section.model`, true)))
        setSectionDist(Boolean(props.api.kv.get(`${KV_PREFIX}.section.dist`, true)))
        setSectionSkills(Boolean(props.api.kv.get(`${KV_PREFIX}.section.skills`, true)))
        setSectionPerf(Boolean(props.api.kv.get(`${KV_PREFIX}.section.perf`, true)))
        setSectionBalance(Boolean(props.api.kv.get(`${KV_PREFIX}.section.balance`, true)))
        const bv = props.api.kv.get<boolean>(`${KV_PREFIX}.border`, true)
        setBorderVisible(bv !== false)
        // Restore distribution snapshot so the token distribution block
        // doesn't blank out while api.state.part() re-hydrates.
        const cachedDist = props.api.kv.get<TokenDist>(`${KV_PREFIX}.dist_snapshot`)
        if (cachedDist) {
          setLastDist(cachedDist)
          setLastHasDist(true)
        }
        const cachedPerf = props.api.kv.get<PerfStats & { modelKey?: string | null }>(`${KV_PREFIX}.perf_snapshot`)
        if (cachedPerf) {
          setLastPerf({ ...EMPTY_PERF, ...cachedPerf })
          setLastPerfModelKey(cachedPerf.modelKey || null)
          setLastHasPerf(true)
        }
        // Restore performance model-filter preference (default: on)
        const savedPerfFilter = props.api.kv.get<boolean>(`${KV_PREFIX}.perf_model_filter`, true)
        setPerfModelFilter(savedPerfFilter !== false)
      } catch {
        // kv read failed — signals stay at defaults
      }
      // Re-measure panel width after config signals have settled
      if (boxEl && typeof boxEl.width === "number" && boxEl.width > 0) {
        setPanelWidth(Math.max(MIN_PANEL_WIDTH, boxEl.width))
      }
    }

    if (props.api.kv.ready) {
      doRestore()
    } else {
      // Poll kv.ready with a 1-second timeout to avoid infinite busy-wait
      // on platforms where kv initialisation may be delayed (Linux single-thread
      // mode, session switch storms, etc.).
      const MAX_POLL = 100
      let tries = 0
      const pollRestore = () => {
        if (!props.api.kv.ready) {
          if (++tries > MAX_POLL) { doRestore(); return }
          setTimeout(pollRestore, 10)
          return
        }
        doRestore()
      }
      pollRestore()
    }

    // part/msg 事件 → partVersion（前沿+尾沿节流 100ms）：突发流式期间重算
    // 钳到 ≤10Hz，首事件立即生效；refreshTick 仅由 session.updated 驱动
    // （session 聚合 tokens/model 变化，step 级频率，不构成热点）。
    const bumper = createThrottledBumper(() => setPartVersion((v) => v + 1), PART_THROTTLE_MS)
    const unsubPart = props.api.event.on("message.part.updated", bumper.bump)
    const unsubMsg = props.api.event.on("message.updated", bumper.bump)
    const unsubSession = props.api.event.on("session.updated", () => { setRefreshTick(v => v + 1) })
    setRefreshTick(v => v + 1)
    onCleanup(() => { bumper.dispose(); unsubPart(); unsubMsg(); unsubSession() })
  })

  // ── colours ──
  // Pull from the current theme, auto-desaturate if too punchy,
  // fall back to Morandi when a key is missing from the theme.
  const pal = createMemo(() => {
    const t = props.theme as Record<string, unknown>
    const sat = (k: string, fb: string) => desaturateTo(t[k], MAX_SAT, fb)
    return {
      primary:   sat("primary",   FALLBACK.primary),
      text:      sat("text",      FALLBACK.text),
      muted:     sat("textMuted", FALLBACK.muted),
      success:   sat("success",   FALLBACK.success),
      warning:   sat("warning",   FALLBACK.warning),
      error:     sat("error",     FALLBACK.error),
      border:    sat("border",    FALLBACK.border),
    }
  })

  const hitColor = createMemo(() => {
    const r = data().hitRate
    if (r >= 85) return pal().success
    if (r >= 70) return pal().warning
    return pal().error
  })

  /** Horizontal space eaten by border (1+1 when visible) + padding (2+2 when visible). */
  const gutter = createMemo(() => borderVisible() ? 6 : 0)

  const sep = createMemo(() => "\u2500".repeat(Math.max(1, panelWidth() - gutter())))
  function trendLabel(t: number): string {
    // |t| < 0.05 视为无变化：避免显示 "↑0.0%" 的矛盾（箭头存在但数值截断为零）
    if (Math.abs(t) < 0.05) return "-"
    return (t > 0 ? "\u2191" : "\u2193") + Math.abs(t).toFixed(1) + "%"
  }

  const barW = createMemo(() => {
    const trendSpace = data().hasTrendData ? LABEL_GAP + visualWidth(trendLabel(data().trend)) : 0
    const overhead = visualWidth(t("hit")) + LABEL_GAP + BAR_BRACKETS + BAR_GAP + PCT_FIXED_WIDTH + trendSpace + gutter()
    return Math.max(3, panelWidth() - overhead)
  })
  const bar = createMemo(() => progressBar(data().hitRate, barW()))
  const pct = createMemo(() => (Math.floor(data().hitRate * 10) / 10).toFixed(1) + "%")

  // When border visibility changes the box dimensions shift, which
  // may not reliably trigger onSizeChange across (re)mount cycles.
  // Force panelWidth to resync with the live box after every change.
  createEffect(() => {
    borderVisible()
    if (boxEl && typeof boxEl.width === "number" && boxEl.width > 0) {
      const w = Math.max(MIN_PANEL_WIDTH, boxEl.width)
      setPanelWidth((prev) => (prev === w ? prev : w))
    }
  })

  // left-align label, right-align value — auto-fill space between
  const justify = (label: string, value: string, unit = ""): string => {
    const gauge = panelWidth() - gutter()
    const used = visualWidth(label) + visualWidth(value) + (unit ? visualWidth(unit) + UNIT_GAP : 0)
    const gap = Math.max(1, gauge - used)
    return label + " ".repeat(gap) + value + (unit ? " " + unit : "")
  }

  // ── performance rows ──
  // 每行 "标签: 最近值 (中 中位数)"，仅精确口径（请求结束后随精确数据刷新）；
  // 面板过窄放不下中位段时自动省略，保证标签与最近值始终完整显示。
  const perfRow = (label: string, lastStr: string, medStr: string | null): string => {
    const gauge = panelWidth() - gutter()
    let value = lastStr
    if (medStr) {
      const suffix = " (" + medStr + ")"
      if (visualWidth(label) + visualWidth(lastStr + suffix) + 1 <= gauge) {
        value = lastStr + suffix
      }
    }
    return justify(label, value)
  }

  // 延迟行：单次请求完成后才有值
  const latRow = createMemo<string | null>(() => {
    const p = data().perf
    if (p.latLast === null) return null
    return perfRow(t("perfLat"), fmtMs(p.latLast),
      p.latMed !== null ? t("perfAvg", { v: fmtMs(p.latMed) }) : null)
  })

  const perfRows = createMemo<string[]>(() => {
    const p = data().perf
    if (!p.hasPerf) return []
    const rows: string[] = []
    if (p.ttftLast !== null) {
      rows.push(perfRow(t("perfTTFT"), fmtMs(p.ttftLast),
        p.ttftMed !== null ? t("perfAvg", { v: fmtMs(p.ttftMed) }) : null))
    }
    if (p.tpsLast !== null) {
      rows.push(perfRow(t("perfTPS"), p.tpsLast.toFixed(1) + " " + t("tokS"),
        p.tpsMed !== null ? t("perfAvg", { v: p.tpsMed.toFixed(1) }) : null))
    }
    const lr = latRow()
    if (lr) rows.push(lr)
    return rows
  })

  const balanceHeader = () => {
    const arrow = balanceDetails().length > 0 ? (balanceOpen() ? "\u25bc " : "\u25b6 ") : ""
    const title = t("secBalance")
    const summary = balanceState().data ? formatBalanceText(balanceState().data!, balanceCurrency(), exchangeRate()) : ""
    const gauge = panelWidth() - gutter()
    const dividerLength = Math.max(1, gauge - visualWidth(arrow + title) - visualWidth(summary) - 1)
    return { arrow, title, summary, divider: sep().slice(0, dividerLength) }
  }

  return (
    <box
      border={borderVisible()}
      {...(borderVisible() ? { borderColor: pal().border } : {})}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={borderVisible() ? 2 : 0}
      paddingRight={borderVisible() ? 2 : 0}
      flexDirection="column"
      gap={0}
      ref={boxEl}
      onSizeChange={() => {
        // boxEl.width may be undefined before the first measurement — guard with 0
        const w = boxEl ? Math.max(MIN_PANEL_WIDTH, boxEl.width ?? 0) : DEFAULT_PANEL_WIDTH
        setPanelWidth((prev) => (prev === w ? prev : w))
      }}
    >
      {/* collapsible header */}
      <text onMouseUp={() => setOpen((o) => { const n = !o; persistFold("open", n); return n })}>
        <span style={{ fg: pal().muted }}>{open() ? "\u25bc " : "\u25b6 "}</span>
        <span style={{ fg: pal().primary }}>
            <b>{t("title")}</b>
            <Show when={open()}>
              <span style={{ fg: dimColor(pal().muted, 0.75) }}> v{PLUGIN_VERSION}</span>
            </Show>
          </span>
        <Show when={!open() && data().hasData}>
          <Show when={data().hasTrendData}>
            <span>
              {" ".repeat(Math.max(1, panelWidth() - gutter() - HEADER_PREFIX - visualWidth(t("title")) - visualWidth(pct() + " " + t("hitFolded") + " " + trendLabel(data().trend))))}
            </span>
            <span style={{ fg: hitColor() }}>{pct()} {t("hitFolded")}</span>
            <span style={{ fg: Math.abs(data().trend) >= 0.05 ? (data().trend > 0 ? pal().success : pal().error) : pal().text }}>
              {" "}{trendLabel(data().trend)}
            </span>
          </Show>
          <Show when={!data().hasTrendData}>
            <span>
              {" ".repeat(Math.max(1, panelWidth() - gutter() - HEADER_PREFIX - visualWidth(t("title")) - visualWidth(pct() + " " + t("hitFolded"))))}
            </span>
            <span style={{ fg: hitColor() }}>{pct()} {t("hitFolded")}</span>
          </Show>
        </Show>
      </text>

      <Show when={open()}>
        <Show when={props.signals.overrideSessionId()}>
          {(() => {
            const prefix = "  \u21b3 " + t("subPrefix")
            const maxSidW = Math.max(6, panelWidth() - visualWidth(prefix))
            return (
              <text>
                <span style={{ fg: pal().muted }}>{prefix}</span>
                <span style={{ fg: pal().text }}>{truncateVisual(props.signals.overrideSessionId()!, maxSidW)}</span>
              </text>
            )
          })()}
        </Show>
        <Show when={data().hasData} fallback={
          <>
            <text fg={pal().muted}>{sep()}</text>
            <text>
              <span style={{ fg: pal().muted }}>{"> "}</span>
              <span style={{ fg: pal().muted }}>{t("noData")}</span>
            </text>
          </>
        }>
          <text fg={pal().muted}>{sep()}</text>

          {/* hit rate + bar — inline to avoid box spacing */}
          <text>
            <span style={{ fg: pal().text }}>{t("hit")} </span>
            <span style={{ fg: hitColor() }}>[{bar()}] </span>
            <span style={{ fg: pal().text }}>{pct()}</span>
            <Show when={data().hasTrendData}>
              <span style={{ fg: Math.abs(data().trend) >= 0.05 ? (data().trend > 0 ? pal().success : pal().error) : pal().text }}>
                {" "}{trendLabel(data().trend)}
              </span>
            </Show>
          </text>

          {/* session cumulative hit rate */}
          <text fg={pal().muted}>
            {justify(t("totalHit"), (Math.floor(data().sessionHitRate * 10) / 10).toFixed(1) + "%")}
          </text>

          {/* ── detail section (collapsible, default open) ── */}
          <Show when={sectionDetail()}>
          <text onMouseUp={() => setDetailOpen((o) => { const n = !o; persistFold("detail", n); return n })}>
            <span style={{ fg: pal().muted }}>{detailOpen() ? "\u25bc " : "\u25b6 "}</span>
            <span style={{ fg: pal().primary }}><b>{t("secDetail")}</b></span>
            <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((detailOpen() ? "\u25bc " : "\u25b6 ") + t("secDetail")))}</span>
          </text>

          <Show when={detailOpen()}>
            <Show when={data().read > 0}>
              <text fg={pal().muted}>
                {justify(t("read"),  fmt(data().read),         t("tok"))}
              </text>
            </Show>
            <Show when={data().write > 0}>
              <text fg={pal().muted}>
                {justify(t("write"), fmt(data().write),        t("tok"))}
              </text>
            </Show>
            {/* 未命中 = 新鲜输入 + 缓存写（两者都未从缓存命中） */}
            <text fg={pal().muted}>
              {justify(t("miss"),  fmt(data().freshInput + data().write), t("tok"))}
            </text>
            <text fg={pal().muted}>
              {justify(t("out"),   fmt(data().output),       t("tok"))}
            </text>
            {/* 本回合多次 API 调用时才显示调用次数与末次成本（单次调用不占行） */}
            <Show when={data().dist.stepCount >= 2}>
              <text fg={pal().muted}>
                {justify(t("stepsCount", { n: data().dist.stepCount }), fmtCost(data().dist.stepCost, currencySymbol(), exchangeRate()))}
              </text>
            </Show>
            <Show when={data().saved > 0}>
              <text>
                <span style={{ fg: pal().muted }}>{t("saved")}</span>
                <span>{" ".repeat(Math.max(1, panelWidth() - gutter() - visualWidth(t("saved")) - visualWidth("~" + fmtCost(data().saved, currencySymbol(), exchangeRate()))))}</span>
                <span style={{ fg: pal().success }}>~{fmtCost(data().saved, currencySymbol(), exchangeRate())}</span>
              </text>
            </Show>
          </Show>
          </Show>

          {/* ── performance: TTFT / TPS / latency (collapsible, default open) ── */}
          <Show when={sectionPerf()}>
          <Show when={data().hasPerf}>
            {<text onMouseUp={() => setPerfOpen((o) => { const n = !o; persistFold("perf", n); return n })}>
              <span style={{ fg: pal().muted }}>{perfOpen() ? "\u25bc " : "\u25b6 "}</span>
              <span style={{ fg: pal().primary }}><b>{t("secPerf")}</b></span>
              <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((perfOpen() ? "\u25bc " : "\u25b6 ") + t("secPerf")))}</span>
            </text>}
            <Show when={perfOpen()}>
              <For each={perfRows()}>
                {(row) => <text fg={pal().muted}>{row}</text>}
              </For>
            </Show>
          </Show>
          </Show>

          {/* ── model section (collapsible, default open) ── */}
          <Show when={sectionModel()}>
          {<text onMouseUp={() => setModelOpen((o) => { const n = !o; persistFold("model", n); return n })}>
            <span style={{ fg: pal().muted }}>{modelOpen() ? "\u25bc " : "\u25b6 "}</span>
            <span style={{ fg: pal().primary }}><b>{t("secModel")}</b></span>
            <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((modelOpen() ? "\u25bc " : "\u25b6 ") + t("secModel")))}</span>
          </text>}

          <Show when={modelOpen()}>
            <text fg={pal().text}>
              {justify(t("cost"),  fmtCost(data().cost, currencySymbol(), exchangeRate()))}
            </text>
            <Show when={data().providerName}>
              <text fg={pal().muted}>
                {justify(t("provider"), data().providerName)}
              </text>
            </Show>
            <text fg={pal().muted}>
              {justify(t("model"), data().model)}
            </text>
            <Show when={data().hasPricing}>
              <text fg={pal().muted}>
                {justify(t("rate"), currencySymbol() + (data().inputRate * exchangeRate()).toFixed(2) + "/M " + t("inputRate"))}
              </text>
              <Show when={data().cacheReadRate > 0}>
                <text fg={pal().muted}>
                  {justify("", currencySymbol() + (data().cacheReadRate * exchangeRate()).toFixed(2) + "/M " + t("cacheRate"))}
                </text>
              </Show>
              <Show when={data().cacheWriteRate > 0}>
                <text fg={pal().muted}>
                  {justify("", currencySymbol() + (data().cacheWriteRate * exchangeRate()).toFixed(2) + "/M " + t("writeRate"))}
                </text>
            </Show>
          </Show>
          </Show>
        </Show>

          {/* ── token distribution (collapsible, default closed) ── */}
          <Show when={sectionDist()}>
          <Show when={data().hasDistData}>
            {<text onMouseUp={() => setDistOpen((o) => { const n = !o; persistFold("dist", n); return n })}>
              <span style={{ fg: pal().muted }}>{distOpen() ? "\u25bc " : "\u25b6 "}</span>
              <span style={{ fg: pal().primary }}><b>{t("distTitle")}</b></span>
              <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((distOpen() ? "\u25bc " : "\u25b6 ") + t("distTitle")))}</span>
            </text>}
            <Show when={distOpen()}>
            <Show when={data().dist.system > 0}>
              <text fg={pal().muted}>
                {justify(t("distSys"), fmt(data().dist.system), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.user > 0}>
              <text fg={pal().muted}>
                {justify(t("distUser"), fmt(data().dist.user), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.agent > 0}>
              <text fg={pal().muted}>
                {justify(t("distAgent"), fmt(data().dist.agent), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.toolCall > 0}>
              <text fg={pal().muted}>
                {justify(t("distTool"), fmt(data().dist.toolCall), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.toolResult > 0}>
              <text fg={pal().muted}>
                {justify(t("distRes"), fmt(data().dist.toolResult), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.reasoning > 0}>
              <text fg={pal().muted}>
                {justify(t("distReason"), fmt(data().dist.reasoning), t("tok"))}
              </text>
            </Show>
            </Show>
          </Show>
          </Show>

          {/* ── loaded skills (collapsible, default open) ── */}
          <Show when={sectionSkills()}>
          <Show when={data().hasSkills}>
            {<text onMouseUp={() => setSkillsOpen((o) => { const n = !o; persistFold("skills", n); return n })}>
              <span style={{ fg: pal().muted }}>{skillsOpen() ? "\u25bc " : "\u25b6 "}</span>
              <span style={{ fg: pal().primary }}><b>{t("secSkills")}</b></span>
              <span style={{ fg: pal().muted }}> ({data().skills.length})</span>
              <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((skillsOpen() ? "\u25bc " : "\u25b6 ") + t("secSkills") + ` (${data().skills.length})`))}</span>
            </text>}
            <Show when={skillsOpen()}>
                {data().skills.map((sk: { name: string; tokens: number }) => {
                  const rightW = visualWidth(fmt(sk.tokens)) + UNIT_GAP + visualWidth(t("tok"))
                  const maxLabel = Math.max(4, panelWidth() - gutter() - rightW - 1)
                  const label = truncateVisual(sk.name, maxLabel)
                  return (
                    <text fg={pal().muted}>
                      {justify(label, fmt(sk.tokens), t("tok"))}
                    </text>
                  )
                })}
            </Show>
          </Show>
          </Show>

          {/* ── provider balance (single line) ── */}
          <Show when={sectionBalance()}>
            <Show when={balanceUnsupported()}>
              <text fg={pal().muted}>
                <span style={{ fg: pal().muted }}>{"> "}</span>
                <span>{t("balUnsupported")}</span>
              </text>
            </Show>
            <Show when={!balanceUnsupported()}>
              <Show when={balanceState().status === "idle"}>
                <text fg={pal().muted}>
                  <span style={{ fg: pal().muted }}>{"> "}</span>
                  <span>{t("balNoKey", { p: providerName() })}</span>
                </text>
              </Show>
              <Show when={balanceState().status === "loading"}>
                <text fg={pal().muted}>
                  <span style={{ fg: pal().muted }}>{"> "}</span>
                  <span>{t("balLoading")}</span>
                </text>
              </Show>
              <Show when={balanceState().status === "error"}>
                <text fg={pal().error}>
                  <span style={{ fg: pal().muted }}>{"> "}</span>
                  <span>{(() => {
                    const code = balanceState().error
                    if (code === "401") return t("balErr401")
                    if (code === "403") return t("balErr403")
                    if (code === "EMPTY") return t("balErrEmpty")
                    if (code === "TIMEOUT") return t("balErrTimeout")
                    return t("balError") + (code ? ` (${code})` : "")
                  })()}</span>
                </text>
              </Show>
              <Show when={balanceState().status === "ok" && balanceState().data}>
                <Show when={balanceDetails().length > 0}>
                  <text fg={pal().text} onMouseUp={() => {
                    const next = !balanceOpen()
                    setBalanceOpen(next)
                    persistFold("balance.open", next)
                  }}>
                    <span style={{ fg: pal().muted }}>{balanceHeader().arrow}</span>
                    <span style={{ fg: pal().primary }}><b>{balanceHeader().title}</b></span>
                    <span style={{ fg: pal().muted }}>{balanceHeader().divider}</span>
                    <span>{" " + balanceHeader().summary}</span>
                  </text>
                  <Show when={balanceOpen()}>
                    {balanceDetails().map((detail) => (
                      <text fg={pal().muted}>
                        {justify(formatBalanceDetailLabel(detail) + ":", formatBalanceDetailValue(detail))}
                      </text>
                    ))}
                  </Show>
                </Show>
                <Show when={balanceDetails().length === 0}>
                  <text fg={pal().muted}>{sep()}</text>
                  <text fg={pal().text}>
                    {justify(t("balTotal"), formatBalanceText(balanceState().data!, balanceCurrency(), exchangeRate()))}
                  </text>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

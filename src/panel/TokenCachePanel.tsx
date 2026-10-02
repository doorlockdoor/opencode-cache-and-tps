/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Message } from "@opencode-ai/sdk"
import {
  createMemo,
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  Show,
  For,
  untrack,
} from "solid-js"
import { PLUGIN_VERSION } from "../_version"
import { getBalanceProvider, type BalanceDetail, type BalanceDetailKey } from "../balance-providers"
import { createT, type Translation } from "../i18n"
import { num } from "../tokens"
import {
  aggregateHostTps,
  aggregatePerf,
  currentModelKey,
  EMPTY_HOST_TPS,
  EMPTY_PERF,
} from "../perf"
import { collectTokenDist } from "../dist"
import { collectUsage } from "../stats"
import { createThrottledBumper } from "../util"
import {
  FALLBACK,
  MAX_SAT,
  desaturateTo,
  dimColor,
  fmt,
  fmtCost,
  fmtMs,
  progressBar,
  truncateVisual,
  visualWidth,
} from "../ui"
import { formatBalanceText } from "../currency"
import { PART_THROTTLE_MS } from "../live"
import { persistPreference } from "../preferences"
import { KV_PREFIX, type PanelApi, type PanelSignals } from "./panel-api"

const MIN_PANEL_WIDTH = 20
const DEFAULT_PANEL_WIDTH = 26

/** ── 布局测量常量（终端显示列） ── */
const LABEL_GAP = 1 // label（如 "Hit"）后面的空格
const BAR_BRACKETS = 2 // "[" + "]" 包围进度条
const BAR_GAP = 1 // "]" 后面的空格
const PCT_FIXED_WIDTH = 5 // "XX.X%" 固定 5 字符宽度
const HEADER_PREFIX = 2 // 折叠态标题行：▶/▼ 图标 + 后面的空格
const UNIT_GAP = 1 // 计量单位前的空格（如 "tok"）

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

  const {
    currencySymbol,
    exchangeRate,
    langCode,
    sectionDetail,
    sectionModel,
    sectionDist,
    sectionSkills,
    sectionPerf,
    tpsMode,
    sectionBalance,
    balanceProviderId,
    balanceUnsupported,
    balanceState,
    balanceCurrency,
    borderVisible,
  } = props.signals

  // ── 响应式翻译（跟随 langCode 信号） ──
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

  const [dataSignal, setDataSignal] = createSignal({
    hitRate: 0,
    read: 0,
    write: 0,
    freshInput: 0,
    output: 0,
    cost: 0,
    saved: 0,
    model: "",
    inputRate: 0,
    cacheReadRate: 0,
    cacheWriteRate: 0,
    hasPricing: false,
    hasData: false,
    trend: 0,
    hasTrendData: false,
    providerName: "",
    sessionHitRate: 0,
    dist: {
      system: 0,
      user: 0,
      agent: 0,
      toolCall: 0,
      toolResult: 0,
      output: 0,
      reasoning: 0,
      apiOutput: 0,
      apiInput: 0,
      stepCost: 0,
      stepCount: 0,
    },
    hasDistData: false,
    perf: { ...EMPTY_PERF },
    hostTps: { ...EMPTY_HOST_TPS },
    skills: [] as { name: string; tokens: number }[],
    hasSkills: false,
  })
  const [refreshTick, setRefreshTick] = createSignal(0)
  // ── token 分布（从 api.state.part 读取） ──
  const [partVersion, setPartVersion] = createSignal(0)

  // 当前 provider 显示名（余额查询状态为共享信号，见 PanelSignals.balanceState）
  const providerName = createMemo(() => getBalanceProvider(balanceProviderId()).name)

  // 自动切换余额 provider 已移到各壳的常驻层（V1: tui()；V2: app 插槽 RuntimeRoot），
  // 避免侧边栏隐藏时失效；唯一实现在 src/balance.ts 的 syncAutoBalance。
  // override 的自动清理同样在常驻层。

  createEffect(() => {
    const sid = props.signals.overrideSessionId() ?? props.sessionId
    // 双通道驱动：partVersion（part/消息事件）承担高频增量；refreshTick（仅
    // session.updated）承担 session 级聚合变化。重算成本已由 dist.ts 指纹缓存
    // 摊平，但节流仍是第一道闸（聚合循环本身 O(消息数)，不必跑在事件频率上）。
    void refreshTick()
    void partVersion()

    // 自然追踪 messages 和 provider（SDK 数据就绪时自动重新执行）
    const msgs = props.api.state.session.messages(sid) as Message[]
    const session =
      typeof props.api.state.session.get === "function"
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
    const pid = usage.providerID,
      mid = usage.modelID

    let saved = 0,
      inputRate = 0,
      cacheReadRate = 0,
      cacheWriteRate = 0
    if (pid && mid && Array.isArray(props.api.state.provider))
      for (const provider of props.api.state.provider) {
        if (provider.id !== pid) continue
        const model = provider.models[mid]
        if (!model?.cost) continue
        inputRate = num(model.cost.input)
        cacheReadRate = num(model.cost.cache?.read)
        cacheWriteRate = num(model.cost.cache?.write)
        if (inputRate > cacheReadRate) saved = (read * (inputRate - cacheReadRate)) / 1_000_000
        break
      }
    // 面板内部口径：无命中率数据时按 0 展示（底栏用 -1 表示无数据）
    const hitRate = usage.hitRate >= 0 ? usage.hitRate : 0
    // 总命中率分母含缓存写（业界口径：read / (input+read+write)）
    const freshTotal = input + read + write,
      sessionHitRate = freshTotal > 0 ? (read / freshTotal) * 100 : 0
    const model = mid.split("/").pop() ?? mid,
      hasPricing = inputRate > 0 || cacheReadRate > 0 || cacheWriteRate > 0
    const hasTrendData = usage.hasTrend
    const trend = hasTrendData ? usage.hitRate - usage.prevHitRate : 0,
      providerName = pid || ""

    // parts 扫描由事件驱动，不订阅每个字段的高频更新。
    const distData = untrack(() => {
      try {
        const { dist, hasDistData, skills } = collectTokenDist(props.api, msgs, session)
        const perf = aggregatePerf(props.api, msgs, { modelKey: perfCtxKey || undefined })
        // 宿主口径 TPS（体感模式）：仅消息级时间戳、与 part 水合无关，无闪烁 → 直接计算。
        // 模型过滤同精确口径：perfCtxKey 非空时按回合归属模型过滤（整回合计入/排除）。
        const hostTps = aggregateHostTps(msgs, perfCtxKey || undefined)
        return { finalDist: dist, finalHasDist: hasDistData, finalPerf: perf, hostTps, skills }
      } catch {
        // 无法读取当前数据时显示空统计，避免沿用其他会话或已撤销的数据。
        return {
          finalDist: {
            system: 0,
            user: 0,
            agent: 0,
            toolCall: 0,
            toolResult: 0,
            output: 0,
            reasoning: 0,
            apiOutput: 0,
            apiInput: 0,
            stepCost: 0,
            stepCount: 0,
          },
          finalHasDist: false,
          finalPerf: EMPTY_PERF,
          hostTps: EMPTY_HOST_TPS,
          skills: [] as { name: string; tokens: number }[],
        }
      }
    })

    setDataSignal({
      hitRate,
      read,
      write,
      freshInput: input,
      output,
      cost,
      saved,
      model,
      inputRate,
      cacheReadRate,
      cacheWriteRate,
      hasPricing,
      hasData: read > 0 || write > 0 || input > 0 || output > 0 || cost > 0,
      trend,
      hasTrendData,
      providerName,
      sessionHitRate,
      dist: distData.finalDist,
      hasDistData: distData.finalHasDist,
      perf: distData.finalPerf,
      hostTps: distData.hostTps,
      skills: distData.skills,
      hasSkills: distData.skills.length > 0,
    })
  })

  const data = createMemo(() => {
    return dataSignal()
  })

  const balanceDetails = createMemo(
    () => balanceState().data?.find((entry) => entry.details)?.details ?? [],
  )

  // 将折叠状态保存到 api.kv。
  const persistFold = (key: string, val: boolean) => {
    persistPreference(props.api, `${KV_PREFIX}.${key}`, val)
  }

  onMount(() => {
    // 挂载时重置面板宽度，先使用默认布局，
    // 待 onSizeChange 测量后再按实际尺寸显示。
    setPanelWidth(DEFAULT_PANEL_WIDTH)

    const restoreFolds = () => {
      try {
        setOpen(props.api.kv.get<boolean>(KV_PREFIX + ".open", false) === true)
        setDetailOpen(props.api.kv.get<boolean>(KV_PREFIX + ".detail", true) !== false)
        setModelOpen(props.api.kv.get<boolean>(KV_PREFIX + ".model", true) !== false)
        setDistOpen(props.api.kv.get<boolean>(KV_PREFIX + ".dist", false) === true)
        setSkillsOpen(props.api.kv.get<boolean>(KV_PREFIX + ".skills", true) !== false)
        setPerfOpen(props.api.kv.get<boolean>(KV_PREFIX + ".perf", true) !== false)
        setBalanceOpen(props.api.kv.get<boolean>(KV_PREFIX + ".balance.open", false) === true)
      } catch {
        /* 折叠偏好读取失败时保留默认值。 */
      }
    }
    if (props.api.kv.ready) restoreFolds()
    else {
      const timer = setInterval(() => {
        if (props.api.kv.ready) {
          clearInterval(timer)
          restoreFolds()
        }
      }, 10)
      onCleanup(() => clearInterval(timer))
    }

    // part/msg 事件 → partVersion（前沿+尾沿节流 100ms）：突发流式期间重算
    // 钳到 ≤10Hz，首事件立即生效；refreshTick 仅由 session.updated 驱动
    // （session 聚合 tokens/model 变化，step 级频率，不构成热点）。
    const bumper = createThrottledBumper(() => setPartVersion((v) => v + 1), PART_THROTTLE_MS)
    const unsubPart = props.api.event.on("message.part.updated", bumper.bump)
    const unsubMsg = props.api.event.on("message.updated", bumper.bump)
    const unsubSession = props.api.event.on("session.updated", () => {
      setRefreshTick((v) => v + 1)
    })
    setRefreshTick((v) => v + 1)
    onCleanup(() => {
      bumper.dispose()
      unsubPart()
      unsubMsg()
      unsubSession()
    })
  })

  // ── 配色 ──
  // 使用当前主题颜色，饱和度过高时自动降低；
  // 主题缺少对应颜色时使用莫兰迪默认色。
  const pal = createMemo(() => {
    const t = props.theme as Record<string, unknown>
    const sat = (k: string, fb: string) => desaturateTo(t[k], MAX_SAT, fb)
    return {
      primary: sat("primary", FALLBACK.primary),
      text: sat("text", FALLBACK.text),
      muted: sat("textMuted", FALLBACK.muted),
      success: sat("success", FALLBACK.success),
      warning: sat("warning", FALLBACK.warning),
      error: sat("error", FALLBACK.error),
      border: sat("border", FALLBACK.border),
    }
  })

  const hitColor = createMemo(() => {
    const r = data().hitRate
    if (r >= 85) return pal().success
    if (r >= 70) return pal().warning
    return pal().error
  })

  /** 可见边框占 1+1 列，内边距占 2+2 列。 */
  const gutter = createMemo(() => (borderVisible() ? 6 : 0))

  const sep = createMemo(() => "─".repeat(Math.max(1, panelWidth() - gutter())))
  function trendLabel(t: number): string {
    // |t| < 0.05 视为无变化：避免显示 "↑0.0%" 的矛盾（箭头存在但数值截断为零）
    if (Math.abs(t) < 0.05) return "-"
    return (t > 0 ? "↑" : "↓") + Math.abs(t).toFixed(1) + "%"
  }

  const barW = createMemo(() => {
    const trendSpace = data().hasTrendData ? LABEL_GAP + visualWidth(trendLabel(data().trend)) : 0
    const overhead =
      visualWidth(t("hit")) +
      LABEL_GAP +
      BAR_BRACKETS +
      BAR_GAP +
      PCT_FIXED_WIDTH +
      trendSpace +
      gutter()
    return Math.max(3, panelWidth() - overhead)
  })
  const bar = createMemo(() => progressBar(data().hitRate, barW()))
  const pct = createMemo(() => (Math.floor(data().hitRate * 10) / 10).toFixed(1) + "%")

  // 边框开关会改变尺寸，重新挂载时可能无法可靠触发
  // onSizeChange，因此每次切换后都重新测量，
  // 使 panelWidth 与实际宽度同步。
  createEffect(() => {
    borderVisible()
    if (boxEl && typeof boxEl.width === "number" && boxEl.width > 0) {
      const w = Math.max(MIN_PANEL_WIDTH, boxEl.width)
      setPanelWidth((prev) => (prev === w ? prev : w))
    }
  })

  // 标签左对齐，数值右对齐，中间自动补空格。
  const justify = (label: string, value: string, unit = ""): string => {
    const gauge = panelWidth() - gutter()
    const used = visualWidth(label) + visualWidth(value) + (unit ? visualWidth(unit) + UNIT_GAP : 0)
    const gap = Math.max(1, gauge - used)
    return label + " ".repeat(gap) + value + (unit ? " " + unit : "")
  }

  // ── 性能统计行 ──
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
    return perfRow(
      t("perfLat"),
      fmtMs(p.latLast),
      p.latMed !== null ? t("perfAvg", { v: fmtMs(p.latMed) }) : null,
    )
  })

  // 速度行口径由 /cache-tps 决定：体感模式且有有效回合 → 取回合聚合的宿主 TPS
  // （无有效回合——如 V1 无 streamed——回落输出速度口径）。可见性与取值共用此判定。
  const useHostTps = createMemo(() => tpsMode() === "perceived" && data().hostTps.n > 0)
  // 性能区可见性：有精确样本即显示；体感模式下即使精确样本缺失（如 v2 历史
  // 文本步无首字时间戳）但有宿主回合 TPS 时同样显示（仅速度行）。
  const perfVisible = createMemo(() => data().perf.hasPerf || useHostTps())

  const perfRows = createMemo<string[]>(() => {
    const p = data().perf
    if (!perfVisible()) return []
    const rows: string[] = []
    if (p.ttftLast !== null) {
      rows.push(
        perfRow(
          t("perfTTFT"),
          fmtMs(p.ttftLast),
          p.ttftMed !== null ? t("perfAvg", { v: fmtMs(p.ttftMed) }) : null,
        ),
      )
    }
    const host = data().hostTps
    const tpsLast = useHostTps() ? host.last : p.tpsLast
    const tpsMed = useHostTps() ? host.med : p.tpsMed
    if (tpsLast !== null) {
      rows.push(
        perfRow(
          t("perfTPS"),
          tpsLast.toFixed(1) + " " + t("tokS"),
          tpsMed !== null ? t("perfAvg", { v: tpsMed.toFixed(1) }) : null,
        ),
      )
    }
    const lr = latRow()
    if (lr) rows.push(lr)
    return rows
  })

  const balanceHeader = () => {
    const arrow = balanceDetails().length > 0 ? (balanceOpen() ? "▼ " : "▶ ") : ""
    const title = t("secBalance")
    const summary = balanceState().data
      ? formatBalanceText(balanceState().data!, balanceCurrency(), exchangeRate())
      : ""
    const gauge = panelWidth() - gutter()
    const dividerLength = Math.max(1, gauge - visualWidth(arrow + title) - visualWidth(summary) - 1)
    return { arrow, title, summary, divider: sep().slice(0, dividerLength) }
  }

  const FoldHeader = (header: {
    storageKey: string
    expanded: boolean
    toggle: (value: boolean) => void
    title: string
  }) => {
    const arrow = () => (header.expanded ? "▼ " : "▶ ")
    return (
      <text
        onMouseUp={() => {
          const next = !header.expanded
          header.toggle(next)
          persistFold(header.storageKey, next)
        }}
      >
        <span style={{ fg: pal().muted }}>{arrow()}</span>
        <span style={{ fg: pal().primary }}>
          <b>{header.title}</b>
        </span>
        <span style={{ fg: pal().muted }}>{sep().slice(visualWidth(arrow() + header.title))}</span>
      </text>
    )
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
        // 首次测量前 width 可能为空，使用 0 兜底。
        const w = boxEl ? Math.max(MIN_PANEL_WIDTH, boxEl.width ?? 0) : DEFAULT_PANEL_WIDTH
        setPanelWidth((prev) => (prev === w ? prev : w))
      }}
    >
      {/* 可折叠标题 */}
      <text
        onMouseUp={() =>
          setOpen((o) => {
            const n = !o
            persistFold("open", n)
            return n
          })
        }
      >
        <span style={{ fg: pal().muted }}>{open() ? "▼ " : "▶ "}</span>
        <span style={{ fg: pal().primary }}>
          <b>{t("title")}</b>
          <Show when={open()}>
            <span style={{ fg: dimColor(pal().muted, 0.75) }}> v{PLUGIN_VERSION}</span>
          </Show>
        </span>
        <Show when={!open() && data().hasData}>
          <Show when={data().hasTrendData}>
            <span>
              {" ".repeat(
                Math.max(
                  1,
                  panelWidth() -
                    gutter() -
                    HEADER_PREFIX -
                    visualWidth(t("title")) -
                    visualWidth(pct() + " " + t("hitFolded") + " " + trendLabel(data().trend)),
                ),
              )}
            </span>
            <span style={{ fg: hitColor() }}>
              {pct()} {t("hitFolded")}
            </span>
            <span
              style={{
                fg:
                  Math.abs(data().trend) >= 0.05
                    ? data().trend > 0
                      ? pal().success
                      : pal().error
                    : pal().text,
              }}
            >
              {" "}
              {trendLabel(data().trend)}
            </span>
          </Show>
          <Show when={!data().hasTrendData}>
            <span>
              {" ".repeat(
                Math.max(
                  1,
                  panelWidth() -
                    gutter() -
                    HEADER_PREFIX -
                    visualWidth(t("title")) -
                    visualWidth(pct() + " " + t("hitFolded")),
                ),
              )}
            </span>
            <span style={{ fg: hitColor() }}>
              {pct()} {t("hitFolded")}
            </span>
          </Show>
        </Show>
      </text>

      <Show when={open()}>
        <Show when={props.signals.overrideSessionId()}>
          {(() => {
            const prefix = "  ↳ " + t("subPrefix")
            const maxSidW = Math.max(6, panelWidth() - visualWidth(prefix))
            return (
              <text>
                <span style={{ fg: pal().muted }}>{prefix}</span>
                <span style={{ fg: pal().text }}>
                  {truncateVisual(props.signals.overrideSessionId()!, maxSidW)}
                </span>
              </text>
            )
          })()}
        </Show>
        <Show
          when={data().hasData}
          fallback={
            <>
              <text fg={pal().muted}>{sep()}</text>
              <text>
                <span style={{ fg: pal().muted }}>{"> "}</span>
                <span style={{ fg: pal().muted }}>{t("noData")}</span>
              </text>
            </>
          }
        >
          <text fg={pal().muted}>{sep()}</text>

          {/* 命中率与进度条同行显示，避免额外间距 */}
          <text>
            <span style={{ fg: pal().text }}>{t("hit")} </span>
            <span style={{ fg: hitColor() }}>[{bar()}] </span>
            <span style={{ fg: pal().text }}>{pct()}</span>
            <Show when={data().hasTrendData}>
              <span
                style={{
                  fg:
                    Math.abs(data().trend) >= 0.05
                      ? data().trend > 0
                        ? pal().success
                        : pal().error
                      : pal().text,
                }}
              >
                {" "}
                {trendLabel(data().trend)}
              </span>
            </Show>
          </text>

          {/* 会话累计命中率 */}
          <text fg={pal().muted}>
            {justify(t("totalHit"), (Math.floor(data().sessionHitRate * 10) / 10).toFixed(1) + "%")}
          </text>

          {/* ── 明细区（可折叠，默认展开） ── */}
          <Show when={sectionDetail()}>
            <FoldHeader
              storageKey="detail"
              expanded={detailOpen()}
              toggle={setDetailOpen}
              title={t("secDetail")}
            />

            <Show when={detailOpen()}>
              <Show when={data().read > 0}>
                <text fg={pal().muted}>{justify(t("read"), fmt(data().read), t("tok"))}</text>
              </Show>
              <Show when={data().write > 0}>
                <text fg={pal().muted}>{justify(t("write"), fmt(data().write), t("tok"))}</text>
              </Show>
              {/* 未命中 = 新鲜输入 + 缓存写（两者都未从缓存命中） */}
              <text fg={pal().muted}>
                {justify(t("miss"), fmt(data().freshInput + data().write), t("tok"))}
              </text>
              <text fg={pal().muted}>{justify(t("out"), fmt(data().output), t("tok"))}</text>
              {/* 本回合多次 API 调用时才显示调用次数与末次成本（单次调用不占行） */}
              <Show when={data().dist.stepCount >= 2}>
                <text fg={pal().muted}>
                  {justify(
                    t("stepsCount", { n: data().dist.stepCount }),
                    fmtCost(data().dist.stepCost, currencySymbol(), exchangeRate()),
                  )}
                </text>
              </Show>
              <Show when={data().saved > 0}>
                <text>
                  <span style={{ fg: pal().muted }}>{t("saved")}</span>
                  <span>
                    {" ".repeat(
                      Math.max(
                        1,
                        panelWidth() -
                          gutter() -
                          visualWidth(t("saved")) -
                          visualWidth(
                            "~" + fmtCost(data().saved, currencySymbol(), exchangeRate()),
                          ),
                      ),
                    )}
                  </span>
                  <span style={{ fg: pal().success }}>
                    ~{fmtCost(data().saved, currencySymbol(), exchangeRate())}
                  </span>
                </text>
              </Show>
            </Show>
          </Show>

          {/* ── 性能区：首字时间 / 速度 / 延迟（可折叠，默认展开） ── */}
          <Show when={sectionPerf()}>
            <Show when={perfVisible()}>
              {
                <FoldHeader
                  storageKey="perf"
                  expanded={perfOpen()}
                  toggle={setPerfOpen}
                  title={t("secPerf")}
                />
              }
              <Show when={perfOpen()}>
                <For each={perfRows()}>{(row) => <text fg={pal().muted}>{row}</text>}</For>
              </Show>
            </Show>
          </Show>

          {/* ── 模型区（可折叠，默认展开） ── */}
          <Show when={sectionModel()}>
            {
              <FoldHeader
                storageKey="model"
                expanded={modelOpen()}
                toggle={setModelOpen}
                title={t("secModel")}
              />
            }

            <Show when={modelOpen()}>
              <text fg={pal().text}>
                {justify(t("cost"), fmtCost(data().cost, currencySymbol(), exchangeRate()))}
              </text>
              <Show when={data().providerName}>
                <text fg={pal().muted}>{justify(t("provider"), data().providerName)}</text>
              </Show>
              <text fg={pal().muted}>{justify(t("model"), data().model)}</text>
              <Show when={data().hasPricing}>
                <text fg={pal().muted}>
                  {justify(
                    t("rate"),
                    currencySymbol() +
                      (data().inputRate * exchangeRate()).toFixed(2) +
                      "/M " +
                      t("inputRate"),
                  )}
                </text>
                <Show when={data().cacheReadRate > 0}>
                  <text fg={pal().muted}>
                    {justify(
                      "",
                      currencySymbol() +
                        (data().cacheReadRate * exchangeRate()).toFixed(2) +
                        "/M " +
                        t("cacheRate"),
                    )}
                  </text>
                </Show>
                <Show when={data().cacheWriteRate > 0}>
                  <text fg={pal().muted}>
                    {justify(
                      "",
                      currencySymbol() +
                        (data().cacheWriteRate * exchangeRate()).toFixed(2) +
                        "/M " +
                        t("writeRate"),
                    )}
                  </text>
                </Show>
              </Show>
            </Show>
          </Show>

          {/* ── token 分布区（可折叠，默认收起） ── */}
          <Show when={sectionDist()}>
            <Show when={data().hasDistData}>
              {
                <FoldHeader
                  storageKey="dist"
                  expanded={distOpen()}
                  toggle={setDistOpen}
                  title={t("distTitle")}
                />
              }
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

          {/* ── 已加载技能（可折叠，默认展开） ── */}
          <Show when={sectionSkills()}>
            <Show when={data().hasSkills}>
              {
                <FoldHeader
                  storageKey="skills"
                  expanded={skillsOpen()}
                  toggle={setSkillsOpen}
                  title={t("secSkills")}
                />
              }
              <Show when={skillsOpen()}>
                {data().skills.map((sk: { name: string; tokens: number }) => {
                  const rightW = visualWidth(fmt(sk.tokens)) + UNIT_GAP + visualWidth(t("tok"))
                  const maxLabel = Math.max(4, panelWidth() - gutter() - rightW - 1)
                  const label = truncateVisual(sk.name, maxLabel)
                  return <text fg={pal().muted}>{justify(label, fmt(sk.tokens), t("tok"))}</text>
                })}
              </Show>
            </Show>
          </Show>

          {/* ── 供应商余额（单行显示） ── */}
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
                  <span>
                    {(() => {
                      const code = balanceState().error
                      if (code === "401") return t("balErr401")
                      if (code === "403") return t("balErr403")
                      if (code === "EMPTY") return t("balErrEmpty")
                      if (code === "TIMEOUT") return t("balErrTimeout")
                      return t("balError") + (code ? ` (${code})` : "")
                    })()}
                  </span>
                </text>
              </Show>
              <Show when={balanceState().status === "ok" && balanceState().data}>
                <Show when={balanceDetails().length > 0}>
                  <text
                    fg={pal().text}
                    onMouseUp={() => {
                      const next = !balanceOpen()
                      setBalanceOpen(next)
                      persistFold("balance.open", next)
                    }}
                  >
                    <span style={{ fg: pal().muted }}>{balanceHeader().arrow}</span>
                    <span style={{ fg: pal().primary }}>
                      <b>{balanceHeader().title}</b>
                    </span>
                    <span style={{ fg: pal().muted }}>{balanceHeader().divider}</span>
                    <span>{" " + balanceHeader().summary}</span>
                  </text>
                  <Show when={balanceOpen()}>
                    {balanceDetails().map((detail) => (
                      <text fg={pal().muted}>
                        {justify(
                          formatBalanceDetailLabel(detail) + ":",
                          formatBalanceDetailValue(detail),
                        )}
                      </text>
                    ))}
                  </Show>
                </Show>
                <Show when={balanceDetails().length === 0}>
                  <text fg={pal().muted}>{sep()}</text>
                  <text fg={pal().text}>
                    {justify(
                      t("balTotal"),
                      formatBalanceText(balanceState().data!, balanceCurrency(), exchangeRate()),
                    )}
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

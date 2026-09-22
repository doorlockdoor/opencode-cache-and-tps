/** @jsxImportSource @opentui/solid */

import { createSignal, createEffect, onMount, onCleanup, untrack } from "solid-js"
import type { Context } from "./types"
import { createPanelApi } from "./panel-api"
import { TokenCachePanel } from "../panel/TokenCachePanel"
import type { BalanceState, PanelApi, PanelSignals, LiveStyle, BarStyle } from "../panel/panel-api"
import { KV_PREFIX } from "../panel/panel-api"
import { StatusView } from "./status"
import { mapTheme } from "./theme"
import { makeCommands, findOpencodeKeyV2, currentSessionID } from "./commands"
import { getBalanceProvider, balanceProviders } from "../balance-providers"
import { syncAutoBalance } from "../balance"
import { LANG_META, detectLang, type LangCode } from "../i18n"
import { LIVE_STYLES, BAR_STYLES, readBarItem } from "../live"

const BALANCE_POLL_MS = 5 * 60 * 1000 // 5 minutes（对齐 V1）

declare const process: { env: Record<string, string | undefined> } | undefined
const DEBUG_LANG = typeof process !== "undefined" ? process.env?.CACHE_TUI_LANG : undefined
const INIT_LANG: LangCode = DEBUG_LANG !== undefined && LANG_META.some((m) => m.code === DEBUG_LANG)
  ? (DEBUG_LANG as LangCode)
  : detectLang()

type Signals = PanelSignals & { setBalanceState: (v: BalanceState) => void }

/** v2 侧创建面板信号（默认值；偏好持久化经 PanelApi.kv → storage.store）。 */
function createPanelSignals(): Signals {
  const [currencySymbol, setCurrencySymbol] = createSignal("$")
  const [exchangeRate, setExchangeRate] = createSignal(1)
  const [langCode, setLangCode] = createSignal<LangCode>(INIT_LANG)
  const [sectionDetail, setSectionDetail] = createSignal(true)
  const [sectionModel, setSectionModel] = createSignal(true)
  const [sectionDist, setSectionDist] = createSignal(true)
  const [sectionSkills, setSectionSkills] = createSignal(true)
  const [sectionPerf, setSectionPerf] = createSignal(true)
  const [perfModelFilter, setPerfModelFilter] = createSignal(true)
  const [liveStyle, setLiveStyle] = createSignal<LiveStyle>("default")
  const [barStyle, setBarStyle] = createSignal<BarStyle>("default")
  const [sectionBalance, setSectionBalance] = createSignal(true)
  const [sectionBottom, setSectionBottom] = createSignal(true)
  const [barShowHit, setBarShowHit] = createSignal(true)
  const [barShowTokens, setBarShowTokens] = createSignal(false)
  const [barShowSpeed, setBarShowSpeed] = createSignal(true)
  const [barShowBalance, setBarShowBalance] = createSignal(false)
  // 底栏流式实时段（默认关，见 v2/status.tsx）
  const [barShowLive, setBarShowLive] = createSignal(false)
  const [balanceRefresh, setBalanceRefresh] = createSignal(0)
  const [balanceProviderId, setBalanceProviderId] = createSignal("deepseek")
  const [autoBalance, setAutoBalance] = createSignal(true)
  const [balanceUnsupported, setBalanceUnsupported] = createSignal(false)
  const [balanceState, setBalanceState] = createSignal<BalanceState>({ status: "idle", data: null, lastFetch: 0 })
  const [balanceCurrency, setBalanceCurrency] = createSignal("")
  const [borderVisible, setBorderVisible] = createSignal(true)
  const [overrideSessionId, setOverrideSessionId] = createSignal<string | undefined>(undefined)
  const [sidebarVisible, setSidebarVisible] = createSignal(true)
  return {
    currencySymbol, setCurrencySymbol,
    exchangeRate, setExchangeRate,
    langCode, setLangCode,
    sectionDetail, setSectionDetail,
    sectionModel, setSectionModel,
    sectionDist, setSectionDist,
    sectionSkills, setSectionSkills,
    sectionPerf, setSectionPerf,
    perfModelFilter, setPerfModelFilter,
    liveStyle, setLiveStyle,
    barStyle, setBarStyle,
    sectionBalance, setSectionBalance,
    sectionBottom, setSectionBottom,
    barShowHit, setBarShowHit,
    barShowTokens, setBarShowTokens,
    barShowSpeed, setBarShowSpeed,
    barShowBalance, setBarShowBalance,
    barShowLive, setBarShowLive,
    balanceRefresh, setBalanceRefresh,
    balanceProviderId, setBalanceProviderId,
    autoBalance, setAutoBalance,
    balanceUnsupported, setBalanceUnsupported,
    balanceState,
    setBalanceState,
    balanceCurrency, setBalanceCurrency,
    borderVisible, setBorderVisible,
    overrideSessionId, setOverrideSessionId,
    sidebarVisible, setSidebarVisible,
  }
}

/** 常驻运行时根（app 插槽）：余额轮询、偏好恢复、自动切换、子代理清理、命令层——侧栏隐藏也生效。 */
function RuntimeRoot(props: { context: Context; api: PanelApi; signals: Signals }) {
  let balanceSeq = 0
  /** 当前统计目标会话：子代理 override 优先，否则当前路由会话。 */
  const currentSid = () => props.signals.overrideSessionId() ?? currentSessionID(props.context)

  // 语言 / 实时行 / 底栏样式 / 底栏开关 / 性能过滤 偏好恢复（KV 就绪后）
  const restorePrefs = () => {
    try {
      const saved = props.api.kv.get<string>(`${KV_PREFIX}.lang`)
      if (saved && LANG_META.some((m) => m.code === saved)) props.signals.setLangCode(saved as LangCode)
      const legacy = props.api.kv.get<string>(`${KV_PREFIX}.tps_style`)
      const savedLive = props.api.kv.get<string>(`${KV_PREFIX}.style_live`) ?? legacy
      if (savedLive && LIVE_STYLES.some((s) => s.id === savedLive)) props.signals.setLiveStyle(savedLive as LiveStyle)
      const savedBar = props.api.kv.get<string>(`${KV_PREFIX}.style_bar`) ?? (legacy === "min" ? "min" : "default")
      if (savedBar && BAR_STYLES.some((s) => s.id === savedBar)) props.signals.setBarStyle(savedBar as BarStyle)
      const filter = props.api.kv.get<boolean>(`${KV_PREFIX}.perf_model_filter`, true)
      props.signals.setPerfModelFilter(filter !== false)
      // 底栏内容段开关（默认 命中/速度 开、Tokens/余额/实时 关）
      props.signals.setBarShowHit(readBarItem(props.api.kv, "hit"))
      props.signals.setBarShowTokens(readBarItem(props.api.kv, "tokens"))
      props.signals.setBarShowSpeed(readBarItem(props.api.kv, "speed"))
      props.signals.setBarShowBalance(readBarItem(props.api.kv, "balance"))
      props.signals.setBarShowLive(readBarItem(props.api.kv, "live"))
      // 余额 provider / 自动切换（常驻层恢复；侧栏隐藏也要生效）
      const provider = props.api.kv.get<string>(`${KV_PREFIX}.balance.provider`)
      if (typeof provider === "string" && balanceProviders.some((p) => p.id === provider)) {
        props.signals.setBalanceProviderId(provider)
        props.signals.setBalanceUnsupported(false)
      }
      const auto = props.api.kv.get<boolean>(`${KV_PREFIX}.balance.auto`)
      if (typeof auto === "boolean") props.signals.setAutoBalance(auto)
    } catch {}
  }
  onMount(restorePrefs)

  const pollBalance = async () => {
    const provider = getBalanceProvider(props.signals.balanceProviderId())
    const key = props.api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
      || findOpencodeKeyV2(provider)
    const set = props.signals.setBalanceState
    if (props.signals.balanceUnsupported()) { set({ status: "idle", data: null, lastFetch: 0 }); return }
    if (!key) { set({ status: "idle", data: null, lastFetch: 0 }); return }
    const prev = props.signals.balanceState()
    if (prev.status === "ok" && prev.key === key && Date.now() - prev.lastFetch < BALANCE_POLL_MS) return
    const seq = ++balanceSeq
    set({ ...prev, status: "loading", error: undefined, key })
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    try {
      const data = await provider.fetchBalance(key, controller.signal)
      clearTimeout(timer)
      if (seq !== balanceSeq) return
      set({ status: "ok", data, lastFetch: Date.now(), key })
    } catch (err) {
      clearTimeout(timer)
      if (seq !== balanceSeq) return
      const code = timedOut ? "TIMEOUT" : (err instanceof Error ? err.message : "")
      set({ status: "error", data: null, lastFetch: 0, error: code, key })
    }
  }
  createEffect(() => {
    void props.signals.balanceRefresh()
    untrack(() => { void pollBalance() })
  })
  const balanceTimer = setInterval(pollBalance, BALANCE_POLL_MS)
  onCleanup(() => clearInterval(balanceTimer))

  // 自动切换余额 provider（唯一实现见 src/balance.ts；侧栏隐藏也生效）
  createEffect(() => {
    syncAutoBalance(props.api, props.signals, currentSid())
  })

  // 子代理视图清理：主会话切换时清除 override（与 V1 对齐）
  let lastMainSid = currentSessionID(props.context)
  createEffect(() => {
    const main = currentSessionID(props.context)
    if (main !== lastMainSid) {
      lastMainSid = main
      if (props.signals.overrideSessionId()) {
        props.signals.setOverrideSessionId(undefined)
        void props.api.kv.set(`${KV_PREFIX}.session`, "")
      }
    }
  })

  // 命令层不能依赖侧栏挂载；窄屏或隐藏侧栏时仍需可用。
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: makeCommands(props.context, props.api, props.signals),
  }))
  return null
}

export default {
  id: "opencode-visual-cache",
  setup(context: Context) {
    const api = createPanelApi(context)
    const signals = createPanelSignals()

    // 常驻运行时（app 插槽）：余额轮询 / 偏好恢复 / 自动切换 / 命令层。
    context.ui.slot({
      append: "app",
      render: () => <RuntimeRoot context={context} api={api} signals={signals} />,
    })

    // 侧边栏完整面板（prepend，排在宿主官方信息之前）。纯展示，副作用在常驻层。
    context.ui.slot({
      prepend: "sidebar.content",
      render: (props: any) => (
        <TokenCachePanel
          theme={mapTheme(context.theme)}
          api={api}
          sessionId={String(props?.sessionID ?? "")}
          signals={signals}
        />
      ),
    })

    // 底部状态栏 + 实时行（合并到 prompt.footer.status）。
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props: any) => (
        <StatusView context={context} api={api} signals={signals} sessionID={String(props?.sessionID ?? "")} />
      ),
    })
  },
}

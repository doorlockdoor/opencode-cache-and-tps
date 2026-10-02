import { createSignal } from "solid-js"
import type { BalanceState, PanelSignals, DisplayStyle, TpsMode } from "./panel-api"
import { LANG_META, detectLang, type LangCode } from "../i18n"

const override = typeof process !== "undefined" ? process.env.CACHE_TUI_LANG : undefined
const INIT_LANG: LangCode = LANG_META.some((m) => m.code === override)
  ? (override as LangCode)
  : detectLang()

export type Signals = PanelSignals & { setBalanceState: (v: BalanceState) => void }

/** 两版共用的信号默认值；由常驻运行时恢复偏好。 */
export function createPanelSignals(): Signals {
  const [currencySymbol, setCurrencySymbol] = createSignal("$")
  const [exchangeRate, setExchangeRate] = createSignal(1)
  const [langCode, setLangCode] = createSignal<LangCode>(INIT_LANG)
  const [sectionDetail, setSectionDetail] = createSignal(true)
  const [sectionModel, setSectionModel] = createSignal(true)
  const [sectionDist, setSectionDist] = createSignal(true)
  const [sectionSkills, setSectionSkills] = createSignal(true)
  const [sectionPerf, setSectionPerf] = createSignal(true)
  const [perfModelFilter, setPerfModelFilter] = createSignal(true)
  const [style, setStyle] = createSignal<DisplayStyle>("default")
  const [sectionBalance, setSectionBalance] = createSignal(true)
  const [sectionBottom, setSectionBottom] = createSignal(true)
  const [barShowHit, setBarShowHit] = createSignal(true)
  const [barShowTokens, setBarShowTokens] = createSignal(false)
  const [barShowTtft, setBarShowTtft] = createSignal(false)
  const [barShowSpeed, setBarShowSpeed] = createSignal(true)
  const [barShowLat, setBarShowLat] = createSignal(false)
  const [barShowTool, setBarShowTool] = createSignal(true)
  const [barShowBalance, setBarShowBalance] = createSignal(false)
  // 精确 TPS 计算方式（/cache-tps；output 输出速度默认，perceived 体感速度仅 V2 可算）
  const [tpsMode, setTpsMode] = createSignal<TpsMode>("output")
  const [balanceRefresh, setBalanceRefresh] = createSignal(0)
  const [balanceProviderId, setBalanceProviderId] = createSignal("deepseek")
  const [autoBalance, setAutoBalance] = createSignal(true)
  const [balanceUnsupported, setBalanceUnsupported] = createSignal(false)
  const [balanceState, setBalanceState] = createSignal<BalanceState>({
    status: "idle",
    data: null,
    lastFetch: 0,
  })
  const [balanceCurrency, setBalanceCurrency] = createSignal("")
  const [borderVisible, setBorderVisible] = createSignal(true)
  const [overrideSessionId, setOverrideSessionId] = createSignal<string | undefined>(undefined)
  const [sidebarVisible, setSidebarVisible] = createSignal(false)
  return {
    currencySymbol,
    setCurrencySymbol,
    exchangeRate,
    setExchangeRate,
    langCode,
    setLangCode,
    sectionDetail,
    setSectionDetail,
    sectionModel,
    setSectionModel,
    sectionDist,
    setSectionDist,
    sectionSkills,
    setSectionSkills,
    sectionPerf,
    setSectionPerf,
    perfModelFilter,
    setPerfModelFilter,
    style,
    setStyle,
    sectionBalance,
    setSectionBalance,
    sectionBottom,
    setSectionBottom,
    barShowHit,
    setBarShowHit,
    barShowTokens,
    setBarShowTokens,
    barShowTtft,
    setBarShowTtft,
    barShowSpeed,
    setBarShowSpeed,
    barShowLat,
    setBarShowLat,
    barShowTool,
    setBarShowTool,
    barShowBalance,
    setBarShowBalance,
    tpsMode,
    setTpsMode,
    balanceRefresh,
    setBalanceRefresh,
    balanceProviderId,
    setBalanceProviderId,
    autoBalance,
    setAutoBalance,
    balanceUnsupported,
    setBalanceUnsupported,
    balanceState,
    setBalanceState,
    balanceCurrency,
    setBalanceCurrency,
    borderVisible,
    setBorderVisible,
    overrideSessionId,
    setOverrideSessionId,
    sidebarVisible,
    setSidebarVisible,
  }
}

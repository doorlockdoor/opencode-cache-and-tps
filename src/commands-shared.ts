// ---------------------------------------------------------------------------
// 命令共享层：V1/V2 斜杠命令共用的「选项构建 + 状态应用」（KV/信号/i18n/标题格式）。
// 宿主对话框控制流差异（V1 dialog.replace / V2 await dialog.select）留在各壳。
// ---------------------------------------------------------------------------
import type { PanelApi, PanelSignals, DisplayStyle, TpsMode } from "./panel/panel-api"
import { KV_PREFIX } from "./panel/panel-api"
import {
  BAR_ITEMS,
  STYLES,
  TPS_MODES,
  readBarItem,
  readDisplayStyle,
  readTpsMode,
  type BarItemId,
} from "./live"
import { CURRENCIES, DEFAULT_RATES } from "./currency"
import { balanceProviders } from "./balance-providers"
import { LANG_META, createT, type Translation, type LangCode, detectLang } from "./i18n"
import { visualPadEnd } from "./ui"

/** 下拉项（与两壳 DialogSelect / dialog.select 的选项形状兼容）。 */
export interface Choice<V> {
  title: string
  value: V
}
/** 待宿主显示的 toast（壳层负责 api.ui.toast / context.ui.toast.show）。 */
export interface ToastMsg {
  message: string
  title?: string
  duration?: number
}

const tr = (signals: PanelSignals) => createT(() => signals.langCode())

/** 通用「标签 + [ON/OFF]」选项标题（宽度与旧实现一致）。 */
export const toggleTitle = (label: string, on: boolean): string =>
  `${visualPadEnd(label, 15)}[${on ? "ON" : "OFF"}]`

/**
 * 单选菜单选项（注册表驱动）：标签定宽 + 当前项打勾。
 * /cache-style、/cache-lang、/cache-tps 的选项构建共用，避免三处重复同一模板。
 */
export function radioChoices<T extends string>(
  items: readonly { id: T; label: string }[],
  current: string,
  width: number,
): Choice<T>[] {
  return items.map((it) => ({
    title: `${visualPadEnd(it.label, width)}${current === it.id ? "✓" : ""}`,
    value: it.id,
  }))
}

/** 区块 key ↔ i18n 标签键。 */
const SECTION_LABEL_KEYS: Record<string, keyof Translation> = {
  detail: "secDetail",
  model: "secModel",
  dist: "distTitle",
  skills: "secSkills",
  perf: "secPerf",
  balance: "secBalance",
  bottom: "secBottom",
  border: "secBorder",
}

// ── 币种 ────────────────────────────────────────────────────────────────

export function currencyChoices(): Choice<string>[] {
  return Object.entries(CURRENCIES).map(([code, sym]) => ({
    title: `${code}  (${sym})`,
    value: code,
  }))
}

export async function applyCurrency(
  api: PanelApi,
  signals: PanelSignals,
  code: string,
): Promise<ToastMsg> {
  const t = tr(signals)
  const sym = CURRENCIES[code] ?? "$"
  const rate = DEFAULT_RATES[code] ?? 1
  // 同步余额显示币种偏好：CNY/USD 原生直显，其余币种按汇率换算
  signals.setBalanceCurrency(code)
  signals.setCurrencySymbol(sym)
  signals.setExchangeRate(rate)
  await api.kv.set(`${KV_PREFIX}.currency`, sym)
  await api.kv.set(`${KV_PREFIX}.rate`, rate)
  await api.kv.set(`${KV_PREFIX}.balance_currency`, code)
  return { message: t("currencySet", { v: code, s: sym, r: rate }) }
}

// ── 汇率 ───────────────────────────────────────────────────────────

/** 解析并应用汇率；非法（≤0）返回 null（调用方不弹 toast）。 */
export async function applyRate(
  api: PanelApi,
  signals: PanelSignals,
  raw: string,
): Promise<ToastMsg | null> {
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || !(n > 0)) return null
  signals.setExchangeRate(n)
  await api.kv.set(`${KV_PREFIX}.rate`, n)
  return { message: tr(signals)("rateSet", { r: n }) }
}

// ── 性能模型过滤 ───────────────────────────────────────────────────────

export async function applyPerfFilter(api: PanelApi, signals: PanelSignals): Promise<ToastMsg> {
  const cur = signals.perfModelFilter()
  signals.setPerfModelFilter(!cur)
  const t = tr(signals)
  await api.kv.set(`${KV_PREFIX}.perf_model_filter`, !cur)
  return { message: t(!cur ? "perfFilterOn" : "perfFilterOff") }
}

// ── 显示样式 ───────────────────────────────────────────────────────────

/** 显示样式菜单选项（/cache-style；全段两态共用）。 */
export function styleChoices(signals: PanelSignals, current: string): Choice<DisplayStyle>[] {
  const t = tr(signals)
  return radioChoices(
    STYLES.map((s) => ({ id: s.id, label: t(s.labelKey) })),
    current,
    10,
  )
}

export async function applyStyle(
  api: PanelApi,
  signals: PanelSignals,
  id: string,
): Promise<ToastMsg> {
  const t = tr(signals)
  const hit = STYLES.find((s) => s.id === id)
  const style: DisplayStyle = hit ? hit.id : "default"
  signals.setStyle(style)
  await api.kv.set(`${KV_PREFIX}.style`, style)
  return { message: t("styleSet", { s: t(hit ? hit.labelKey : "styleDefault") }) }
}

// ── 侧栏区块 ────────────────────────────────────────────────────────

export function sectionChoices(signals: PanelSignals): Choice<string>[] {
  const t = tr(signals)
  const on = (k: string) => sectionGetters(signals)[k]()
  return [
    { title: toggleTitle(t("secDetail"), on("detail")), value: "detail" },
    { title: toggleTitle(t("secModel"), on("model")), value: "model" },
    { title: toggleTitle(t("distTitle"), on("dist")), value: "dist" },
    { title: toggleTitle(t("secSkills"), on("skills")), value: "skills" },
    { title: toggleTitle(t("secPerf"), on("perf")), value: "perf" },
    { title: toggleTitle(t("secBalance"), on("balance")), value: "balance" },
    { title: toggleTitle(t("secBottom"), on("bottom")), value: "bottom" },
    { title: toggleTitle(t("secBorder"), signals.borderVisible()), value: "border" },
  ]
}

export async function applySection(
  api: PanelApi,
  signals: PanelSignals,
  id: string,
): Promise<ToastMsg> {
  const t = tr(signals)
  if (id === "border") {
    const cur = signals.borderVisible()
    signals.setBorderVisible(!cur)
    await api.kv.set(`${KV_PREFIX}.border`, !cur)
    return { message: !cur ? t("borderShown") : t("borderHidden") }
  }
  const key = `${KV_PREFIX}.section.${id}`
  const cur = sectionGetters(signals)[id]?.() ?? true
  if (id === "detail") signals.setSectionDetail(!cur)
  if (id === "model") signals.setSectionModel(!cur)
  if (id === "dist") signals.setSectionDist(!cur)
  if (id === "skills") signals.setSectionSkills(!cur)
  if (id === "perf") signals.setSectionPerf(!cur)
  if (id === "balance") signals.setSectionBalance(!cur)
  if (id === "bottom") signals.setSectionBottom(!cur)
  await api.kv.set(key, !cur)
  return {
    message: t(!cur ? "sectionShown" : "sectionHidden", {
      s: t(SECTION_LABEL_KEYS[id] ?? "secToggle"),
    }),
  }
}

// ── content segments（/cache-bar 唯一段菜单；段两态行为见 BAR_ITEMS 注释）──

/** BAR_ITEMS ↔ 信号 setter 映射（/cache-bar 应用与偏好恢复共用；新增段只需改此处 + BAR_ITEMS）。 */
function barItemSetters(signals: PanelSignals): Record<BarItemId, (v: boolean) => void> {
  return {
    hit: signals.setBarShowHit,
    tokens: signals.setBarShowTokens,
    balance: signals.setBarShowBalance,
    ttft: signals.setBarShowTtft,
    speed: signals.setBarShowSpeed,
    lat: signals.setBarShowLat,
    tool: signals.setBarShowTool,
  }
}

/** 内容段菜单选项（注册表驱动，7 段）。速度计算方式已独立为 /cache-tps。 */
export function barItemChoices(signals: PanelSignals): Choice<BarItemId>[] {
  const t = tr(signals)
  return BAR_ITEMS.map((it) => ({
    title: toggleTitle(t(it.labelKey), barItemGetters(signals)[it.id]()),
    value: it.id,
  }))
}

export async function applyBarItem(
  api: PanelApi,
  signals: PanelSignals,
  id: BarItemId,
): Promise<ToastMsg> {
  const t = tr(signals)
  const cur = barItemGetters(signals)[id]()
  barItemSetters(signals)[id](!cur)
  const item = BAR_ITEMS.find((i) => i.id === id)
  await api.kv.set(`${KV_PREFIX}.bar.${id}`, !cur)
  return {
    message: t(!cur ? "sectionShown" : "sectionHidden", {
      s: t(item ? item.labelKey : "barItemsTitle"),
    }),
  }
}

// ── speed calculation mode（/cache-tps 独立菜单；仅 V2 注册，V1 无 streamed 无法计算体感）──

/** 速度计算方式菜单选项（注册表驱动；当前项打勾，同 /cache-style）。 */
export function tpsModeChoices(signals: PanelSignals, current: TpsMode): Choice<TpsMode>[] {
  const t = tr(signals)
  return radioChoices(
    TPS_MODES.map((m) => ({ id: m.id, label: t(m.labelKey) })),
    current,
    16,
  )
}

export async function applyTpsMode(
  api: PanelApi,
  signals: PanelSignals,
  id: string,
): Promise<ToastMsg> {
  const t = tr(signals)
  const hit = TPS_MODES.find((m) => m.id === id)
  const mode: TpsMode = hit ? hit.id : "output"
  signals.setTpsMode(mode)
  await api.kv.set(`${KV_PREFIX}.tps_mode`, mode)
  return { message: t("tpsModeSet", { s: t(hit ? hit.labelKey : "tpsOutput") }) }
}

// ── preference restore（V1/V2 常驻层共用）───────────────────────────────────

/**
 * 恢复面板偏好：语言、显示样式（含旧键迁移）、内容段开关、速度计算方式（含旧键迁移）、
 * 余额 provider / 自动切换。KV 缺省时保留信号默认值（各注册表 default）。
 * 侧栏隐藏或未挂载也需生效，故由常驻层调用。
 */
export function restorePanelPrefs(api: PanelApi, signals: PanelSignals): void {
  void migrateLegacyKey(api).catch((error) =>
    console.error("[cache-panel] 无法迁移余额密钥", error),
  )
  const symbol = api.kv.get<string>(KV_PREFIX + ".currency")
  const rate = api.kv.get<number>(KV_PREFIX + ".rate")
  const currency = api.kv.get<string>(KV_PREFIX + ".balance_currency")
  if (typeof symbol === "string") signals.setCurrencySymbol(symbol)
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) signals.setExchangeRate(rate)
  if (typeof currency === "string" && (currency === "" || currency in CURRENCIES))
    signals.setBalanceCurrency(currency)
  const sections = sectionSetters(signals)
  for (const id of Object.keys(sections))
    sections[id](api.kv.get<boolean>(KV_PREFIX + ".section." + id, true) !== false)
  signals.setBorderVisible(api.kv.get<boolean>(KV_PREFIX + ".border", true) !== false)

  const savedLang = api.kv.get<string>(`${KV_PREFIX}.lang`)
  if (savedLang && LANG_META.some((m) => m.code === savedLang))
    signals.setLangCode(savedLang as LangCode)
  signals.setStyle(readDisplayStyle(api.kv))
  signals.setPerfModelFilter(api.kv.get<boolean>(`${KV_PREFIX}.perf_model_filter`, true) !== false)
  const setBarItem = barItemSetters(signals)
  for (const it of BAR_ITEMS) setBarItem[it.id](readBarItem(api.kv, it.id))
  signals.setTpsMode(readTpsMode(api.kv))
  const provider = api.kv.get<string>(`${KV_PREFIX}.balance.provider`)
  if (typeof provider === "string" && balanceProviders.some((p) => p.id === provider)) {
    signals.setBalanceProviderId(provider)
    signals.setBalanceUnsupported(false)
  }
  const auto = api.kv.get<boolean>(`${KV_PREFIX}.balance.auto`)
  if (typeof auto === "boolean") signals.setAutoBalance(auto)
  signals.setBalanceRefresh(signals.balanceRefresh() + 1)
}

async function migrateLegacyKey(api: PanelApi): Promise<void> {
  const legacy = api.kv.get<string>(`${KV_PREFIX}.ds_key`, "")
  if (!legacy) return
  if (!api.kv.get<string>(`${KV_PREFIX}.balance.deepseek.key`, ""))
    await api.kv.set(`${KV_PREFIX}.balance.deepseek.key`, legacy)
  await api.kv.set(`${KV_PREFIX}.ds_key`, "")
}

// ── 语言 ────────────────────────────────────────────────────────────────

export function langChoices(current: LangCode): Choice<LangCode>[] {
  return radioChoices(
    LANG_META.map((m) => ({ id: m.code, label: m.label })),
    current,
    9,
  )
}

export async function applyLang(
  api: PanelApi,
  signals: PanelSignals,
  code: LangCode,
): Promise<ToastMsg> {
  signals.setLangCode(code)
  await api.kv.set(`${KV_PREFIX}.lang`, code)
  return { message: tr(signals)("langSwitched") }
}

// ── 配置摘要 ──────────────────────────────────────────────────────────

export function configToast(signals: PanelSignals): ToastMsg {
  const t = tr(signals)
  const sym = signals.currencySymbol()
  const rate = signals.exchangeRate()
  const on = (k: string) => (sectionGetters(signals)[k]() ? "ON" : "OFF")
  return {
    title: t("panelConfigTitle"),
    message: t("panelConfigMsg", {
      c: sym,
      r: rate,
      d: on("detail"),
      m: on("model"),
      t: on("dist"),
      k: on("skills"),
      p: on("perf"),
      b: on("balance"),
      f: on("bottom"),
    }),
    duration: 8000,
  }
}

function sectionGetters(s: PanelSignals): Record<string, () => boolean> {
  return {
    detail: s.sectionDetail,
    model: s.sectionModel,
    dist: s.sectionDist,
    skills: s.sectionSkills,
    perf: s.sectionPerf,
    balance: s.sectionBalance,
    bottom: s.sectionBottom,
  }
}
function sectionSetters(s: PanelSignals): Record<string, (v: boolean) => void> {
  return {
    detail: s.setSectionDetail,
    model: s.setSectionModel,
    dist: s.setSectionDist,
    skills: s.setSectionSkills,
    perf: s.setSectionPerf,
    balance: s.setSectionBalance,
    bottom: s.setSectionBottom,
  }
}
function barItemGetters(s: PanelSignals): Record<BarItemId, () => boolean> {
  return {
    hit: s.barShowHit,
    tokens: s.barShowTokens,
    balance: s.barShowBalance,
    ttft: s.barShowTtft,
    speed: s.barShowSpeed,
    lat: s.barShowLat,
    tool: s.barShowTool,
  }
}

export async function notifySetting(
  message: ToastMsg | null | Promise<ToastMsg | null>,
  show: (message: ToastMsg) => void,
  signals?: PanelSignals,
): Promise<void> {
  try {
    const result = await message
    if (result) show(result)
  } catch {
    show({ message: createT(() => signals?.langCode() ?? detectLang())("saveFailed") })
  }
}

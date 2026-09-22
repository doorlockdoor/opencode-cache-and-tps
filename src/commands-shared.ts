// ---------------------------------------------------------------------------
// 命令共享层：V1/V2 斜杠命令共用的「选项构建 + 状态应用」（KV/信号/i18n/标题格式）。
// 宿主对话框控制流差异（V1 dialog.replace / V2 await dialog.select）留在各壳。
// ---------------------------------------------------------------------------
import type { PanelApi, PanelSignals, LiveStyle, BarStyle } from "./panel/panel-api"
import { KV_PREFIX } from "./panel/panel-api"
import { BAR_ITEMS, BAR_STYLES, LIVE_STYLES, readBarItem, type BarItemId } from "./live"
import { CURRENCIES, DEFAULT_RATES } from "./currency"
import { LANG_META, createT, type Translation, type LangCode } from "./i18n"
import { visualPadEnd } from "./ui"

/** 下拉项（与两壳 DialogSelect / dialog.select 的选项形状兼容）。 */
export interface Choice<V> { title: string; value: V }
/** 待宿主显示的 toast（壳层负责 api.ui.toast / context.ui.toast.show）。 */
export interface ToastMsg { message: string; title?: string; duration?: number }

const tr = (signals: PanelSignals) => createT(() => signals.langCode())

/** 通用「标签 + [ON/OFF]」选项标题（宽度与旧实现一致）。 */
export const toggleTitle = (label: string, on: boolean): string => `${visualPadEnd(label, 15)}[${on ? "ON" : "OFF"}]`

/** 区块 key ↔ i18n 标签键。 */
const SECTION_LABEL_KEYS: Record<string, keyof Translation> = {
  detail: "secDetail", model: "secModel", dist: "distTitle", skills: "secSkills",
  perf: "secPerf", balance: "secBalance", bottom: "secBottom", border: "secBorder",
}

// ── currency ────────────────────────────────────────────────────────────────

export function currencyChoices(): Choice<string>[] {
  return Object.entries(CURRENCIES).map(([code, sym]) => ({ title: `${code}  (${sym})`, value: code }))
}

export function applyCurrency(api: PanelApi, signals: PanelSignals, code: string): ToastMsg {
  const t = tr(signals)
  const sym = CURRENCIES[code] ?? "$"
  const rate = DEFAULT_RATES[code] ?? 1
  api.kv.set(`${KV_PREFIX}.currency`, sym)
  api.kv.set(`${KV_PREFIX}.rate`, rate)
  // 同步余额显示币种偏好：CNY/USD 原生直显，其余币种按汇率换算
  api.kv.set(`${KV_PREFIX}.balance_currency`, code)
  signals.setBalanceCurrency(code)
  signals.setCurrencySymbol(sym)
  signals.setExchangeRate(rate)
  return { message: t("currencySet", { v: code, s: sym, r: rate }) }
}

// ── exchange rate ───────────────────────────────────────────────────────────

/** 解析并应用汇率；非法（≤0）返回 null（调用方不弹 toast）。 */
export function applyRate(api: PanelApi, signals: PanelSignals, raw: string): ToastMsg | null {
  const n = parseFloat(raw)
  if (!(n > 0)) return null
  api.kv.set(`${KV_PREFIX}.rate`, n)
  signals.setExchangeRate(n)
  return { message: tr(signals)("rateSet", { r: n }) }
}

// ── perf model filter ───────────────────────────────────────────────────────

export function applyPerfFilter(api: PanelApi, signals: PanelSignals): ToastMsg {
  const cur = Boolean(api.kv.get(`${KV_PREFIX}.perf_model_filter`, true))
  api.kv.set(`${KV_PREFIX}.perf_model_filter`, !cur)
  signals.setPerfModelFilter(!cur)
  const t = tr(signals)
  return { message: t(!cur ? "perfFilterOn" : "perfFilterOff") }
}

// ── live line style ─────────────────────────────────────────────────────────

export function liveStyleChoices(signals: PanelSignals, current: string): Choice<LiveStyle>[] {
  const t = tr(signals)
  return LIVE_STYLES.map((s) => ({
    title: `${visualPadEnd(t(s.labelKey), 10)}${current === s.id ? "\u2713" : ""}`,
    value: s.id,
  }))
}

export function applyLiveStyle(api: PanelApi, signals: PanelSignals, id: string): ToastMsg {
  const t = tr(signals)
  const hit = LIVE_STYLES.find((s) => s.id === id)
  const style: LiveStyle = hit ? hit.id : "default"
  api.kv.set(`${KV_PREFIX}.style_live`, style)
  signals.setLiveStyle(style)
  return { message: t("liveStyleSet", { s: t(hit ? hit.labelKey : "styleDefault") }) }
}

// ── status bar style ────────────────────────────────────────────────────────

export function barStyleChoices(signals: PanelSignals, current: string): Choice<BarStyle>[] {
  const t = tr(signals)
  return BAR_STYLES.map((s) => ({
    title: `${visualPadEnd(t(s.labelKey), 10)}${current === s.id ? "\u2713" : ""}`,
    value: s.id,
  }))
}

export function applyBarStyle(api: PanelApi, signals: PanelSignals, id: string): ToastMsg {
  const t = tr(signals)
  const hit = BAR_STYLES.find((s) => s.id === id)
  const style: BarStyle = hit ? hit.id : "default"
  api.kv.set(`${KV_PREFIX}.style_bar`, style)
  signals.setBarStyle(style)
  return { message: t("barStyleSet", { s: t(hit ? hit.labelKey : "styleDefault") }) }
}

// ── sidebar sections ────────────────────────────────────────────────────────

export function sectionChoices(api: PanelApi, signals: PanelSignals): Choice<string>[] {
  const t = tr(signals)
  const on = (k: string, def = true) => Boolean(api.kv.get(`${KV_PREFIX}.section.${k}`, def))
  return [
    { title: toggleTitle(t("secDetail"), on("detail")), value: "detail" },
    { title: toggleTitle(t("secModel"), on("model")), value: "model" },
    { title: toggleTitle(t("distTitle"), on("dist")), value: "dist" },
    { title: toggleTitle(t("secSkills"), on("skills")), value: "skills" },
    { title: toggleTitle(t("secPerf"), on("perf")), value: "perf" },
    { title: toggleTitle(t("secBalance"), on("balance")), value: "balance" },
    { title: toggleTitle(t("secBottom"), on("bottom")), value: "bottom" },
    { title: toggleTitle(t("secBorder"), Boolean(api.kv.get(`${KV_PREFIX}.border`, true))), value: "border" },
  ]
}

export function applySection(api: PanelApi, signals: PanelSignals, id: string): ToastMsg {
  const t = tr(signals)
  if (id === "border") {
    const cur = Boolean(api.kv.get(`${KV_PREFIX}.border`, true))
    api.kv.set(`${KV_PREFIX}.border`, !cur)
    signals.setBorderVisible(!cur)
    return { message: !cur ? t("borderShown") : t("borderHidden") }
  }
  const key = `${KV_PREFIX}.section.${id}`
  const cur = Boolean(api.kv.get(key, true))
  api.kv.set(key, !cur)
  if (id === "detail") signals.setSectionDetail(!cur)
  if (id === "model") signals.setSectionModel(!cur)
  if (id === "dist") signals.setSectionDist(!cur)
  if (id === "skills") signals.setSectionSkills(!cur)
  if (id === "perf") signals.setSectionPerf(!cur)
  if (id === "balance") signals.setSectionBalance(!cur)
  if (id === "bottom") signals.setSectionBottom(!cur)
  return { message: t(!cur ? "sectionShown" : "sectionHidden", { s: t(SECTION_LABEL_KEYS[id] ?? "secToggle") }) }
}

// ── bottom bar items ────────────────────────────────────────────────────────

/** 底栏内容段菜单选项；includeLive 仅 V2 传（实时段开关只由 V2 底栏消费，默认关）。 */
export function barItemChoices(api: PanelApi, signals: PanelSignals, opts?: { includeLive?: boolean }): Choice<BarItemId>[] {
  const t = tr(signals)
  return BAR_ITEMS
    .filter((it) => it.id !== "live" || Boolean(opts?.includeLive))
    .map((it) => ({ title: toggleTitle(t(it.labelKey), readBarItem(api.kv, it.id)), value: it.id }))
}

export function applyBarItem(api: PanelApi, signals: PanelSignals, id: BarItemId): ToastMsg {
  const t = tr(signals)
  const cur = readBarItem(api.kv, id)
  api.kv.set(`${KV_PREFIX}.bar.${id}`, !cur)
  const set: Record<BarItemId, (v: boolean) => void> = {
    hit: signals.setBarShowHit,
    tokens: signals.setBarShowTokens,
    speed: signals.setBarShowSpeed,
    balance: signals.setBarShowBalance,
    live: signals.setBarShowLive,
  }
  set[id](!cur)
  const item = BAR_ITEMS.find((i) => i.id === id)
  return { message: t(!cur ? "sectionShown" : "sectionHidden", { s: t(item ? item.labelKey : "barItemsTitle") }) }
}

// ── language ────────────────────────────────────────────────────────────────

export function langChoices(current: LangCode): Choice<LangCode>[] {
  return LANG_META.map((m) => ({ title: `${visualPadEnd(m.label, 9)}${current === m.code ? "\u2713" : ""}`, value: m.code }))
}

export function applyLang(api: PanelApi, signals: PanelSignals, code: LangCode): ToastMsg {
  api.kv.set(`${KV_PREFIX}.lang`, code)
  signals.setLangCode(code)
  return { message: tr(signals)("langSwitched") }
}

// ── config summary ──────────────────────────────────────────────────────────

export function configToast(api: PanelApi, signals: PanelSignals): ToastMsg {
  const t = tr(signals)
  const sym = api.kv.get<string>(`${KV_PREFIX}.currency`) ?? "$"
  const rate = api.kv.get<number>(`${KV_PREFIX}.rate`) ?? 1
  const on = (k: string, def = true) => (Boolean(api.kv.get(`${KV_PREFIX}.section.${k}`, def)) ? "ON" : "OFF")
  return {
    title: t("panelConfigTitle"),
    message: t("panelConfigMsg", {
      c: sym, r: rate,
      d: on("detail"), m: on("model"), t: on("dist"), k: on("skills"),
      p: on("perf"), b: on("balance"), f: on("bottom"),
    }),
    duration: 8000,
  }
}

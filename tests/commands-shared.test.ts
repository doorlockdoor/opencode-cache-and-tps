import assert from "node:assert/strict"
import {
  applyBarItem, applyBarStyle, applyCurrency, applyLang, applyLiveStyle,
  applyPerfFilter, applyRate, applySection, configToast,
} from "../src/commands-shared"
import type { PanelApi, PanelSignals } from "../src/panel/panel-api"

/** 记录 setter 调用、固定语言为 en 的假 signals。 */
function makeSignals() {
  const calls: Record<string, unknown[]> = {}
  const signals = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === "langCode") return () => "en"
      if (prop.startsWith("set")) return (v: unknown) => { (calls[prop] ??= []).push(v) }
      return () => undefined
    },
  }) as unknown as PanelSignals
  return { signals, calls }
}

/** 内存 KV。 */
function makeApi() {
  const store = new Map<string, unknown>()
  const kv = {
    ready: true,
    get: <T>(key: string, fallback?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key: string, value: unknown) => { store.set(key, value) },
  }
  return { api: { kv } as unknown as PanelApi, store }
}

// ── currency：写入符号/汇率/余额币种并同步信号 ──────────────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = applyCurrency(api, signals, "CNY")
  assert.equal(store.get("cache_panel.currency"), "¥")
  assert.equal(store.get("cache_panel.rate"), 7.2)
  assert.equal(store.get("cache_panel.balance_currency"), "CNY")
  assert.deepEqual(calls.setCurrencySymbol, ["¥"])
  assert.equal(calls.setExchangeRate[0], 7.2)
  assert.match(msg.message, /CNY/)
}

// ── rate：非法值不改动且返回 null ───────────────────────────────────────────
{
  const { api, store } = makeApi()
  const { signals } = makeSignals()
  assert.equal(applyRate(api, signals, "0"), null)
  assert.equal(applyRate(api, signals, "abc"), null)
  assert.equal(store.has("cache_panel.rate"), false)
  assert.ok(applyRate(api, signals, "7.5"))
  assert.equal(store.get("cache_panel.rate"), 7.5)
}

// ── perf filter：默认 on → 关 ───────────────────────────────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = applyPerfFilter(api, signals)
  assert.equal(store.get("cache_panel.perf_model_filter"), false)
  assert.deepEqual(calls.setPerfModelFilter, [false])
  assert.equal(msg.message, "Performance stats now cover the whole session")
}

// ── section：非 border 走 section 键，border 独立处理 ───────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  applySection(api, signals, "detail") // 默认 on → off
  assert.equal(store.get("cache_panel.section.detail"), false)
  assert.deepEqual(calls.setSectionDetail, [false])

  applySection(api, signals, "border") // 默认 on → off
  assert.equal(store.get("cache_panel.border"), false)
  assert.deepEqual(calls.setBorderVisible, [false])
}

// ── bar items：tokens 默认 off → on，并更新信号 + toast 文案 ────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = applyBarItem(api, signals, "tokens")
  assert.equal(store.get("cache_panel.bar.tokens"), true)
  assert.deepEqual(calls.setBarShowTokens, [true])
  assert.match(msg.message, /Tok/)
}

// ── live / bar style：非法 id 回退 default ──────────────────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  applyLiveStyle(api, signals, "bogus")
  assert.equal(store.get("cache_panel.style_live"), "default")
  assert.deepEqual(calls.setLiveStyle, ["default"])

  applyBarStyle(api, signals, "min")
  assert.equal(store.get("cache_panel.style_bar"), "min")
  assert.deepEqual(calls.setBarStyle, ["min"])
}

// ── lang / config ───────────────────────────────────────────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  applyLang(api, signals, "ja")
  assert.equal(store.get("cache_panel.lang"), "ja")
  assert.deepEqual(calls.setLangCode, ["ja"])

  const cfg = configToast(api, signals)
  assert.equal(typeof cfg.title, "string")
  assert.match(cfg.message ?? "", /Currency|Rate|Detail/)
}

console.log("commands-shared tests passed")

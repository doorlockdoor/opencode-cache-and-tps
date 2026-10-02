import assert from "node:assert/strict"
import {
  applyBarItem,
  applyStyle,
  applyCurrency,
  applyLang,
  applyPerfFilter,
  applyRate,
  applySection,
  applyTpsMode,
  configToast,
  restorePanelPrefs,
  notifySetting,
} from "../src/commands-shared"
import { createPanelSignals } from "../src/panel/signals"
import type { PanelApi } from "../src/panel/panel-api"

/** 记录 setter 调用、固定语言为 en 的假 signals。 */
function makeSignals() {
  const calls: Record<string, unknown[]> = {}
  const signals = createPanelSignals()
  signals.setLangCode("en")
  const recorded = new Proxy(signals, {
    get(target, prop: keyof typeof signals) {
      const value = target[prop]
      if (String(prop).startsWith("set"))
        return (v: unknown) => {
          ;(calls[prop] ??= []).push(v)
          ;(value as (v: unknown) => void)(v)
        }
      return value
    },
  })
  return { signals: recorded, calls }
}

/** 内存 KV。 */
function makeApi() {
  const store = new Map<string, unknown>()
  const kv = {
    ready: true,
    get: <T>(key: string, fallback?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : fallback,
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
  }
  return { api: { kv } as unknown as PanelApi, store }
}

// ── currency：写入符号/汇率/余额币种并同步信号 ──────────────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = await applyCurrency(api, signals, "CNY")
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
  assert.equal(await applyRate(api, signals, "0"), null)
  assert.equal(await applyRate(api, signals, "abc"), null)
  assert.equal(store.has("cache_panel.rate"), false)
  assert.ok(await applyRate(api, signals, "7.5"))
  assert.equal(store.get("cache_panel.rate"), 7.5)
}

// ── perf filter：默认 on → 关 ───────────────────────────────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = await applyPerfFilter(api, signals)
  assert.equal(store.get("cache_panel.perf_model_filter"), false)
  assert.deepEqual(calls.setPerfModelFilter, [false])
  assert.equal(msg.message, "Performance stats now cover the whole session")
}

// ── section：非 border 走 section 键，border 独立处理 ───────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  await applySection(api, signals, "detail") // 默认 on → off
  assert.equal(store.get("cache_panel.section.detail"), false)
  assert.deepEqual(calls.setSectionDetail, [false])

  await applySection(api, signals, "border") // 默认 on → off
  assert.equal(store.get("cache_panel.border"), false)
  assert.deepEqual(calls.setBorderVisible, [false])
}

// ── bar items：tokens 默认 off → on，并更新信号 + toast 文案 ────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = await applyBarItem(api, signals, "tokens")
  assert.equal(store.get("cache_panel.bar.tokens"), true)
  assert.deepEqual(calls.setBarShowTokens, [true])
  assert.match(msg.message, /Tok/)
}

// ── bar items：tool 默认 on → off（工具计时段，仅流式工具相位消费）──────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = await applyBarItem(api, signals, "tool")
  assert.equal(store.get("cache_panel.bar.tool"), false)
  assert.deepEqual(calls.setBarShowTool, [false])
  assert.match(msg.message, /Tool/)
}

// ── 速度计算方式（/cache-tps）：写 cache_panel.tps_mode 并更新信号；非法值回落 output ──
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  const msg = await applyTpsMode(api, signals, "perceived")
  assert.equal(store.get("cache_panel.tps_mode"), "perceived")
  assert.deepEqual(calls.setTpsMode, ["perceived"])
  assert.match(msg.message, /Perceived Speed/)

  await applyTpsMode(api, signals, "bogus")
  assert.equal(store.get("cache_panel.tps_mode"), "output")
  assert.equal(calls.setTpsMode[1], "output")
}

// ── display style：非法 id 回退 default；min 去标签生效 ─────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  await applyStyle(api, signals, "bogus")
  assert.equal(store.get("cache_panel.style"), "default")

  await applyStyle(api, signals, "min")
  assert.equal(store.get("cache_panel.style"), "min")
  assert.deepEqual(calls.setStyle, ["default", "min"])
}

// ── 语言与配置 ───────────────────────────────────────────────────────────
{
  const { api, store } = makeApi()
  const { signals, calls } = makeSignals()
  await applyLang(api, signals, "ja")
  assert.equal(store.get("cache_panel.lang"), "ja")
  assert.deepEqual(calls.setLangCode, ["ja"])

  signals.setLangCode("en")
  const cfg = configToast(signals)
  assert.equal(typeof cfg.title, "string")
  assert.match(cfg.message ?? "", /Currency|Rate|Detail/)
}

{
  const { api, store } = makeApi()
  const signals = createPanelSignals()
  for (const invalid of ["Infinity", "1e999", "7.2abc", "", "-1"])
    assert.equal(await applyRate(api, signals, invalid), null)
  store.set("cache_panel.currency", "¥")
  store.set("cache_panel.rate", 7.2)
  store.set("cache_panel.balance_currency", "CNY")
  store.set("cache_panel.section.detail", false)
  store.set("cache_panel.border", false)
  restorePanelPrefs(api, signals)
  assert.equal(signals.currencySymbol(), "¥")
  assert.equal(signals.exchangeRate(), 7.2)
  assert.equal(signals.balanceCurrency(), "CNY")
  assert.equal(signals.sectionDetail(), false)
  assert.equal(signals.borderVisible(), false)
  store.set("cache_panel.rate", Infinity)
  restorePanelPrefs(api, signals)
  assert.equal(signals.exchangeRate(), 7.2, "invalid persisted rates cannot enter signals")
}

{
  const { api } = makeApi()
  const signals = createPanelSignals()
  signals.setLangCode("en")
  const writes: (() => void)[] = []
  api.kv.set = () =>
    new Promise<void>((resolve) => {
      writes.push(resolve)
    })
  const first = applyPerfFilter(api, signals)
  const second = applyPerfFilter(api, signals)
  assert.equal(
    signals.perfModelFilter(),
    true,
    "fast toggles read current signals while disk writes are pending",
  )
  writes.forEach((resolve) => resolve())
  await Promise.all([first, second])
  api.kv.set = async () => {
    throw new Error("磁盘空间不足")
  }
  const messages: string[] = []
  await notifySetting(
    applyStyle(api, signals, "min"),
    (message) => {
      messages.push(message.message)
    },
    signals,
  )
  assert.equal(messages.length, 1)
  assert.match(messages[0], /Could not save/)
}

console.log("共用命令逻辑测试通过")

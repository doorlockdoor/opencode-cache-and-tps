import assert from "node:assert/strict"
import { BAR_ITEMS, readBarItem, readDisplayStyle, liveStatSegs, perfLabel, pushPerfSegs, type LiveEnabled, type Translate } from "../src/live"
import { KV_PREFIX } from "../src/panel/panel-api"

// ── 内容段注册表默认值：命中/速度/工具 开，Tokens/首字/延迟/余额 关 ──────────
// （每段一个开关管两态：ttft/speed/lat 流式显实时、回合内冻结、回合结束显精确；tool 仅工具相位）
{
  const defaults: Record<string, boolean> = {}
  for (const it of BAR_ITEMS) defaults[it.id] = it.default
  assert.deepEqual(defaults, { hit: true, tokens: false, balance: false, ttft: false, speed: true, lat: false, tool: true })
  assert.equal(BAR_ITEMS.length, 7)
}

// ── readBarItem：缺失用默认值，已存值优先 ───────────────────────────────────
{
  const store = new Map<string, unknown>()
  const kv = {
    ready: true,
    get: <T>(key: string, fallback?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : fallback,
    set: (key: string, value: unknown) => { store.set(key, value) },
  }

  assert.equal(readBarItem(kv, "hit"), true)
  assert.equal(readBarItem(kv, "ttft"), false)
  assert.equal(readBarItem(kv, "speed"), true)
  assert.equal(readBarItem(kv, "tool"), true)
  assert.equal(readBarItem(kv, "tokens"), false)
  assert.equal(readBarItem(kv, "lat"), false)
  assert.equal(readBarItem(kv, "balance"), false)

  // 用户显式切换 → 以存储值为准
  store.set(`${KV_PREFIX}.bar.hit`, false)
  store.set(`${KV_PREFIX}.bar.tokens`, true)
  assert.equal(readBarItem(kv, "hit"), false)
  assert.equal(readBarItem(kv, "tokens"), true)
}

// ── liveStatSegs：段开关逐段生效；tool 相位随「工具」项切换 ─────────────────
{
  const t = ((k: string) => k) as unknown as Translate
  const off: LiveEnabled = { ttft: false, tps: false, lat: false, tool: false }
  const all: LiveEnabled = { ttft: true, tps: true, lat: true, tool: true }
  const basic: LiveEnabled = { ttft: true, tps: true, lat: false, tool: false } // 首字+速度
  const texts = (segs: { text: string }[]) => segs.map((s) => s.text).join("")

  // streaming（首字+速度）：首字精确值 · 实时速度
  const streaming = { phase: "streaming" as const, waitMs: null, ttft: 500, tps: 12.5, elapsed: 2500, toolMs: null }
  assert.equal(texts(liveStatSegs(streaming, t, "m", "x", "default", basic)), "barTTFT 0.50s \u00b7 barTPS 12.5 tokS")

  // 延迟段开启 → 追加进行中净生成时长；全关 → 空（调用方回落精确值）
  assert.match(texts(liveStatSegs(streaming, t, "m", "x", "default", all)), /barLat 2\.50s…/)
  assert.equal(liveStatSegs(streaming, t, "m", "x", "default", off).length, 0)

  // 首字关闭：分隔符不残留前导「·」（default 风格标签仍在）
  assert.equal(texts(liveStatSegs(streaming, t, "m", "x", "default", { ttft: false, tps: true, lat: false, tool: false })), "barTPS 12.5 tokS")
  // dsh：速度/延迟标签省去（仅保留「首 Token」文案）
  assert.equal(texts(liveStatSegs(streaming, t, "m", "x", "dsh", basic)), "barFirstToken 0.50s \u00b7 12.5 tokS")

  // perfLabel：精确段标签与实时块同口径
  assert.equal(perfLabel("default", t, "ttft"), "barTTFT")
  assert.equal(perfLabel("default", t, "tps"), "barTPS")
  assert.equal(perfLabel("dsh", t, "ttft"), "barFirstToken")
  assert.equal(perfLabel("dsh", t, "tps"), null)
  assert.equal(perfLabel("dsh", t, "lat"), null)
  assert.equal(perfLabel("min", t, "ttft"), null)

  // prefill：等待进行中（速度/延迟无值不显示）
  const prefill = { phase: "prefill" as const, waitMs: 800, ttft: null, tps: null, elapsed: null, toolMs: null }
  assert.equal(texts(liveStatSegs(prefill, t, "m", "x", "default", basic)), "barTTFT 0.80s…")
  assert.equal(liveStatSegs(prefill, t, "m", "x", "default", { ttft: false, tps: true, lat: true, tool: true }).length, 0)

  // tool 相位：「工具」项开 → 仅工具计时；关 → 冻结的实时值照常逐段显示
  const tool = { phase: "tool" as const, waitMs: null, ttft: 500, tps: 12.5, elapsed: 2500, toolMs: 1000 }
  assert.equal(texts(liveStatSegs(tool, t, "m", "x", "default", { ...basic, tool: true })), "barTool 1.00s…")
  assert.equal(
    texts(liveStatSegs(tool, t, "m", "x", "default", basic)),
    "barTTFT 0.50s \u00b7 barTPS 12.5 tokS",
  )
}

// ── readDisplayStyle：新键优先 + 旧键迁移（含 tps_style=dsh 不再丢失）──────
{
  type Kv = Parameters<typeof readDisplayStyle>[0]
  const mk = (entries: Record<string, unknown>): Kv =>
    ({ get: <T>(key: string, fallback?: T): T | undefined => (key in entries ? (entries[key] as T) : fallback) }) as unknown as Kv
  assert.equal(readDisplayStyle(mk({ "cache_panel.style": "min", "cache_panel.style_live": "dsh" })), "min")
  assert.equal(readDisplayStyle(mk({ "cache_panel.style_live": "dsh" })), "dsh")
  assert.equal(readDisplayStyle(mk({ "cache_panel.style_bar": "min" })), "min")
  assert.equal(readDisplayStyle(mk({ "cache_panel.tps_style": "dsh" })), "dsh")
  assert.equal(readDisplayStyle(mk({ "cache_panel.style": "bogus" })), "default")
  assert.equal(readDisplayStyle(mk({})), "default")
}

// ── pushPerfSegs：精确性能段开关、标签与段间分隔符 ─────────────────────────
{
  const t = ((k: string) => k) as unknown as Translate
  const sample = { ttft: 500, tps: 12.5, latency: 2500 }
  const run = (over: Partial<Parameters<typeof pushPerfSegs>[2]>) => {
    const out: { text: string; color: string | undefined }[] = []
    const sep = () => { if (out.length) out.push({ text: " \u00b7 ", color: "m" }) }
    pushPerfSegs(out, sep, {
      style: "default", t, sample, tps: sample.tps, ttft: true, speed: true, lat: true, muted: "m", text: "x", ...over,
    })
    return out.map((s) => s.text).join("")
  }
  assert.equal(run({}), "barTTFT 0.50s \u00b7 barTPS 12.5 tokS \u00b7 barLat 2.50s")
  // 首字/延迟关 → 仅速度，无前导分隔符
  assert.equal(run({ ttft: false, lat: false }), "barTPS 12.5 tokS")
  // 速度取 null → 隐藏，首字/延迟照常
  assert.equal(run({ tps: null }), "barTTFT 0.50s \u00b7 barLat 2.50s")
  // 样本为 null → 首字/延迟隐藏（速度仍可显）
  assert.equal(run({ sample: null }), "barTPS 12.5 tokS")
  // dsh：首字「首 Token」、速度/延迟省标签；min：全省标签
  assert.equal(run({ style: "dsh" }), "barFirstToken 0.50s \u00b7 12.5 tokS \u00b7 2.50s")
  assert.equal(run({ style: "min" }), "0.50s \u00b7 12.5 tokS \u00b7 2.50s")
}

console.log("bar items tests passed")

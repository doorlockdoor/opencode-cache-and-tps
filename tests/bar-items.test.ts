import assert from "node:assert/strict"
import { BAR_ITEMS, readBarItem } from "../src/live"
import { KV_PREFIX } from "../src/panel/panel-api"

// ── 注册表默认值：命中 / 速度 开，Tokens / 余额 / 实时 关 ──────────────────
{
  const defaults: Record<string, boolean> = {}
  for (const it of BAR_ITEMS) defaults[it.id] = it.default
  assert.deepEqual(defaults, { hit: true, tokens: false, speed: true, balance: false, live: false })
  assert.equal(BAR_ITEMS.length, 5)
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
  assert.equal(readBarItem(kv, "speed"), true)
  assert.equal(readBarItem(kv, "tokens"), false)
  assert.equal(readBarItem(kv, "balance"), false)
  assert.equal(readBarItem(kv, "live"), false)

  // 用户显式关闭命中 / 打开 Tokens → 以存储值为准
  store.set(`${KV_PREFIX}.bar.hit`, false)
  store.set(`${KV_PREFIX}.bar.tokens`, true)
  assert.equal(readBarItem(kv, "hit"), false)
  assert.equal(readBarItem(kv, "tokens"), true)
}

console.log("bar items tests passed")

import assert from "node:assert/strict"
import { syncAutoBalance } from "../src/balance"
import type { PanelApi, PanelSignals } from "../src/panel/panel-api"

/** 构造仅含 syncAutoBalance 所需字段的假 api / signals。 */
function harness(opts: { auto?: boolean; messages?: any[]; modelProvider?: string }) {
  let provider = "deepseek"
  let unsupported = false
  let refresh = 0
  const api = {
    state: {
      session: {
        messages: () => opts.messages ?? [],
        get: () => (opts.modelProvider ? { model: { providerID: opts.modelProvider, id: "m" } } : undefined),
      },
    },
  } as unknown as PanelApi
  const signals = {
    autoBalance: () => opts.auto !== false,
    balanceProviderId: () => provider,
    setBalanceProviderId: (v: string) => { provider = v },
    setBalanceUnsupported: (v: boolean) => { unsupported = v },
    balanceRefresh: () => refresh,
    setBalanceRefresh: (v: number) => { refresh = v },
  } as unknown as PanelSignals
  return { api, signals, state: () => ({ provider, unsupported, refresh }) }
}

// ── 跟随最后一条 assistant 消息的 provider（精确匹配）────────────────────────
{
  const h = harness({ messages: [{ role: "assistant", providerID: "openrouter" }] })
  syncAutoBalance(h.api, h.signals, "ses_1")
  assert.deepEqual(h.state(), { provider: "openrouter", unsupported: false, refresh: 1 })
}

// ── 前缀匹配（moonshotai-cn → moonshot）──────────────────────────────────────
{
  const h = harness({ messages: [{ role: "assistant", providerID: "moonshotai-cn" }] })
  syncAutoBalance(h.api, h.signals, "ses_1")
  assert.equal(h.state().provider, "moonshot")
}

// ── 无 assistant 消息 → 回退 session.model.providerID ────────────────────────
{
  const h = harness({ messages: [], modelProvider: "siliconflow" })
  syncAutoBalance(h.api, h.signals, "ses_1")
  assert.deepEqual(h.state(), { provider: "siliconflow", unsupported: false, refresh: 1 })
  // 已是同一 provider 时不重复刷新
  syncAutoBalance(h.api, h.signals, "ses_1")
  assert.equal(h.state().refresh, 1)
}

// ── 无适配器 → 标记 unsupported，不切换 ─────────────────────────────────────
{
  const h = harness({ messages: [{ role: "assistant", providerID: "some-unknown" }] })
  syncAutoBalance(h.api, h.signals, "ses_1")
  assert.deepEqual(h.state(), { provider: "deepseek", unsupported: true, refresh: 0 })
}

// ── auto 关闭 / 空会话 → 完全不动 ───────────────────────────────────────────
{
  const h = harness({ auto: false, messages: [{ role: "assistant", providerID: "openrouter" }] })
  syncAutoBalance(h.api, h.signals, "ses_1")
  assert.deepEqual(h.state(), { provider: "deepseek", unsupported: false, refresh: 0 })

  const h2 = harness({ messages: [{ role: "assistant", providerID: "openrouter" }] })
  syncAutoBalance(h2.api, h2.signals, "")
  assert.deepEqual(h2.state(), { provider: "deepseek", unsupported: false, refresh: 0 })
}

console.log("balance auto-switch tests passed")

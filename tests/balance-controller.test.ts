import assert from "node:assert/strict"
import { createBalanceController } from "../src/balance-controller"
import { getBalanceProvider, type BalanceEntry } from "../src/balance-providers"
import { createPanelSignals } from "../src/panel/signals"
import type { PanelApi } from "../src/panel/panel-api"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const signals = createPanelSignals()
const keys = new Map<string, string>([["cache_panel.balance.deepseek.key", "same"]])
const api = {
  kv: { ready: true, get: (key: string, fallback: string) => keys.get(key) ?? fallback },
} as unknown as PanelApi
const provider = getBalanceProvider("deepseek")
const original = provider.fetchBalance
const pending: { result: ReturnType<typeof deferred<BalanceEntry[]>>; signal?: AbortSignal }[] = []
provider.fetchBalance = async (_key, signal) => {
  const result = deferred<BalanceEntry[]>()
  pending.push({ result, signal })
  return result.promise
}
const controller = createBalanceController(api, signals, () => "")
const balance: BalanceEntry[] = [{ currency: "USD", total: "5" }]
try {
  signals.setBalanceState({
    status: "ok",
    data: balance,
    lastFetch: Date.now(),
    providerID: "other",
    key: "same",
  })
  const old = controller.poll()
  signals.setBalanceUnsupported(true)
  await controller.poll()
  assert.equal(pending[0].signal?.aborted, true)
  pending[0].result.resolve(balance)
  await old
  assert.equal(signals.balanceState().status, "idle", "unsupported targets reject late results")

  signals.setBalanceUnsupported(false)
  const first = controller.poll()
  pending[1].result.resolve(balance)
  await first
  await controller.poll()
  assert.equal(pending.length, 2, "same provider and key use fresh cached results")
  const forced = controller.poll(true)
  pending[2].result.resolve(balance)
  await forced
  keys.clear()
  await controller.poll()
  assert.equal(signals.balanceState().data, null, "clearing credentials clears old balance")

  keys.set("cache_panel.balance.deepseek.key", "new")
  const last = controller.poll()
  controller.dispose()
  assert.equal(pending[3].signal?.aborted, true)
  pending[3].result.resolve(balance)
  await last
  assert.equal(signals.balanceState().status, "loading", "disposed controller cannot write results")
} finally {
  controller.dispose()
  provider.fetchBalance = original
}

// 凭据可能在目标切换后才解析完成，此时网络请求尚未开始。
const credentials = deferred<string>()
const delayed = createBalanceController(api, signals, () => credentials.promise)
keys.clear()
try {
  const old = delayed.poll()
  signals.setBalanceUnsupported(true)
  await delayed.poll()
  credentials.resolve("late-key")
  await old
  assert.equal(signals.balanceState().status, "idle")
} finally {
  delayed.dispose()
}
console.log("余额请求控制器测试通过")

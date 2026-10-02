import { getBalanceProvider, type BalanceProvider } from "./balance-providers"
import { KV_PREFIX, type PanelApi } from "./panel/panel-api"
import type { Signals } from "./panel/signals"

export const BALANCE_POLL_MS = 5 * 60 * 1000

/** 两版共用的余额请求控制器；异步读取密钥前先使旧请求失效。 */
export function createBalanceController(
  api: PanelApi,
  signals: Signals,
  resolveKey: (provider: BalanceProvider) => string | Promise<string>,
) {
  let sequence = 0
  let disposed = false
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    sequence++
    controller?.abort()
    controller = undefined
    clearTimeout(timer)
    timer = undefined
  }
  const poll = async (force = false) => {
    cancel()
    const current = sequence
    if (disposed) return
    const provider = getBalanceProvider(signals.balanceProviderId())
    const set = signals.setBalanceState
    const valid = () => !disposed && current === sequence
    if (!api.kv.ready || signals.balanceUnsupported()) {
      set({ status: "idle", data: null, lastFetch: 0 })
      return
    }
    let key = ""
    let timedOut = false
    try {
      key =
        api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "") ||
        (provider.id === "deepseek" ? api.kv.get<string>(`${KV_PREFIX}.ds_key`, "") : "") ||
        (await resolveKey(provider))
      if (!valid()) return
      if (!key) {
        set({ status: "idle", data: null, lastFetch: 0 })
        return
      }
      const previous = signals.balanceState()
      const same = previous.providerID === provider.id && previous.key === key
      if (
        !force &&
        same &&
        previous.status === "ok" &&
        Date.now() - previous.lastFetch < BALANCE_POLL_MS
      )
        return
      set({
        status: "loading",
        data: same ? previous.data : null,
        lastFetch: 0,
        providerID: provider.id,
        key,
      })
      const request = new AbortController()
      controller = request
      timer = setTimeout(() => {
        timedOut = true
        request.abort()
      }, 10_000)
      const data = await provider.fetchBalance(key, request.signal)
      if (valid()) set({ status: "ok", data, lastFetch: Date.now(), providerID: provider.id, key })
    } catch (error) {
      if (valid())
        set({
          status: "error",
          data: null,
          lastFetch: 0,
          providerID: provider.id,
          key,
          error: timedOut ? "TIMEOUT" : error instanceof Error ? error.message : "",
        })
    } finally {
      if (valid()) {
        clearTimeout(timer)
        timer = undefined
        controller = undefined
      }
    }
  }
  return {
    poll,
    dispose: () => {
      disposed = true
      cancel()
    },
  }
}

// ── shared balance auto-switch ──
// 根据会话最后使用的 provider 自动切换余额 provider。V1 / V2 壳共用的唯一实现，
// 由各壳的「常驻层」调用（V1: tui()；V2: app 插槽 RuntimeRoot）。
// 不放在条件挂载的侧边栏组件里——侧栏隐藏时该逻辑必须仍然生效；同时消除此前
// TokenCachePanel 与 V1 底栏各写一份造成的重复执行 / 子代理视图下互相打架。
import type { Message, AssistantMessage } from "@opencode-ai/sdk"
import type { PanelApi, PanelSignals } from "./panel/panel-api"
import { matchBalanceProvider } from "./balance-providers"

/**
 * 幂等：auto 关闭、无会话或 provider 不可知时直接返回。
 * 直接追踪 messages 取最后一条 assistant 消息的 providerID——不依赖
 * session.model 的响应式更新（模型切换时该链路可能不触发重算）；
 * 无 assistant 消息时回退 session.model.providerID。
 */
export function syncAutoBalance(api: PanelApi, signals: PanelSignals, sessionId: string): void {
  if (!signals.autoBalance()) return
  if (!sessionId) return
  let pid = ""
  try {
    const msgs = api.state.session.messages(sessionId) as Message[]
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === "assistant" && (m as AssistantMessage).providerID) {
        pid = (m as AssistantMessage).providerID
        break
      }
    }
    if (!pid) pid = api.state.session.get(sessionId)?.model?.providerID ?? ""
  } catch { /* session 数据未就绪 */ }
  if (!pid) return
  const hit = matchBalanceProvider(pid)
  if (hit) {
    signals.setBalanceUnsupported(false)
    if (hit.id !== signals.balanceProviderId()) {
      signals.setBalanceProviderId(hit.id)
      signals.setBalanceRefresh(signals.balanceRefresh() + 1)
    }
  } else {
    // 当前 provider 无余额适配器 → 标记不支持，余额显示 N/A 并停止轮询
    signals.setBalanceUnsupported(true)
  }
}

// ── usage / hit-rate 统计口径（唯一实现）──
// 侧边栏面板（TokenCachePanel）与 V1/V2 底栏共用，避免三处各写一遍
// 命中率 / 趋势 / token 合计。纯函数，不建立响应式依赖（调用方在 untrack 内使用）。
import type { AssistantMessage } from "@opencode-ai/sdk"
import type { PanelApi, PanelSession } from "./panel/panel-api"
import { num } from "./tokens"

export interface UsageStats {
  /** 最后一条有 token 的 assistant 消息命中率（%）；-1 表示无数据。 */
  hitRate: number
  /** 上一条命中率（%）；-1 表示不足两条。 */
  prevHitRate: number
  /** 趋势是否可用（最后两条都有 token 数据）。 */
  hasTrend: boolean
  input: number
  read: number
  write: number
  output: number
  cost: number
  providerID: string
  modelID: string
}

/**
 * 扫描会话消息汇总用量：
 * - 累计值优先取 Session 聚合字段（数据库级，不受 sync 层 limit 截断），
 *   字段缺失（旧版 SDK）时降级为消息遍历累加；
 * - 命中率为最后两条有 token 的 assistant 消息（分母含缓存写：
 *   read / (input + read + write)），返回 -1 表示无数据。
 */
export function collectUsage(msgs: readonly any[], session: PanelSession | undefined): UsageStats {
  let input  = num(session?.tokens?.input)
  let read   = num(session?.tokens?.cache?.read)
  let write  = num(session?.tokens?.cache?.write)
  let output = num(session?.tokens?.output)
  let cost   = num(session?.cost)
  let pid    = session?.model?.providerID ?? ""
  let mid    = session?.model?.id ?? ""

  const fallbackTokens = session?.tokens == null
  const fallbackCost   = session?.cost == null
  const fallbackModel  = !pid || !mid

  let prev = -1, last = -1
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue
    const tk = (msg as AssistantMessage).tokens
    if (!tk) continue
    const mit = num(tk.input) + num(tk.cache?.read) + num(tk.cache?.write)
    if (mit > 0) { prev = last; last = (num(tk.cache?.read) / mit) * 100 }
    if (fallbackTokens) {
      input += num(tk.input); read += num(tk.cache?.read); write += num(tk.cache?.write); output += num(tk.output)
    }
    if (fallbackCost) cost += num((msg as AssistantMessage).cost)
    if (fallbackModel && (msg as AssistantMessage).providerID && (msg as AssistantMessage).modelID) {
      pid = (msg as AssistantMessage).providerID
      mid = (msg as AssistantMessage).modelID
    }
  }
  return { hitRate: last, prevHitRate: prev, hasTrend: prev >= 0 && last >= 0, input, read, write, output, cost, providerID: pid, modelID: mid }
}

/** 便捷版：从 api 读取会话与消息后汇总（底栏使用）。 */
export function collectUsageBySession(api: PanelApi, sessionId: string): UsageStats {
  const session = typeof api.state.session.get === "function" ? api.state.session.get(sessionId) : undefined
  return collectUsage(api.state.session.messages(sessionId), session)
}

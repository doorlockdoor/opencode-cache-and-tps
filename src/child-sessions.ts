import type { PanelApi } from "./panel/panel-api"

const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])

/** 按消息顺序收集委托工具的子会话，并去重。 */
export function childSessionChoices(api: PanelApi, sessionID: string) {
  const children: { title: string; value: string; description: string }[] = []
  const seen = new Set<string>()
  if (!sessionID) return children
  try {
    for (const message of api.state.session.messages(sessionID)) {
      if (message.role !== "assistant") continue
      let parts: readonly any[] = []
      try {
        parts = api.state.part(message.id)
      } catch {
        continue
      }
      for (const part of parts) {
        if (part.type !== "tool" || !SUBAGENT_TOOLS.has(part.tool)) continue
        const state = part.state
        const id = state?.metadata?.session_id ?? state?.metadata?.sessionId
        if (!id || seen.has(String(id))) continue
        const value = String(id)
        seen.add(value)
        const input = state?.input
        const agent = String(
          part.subagent_type ?? input?.subagent_type ?? input?.category ?? part.tool,
        )
        const prompt = String(input?.prompt ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40)
        children.push({
          title: String(input?.description || prompt || agent),
          value,
          description: `${agent} · ${value.slice(0, 24)}…`,
        })
      }
    }
  } catch {
    /* 会话数据可能尚未加载完成。 */
  }
  return children
}

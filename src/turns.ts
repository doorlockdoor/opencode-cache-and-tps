/** 新版 v2 使用 idle 标记划分回合；运行中追加的输入仍属当前回合。 */
export function usesIdleTurns(messages: readonly { role?: unknown; type?: unknown }[]): boolean {
  return messages.some((message) => (message.role ?? message.type) === "idle")
}

export function isTurnBoundary(role: unknown, idleTurns: boolean): boolean {
  return role === "idle" || (!idleTurns && (role === "user" || role === "synthetic"))
}

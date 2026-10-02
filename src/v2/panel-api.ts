import { createMemo, createRoot, createSignal } from "solid-js"
import { usesIdleTurns, isTurnBoundary } from "../turns"
import type { Context } from "./types"
import type { PanelApi, PanelSession } from "../panel/panel-api"

// ---------------------------------------------------------------------------
// v2 消息归一化（纯函数，可单测）
// ---------------------------------------------------------------------------

/** 工具输出 content[]（ToolTextContent | ToolFileContent）→ 文本。 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((c: any) =>
      c?.type === "text"
        ? String(c.text ?? "")
        : c?.type === "file"
          ? String(c.uri ?? c.name ?? "")
          : "",
    )
    .filter((s) => s.length > 0)
    .join("\n")
}

/**
 * v2 message.content → V1 part 形状（分布/性能/技能区块消费）。
 * textStart 为该 assistant 消息的实时首字时刻，由 createPanelApi 订阅内容开始
 * 事件捕获后传入。
 */
export function buildParts(rec: Record<string, any>, textStart?: number): any[] {
  const out: any[] = []
  const content = Array.isArray(rec.content) ? rec.content : []
  for (const p of content) {
    if (p?.type === "text") {
      // streamed 表示响应结束；首字时间使用实时事件时间，
      // 历史文本不补造时间，避免产生错误 TTFT。
      out.push({
        type: "text",
        text: String(p.text ?? ""),
        time: textStart !== undefined ? { start: textStart } : undefined,
      })
    } else if (p?.type === "reasoning") {
      out.push({
        type: "reasoning",
        text: String(p.text ?? ""),
        time: { start: p.time?.created, end: p.time?.completed },
      })
    } else if (p?.type === "tool") {
      const st = p.state ?? {}
      // v2 工具参数流式期状态为 "streaming"，V1 SDK 对应 "pending"；归一化后
      // computeLivePerf 的「工具进行中」判定与 V1 一致（参数流式期即计工具相位）
      const status = st.status === "streaming" ? "pending" : st.status
      const output =
        status === "completed"
          ? contentText(st.content)
          : status === "error"
            ? (st.error?.message ?? "")
            : ""
      out.push({
        type: "tool",
        id: p.id,
        tool: p.name ?? p.tool,
        subagent_type: st.input?.subagent_type ?? st.input?.category,
        state: {
          status,
          input: st.input,
          raw: typeof st.input === "string" ? st.input : undefined,
          output,
          error: st.error?.message,
          metadata: st.metadata,
          // v2 工具时间在 part.time（{ created, ran?, completed? }），无 state.time
          time: { start: p.time?.ran ?? p.time?.created, end: p.time?.completed },
        },
      })
    }
  }
  // v2 无 step-finish part：assistant 顶层 cost 合成一条（每 assistant 消息 = 一步）
  if (rec.type === "assistant" && typeof rec.cost === "number" && Number.isFinite(rec.cost)) {
    out.push({ type: "step-finish", cost: rec.cost })
  }
  // v2 技能为独立消息类型：合成 skill tool part，复用现有技能扫描
  if (rec.type === "skill") {
    out.push({
      type: "tool",
      tool: "skill",
      state: { status: "completed", metadata: { name: rec.name }, output: String(rec.text ?? "") },
    })
  }
  // v2 user 消息文本在顶层，构造 text part 供分布统计
  if (rec.type === "user" && typeof rec.text === "string" && rec.text.length > 0) {
    out.push({ type: "text", text: rec.text })
  }
  return out
}

/** 将 v2 消息及新旧回合标识转换为共用的 v1 结构。 */
export function normalizeMessages(
  raw: readonly any[],
  firstOutput?: (messageID: string) => number | undefined,
): { messages: Record<string, any>[]; parts: Map<string, any[]> } {
  const parts = new Map<string, any[]>()
  let turnId: string | undefined
  const idleTurns = usesIdleTurns(raw)
  const messages = raw.map((m) => {
    const rec = m as Record<string, any>
    const id = String(rec.id)
    parts.set(id, buildParts(rec, firstOutput?.(id)))
    if (isTurnBoundary(rec.type, idleTurns)) turnId = undefined
    let parentID: string | undefined
    if (rec.type === "assistant") {
      if (!turnId) turnId = id
      parentID = turnId
      const terminal =
        (typeof rec.finish === "string" && !["tool-calls", "unknown"].includes(rec.finish)) ||
        Boolean(rec.error)
      if (!idleTurns && terminal) turnId = undefined
    }
    const model = rec.model as { providerID?: string; id?: string } | undefined
    return {
      ...rec,
      id,
      role: rec.type === "assistant" ? "assistant" : rec.type === "user" ? "user" : rec.type,
      parentID,
      providerID: model?.providerID,
      modelID: model?.id,
      cost: typeof rec.cost === "number" ? rec.cost : 0,
      summary: rec.type === "compaction" ? rec.summary : undefined,
    }
  })
  return { messages, parts }
}

// ---------------------------------------------------------------------------
// v2 Context → PanelApi 适配
// ---------------------------------------------------------------------------

/**
 * 把 v2 的整条消息模型（content[] + 顶层 tokens/cost/time）归一化为组件消费的
 * V1 形状。组件体保持零改动；v2 缺失字段做合理近似（见各注释）。
 */
export function createPanelApi(context: Context): PanelApi & { dispose(): void } {
  // storage.store 持久化 → PanelApi.kv 语义（每个逻辑键一个 store，惰性创建）
  type StoreEntry = readonly [
    Record<string, any>,
    (fn: (d: Record<string, any>) => void) => Promise<void>,
  ]
  const stores = new Map<string, StoreEntry>()
  const entry = (key: string, initial: unknown): StoreEntry => {
    let e = stores.get(key)
    if (!e) {
      e = context.storage.store<Record<string, any>>(key, {
        initial: { value: initial },
      }) as unknown as StoreEntry
      stores.set(key, e)
    }
    return e
  }
  const kvGet = <T>(key: string, fallback?: T): T | undefined => {
    const v = entry(key, fallback)[0].value
    return (v === undefined ? fallback : v) as T
  }
  const writes = new Map<string, Promise<void>>()
  const kvSet = (key: string, value: unknown): Promise<void> => {
    const previous = writes.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() =>
        entry(key, undefined)[1]((draft) => {
          draft.value = value
        }),
      )
    writes.set(key, next)
    void next
      .finally(() => {
        if (writes.get(key) === next) writes.delete(key)
      })
      .catch(() => {})
    return next
  }

  type Normalized = ReturnType<typeof normalizeMessages>
  type CachedSession = {
    value: () => Normalized
    bump: () => void
    dispose: () => void
    ids: Set<string>
  }
  const sessions = new Map<string, CachedSession>()
  const parts = new Map<string, any[]>()
  const firstOutput = new Map<string, number>()
  const started = new Set([
    "session.text.started",
    "session.reasoning.started",
    "session.tool.input.started",
  ])
  const canonical = new Map<string, Set<(event: unknown) => void>>()
  const removers: (() => void)[] = []
  const removeSession = (id: string) => {
    const cached = sessions.get(id)
    if (!cached) return
    for (const mid of cached.ids) parts.delete(mid)
    cached.dispose()
    sessions.delete(id)
  }
  const cachedSession = (id: string) => {
    let cached = sessions.get(id)
    if (cached) return cached
    if (sessions.size >= 64) removeSession(sessions.keys().next().value!)
    cached = createRoot((dispose) => {
      const [revision, setRevision] = createSignal(0)
      // 通过 memo 保留对 Solid 嵌套字段的依赖，缓存命中时也能感知
      // 无事件的历史数据加载；事件同时记录真实首字时间。
      const value = createMemo(() => {
        revision()
        return normalizeMessages(context.data.session.message.list(id) ?? [], (mid) =>
          firstOutput.get(mid),
        )
      })
      return { value, bump: () => setRevision((v) => v + 1), dispose, ids: new Set<string>() }
    })
    sessions.set(id, cached)
    return cached
  }
  removers.push(
    context.data.listen((wrapper) => {
      const event = wrapper?.details ?? wrapper
      if (typeof event?.type !== "string" || !event.type.startsWith("session.")) return
      const mid = event.data?.assistantMessageID
      if (started.has(event.type) && typeof mid === "string" && Number.isFinite(event.created)) {
        const previous = firstOutput.get(mid)
        if (previous === undefined || event.created < previous) {
          if (!firstOutput.has(mid) && firstOutput.size >= 1024)
            firstOutput.delete(firstOutput.keys().next().value!)
          firstOutput.set(mid, event.created)
        }
      }
      const sid = event.data?.sessionID
      if (typeof sid === "string") sessions.get(sid)?.bump()
      else for (const cached of sessions.values()) cached.bump()
      // 高频内容事件统一走共用的节流片段通道。
      const type = /^session\.(text|reasoning|tool)\./.test(event.type)
        ? "message.part.updated"
        : /^session\.(step|compaction)\./.test(event.type)
          ? "message.updated"
          : "session.updated"
      for (const handler of canonical.get(type) ?? []) handler(event)
    }),
  )

  return {
    dispose() {
      for (const remove of removers) remove()
      for (const cached of sessions.values()) cached.dispose()
      sessions.clear()
      parts.clear()
      firstOutput.clear()
      canonical.clear()
    },
    kv: { ready: true, get: kvGet, set: kvSet },
    state: {
      session: {
        get(id): PanelSession | undefined {
          const s = context.data.session.get(id)
          if (!s) return undefined
          return {
            id: s.id,
            title: s.title,
            agent: s.agent,
            model: s.model,
            tokens: s.tokens,
            cost: s.cost,
          }
        },
        messages(id) {
          const cached = cachedSession(id)
          const normalized = cached.value()
          for (const mid of cached.ids) if (!normalized.parts.has(mid)) parts.delete(mid)
          for (const [mid, value] of normalized.parts) parts.set(mid, value)
          cached.ids = new Set(normalized.parts.keys())
          return normalized.messages
        },
        status: (id) => context.data.session.status(id),
      },
      get provider() {
        const models = context.data.location.model.list(context.location) ?? []
        const providers = new Map<string, { id: string; models: Record<string, any> }>()
        for (const model of models) {
          const pid = String(model.providerID ?? "")
          const cost = Array.isArray(model.cost) ? model.cost[0] : undefined
          if (!pid || !cost) continue
          const provider = providers.get(pid) ?? { id: pid, models: {} }
          const fullID = String(model.id ?? "")
          const keys = new Set([String(model.modelID ?? ""), fullID, fullID.split("/").pop() ?? ""])
          for (const key of keys) if (key) provider.models[key] = { cost, limit: model.limit }
          providers.set(pid, provider)
        }
        return [...providers.values()]
      },
      get config() {
        const agent: Record<string, { prompt: unknown }> = {}
        for (const item of context.data.location.agent.list(context.location) ?? [])
          if (item.id) agent[item.id] = { prompt: item.system }
        return { agent }
      },
      // 调用方先读取 messages() 再取片段；v2 无独立片段 API。
      part: (id) => parts.get(String(id)) ?? [],
    },
    event: {
      on(type, handler) {
        if (!["message.part.updated", "message.updated", "session.updated"].includes(type)) {
          const remove = context.data.on(type, handler)
          removers.push(remove)
          return remove
        }
        const handlers = canonical.get(type) ?? new Set()
        handlers.add(handler)
        canonical.set(type, handlers)
        return () => {
          handlers.delete(handler)
        }
      },
    },
  }
}

import type { Context } from "./types"
import type { PanelApi, PanelSession } from "../panel/panel-api"

// ---------------------------------------------------------------------------
// v2 消息归一化（纯函数，可单测）
// ---------------------------------------------------------------------------

/** 工具输出 content[]（ToolTextContent | ToolFileContent）→ 文本。 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "file" ? String(c.uri ?? c.name ?? "") : ""))
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
      // v2 text part 无自身时间戳（schema AssistantText 无 time），message.time.streamed
      // 又是响应体「结束」边界而非首字。实时首字由 textStart（事件捕获）注入；历史数据
      // 无从得知首字 → 留空，使该步不计入 TTFT/TPS 样本（宁可缺失，也不要用 streamed
      // 伪造出≈整段生成时长的 TTFT）。含 reasoning 的步仍有 reasoning.time.created 兜底。
      out.push({ type: "text", text: String(p.text ?? ""), time: textStart !== undefined ? { start: textStart } : undefined })
    } else if (p?.type === "reasoning") {
      out.push({ type: "reasoning", text: String(p.text ?? ""), time: { start: p.time?.created, end: p.time?.completed } })
    } else if (p?.type === "tool") {
      const st = p.state ?? {}
      // v2 工具参数流式期状态为 "streaming"，V1 SDK 对应 "pending"；归一化后
      // computeLivePerf 的「工具进行中」判定与 V1 一致（参数流式期即计工具相位）
      const status = st.status === "streaming" ? "pending" : st.status
      const output = status === "completed"
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
    out.push({ type: "tool", tool: "skill", state: { status: "completed", metadata: { name: rec.name }, output: String(rec.text ?? "") } })
  }
  // v2 user 消息文本在顶层，构造 text part 供分布统计
  if (rec.type === "user" && typeof rec.text === "string" && rec.text.length > 0) {
    out.push({ type: "text", text: rec.text })
  }
  return out
}

/**
 * 归一化整段消息：
 * - 合成回合 parentID（连续 assistant 到终止 finish 视为同回合），使「本回合调用
 *   次数 / 末次成本」的 parentID 链聚合成立；
 * - 展开 role / providerID / modelID / cost / summary；
 * - 为每条消息生成 V1 形状 parts（v2 无 part API）。
 */
export function normalizeMessages(
  raw: readonly any[],
  firstOutput?: (messageID: string) => number | undefined,
): { messages: Record<string, any>[]; parts: Map<string, any[]> } {
  const parts = new Map<string, any[]>()
  let turnId: string | undefined
  const messages = raw.map((m) => {
    const rec = m as Record<string, any>
    const id = String(rec.id)
    parts.set(id, buildParts(rec, firstOutput?.(id)))
    let parentID: string | undefined
    if (rec.type === "assistant") {
      if (!turnId) turnId = id
      parentID = turnId
      const terminal = (typeof rec.finish === "string" && !["tool-calls", "unknown"].includes(rec.finish)) || Boolean(rec.error)
      if (terminal) turnId = undefined
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
export function createPanelApi(context: Context): PanelApi {
  // storage.store 持久化 → PanelApi.kv 语义（每个逻辑键一个 store，惰性创建）
  type StoreEntry = readonly [Record<string, any>, (fn: (d: Record<string, any>) => void) => Promise<void>]
  const stores = new Map<string, StoreEntry>()
  const entry = (key: string, initial: unknown): StoreEntry => {
    let e = stores.get(key)
    if (!e) {
      e = context.storage.store<Record<string, any>>(key, { initial: { value: initial } }) as unknown as StoreEntry
      stores.set(key, e)
    }
    return e
  }
  const kvGet = <T>(key: string, fallback?: T): T | undefined => {
    const v = entry(key, fallback)[0].value
    return (v === undefined ? fallback : v) as T
  }
  const kvSet = (key: string, value: unknown): Promise<void> =>
    entry(key, value)[1]((d) => { d.value = value })

  // messages() 归一化结果按「原始数组引用」缓存：上游 store.session.message[id]
  // 未变化时返回同一引用（client/src/solid/data.ts），命中即复用——避免 status/panel
  // 每轮多次调用都全量重建 parts（250ms 心跳下长会话是 O(n) 重复分配）。
  // normCache 同时持有 parts，供 partCache 被清空后按会话回填（见 messages()）：
  // partCache 是跨会话的全局表，达到上限时会整表清空并只回填当前会话，
  // 若缓存命中路径不回填，则切回仍命中 normCache 的旧会话时 part() 会返回空。
  // 关键：上游用 Solid `produce` **就地**修改嵌套内容（流式 delta 追加 text、push
  // part），外层数组引用在内容变化时【不变】——仅比对引用会命中陈旧快照，实时块读到
  // 的文本/思考永远停在首次归一化时的空串（estTok=0 → 速度记 null，只显示首字）。
  // 故订阅全量事件流：任一 session.* 事件 revision++；缓存同时校验 revision，内容一变
  // 即失效。事件与 store 更新同源，memo 重算时 revision 已更新。
  let messagesRevision = 0
  let cacheEnabled = false
  try {
    context.data.listen((event: any) => {
      const type = event?.details?.type ?? event?.type
      if (typeof type === "string" && type.startsWith("session.")) messagesRevision++
    })
    cacheEnabled = true
  } catch { /* listen 不可用 → 关闭缓存，始终重建（正确性优先） */ }
  const normCache = new Map<string, { ref: readonly any[]; version: number; revision: number; messages: any[]; parts: Map<string, any[]>; partGen: number }>()
  const NORM_CACHE_MAX = 64
  // part() 按 messageID 查（v2 无 part API）；上限清理防止长会话累积。
  const partCache = new Map<string, any[]>()
  const PART_CACHE_MAX = 2000
  // partCache 的代际：每次整表清空自增，用于判断某会话缓存的 parts 是否已失效。
  let partCacheGeneration = 0

  // ── 实时首字时刻（v2 实时块必需）─────────────────────────────────────────
  // v2 的 text part 不携带时间戳，而 session.step.streamed 记录的是响应体「结束」
  // 边界而非首字；实时块 computeLivePerf 依赖 part.time.start，故订阅三个「内容
  // 开始」事件，按 assistant 消息记录最早产出时刻，归一化时注入 text part。
  // （V1 SDK 的 text part 自带 time.start，无需此步。）
  const firstOutput = new Map<string, number>()
  const FIRST_OUTPUT_MAX = 1024
  let firstOutputVersion = 0
  const captureFirstOutput = (event: any): void => {
    const mid = event?.data?.assistantMessageID
    const at = event?.created
    if (typeof mid !== "string" || typeof at !== "number") return
    const cur = firstOutput.get(mid)
    if (cur !== undefined && at >= cur) return
    if (firstOutput.size >= FIRST_OUTPUT_MAX) firstOutput.clear()
    firstOutput.set(mid, at)
    firstOutputVersion++
  }
  for (const type of ["session.text.started", "session.reasoning.started", "session.tool.input.started"]) {
    try { context.data.on(type, captureFirstOutput) } catch { /* 事件名不可用则退回时间戳近似 */ }
  }

  return {
    kv: {
      ready: true,
      get: kvGet,
      set: kvSet,
    },
    state: {
      session: {
        get(id: string): PanelSession | undefined {
          const s = context.data.session.get(id)
          if (!s) return undefined
          const model = s.model as { providerID?: string; id?: string } | undefined
          return {
            id: s.id,
            title: s.title,
            agent: s.agent,
            model: model ? { providerID: model.providerID, id: model.id } : undefined,
            tokens: s.tokens as PanelSession["tokens"],
            cost: s.cost,
          }
        },
        messages(id: string): readonly any[] {
          const raw = context.data.session.message.list(id) ?? []
          const hit = normCache.get(id)
          // 空会话上游每次返回新 []（`?? []`），按「双方都空」视为等价复用；
          // 实时首字表更新（version 变）时强制重建，避免事件与 store 更新竞态漏注入
          if (
            cacheEnabled &&
            hit &&
            hit.revision === messagesRevision &&
            hit.version === firstOutputVersion &&
            (hit.ref === raw || (raw.length === 0 && hit.messages.length === 0))
          ) {
            // partCache 可能已被其他会话的 messages() 整表清空：此时按本会话缓存
            // 的 parts 回填，避免 part() 返回空导致分布/性能/子代理扫描空白。
            if (hit.partGen !== partCacheGeneration) {
              for (const [k, v] of hit.parts) partCache.set(k, v)
              hit.partGen = partCacheGeneration
            }
            return hit.messages
          }
          const { messages, parts } = normalizeMessages(raw, (mid) => firstOutput.get(mid))
          if (normCache.size >= NORM_CACHE_MAX) normCache.clear()
          if (partCache.size >= PART_CACHE_MAX) { partCache.clear(); partCacheGeneration++ }
          for (const [k, v] of parts) partCache.set(k, v)
          normCache.set(id, { ref: raw, version: firstOutputVersion, revision: messagesRevision, messages, parts, partGen: partCacheGeneration })
          return messages
        },
        status(id: string): unknown {
          try { return context.data.session.status(id) } catch { return undefined }
        },
      },
      // 响应式 getter：在组件 effect 中读取会订阅 location.model store。
      // cost 取第一档 tier 近似；limit.context 供底部栏 usage 百分比。
      get provider() {
        const models = (context.data.location.model.list(context.location) ?? []) as Record<string, any>[]
        const byProvider = new Map<string, { id: string; models: Record<string, any> }>()
        for (const m of models) {
          const pid = String(m.providerID ?? "")
          if (!pid) continue
          const costArr = Array.isArray(m.cost) ? m.cost : []
          const cost = costArr[0]
          if (!cost) continue
          const prov = byProvider.get(pid) ?? { id: pid, models: {} }
          const fullId = m.id !== undefined ? String(m.id) : ""
          const keys = new Set([String(m.modelID ?? ""), fullId, fullId.split("/").pop() ?? ""].filter((x) => x.length > 0))
          for (const k of keys) prov.models[k] = { cost, limit: m.limit }
          byProvider.set(pid, prov)
        }
        return [...byProvider.values()]
      },
      // v2 无 config 读取：从 location.agent 组装系统提示（dist 的系统提示估算用）。
      get config() {
        const agents = (context.data.location.agent.list(context.location) ?? []) as Record<string, any>[]
        const map: Record<string, any> = {}
        for (const a of agents) if (a?.id) map[String(a.id)] = { prompt: a.system }
        return { agent: map }
      },
      // 注意：part() 依赖 messages() 先归一化填充 partCache（v2 无独立 part API，
      // 且无法从 messageID 反查 sessionID）。当前所有调用路径均先 messages()。
      part(messageID: string): readonly any[] {
        return partCache.get(String(messageID)) ?? []
      },
    },
    event: {
      // v1 事件名在 v2 多不触发；data 为 Solid store，组件读取即响应式。
      on: (type: string, handler: (event: unknown) => void) => context.data.on(type, handler),
    },
  }
}

import type { PanelApi } from "./panel/panel-api"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { estimateTokens, num } from "./tokens"

// 按宿主 API 隔离分布缓存，以扫描字段的实际值判断失效。
// 仅保留当前扫描的消息，避免长会话在扫描途中清空缓存。
// 调用方通过 untrack 和共用更新事件调度聚合计算。

/** 单条消息 token 分布与当前回合 API 精确值（字段见行内注释）。 */
export interface TokenDist {
  system: number // 用户消息的系统提示 + 代理配置提示
  user: number // 用户消息的文本和文件片段
  agent: number // task 工具的提示和描述（子代理委托）
  toolCall: number // 工具调用的实际参数
  toolResult: number // 工具完成后的输出或错误
  output: number // API 精确输出量，不含推理
  reasoning: number // API 精确推理量
  apiOutput: number // 最后一条有数据消息的 tokens.output（API exact）
  apiInput: number // API 精确输入总量（输入 + 缓存读 + 缓存写）
  stepCost: number // 当前回合最后一步的美元成本
  stepCount: number // 当前回合的步骤数（按 parentID 链聚合）
}

/** SDK 未就绪/越界时返回空 parts（逐条 try/catch 的公共形态） */
function partsOf(api: PanelApi, id: string): readonly Part[] {
  try {
    return api.state.part(id)
  } catch {
    return []
  }
}

// TUI SDK 剥离工具元数据 — 从 skill 输出的固定格式提取名称
// （与 api.client.app.skills() 交叉验证过）
function skillNameFromOutput(output: string): string | undefined {
  const m = output.match(/^#{1,2}\s*Skill:\s*(.+)/m)
  return m?.[1].trim()
}

/** 回合统计：最后一条有 token 数据消息的 context 大小 + 其 parentID 链的 step 数与末次成本。 */
export function collectRoundUsage(
  api: PanelApi,
  msgs: Message[],
): {
  apiInput: number
  apiOutput: number
  stepCount: number
  stepCost: number
} {
  // 从后往前找最后一条有 token 数据的 assistant 消息（避免取到 streaming 中未填充的消息）
  let lastAssMsg: AssistantMessage | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue
    const tok = (msgs[i] as AssistantMessage).tokens
    if (
      tok &&
      ((tok.input ?? 0) > 0 || (tok.cache?.read ?? 0) > 0 || (tok.cache?.write ?? 0) > 0)
    ) {
      lastAssMsg = msgs[i] as AssistantMessage
      break
    }
  }
  if (!lastAssMsg) return { apiInput: 0, apiOutput: 0, stepCount: 0, stepCost: 0 }
  // 取最后一条有数据消息的总输入（含缓存读/写）作为当前 context 大小
  const apiInput =
    num(lastAssMsg.tokens?.input) +
    num(lastAssMsg.tokens?.cache?.read) +
    num(lastAssMsg.tokens?.cache?.write)
  const apiOutput = num(lastAssMsg.tokens?.output)
  // 本回合（最后一条有数据消息所在的 parentID 链）的 API 调用次数与末次成本。
  // opencode 将回合内每次工具调用循环拆为独立 assistant 消息（各含 1 个 step-finish），
  // 故按 parentID 链聚合统计，而非单条消息。
  let stepCount = 0
  let lastCost: number | undefined
  const roundParent = lastAssMsg.parentID
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== "assistant") continue
    if ((m as AssistantMessage).parentID !== roundParent) break
    for (const p of partsOf(api, m.id)) {
      if (p.type !== "step-finish") continue
      stepCount++
      const sc = (p as { cost?: unknown }).cost
      if (lastCost === undefined && typeof sc === "number" && Number.isFinite(sc)) lastCost = sc
    }
  }
  return { apiInput, apiOutput, stepCount, stepCost: lastCost ?? 0 }
}

// ── 单消息分布小计与指纹缓存 ──

interface DistSub {
  system: number
  user: number
  agent: number
  toolCall: number
  toolResult: number
  skills: { name: string; tokens: number }[]
}

const distCaches = new WeakMap<PanelApi, Map<string, { fp: readonly unknown[]; sub: DistSub }>>()

function toolInput(state: any): string {
  try {
    return state?.raw ?? (state?.input != null ? JSON.stringify(state.input) : "")
  } catch {
    return ""
  }
}

/** 比较实际值，确保等长编辑也会使 token 估算缓存失效。 */
export function distFingerprint(msg: Message, parts: readonly Part[]): readonly unknown[] {
  const role = String(msg.role)
  const fp: unknown[] = [role, parts.length]
  if (role === "user") {
    fp.push((msg as UserMessage).system)
    for (const part of parts as readonly any[])
      fp.push(part.type, part.text, part.synthetic, part.ignored, part.source?.text?.value)
  } else if (role === "assistant" || role === "skill") {
    for (const part of parts as readonly any[]) {
      if (part.type === "tool") {
        const state = part.state
        fp.push(
          part.tool,
          state?.status,
          toolInput(state),
          state?.output,
          state?.error,
          state?.metadata?.name,
          state?.input?.prompt,
          state?.input?.description,
        )
      } else if (part.type === "subtask") fp.push(part.type, part.prompt, part.description)
      else fp.push(part.type)
    }
  }
  return fp
}

const sameFingerprint = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])

/** 单消息扫描（estimateTokens 密集区；结果经指纹缓存复用）。 */
function scanMessageDist(msg: Message, parts: readonly Part[]): DistSub {
  const sub: DistSub = { system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0, skills: [] }
  if (msg.role === "user") {
    const um = msg as UserMessage
    if (um.system) sub.system += estimateTokens(um.system)
    for (const p of parts) {
      if (p.type === "text" && !(p as any).synthetic && !(p as any).ignored)
        sub.user += estimateTokens((p as any).text)
      else if (p.type === "file") {
        const fp = p as any
        if (fp.source?.text?.value) sub.user += estimateTokens(fp.source.text.value)
      }
    }
    return sub
  }
  // v2 的技能是独立消息类型（role="skill"），其文本/名称由合成 tool part 承载；
  // 不能按非 assistant 直接跳过，否则「已加载技能」永远为空。
  // 注：SDK Message.role 联合类型不含 "skill"，故按 string 放宽比较。
  const role = msg.role as string
  if (role !== "assistant" && role !== "skill") return sub
  for (const p of parts) {
    if (p.type === "tool") {
      const tp = p as any
      let rawInput = ""
      rawInput = toolInput(tp.state)
      if (rawInput) sub.toolCall += estimateTokens(rawInput, "code")
      // 子代理委托（task 工具）：任务描述计入子代理指令（1.15.x 无 subtask part）
      if (tp.tool === "task" && tp.state?.input) {
        const ti = tp.state.input
        const prompt = typeof ti.prompt === "string" ? ti.prompt : ""
        const desc = typeof ti.description === "string" ? ti.description : ""
        sub.agent += estimateTokens(prompt || desc)
      }
      if (tp.state.status === "completed") {
        if (tp.state.output) sub.toolResult += estimateTokens(tp.state.output, "code")
      } else if (tp.state.status === "error") {
        if (tp.state.error) sub.toolResult += estimateTokens(tp.state.error, "code")
      }
      if (tp.tool === "skill" && tp.state.status === "completed") {
        const output = typeof tp.state.output === "string" ? tp.state.output : ""
        const name =
          typeof tp.state.metadata?.name === "string"
            ? tp.state.metadata.name
            : skillNameFromOutput(output)
        if (name) {
          const tokens = output ? estimateTokens(output) : 0
          sub.skills.push({ name, tokens })
        }
      }
    } else if (p.type === "subtask") {
      const sb = p as any
      sub.agent += estimateTokens(sb.prompt || sb.description || "")
    }
  }
  return sub
}

/** token 分布扫描：user 消息（system/text/file）、assistant 消息（tool 输入/结果、task/skill 子代理指令）
 *  以及 v2 的 skill 独立消息（文本计入 toolResult、名称计入已加载技能）。 */
export function collectTokenDist(
  api: PanelApi,
  msgs: Message[],
  session: { agent?: unknown } | undefined,
): {
  dist: TokenDist
  hasDistData: boolean
  skills: { name: string; tokens: number }[]
} {
  const dist: TokenDist = {
    system: 0,
    user: 0,
    agent: 0,
    toolCall: 0,
    toolResult: 0,
    output: 0,
    reasoning: 0,
    apiOutput: 0,
    apiInput: 0,
    stepCost: 0,
    stepCount: 0,
  }
  const loadedSkills = new Map<string, { name: string; tokens: number }>()
  const cfg = api.state.config as Record<string, unknown> | undefined
  const agentName = String(session?.agent ?? cfg?.default_agent ?? "build")
  const agents = cfg?.agent as Record<string, unknown> | undefined
  const agentCfg = agents?.[agentName] as Record<string, unknown> | undefined
  const sysPrompt = typeof agentCfg?.prompt === "string" ? agentCfg.prompt : ""
  if (sysPrompt) dist.system = estimateTokens(sysPrompt)
  const previous = distCaches.get(api) ?? new Map()
  const current = new Map<string, { fp: readonly unknown[]; sub: DistSub }>()
  for (const msg of msgs) {
    const parts = partsOf(api, msg.id)
    const fp = distFingerprint(msg, parts)
    let entry = previous.get(msg.id)
    if (!entry || !sameFingerprint(entry.fp, fp)) {
      entry = { fp, sub: scanMessageDist(msg, parts) }
    }
    current.set(msg.id, entry)
    dist.system += entry.sub.system
    dist.user += entry.sub.user
    dist.agent += entry.sub.agent
    dist.toolCall += entry.sub.toolCall
    dist.toolResult += entry.sub.toolResult
    // output/reasoning 来自 API 精确 tokens（非文本扫描），不进缓存——
    // tokens 在 step 末写入而指纹不感知，须每次从消息直接读取
    if (msg.role === "assistant") {
      const am = msg as AssistantMessage
      dist.output += num(am.tokens?.output)
      dist.reasoning += num(am.tokens?.reasoning)
    }
    // skill 语义与旧实现一致：跨消息按名称保留最大 token 数
    for (const sk of entry.sub.skills) {
      const existing = loadedSkills.get(sk.name)
      if (!existing || existing.tokens < sk.tokens) loadedSkills.set(sk.name, sk)
    }
  }
  // 仅保留当前显示的扫描结果，避免长会话遍历途中清空缓存。
  distCaches.set(api, current)
  Object.assign(dist, collectRoundUsage(api, msgs))
  const hasDistData =
    dist.system + dist.user + dist.agent + dist.toolCall + dist.toolResult > 0 ||
    dist.apiOutput > 0 ||
    dist.apiInput > 0 ||
    dist.reasoning > 0
  return { dist, hasDistData, skills: [...loadedSkills.values()] }
}

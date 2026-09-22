import type { PanelApi } from "./panel/panel-api"
import type { AssistantMessage, Message } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { ASCII_PER_TOKEN, estimateTokens, num } from "./tokens"

// ── performance (TTFT / TPS / latency) ──
// 口径（在 opencode-throughput / tokenwatch 上的修正版）：
//   TTFT = 首个内容 part (text/reasoning) 的 time.start − message.time.created
//          （体感口径：含 DB 写、预处理与建连等待，略大于 provider 报告的 TTFT）
//   净生成 = time.completed − 首个 part start − 工具执行窗口∩生成区间
//   TPS   = (output + reasoning) / 净生成 × 1000   ← 供应商全量生成 token
//          （例外 1——隐藏思考：usage 计入 reasoningTokens 但无流式 reasoning
//            part（chat-completions o 系等）：思考解码期不可观测、分母从首个
//            text part 起算，保留思考 token 会数量级虚高 → 分子退回 output，
//            与实时估算"只数流式可见"一致）
//          （例外 2——整包参数：缓冲 router 把工具参数整包送达时分子剔除
//            参数估算、退回可见口径；判据与方向见 BUFFERED_* 常量注释）
//   延迟  = time.completed − time.created − 工具执行窗口∩生成区间（净模型耗时）
// 分子为供应商精确 output_tokens（含 tool_use 参数 JSON），分母仅扣"工具执行
// 等待"（tool-call→tool-result 的 state.time 区间，并行去重、钳位）。
// 压缩消息与纯工具 step 不计入样本；小步/缓冲网关守卫触发时 TPS 记 null。
// 宿主动态（packages/opencode/src/session/processor.ts）：
//   text-start → time.start；reasoning-start → time.start（思考段有戳，
//   delta 不更新 end，reasoning-end/cleanup 补 end，流式中只读 start）；
//   tool：参数流式期（tool-input-*）仅建 pending 无 time，tool-call 才置
//   running 并打 start，tool-result 补 end → 参数生成期不可观测，
//   留在分母（已知残余低估），与分子（参数已全量计入）方向相反相互弱化。
//   采样逻辑单一实现（computePerfSample），侧边栏累计与底栏最近样本
//   （lastPerfSample）共用，杜绝双源漂移。V1 时间戳持久化在数据库、直接读取推导；V2 text
//   首字时刻由内容开始事件捕获注入，历史数据缺失 → 该步不计入样本
//   （见 v2/panel-api.ts）。

/** 小步噪声守卫：生成窗口低于此值时时间戳噪声占比过大，TPS 不可信 → 记 null。 */
export const MIN_GEN_MS = 500
/** 缓冲网关守卫：每 token 耗时低于此值（非流式瞬间吐出）时 TPS 不可信 → 记 null。 */
export const BUFFER_MS_PER_TOKEN = 0.2
/** 实时估算守卫：生成窗口过短或产出 token 过少时波动过大 → 速度回落本回合最近实时值（无历史则留空）。 */
export const LIVE_MIN_GEN_MS = 500
/** 实时估算守卫：流式产出 token 数下限。 */
export const LIVE_MIN_TOK = 8
/**
 * 整包参数守卫（三阈值联动）：缓冲 router 把工具参数整块送达（不经可见流式
 * 窗口）→ 参数 token 计入分子而解码时间不在分母，TPS 虚高。当 ① 参数估算 ≥
 * BUFFERED_MIN_PARAM_TOK ② 参数窗口 gap ≤ BUFFERED_GAP_MS ③ 隐含参数速度 ≥
 * BUFFERED_SPEED_RATIO × 同窗口文本速度三者同时命中 → 该步分子剔除工具参数
 * 估算（退回可见口径）。阈值取宽（实测 deepseek 误伤 1/586 步）、方向保守：
 * 最多退回可见速度，不会虚高。
 */
export const BUFFERED_GAP_MS = 150
/** 整包参数守卫阈值：参数估算 token 数下限。 */
export const BUFFERED_MIN_PARAM_TOK = 30
/** 整包参数守卫阈值：隐含参数速度 / 同窗口文本速度倍数下限。 */
export const BUFFERED_SPEED_RATIO = 5

/**
 * 合并工具执行区间（并行重叠去重），并钳位到 [lo, hi]（hi 省略表示无上界），
 * 返回合并后的总时长。用于从生成窗口扣除工具等待。
 */
function mergedIntervalMs(intervals: readonly [number, number][], lo: number, hi?: number): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let ms = 0
  let ws = -1
  let we = -1
  for (const [s, e] of sorted) {
    const a = Math.max(s, lo)
    const b = hi === undefined ? e : Math.min(e, hi)
    if (b <= a) continue
    if (ws < 0) { ws = a; we = b }
    else if (a <= we) { if (b > we) we = b }
    else { ms += we - ws; ws = a; we = b }
  }
  if (ws >= 0) ms += we - ws
  return ms
}

/** 单条 assistant 消息性能样本：ttft 首字延迟 (ms)、tps 输出速度（守卫不通过记 null）、latency 净模型延迟 (ms)。 */
export interface PerfSample {
  ttft: number
  tps: number | null
  latency: number
}

/**
 * 工具参数原文：优先 state.raw（模型生成的原始参数文本），回退 state.input 序列化。
 * 序列化抛错（循环引用等）按空串处理。
 */
function toolParamText(p: Part): string {
  const st = (p as { state?: { raw?: unknown; input?: unknown } }).state
  try {
    if (typeof st?.raw === "string" && st.raw) return st.raw
    return st?.input != null ? JSON.stringify(st.input) : ""
  } catch { return "" }
}

/**
 * 整包参数守卫（见 BUFFERED_* 注释）：命中返回应从分子剔除的参数估算，未命中返回 0。
 */
function bufferedParamTok(
  toolRefs: readonly { start: number; part: Part }[],
  contentRefs: readonly { end: number; len: number; reasoning: boolean }[],
  fs: number,
): number {
  const fts = Math.min(...toolRefs.map((t) => t.start))
  const pre = contentRefs.filter((c) => c.end <= fts)
  if (pre.length === 0) return 0
  const anchor = Math.max(...pre.map((c) => c.end))
  const gap = fts - anchor
  if (gap > BUFFERED_GAP_MS) return 0
  let visTok = 0
  for (const c of pre) visTok += Math.ceil(c.len / (c.reasoning ? ASCII_PER_TOKEN.thinking : ASCII_PER_TOKEN.answer))
  const visMs = anchor - fs
  const visTps = visMs > 0 ? (visTok / visMs) * 1000 : 0
  if (visTps <= 0) return 0
  const paramTok = toolRefs.reduce((n, t) => n + Math.ceil(toolParamText(t.part).length / ASCII_PER_TOKEN.code), 0)
  if (paramTok < BUFFERED_MIN_PARAM_TOK) return 0
  if ((paramTok / Math.max(gap, 1)) * 1000 < visTps * BUFFERED_SPEED_RATIO) return 0
  return paramTok
}

// ── per-message perf sample ──
/**
 * 单条 assistant 消息的性能样本（精确口径唯一实现）：侧边栏「性能」累计与
 * 底栏最近样本（lastPerfSample）共用。条件：已完成、无错误、非压缩、产出
 * token>0、有内容 part 且首 part 晚于创建；返回 null 表示不计入样本。
 */
export function computePerfSample(
  am: AssistantMessage,
  parts: readonly Part[],
): PerfSample | null {
  const created = am.time?.created
  const completed = am.time?.completed
  if (!created || !completed || am.error || am.summary) return null
  const outputTok = num(am.tokens?.output)
  const reasoningTok = num(am.tokens?.reasoning)
  if (outputTok + reasoningTok <= 0) return null
  // 首内容 part 的 time.start = 首 token 到达时刻（text-start / reasoning-start
  // 打戳，取最早）；工具执行窗口扣减 [tool-call 起, tool-result 止] 的
  // state.time 区间。分子用供应商全量 output_tokens（含工具参数 JSON）——
  // 参数生成期（pending 段）无时间戳、留分母，与"参数已全量计入分子"
  // 方向相反、相互弱化；缓冲 router 的整包参数例外由下方守卫剔除
  // （详见头部口径说明）。
  let firstStart: number | undefined
  let toolIvs: [number, number][] | null = null
  let hasReasoning = false
  const toolRefs: { start: number; part: Part }[] = []
  const contentRefs: { end: number; len: number; reasoning: boolean }[] = []
  for (const p of parts) {
    if (p.type === "tool") {
      const tw = (p as any).state?.time
      if (typeof tw?.start === "number" && tw.start > 0) {
        toolRefs.push({ start: tw.start, part: p })
        if (typeof tw.end === "number" && tw.end > tw.start) {
          toolIvs ??= []
          toolIvs.push([tw.start, tw.end])
        }
      }
      continue
    }
    if (p.type !== "text" && p.type !== "reasoning") continue
    if (p.type === "reasoning") hasReasoning = true
    const tm = (p as { time?: { start?: number; end?: number } }).time
    const st = tm?.start
    if (typeof st !== "number" || st <= 0) continue
    const text = (p as { text?: unknown }).text
    contentRefs.push({
      end: typeof tm?.end === "number" && tm.end > st ? tm.end : st,
      len: typeof text === "string" ? text.length : 0,
      reasoning: p.type === "reasoning",
    })
    if (firstStart === undefined || st < firstStart) firstStart = st
  }
  if (firstStart === undefined || firstStart <= created) return null
  // 隐藏思考：无流式 reasoning part → 思考解码时间不可观测，分子退回 output（见头部例外 1）
  let genTok = reasoningTok > 0 && !hasReasoning ? outputTok : outputTok + reasoningTok
  const fs = firstStart
  // 合并工具执行窗口（并行区间重叠去重），钳位到 [fs, completed] 后扣除：
  // 首内容前的工具时间不参与扣减——它被计入 TTFT（体感口径），latency 同基准。
  // 已知偏差：[start,end] 为纯执行窗口，参数生成期无时间戳（含在延迟与净生成内）。
  const toolMs = toolIvs ? mergedIntervalMs(toolIvs, fs, completed) : 0
  // 整包参数守卫（见 BUFFERED_* 注释）：命中时从分子剔除参数估算
  if (toolRefs.length) genTok = Math.max(0, genTok - bufferedParamTok(toolRefs, contentRefs, fs))
  const ttft = fs - created
  const genMs = Math.max(0, completed - fs - toolMs)
  const latency = Math.max(0, completed - created - toolMs)
  // 守卫（小步噪声 / 缓冲网关）触发：TPS 记 null，ttft/latency 照常
  const tps = genTok > 0 && genMs >= Math.max(MIN_GEN_MS, genTok * BUFFER_MS_PER_TOKEN) ? (genTok / genMs) * 1000 : null
  return { ttft, tps, latency }
}

// ── session perf aggregation ──
/**
 * 会话性能聚合（中位数口径，可被 tests/perf.test.ts 直接单测；KV 快照只存
 * 聚合结果不存原始样本）。用中位数而非均值：会话常跨模型/跨路由，均值被
 * 高速段与离群短步拉偏；偶数样本取中间两值平均。
 */
export interface PerfStats {
  ttftLast: number | null // 最近一次首字延迟 (ms)
  tpsLast: number | null  // 最近一次输出速度 (tok/s)
  latLast: number | null  // 最近一次净模型延迟 (ms，已扣工具执行窗口)
  ttftMed: number | null  // 会话首字延迟中位数 (ms)
  tpsMed: number | null   // 会话输出速度中位数 (tok/s)
  latMed: number | null   // 会话净模型延迟中位数 (ms)
  ttftN: number           // 有效样本数（TTFT/延迟共用；压缩消息与纯工具 step 不计）
  tpsN: number            // TPS 有效样本数（守卫记 null 的样本不计入）
  hasPerf: boolean        // 是否存在有效样本
}

/** PerfStats 全空初始值。 */
export const EMPTY_PERF: PerfStats = {
  ttftLast: null, tpsLast: null, latLast: null,
  ttftMed: null, tpsMed: null, latMed: null,
  ttftN: 0, tpsN: 0, hasPerf: false,
}

/** 中位数：偶数个取中间两值平均。 */
function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ── model filtering ──
// 同一会话跨模型切换会混合不同模型的样本（速度差异可达数倍），中位数与最近值
// 均不代表当前模型。每条 assistant 消息自带 modelID/providerID（生成时
// 写入、持久化），按此过滤零成本；过滤上下文由调用方传入（见 index.tsx）。
/**
 * 消息的模型指纹（`providerID/modelID`）。字段缺失（旧版数据）→ null，
 * 表示无法归属任何模型；过滤开启时该类消息被排除。
 */
export function modelKeyOf(am: AssistantMessage): string | null {
  const p = am.providerID
  const m = am.modelID
  return p && m ? `${p}/${m}` : null
}

/**
 * 当前会话的模型指纹：优先 `session.model`（下一条回复将使用的模型，
 * 切换模型后 session 更新即生效，无消息也能得到正确目标），
 * 回退到最后一条 assistant 消息的模型（旧版 SDK/子代理会话缺 model 信息）。
 * 返回 null 表示当前模型不可知——调用方可据此退化为"不过滤"（全局统计）。
 */
export function currentModelKey(api: PanelApi, sid: string): string | null {
  try {
    const session = typeof api.state.session.get === "function" ? api.state.session.get(sid) : undefined
    const p = session?.model?.providerID
    const m = session?.model?.id
    if (p && m) return `${p}/${m}`
  } catch { /* fall through */ }
  try {
    const msgs = api.state.session.messages(sid) as Message[]
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.role !== "assistant") continue
      const k = modelKeyOf(msg as AssistantMessage)
      if (k) return k
    }
  } catch { /* fall through */ }
  return null
}

/** aggregatePerf 的可选过滤：modelKey 存在时只统计该模型归属的样本。 */
export interface PerfFilterOpts {
  modelKey?: string | null
}

/** 遍历 assistant 消息逐条采样（computePerfSample 唯一口径），聚合为中位数 PerfStats。 */
export function aggregatePerf(api: PanelApi, msgs: readonly Message[], opts?: PerfFilterOpts): PerfStats {
  const filterKey = opts?.modelKey || undefined
  const ttfts: number[] = []
  const tpss: number[] = []
  const lats: number[] = []
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue
    const am = msg as AssistantMessage
    if (filterKey !== undefined && modelKeyOf(am) !== filterKey) continue
    let parts: readonly Part[] = []
    try { parts = api.state.part(am.id) } catch {}
    const sample = computePerfSample(am, parts)
    if (!sample) continue
    ttfts.push(sample.ttft)
    lats.push(sample.latency)
    if (sample.tps !== null) tpss.push(sample.tps)
  }
  return {
    ttftLast: ttfts.length ? ttfts[ttfts.length - 1] : null,
    tpsLast: tpss.length ? tpss[tpss.length - 1] : null,
    latLast: lats.length ? lats[lats.length - 1] : null,
    ttftMed: ttfts.length ? median(ttfts) : null,
    tpsMed: tpss.length ? median(tpss) : null,
    latMed: lats.length ? median(lats) : null,
    ttftN: ttfts.length,
    tpsN: tpss.length,
    hasPerf: ttfts.length > 0,
  }
}

/**
 * 最近一次有效样本（底栏精确 首字/速度/延迟 共用；filterKey 模型过滤口径同
 * aggregatePerf）。取第一条 computePerfSample 非空的消息——三个指标同源同一条
 * step（避免混搭不同 step 的值）；该 step 的 tps 若被守卫记 null 则速度段隐藏，
 * 首字/延迟照常显示。
 */
export function lastPerfSample(api: PanelApi, sid: string, filterKey?: string | null): PerfSample | null {
  const msgs = api.state.session.messages(sid) as Message[]
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== "assistant") continue
    const am = m as AssistantMessage
    if (filterKey && modelKeyOf(am) !== filterKey) continue
    let parts: readonly Part[] = []
    try { parts = api.state.part(am.id) } catch {}
    const s = computePerfSample(am, parts)
    if (s) return s
  }
  return null
}

// ── host-style turn TPS (v2 only) ──
/**
 * 宿主口径回合 TPS（对齐宿主 AssistantFooter 的 turnTokensPerSecond）：
 * Σ(output+reasoning) / Σ(streamed − created)，分母含每步首字等待，工具时间
 * 天然落在 streamed 之外。仅依赖消息级 time.streamed（v2 schema 专属且持久化，
 * 历史会话可用；v1 消息无此字段 → 恒 null）。回合边界对齐宿主 inputIndex：
 * 只在 idle（回合结束）与 user/synthetic（回合开始）处断开，其余非 assistant
 * （system/skill/shell/切换标记…）跳过而不截断——宿主在回合中途遇到这些消息
 * 仍连续聚合，若在此 break 会丢步、与 footer 口径不一致。忽略 perfModelFilter
 * （回合为整体单元）。任一步缺 created/streamed/completed → null，调用方回落
 * 最近样本口径（v2/status.tsx 速度段）。
 */
export function hostTurnTps(api: PanelApi, sid: string): number | null {
  try {
    const msgs = api.state.session.messages(sid) as Message[]
    // 锚定最后一条 assistant：回合结束后列表尾部是 idle 等标记，不能从尾直接判型
    // （与 computeLivePerf 同一锚定模式）
    let li = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") { li = i; break }
    }
    if (li < 0) return null
    let tokens = 0
    let duration = 0
    let steps = 0
    for (let i = li; i >= 0; i--) {
      const m = msgs[i]
      const role = String((m as { role?: unknown }).role)
      // 只在回合边界断开，其余非 assistant 跳过（口径见上方说明）
      if (role === "user" || role === "synthetic" || role === "idle") break
      if (role !== "assistant") continue
      const am = m as AssistantMessage
      if (am.error || am.summary) return null
      const created = num(am.time?.created)
      const streamed = num((am.time as { streamed?: unknown } | undefined)?.streamed)
      const completed = num(am.time?.completed)
      if (!created || !streamed || !completed || streamed < created) return null
      tokens += num(am.tokens?.output) + num(am.tokens?.reasoning)
      duration += streamed - created
      steps++
    }
    if (steps === 0 || tokens <= 0 || duration <= 0) return null
    return (tokens / duration) * 1000
  } catch { return null }
}

// ── live (streaming) perf estimation ──
/**
 * usage 与 time.completed 仅在 step 结束时写入，流式期间从 part 增量实时估算：
 *   TTFT = 首个内容 part 的 time.start − time.created（首个 part 到达前显示等待时长）
 *   TPS  = Σ estimateTokens(text/reasoning + 已完成工具参数) / 纯生成时长
 *          （含 reasoning，全量方向：工具参数经 input/raw 近似——pending 段无
 *            增量可估；估算有误差，step 结束产出精确值（会话统计/回合结束口径））
 *   纯生成时长 = now − 首个 part start − 已完成工具区间并集（重叠去重、钳位）
 *   工具相位仅覆盖工具运行中（pending/running）→ 计入工具计时，工具返回即转回非工具阶段；
 *   工具恢复后速度与暂停前严格连续。时钟同机同钟，可直接相减。
 */
/**
 * 实时估算值（单一对象；各段按位取用，不可用为 null）。
 * 工具相位仅覆盖工具运行中（pending/running）：ttft/tps/elapsed 以工具起点为终点冻结
 * （分子分母同时停摆，即「暂停前的最近值」），toolMs 供 /cache-bar「工具」段显示计时；
 * 工具返回后即转为 prefill/streaming。工具相位是否只显工具计时由渲染层段开关决定（liveStatSegs）。
 */
export interface LivePerf {
  phase: "prefill" | "streaming" | "tool"
  waitMs: number | null   // prefill：等待进行中；其余 null
  ttft: number | null     // streaming/tool：本步（或回合内最近）首字；prefill 为 null
  tps: number | null      // streaming：实时估算；tool/prefill：冻结/回落本回合最近实时值；无历史为 null
  elapsed: number | null  // 净生成进行时长（streaming 增长 / tool·prefill 冻结回落），实时延迟段用
  toolMs: number | null   // tool 相位工具计时；其余 null
}

/** 单条 assistant 消息的实时锚点（当前步估算与跨步冻结回落共用同一扫描口径）。 */
interface LiveAnchors {
  created: number | undefined
  firstStart: number | undefined
  estTok: number
  toolActive: boolean
  toolStart: number | undefined
  lastToolStart: number | undefined
  toolIvs: [number, number][] | undefined
}

/** 扫描消息 content parts，提取内容起点、估算 token、工具相位与已完成工具区间。 */
function scanLiveAnchors(api: PanelApi, am: AssistantMessage): LiveAnchors {
  let firstStart: number | undefined
  let estTok = 0
  let toolActive = false
  let toolStart: number | undefined
  let lastToolStart: number | undefined
  let toolIvs: [number, number][] | undefined
  let parts: readonly Part[] = []
  try { parts = api.state.part(am.id) } catch {}
  for (const p of parts) {
    if (p.type === "tool") {
      const ps = (p as { state?: { status?: string; time?: { start?: number; end?: number } } }).state
      const ts = ps?.time?.start
      if (typeof ts === "number" && (lastToolStart === undefined || ts > lastToolStart)) lastToolStart = ts
      if (ps?.status === "pending" || ps?.status === "running") {
        // 计时起点取最新活跃工具的 time.start；pending（参数仍在流式生成）
        // 时无 time，回退消息创建时刻兜底
        toolActive = true
        if (typeof ts === "number" && (toolStart === undefined || ts > toolStart)) toolStart = ts
      } else {
        // 已完成/出错工具：记录区间，循环后统一合并钳位再扣除，并把工具参数
        // （tool_use 输入）计入估算分子，与精确侧全量口径一致；pending 段参数
        // 无增量可估，仅计已落地 input/raw
        const t1 = ps?.time?.end
        if (typeof ts === "number" && ts > 0 && typeof t1 === "number" && t1 > ts) {
          toolIvs ??= []
          toolIvs.push([ts, t1])
        }
        const rawText = toolParamText(p)
        if (rawText) estTok += estimateTokens(rawText, "code")
      }
      continue
    }
    if (p.type !== "text" && p.type !== "reasoning") continue
    const tm = (p as { time?: { start?: number; end?: number } }).time
    const st = tm?.start
    if (typeof st === "number" && st > 0 && (firstStart === undefined || st < firstStart)) firstStart = st
    const txt = (p as { text?: unknown }).text
    if (typeof txt === "string" && txt) estTok += estimateTokens(txt, p.type === "reasoning" ? "thinking" : "answer")
  }
  return { created: am.time?.created, firstStart, estTok, toolActive, toolStart, lastToolStart, toolIvs }
}

// 冻结口径：以 end 为生成窗口终点计算 ttft/tps/elapsed——工具运行时分子分母同时停摆，
// 数值即「暂停前的最近值」；恢复生成后与暂停前严格连续（与精确侧扣窗口同一思路）
function frozenFrom(a: LiveAnchors, end: number, now: number): Pick<LivePerf, "ttft" | "tps" | "elapsed"> {
  if (a.firstStart === undefined) return { ttft: null, tps: null, elapsed: null }
  const genEnd = Math.max(a.firstStart, Math.min(end, now))
  const paused = a.toolIvs ? mergedIntervalMs(a.toolIvs, a.firstStart, genEnd) : 0
  const genMs = Math.max(0, genEnd - a.firstStart - paused)
  const tps = genMs >= LIVE_MIN_GEN_MS && a.estTok >= LIVE_MIN_TOK ? (a.estTok / genMs) * 1000 : null
  return { ttft: Math.max(0, a.firstStart - (a.created ?? a.firstStart)), tps, elapsed: genMs }
}

/**
 * 流式期间实时估算当前步性能（口径见 LivePerf）；无进行中 step 返回 null。
 * 回合内冻结：当前步尚无内容产出（纯工具步 / 首字前等待）或速度被守卫记为 null 时，
 * tps/elapsed（及工具相位下的 ttft）按字段回落本回合内最近一条有内容产出的 assistant
 * 的冻结值——busy 期间不回落精确、不闪断，直到回合结束才由调用方回落精确收官值。
 * 回合边界同 hostTurnTps（user/synthetic/idle 断开），新回合第一步无历史 → 回落精确。
 */
export function computeLivePerf(api: PanelApi, sid: string): LivePerf | null {
  try {
    // status 仅作辅助排除（retry 等）：函数不存在时跳过，
    // 由下方消息状态（最后一条 assistant 未完成）承担流式判定
    try {
      const st = api.state.session.status?.(sid) as { type?: string } | string | undefined
      const mode = typeof st === "string" ? st : st?.type
      if (mode && mode !== "busy" && mode !== "running") return null
    } catch {}
    const msgs = api.state.session.messages(sid) as Message[]
    let li = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") { li = i; break }
    }
    if (li < 0) return null
    const am = msgs[li] as AssistantMessage
    // 出错或压缩流 → 不做实时估算
    if (am.error || am.summary) return null
    const cur = scanLiveAnchors(api, am)
    const created = cur.created
    if (!created) return null
    const now = Date.now()
    const frozen = (end: number) => frozenFrom(cur, end, now)
    const noPerf = (): Pick<LivePerf, "ttft" | "tps" | "elapsed"> => ({ ttft: null, tps: null, elapsed: null })
    // 跨步回落：沿回合内最近一条有内容产出的 assistant 冻结（回合边界同 hostTurnTps）。
    // 惰性求值并缓存，避免每帧重复回溯历史消息。
    let prev: Pick<LivePerf, "ttft" | "tps" | "elapsed"> | null | undefined
    const prevFrozen = (): Pick<LivePerf, "ttft" | "tps" | "elapsed"> => {
      if (prev !== undefined) return prev ?? noPerf()
      prev = null
      for (let i = li - 1; i >= 0; i--) {
        const role = String((msgs[i] as { role?: unknown }).role)
        if (role === "user" || role === "synthetic" || role === "idle") break
        if (role !== "assistant") continue
        const pm = msgs[i] as AssistantMessage
        if (pm.error || pm.summary) break
        const a = scanLiveAnchors(api, pm)
        if (a.firstStart === undefined) continue
        prev = frozenFrom(a, a.lastToolStart ?? a.firstStart, now)
        break
      }
      return prev ?? noPerf()
    }
    // 按字段回落：当前步冻结值缺哪项补哪项（守卫记 null 的速度也得以延续）
    const withCarry = (p: Pick<LivePerf, "ttft" | "tps" | "elapsed">) => {
      if (p.ttft !== null && p.tps !== null && p.elapsed !== null) return p
      const f = prevFrozen()
      return { ttft: p.ttft ?? f.ttft, tps: p.tps ?? f.tps, elapsed: p.elapsed ?? f.elapsed }
    }
    // 工具运行中（pending/running）→ 唯一的工具相位：仅显工具计时；关闭「工具」段时
    // 首字/速度/延迟回落到本回合最近一条有内容产出的 assistant 冻结值。工具返回后
    // 本相位即结束（计时在返回时停）。
    if (cur.toolActive) {
      // frozen 以活跃工具起点为终点；工具计时沿用旧口径：无 time.start 时回退消息创建时刻
      const end = cur.toolStart ?? now
      return { phase: "tool", waitMs: null, toolMs: Math.max(0, now - (cur.toolStart ?? created)), ...withCarry(frozen(end)) }
    }
    // 容器未提供首个内容时间戳（如 v2 归一化缺失、插件中途接入）时，若已有可见
    // 内容产出，无法估算首字/速度，返回 null 由调用方回落最近精确 TPS。
    if (cur.firstStart === undefined && cur.estTok > 0) return null
    if (am.time?.completed) return null
    // 首字前等待（首步 / 工具返回后的下一步）→ 非工具阶段：首字段显实时等待时长；
    // 速度/延迟沿用本回合最近的实时值（回合内冻结，不回落精确），无本回合历史则留空
    if (cur.firstStart === undefined) {
      const f = prevFrozen()
      return { phase: "prefill", waitMs: Math.max(0, now - created), ttft: null, tps: f.tps, elapsed: f.elapsed, toolMs: null }
    }
    // 纯生成时长：已完成工具区间按 start 排序取并集（并行重叠去重），
    // 钳位到生成窗口 [firstStart, now]（首内容前执行的工具不计）后扣除
    const pausedMs = cur.toolIvs ? mergedIntervalMs(cur.toolIvs, cur.firstStart) : 0
    const genMs = Math.max(0, now - cur.firstStart - pausedMs)
    // 守卫：生成窗口 <LIVE_MIN_GEN_MS 或产出 <LIVE_MIN_TOK 时波动过大，速度以本回合
    // 最近的实时值兜底（回合内冻结，不回落精确；首字照常显示）
    const tps = genMs >= LIVE_MIN_GEN_MS && cur.estTok >= LIVE_MIN_TOK ? (cur.estTok / genMs) * 1000 : prevFrozen().tps
    return { phase: "streaming", waitMs: null, toolMs: null, ttft: Math.max(0, cur.firstStart - created), tps, elapsed: genMs }
  } catch { return null }
}

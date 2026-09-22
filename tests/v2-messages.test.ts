import assert from "node:assert/strict"
import { buildParts, normalizeMessages, contentText, createPanelApi } from "../src/v2/panel-api"
import { computeLivePerf, computePerfSample } from "../src/perf"
import { collectTokenDist } from "../src/dist"

// ── contentText ────────────────────────────────────────────────────────────
assert.equal(contentText([{ type: "text", text: "a" }, { type: "file", uri: "file:///x" }]), "a\nfile:///x")
assert.equal(contentText(undefined), "")

// ── buildParts：text / reasoning / tool ─────────────────────────────────────
{
  const rec = {
    id: "a1", type: "assistant", cost: 0.25, time: { created: 100, streamed: 200, completed: 500 },
    content: [
      { type: "text", text: "hello" },
      { type: "reasoning", text: "think", time: { created: 150, completed: 190 } },
      { type: "tool", id: "t1", name: "bash", time: { created: 210, ran: 220, completed: 260 },
        state: { status: "completed", input: { cmd: "ls" }, content: [{ type: "text", text: "out" }], metadata: { name: "x" } } },
    ],
  }
  const parts = buildParts(rec)
  const text = parts.find((p) => p.type === "text")
  assert.equal(text.text, "hello")
  assert.equal(text.time, undefined) // 历史 text part 无首字时间戳（不再用 streamed 伪造）
  const reasoning = parts.find((p) => p.type === "reasoning")
  assert.deepEqual(reasoning.time, { start: 150, end: 190 })
  const tool = parts.find((p) => p.type === "tool")
  assert.equal(tool.tool, "bash")
  assert.equal(tool.state.output, "out")
  assert.deepEqual(tool.state.time, { start: 220, end: 260 })
  const step = parts.find((p) => p.type === "step-finish")
  assert.equal(step.cost, 0.25)
}

// ── buildParts：error 工具 / skill 消息 / user 文本 ──────────────────────────
{
  const errParts = buildParts({ id: "a2", type: "assistant", content: [
    { type: "tool", id: "t2", name: "read", state: { status: "error", error: { message: "boom" } } },
  ] })
  assert.equal(errParts.find((p) => p.type === "tool").state.output, "boom")

  const skillParts = buildParts({ id: "s1", type: "skill", name: "pdf", text: "skill body" })
  const sk = skillParts.find((p) => p.type === "tool")
  assert.equal(sk.tool, "skill")
  assert.equal(sk.state.metadata.name, "pdf")
  assert.equal(sk.state.output, "skill body")

  const userParts = buildParts({ id: "u1", type: "user", text: "hi" })
  assert.equal(userParts[0].type, "text")
  assert.equal(userParts[0].text, "hi")
}

// ── normalizeMessages：role/provider/model/cost 展开与回合 parentID 链 ───────
{
  const raw = [
    { id: "u1", type: "user", text: "q" },
    { id: "a1", type: "assistant", finish: "tool-calls", model: { providerID: "p", id: "m" }, cost: 0.1,
      content: [{ type: "tool", id: "t1", name: "bash", state: { status: "completed", input: {}, content: [] } }] },
    { id: "a2", type: "assistant", finish: "stop", model: { providerID: "p", id: "m" }, cost: 0.2, content: [{ type: "text", text: "done" }] },
    { id: "a3", type: "assistant", finish: "stop", model: { providerID: "p", id: "m" }, cost: 0.3, content: [] },
  ]
  const { messages, parts } = normalizeMessages(raw)
  assert.equal(messages[0].role, "user")
  assert.equal(messages[1].role, "assistant")
  assert.equal(messages[1].providerID, "p")
  assert.equal(messages[1].modelID, "m")
  assert.equal(messages[1].parentID, "a1") // 回合起点
  assert.equal(messages[2].parentID, "a1") // 同回合（a1 finish=tool-calls）
  assert.equal(messages[3].parentID, "a3") // 新回合（a2 finish=stop 终止）
  assert.equal(messages[1].cost, 0.1)
  assert.ok(parts.get("a1")?.some((p) => p.type === "tool"))
  assert.ok(parts.get("a2")?.some((p) => p.type === "step-finish"))
}

// ── error 视为回合终止 ───────────────────────────────────────────────────────
{
  const { messages } = normalizeMessages([
    { id: "a1", type: "assistant", finish: "stop", error: { message: "x" }, content: [] },
    { id: "a2", type: "assistant", finish: "stop", content: [] },
  ])
  assert.equal(messages[1].parentID, "a2")
}

// ── 实时首字注入：text part 使用事件捕获的 textStart（v2 实时行必需）─────────
{
  const rec = {
    id: "a1", type: "assistant", time: { created: 100, streamed: 900 },
    content: [{ type: "text", text: "hi" }],
  }
  // 无 textStart（历史数据，无从得知首字）→ 留空，不用 streamed 伪造（否则 TTFT≈整段生成时长）
  assert.equal(buildParts(rec)[0].time, undefined)
  // 有 textStart（实时事件捕获）→ 使用真实首字时刻
  assert.equal(buildParts(rec, 130)[0].time.start, 130)
  const { parts } = normalizeMessages([rec], () => 140)
  assert.equal(parts.get("a1")?.[0].time.start, 140)
  // 历史 text-only 步：不计入性能样本（而非给出被 streamed 撑大的假 TTFT）
  assert.equal(
    computePerfSample(
      { id: "a1", time: { created: 100, completed: 900 }, tokens: { input: 1, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } } as any,
      buildParts(rec) as any,
    ),
    null,
  )
}

// ── 工具状态归一化：v2 "streaming"（参数流式期）→ V1 "pending" ──────────────
{
  const streaming = buildParts({
    id: "a3", type: "assistant",
    content: [{ type: "tool", id: "t3", name: "bash", time: { created: 300 },
      state: { status: "streaming", input: '{"cmd":"l' } }],
  }).find((p) => p.type === "tool")
  assert.equal(streaming.state.status, "pending")
  assert.equal(streaming.state.raw, '{"cmd":"l')
  assert.equal(streaming.state.time.start, 300)
  const done = buildParts({
    id: "a4", type: "assistant",
    content: [{ type: "tool", id: "t4", name: "read", state: { status: "completed", input: {}, content: [] } }],
  }).find((p) => p.type === "tool")
  assert.equal(done.state.status, "completed")
}

// ── 回归：v2 技能是独立 role=skill 消息，分布扫描须能识别（合成 tool part）────
{
  const { messages, parts } = normalizeMessages([
    { id: "u1", type: "user", text: "load the pdf skill" },
    { id: "s1", type: "skill", name: "pdf", text: "skill body contents" },
  ])
  const api = {
    state: {
      part: (id: string) => parts.get(id) ?? [],
      config: {},
    },
  } as unknown as Parameters<typeof collectTokenDist>[0]
  const out = collectTokenDist(api, messages as any, undefined)
  assert.deepEqual(out.skills.map((s) => s.name), ["pdf"])
  assert.ok(out.skills[0].tokens > 0)
  assert.ok(out.dist.toolResult > 0)
}

// ── createPanelApi：就地增长的内容必须使归一化缓存失效（实时行回归）─────────
// 上游 Solid `produce` 就地改内容、外层数组引用不变；若缓存只比对引用，实时行读到的
// 文本会停在首次归一化的空串 → estTok=0 → 速度记 null，思考期只显示「首字」。
{
  const raw: any[] = [{ id: "a1", type: "assistant", time: { created: 1000 }, content: [] }]
  const listeners: ((e: any) => void)[] = []
  const onHandlers = new Map<string, ((e: any) => void)[]>()
  const stores = new Map<string, { value: any }>()
  const context: any = {
    data: {
      on(type: string, h: (e: any) => void) {
        const arr = onHandlers.get(type) ?? []
        arr.push(h)
        onHandlers.set(type, arr)
        return () => {}
      },
      listen(h: (e: any) => void) { listeners.push(h); return () => {} },
      session: {
        message: { list: () => raw, get: () => undefined },
        status: () => "running",
        get: () => undefined,
      },
      location: { model: { list: () => [] }, agent: { list: () => [] } },
    },
    storage: {
      store(key: string, opts: { initial: any }) {
        if (!stores.has(key)) stores.set(key, { value: opts.initial })
        const s = stores.get(key)!
        return [s, async (fn: (d: any) => void) => fn(s)] as const
      },
    },
  }
  const emit = (type: string, ev: any) => {
    for (const h of listeners) h({ name: type, details: { ...ev, type } })
    for (const h of onHandlers.get(type) ?? []) h(ev)
  }
  const api = createPanelApi(context)
  const origNow = Date.now
  Date.now = () => 3000
  try {
    const rp: any = { type: "reasoning", text: "", time: { created: 1200 } }
    raw[0].content.push(rp)
    emit("session.reasoning.started", { created: 1200, data: { assistantMessageID: "a1" } })
    // 先归一化一次（此时思考文本为空）填充缓存
    api.state.session.messages("s1")
    assert.equal((api.state.part("a1")[0] as any).text, "")
    // 就地增长 + delta 事件（每个 session.* 事件都会使缓存失效）
    for (let i = 0; i < 40; i++) {
      rp.text += "思考内容"
      emit("session.reasoning.delta", { created: 1200, data: { assistantMessageID: "a1", delta: "思考内容" } })
    }
    api.state.session.messages("s1") // 内容变化后重新归一化（真实路径先 messages 再 part）
    assert.equal((api.state.part("a1")[0] as any).text, "思考内容".repeat(40))
    const lv = computeLivePerf(api, "s1")
    assert.ok(lv && lv.phase === "streaming")
    if (lv && lv.phase === "streaming") assert.ok(lv.tps !== null, "思考流式期应给出速度")
  } finally {
    Date.now = origNow
  }
}

console.log("v2 messages tests passed")
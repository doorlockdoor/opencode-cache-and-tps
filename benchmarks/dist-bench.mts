// 分布缓存基准：冷扫描、未变化扫描、流式更新、工具完成，
// 以及无缓存基线和仅使用时间戳的性能聚合。
// 运行 npm run bench:dist，比较相对耗时，不依赖特定机器的绝对时间。
// 冷扫描须在预热前执行；耗时不作为 CI 断言。
import { collectTokenDist } from "../src/dist"
import { aggregatePerf } from "../src/perf"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

// ── 重会话夹具：600 轮 × (user 1KB + 3 工具[输入1KB/输出5KB] + assistant 文本 2KB) ≈ 12MB ──
// 夹具刻意用重复字符而非真实文本：estimateTokens 是逐字符吞吐型扫描，
// 字符分布不影响量级；真实会话的差异主要体现在文本总量上。
const RAW = "x".repeat(1024)
const OUT = "y".repeat(5 * 1024)

function buildSession() {
  const partsByMsg: Record<string, any[]> = {}
  const msgs: any[] = []
  for (let i = 0; i < 600; i++) {
    const uid = `u${i}`,
      aid = `a${i}`
    msgs.push({ id: uid, role: "user", time: { created: i * 100_000 } })
    partsByMsg[uid] = [
      { type: "text", text: "u".repeat(1024), synthetic: false, ignored: false, id: uid + "t" },
    ]
    msgs.push({
      id: aid,
      role: "assistant",
      time: { created: i * 100_000 + 5, completed: i * 100_000 + 50 },
      parentID: `p${i}`,
      tokens: { input: 1000, output: 300, reasoning: 100, cache: { read: 0, write: 0 } },
    })
    partsByMsg[aid] = [
      ...Array.from({ length: 3 }, (_, j) => ({
        type: "tool",
        tool: "bash",
        id: aid + "tl" + j,
        state: {
          status: "completed",
          raw: RAW,
          output: OUT,
          time: { start: i * 100_000 + 10, end: i * 100_000 + 20 },
        },
      })),
      { type: "text", text: "x".repeat(2048), id: aid + "tx", time: { start: i * 100_000 + 6 } },
    ]
  }
  return { msgs, partsByMsg }
}

const session = buildSession()
let gen = 0
function apiOf(map: Record<string, any[]>): TuiPluginApi {
  return { state: { part: (id: string) => map[id] ?? [] } } as unknown as TuiPluginApi
}

// 旧行为基线：所有消息 id 换新 → 缓存全 miss → 全量重扫
function baselineRun() {
  gen++
  const map: Record<string, any[]> = {}
  const msgs = session.msgs.map((m: any) => {
    const id = `${m.id}@${gen}`
    map[id] = session.partsByMsg[m.id]
    return { ...m, id }
  })
  return collectTokenDist(apiOf(map), msgs as never, undefined)
}

function bench(name: string, fn: () => unknown, n: number) {
  fn() // 预热（含首次建缓存）
  const ts: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn()
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  const med = ts[Math.floor(n / 2)]
  console.log(
    `${name}: 中位 ${med.toFixed(3)}ms  (min ${ts[0].toFixed(3)} / max ${ts[n - 1].toFixed(3)}, n=${n})`,
  )
  return med
}

console.log(
  `会话规模: ${session.msgs.length} 消息, 文本总量 ≈ ${((600 * 20 + 300) / 1024).toFixed(2)}MB`,
)

const sessionApi = apiOf(session.partsByMsg)

// 1. 冷启动（进程首次调用，缓存空——须在最前测量，bench 的预热会污染）
{
  const t0 = performance.now()
  collectTokenDist(sessionApi, session.msgs as never, undefined)
  console.log(`1 冷启动（全量扫描 ≈ 旧行为单次）: ${(performance.now() - t0).toFixed(2)}ms`)
}

// 2. 热重建：无变化（流式期间绝大多数重算的情形）
const warm = bench(
  "2 热重建（无变化，缓存全命中）",
  () => collectTokenDist(sessionApi, session.msgs as never, undefined),
  30,
)

// 3. 流式模拟：尾 assistant 文本每轮 +1KB（指纹应不感知 → 不重扫）
{
  const last = session.partsByMsg.a599
  const tp = last[last.length - 1] as { text: string }
  let i = 0
  const t = bench(
    "3 流式增量（尾消息 text +1KB/轮）",
    () => {
      tp.text = "x".repeat(2048 + (++i % 64) * 1024)
      return collectTokenDist(sessionApi, session.msgs as never, undefined)
    },
    30,
  )
  console.log(`   → 指纹稳定，成本 ≈ 热重建（${Math.max(t, warm).toFixed(3)}ms 级）`)
}

// 4. 工具完成模拟：尾 assistant 每轮新增一个已完成工具 part（仅该消息重扫）
{
  const last = session.partsByMsg.a599
  let j = 0
  bench(
    "4 工具完成（尾消息新增 part → 单消息重扫）",
    () => {
      last.push({
        type: "tool",
        tool: "bash",
        id: "extra" + j++,
        state: { status: "completed", raw: RAW, output: OUT, time: { start: 1, end: 2 } },
      })
      return collectTokenDist(sessionApi, session.msgs as never, undefined)
    },
    10,
  )
}

// 5. 旧行为基线：缓存全 miss 全量重扫（≈ 优化前每次事件重算的成本）
const base = bench("5 旧行为基线（无缓存全量重扫）", () => baselineRun(), 5)

console.log(
  `\n收益：热重建 vs 旧基线 = ${base < 0.001 ? "∞" : (base / Math.max(warm, 0.0001)).toFixed(0)}×  (${base.toFixed(1)}ms → ${warm.toFixed(3)}ms/次)`,
)
console.log(
  `旧基线在 20Hz 事件流下 ≈ ${(base * 20).toFixed(0)}ms/s CPU；节流后 10Hz × 热重建 ≈ ${(warm * 10).toFixed(1)}ms/s`,
)
// 回退信号（宽松、只警告不 asserts——时序在 CI/负载下会随机假红，见文件头【约定】）：
// 缓存有效时节流尖峰应远低于旧基线重扫；热重建 ≥ 旧基线 50% ≈ 缓存近乎永远 miss
if (warm > 0 && warm >= base * 0.5) {
  console.log(
    `! 回退信号：热重建 (${warm.toFixed(2)}ms) ≥ 旧基线 (${base.toFixed(1)}ms) 的 50%——指纹漏效/缓存策略失效，回看 src/dist.ts`,
  )
}

// 6. 参照：性能聚合（同一会话）
bench(
  "6 aggregatePerf（1200 消息，参照）",
  () => aggregatePerf(sessionApi, session.msgs as never),
  50,
)

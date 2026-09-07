// ---------------------------------------------------------------------------
// perf/TPS 侧校准探针 —— computePerfSample 在真实会话上的回放验证
// ---------------------------------------------------------------------------
//
// 【简介】
// tokenize-calibrate.mts 校准 estimateTokens 的密度参数；本脚本是它对偶的
// 另一半：用真实 opencode.db 的历史 assistant 消息 + part 时间戳直接回放
// 精确采样管线（computePerfSample 唯一实现，直接 import 不复制逻辑），
// 输出 TPS / TTFT / 延迟的分布与守卫命中率。用于验证：
//   - 数据形状变化（opencode 改 part/时间戳结构）后采样的崩溃与量级合理性
//   - 守卫（MIN_GEN_MS / BUFFER_MS_PER_TOKEN / BUFFERED_*）在真实负载下的
//     命中率是否漂移——大比例 TPS 记 null 或样本全被跳过 = 采样不可用信号
//   - 各模型 TPS / TTFT / 延迟中位数是否符合实际体验（跨模型混合会失真，
//     故按 provider/model 分组，与 tokenize-calibrate.mts 同口径）
//
// 【如何执行】npm run bench:perf（读本机 opencode.db，无需构建）
//
// 【判读】
//   - 每组 "TPS 记 null" 比例显著上升：说明守卫在误杀，回看 src/perf.ts 的
//     MIN_GEN_MS / BUFFER_MS_PER_TOKEN / BUFFERED_* 阈值；该轮真实负载下的
//     误杀率锚点写入 src/perf.ts 常量注释（正常流式 deepseek 1/586 步）
//   - TPS 中位数若所有模型都接近或 10x 抖动：检查时间戳字段取向或区间钳位
//   - 每组样本占比变动属正常（模型路由随使用时间演化），关注量级而非精确值
//
// 【数据来源】本机 ~/.local/share/opencode/opencode.db（同 tokenize-calibrate.mts，
// 可用 OPCODE_CALIBRATE_DB 环境变量指向其他路径）。取最近 200 会话的
// assistant 消息；无数据时直接退出。
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import type { AssistantMessage } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { computePerfSample } from "../src/perf"

const dbFile = process.env.OPCODE_CALIBRATE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
if (!fs.existsSync(dbFile)) {
  console.log(`未找到 opencode 数据库 (${dbFile})；可用环境变量 OPCODE_CALIBRATE_DB 指向其他路径后重跑。`)
  process.exit(0)
}
const db = new DatabaseSync(dbFile)

const sessions = db.prepare("SELECT id FROM session ORDER BY time_updated DESC LIMIT 200").all() as { id: string }[]
if (!sessions.length) {
  console.log("最近会话为空，无样本可校准。")
  process.exit(0)
}
const ph = sessions.map(() => "?").join(",")
const msgs = db.prepare(`SELECT id, time_created, data FROM message WHERE session_id IN (${ph}) AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC`).all(...sessions.map((s) => s.id)) as { id: string; time_created: number; data: string }[]

function median(vals: readonly number[]): number {
  const s = [...vals].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

interface Group {
  n: number       // 有效样本数（computePerfSample 非 null）
  skip: number    // 被采样排除（error/summary/无 token/无首 part 等）
  nullTps: number // 样本有效但守卫记 TPS null
  tps: number[]
  ttft: number[]
  lat: number[]
}
const groups = new Map<string, Group>()
const groupOf = (key: string) => {
  let g = groups.get(key)
  if (!g) { g = { n: 0, skip: 0, nullTps: 0, tps: [], ttft: [], lat: [] }; groups.set(key, g) }
  return g
}

const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ?")
let minT = Infinity
let maxT = 0
for (const row of msgs) {
  const d = JSON.parse(row.data) as Record<string, unknown>
  if (row.time_created) {
    const t = new Date(row.time_created).getTime()
    if (t < minT) minT = t
    if (t > maxT) maxT = t
  }
  const key = [d.providerID ?? "?", d.modelID ?? "?"].join(" | ")
  const g = groupOf(key)
  const parts = partStmt.all(row.id)
    .map((p) => JSON.parse((p as { data: string }).data)) as Part[]
  const sample = computePerfSample(d as unknown as AssistantMessage, parts)
  if (!sample) { g.skip++; continue }
  g.n++
  if (sample.tps === null) g.nullTps++
  else g.tps.push(sample.tps)
  g.ttft.push(sample.ttft)
  g.lat.push(sample.latency)
}

const fmtRange = () => {
  if (minT === Infinity) return "n/a"
  const a = new Date(minT).toLocaleDateString("zh-CN"), b = new Date(maxT).toLocaleDateString("zh-CN")
  return a === b ? a : `${a} ~ ${b}`
}

const totalN = [...groups.values()].reduce((s, g) => s + g.n, 0)
const totalSkip = [...groups.values()].reduce((s, g) => s + g.skip, 0)
const allTps = [...groups.values()].flatMap((g) => g.tps)
console.log(`opencode 样本库: ${sessions.length} 会话, 数据范围 ${fmtRange()}`)
console.log(`assistant 消息: 有效样本 ${totalN} / 采样排除 ${totalSkip} / TPS 非 null ${allTps.length}`)

for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const nullPct = g.n ? ((g.nullTps / g.n) * 100).toFixed(1) : "0.0"
  console.log(`\n${key}:`)
  if (!g.n) { console.log("  (无有效样本)"); continue }
  console.log(`  样本 n=${g.n}  采样排除=${g.skip}  TPS 记 null=${g.nullTps} (${nullPct}%)  tpsN=${g.tps.length}`)
  const tpsMed = g.tps.length ? `${median(g.tps).toFixed(1)} tok/s` : "n/a"
  console.log(`  TPS 中位=${tpsMed}   TTFT 中位=${median(g.ttft).toFixed(0)}ms   净延迟中位=${median(g.lat).toFixed(0)}ms`)
}
console.log("\n判读：TPS 中位应在各模型量级合理（10-200 tok/s 级）、null 比例稳定；若整体 null 比例 >50% 或中位异常，回看守卫阈值与采样口径（见文件头注释）")

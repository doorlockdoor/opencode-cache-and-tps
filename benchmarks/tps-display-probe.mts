// 回放底栏速度口径：A 隐藏无效速度；B 整组回退；C 只回退速度（当前 V1/V2）。
// 阈值扫描直接使用 computePerfSample 的分子与净生成窗口，基线取当前生产阈值。
// npm run bench:display；OPCODE_CALIBRATE_DB 可指定其他 opencode.db。
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import type { Message } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { num } from "../src/tokens"
import {
  BUFFER_MS_PER_TOKEN,
  MIN_GEN_MS,
  computePerfSample,
  modelKeyOf,
  passesTpsGate,
  splitTurns,
  type PerfGateInputs,
  type PerfSample,
} from "../src/perf"

const SESSION_LIMIT = 200
/** 基线 = 当前常量（src/perf.ts MIN_GEN_MS）；扫描行与之对比看增删。 */
const BASE_FLOOR_MS = MIN_GEN_MS
/** 阈值扫描候选（ms）。 */
const FLOORS = [150, 200, 250, 300, 400, 500, 750]

const dbFile =
  process.env.OPCODE_CALIBRATE_DB ||
  path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
if (!fs.existsSync(dbFile)) {
  console.log(
    `未找到 opencode 数据库 (${dbFile})；可用环境变量 OPCODE_CALIBRATE_DB 指向其他路径后重跑。`,
  )
  process.exit(0)
}
const db = new DatabaseSync(dbFile, { readOnly: true })
try {
  const sessions = db
    .prepare(`SELECT id FROM session ORDER BY time_updated DESC LIMIT ${SESSION_LIMIT}`)
    .all() as { id: string }[]
  if (!sessions.length) {
    console.log("最近会话为空，无样本可回放。")
    process.exit(0)
  }
  const ph = sessions.map(() => "?").join(",")
  const rows = db
    .prepare(
      `SELECT id, session_id, data FROM message WHERE session_id IN (${ph}) ORDER BY time_created ASC, id ASC`,
    )
    .all(...sessions.map((s) => s.id)) as { id: string; session_id: string; data: string }[]
  const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ?")
  const partsOf = (mid: string): Part[] =>
    partStmt.all(mid).map((p) => JSON.parse((p as { data: string }).data) as Part)

  function median(vals: readonly number[]): number {
    if (!vals.length) return NaN
    const s = [...vals].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  /** 分位数（最近秩，p 为 0~100）。 */
  function pctile(vals: readonly number[], p: number): number {
    if (!vals.length) return NaN
    const s = [...vals].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]
  }
  const fmtMs = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(0)}ms` : "n/a")
  const fmtTok = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : "n/a")
  const fmtX = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)}x` : "n/a")
  const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a")

  // SQL 已按 time_created 升序，逐会话保持顺序（回合切分依赖顺序）。
  // data 列不含消息 id（id 是行字段），而 part 查询按 id 取——回填后再交给采样。
  const bySession = new Map<string, Message[]>()
  for (const r of rows) {
    const msg = JSON.parse(r.data) as Message & { id?: string }
    msg.id = r.id
    const list = bySession.get(r.session_id)
    if (list) list.push(msg)
    else bySession.set(r.session_id, [msg])
  }

  /** 步的特征分布：tok=输出+推理 token，gen=净生成窗口。 */
  interface Feat {
    n: number
    tok: number[]
    ttft: number[]
    lat: number[]
    gen: number[]
  }
  const feat = (): Feat => ({ n: 0, tok: [], ttft: [], lat: [], gen: [] })
  const keep = feat() // 样本有效且 TPS 非 null
  const drop = feat() // 样本有效但守卫记 TPS null

  /** 阈值扫描用：每个有效样本一条，isObs 标记它是所在回合的最后一条有效样本。 */
  interface StepRec {
    model: string
    genMs: number
    genTok: number
    isObs: boolean
  }
  const sessionsRec: StepRec[][] = []

  const stat = {
    sessions: 0,
    turns: 0, // 回合末观察点（该回合至少有一条有效样本）
    turnsSkipped: 0, // 回合内无任何有效样本（显示口径无值可显示，不计入观察）
    valid: 0, // 有效样本步数
    nullTps: 0, // 其中 TPS 记 null 的步数
    obsNull: 0, // 观察点中「回合末样本 TPS 记 null」（= A 失速度段 = B/C 需回退）
    backSteps: [] as number[], // B 回退步数（仅回退发生时）
    backMs: [] as number[], // 被显示样本与最新样本的 created 差（陈旧度）
    backTtft: [] as number[], // B.ttft − C.ttft
    backLat: [] as number[], // B.latency − C.latency
    crossTurn: 0, // 回退跨回合次数
    hiddenAll: 0, // B 无样本可显示（会话内无 TPS 非 null 样本）
    shortGuard: 0, // 净生成窗口 < MIN_GEN_MS
    burstGuard: 0, // 其余无效速度（主要是每 token 下限）
  }
  const byModel = new Map<
    string,
    {
      valid: number
      nullTps: number
      obs: number
      obsNull: number
      tps: number[]
      msPerTok: number[]
    }
  >()
  const modelOf = (key: string) => {
    let g = byModel.get(key)
    if (!g) {
      g = { valid: 0, nullTps: 0, obs: 0, obsNull: 0, tps: [], msPerTok: [] }
      byModel.set(key, g)
    }
    return g
  }

  for (const msgs of bySession.values()) {
    stat.sessions++
    const turns = splitTurns(msgs)
    // 会话级有效样本序列：显示口径的唯一来源（computePerfSample 非 null）
    const seq: {
      sample: PerfSample
      turn: number
      created: number
      model: string
      rec: StepRec
    }[] = []
    const recs: StepRec[] = []
    turns.forEach((steps, ti) => {
      let turnHasSample = false
      for (const am of steps) {
        const parts = partsOf(am.id)
        const gateInputs: PerfGateInputs = { genTok: 0, genMs: 0 }
        const sample = computePerfSample(am, parts, gateInputs)
        if (!sample) continue
        const model = modelKeyOf(am) ?? "?"
        const g = modelOf(model)
        const { genTok, genMs: gen } = gateInputs
        if ((sample.tps !== null) !== passesTpsGate(genTok, gen))
          throw new Error(`TPS 有效性判断不一致： ${am.id}`)
        const outTok = num(am.tokens?.output)
        const rzTok = num(am.tokens?.reasoning)
        const rec: StepRec = { model, genMs: gen, genTok, isObs: false }
        recs.push(rec)
        seq.push({ sample, turn: ti, created: am.time?.created ?? 0, model, rec })
        turnHasSample = true
        stat.valid++
        g.valid++
        const tok = outTok + rzTok
        const target = sample.tps === null ? drop : keep
        target.n++
        target.tok.push(tok)
        target.ttft.push(sample.ttft)
        target.lat.push(sample.latency)
        target.gen.push(gen)
        if (sample.tps === null) {
          stat.nullTps++
          g.nullTps++
          if (gen < BASE_FLOOR_MS) stat.shortGuard++
          else stat.burstGuard++
        } else {
          g.tps.push(sample.tps)
          g.msPerTok.push(genTok > 0 ? gen / genTok : NaN)
        }
      }
      if (!turnHasSample) {
        stat.turnsSkipped++
        return
      }
      // ── 回合结束快照：此刻底栏显示的样本 ──
      stat.turns++
      const c = seq[seq.length - 1]
      c.rec.isObs = true
      const cg = modelOf(c.model)
      cg.obs++
      if (c.sample.tps === null) {
        cg.obsNull++
        stat.obsNull++
      }
      // A/C 的失效条件就是 c.sample.tps === null：A 隐藏速度段、B/C 需回退取更早样本
      let bi = -1
      for (let i = seq.length - 1; i >= 0; i--) {
        if (seq[i].sample.tps !== null) {
          bi = i
          break
        }
      }
      if (bi < 0) {
        stat.hiddenAll++
        return
      }
      const back = seq.length - 1 - bi
      if (back <= 0) return
      const b = seq[bi]
      stat.backSteps.push(back)
      stat.backMs.push(c.created - b.created)
      stat.backTtft.push(b.sample.ttft - c.sample.ttft)
      stat.backLat.push(b.sample.latency - c.sample.latency)
      if (b.turn !== c.turn) stat.crossTurn++
    })
    sessionsRec.push(recs)
  }

  console.log(`opencode 样本库: ${stat.sessions} 会话（每回合末取一次显示快照）`)
  console.log(
    `有效样本 ${stat.valid} 步（TPS 记 null ${stat.nullTps} = ${pct(stat.nullTps, stat.valid)}）`,
  )
  console.log(
    `回合末观察点 ${stat.turns}（另有 ${stat.turnsSkipped} 个回合无任何有效样本，不计入）`,
  )

  const back = stat.backSteps.length
  console.log(`\n[1] 失效触发率（三种口径在同一批观察点上触发）`)
  console.log(
    `  回合末样本 TPS 记 null：${stat.obsNull} / ${stat.turns} = ${pct(stat.obsNull, stat.turns)}`,
  )
  console.log(`   → A：这些观察点速度段整个缺失（首字/延迟照常）`)
  console.log(`   → B：整组回退 ${back} 次；无有效速度时整组隐藏 ${stat.hiddenAll} 次`)
  console.log(`   → C：首字/延迟保持最新；速度回退 ${back} 次，无可回退值 ${stat.hiddenAll} 次`)

  if (back) {
    const one = stat.backSteps.filter((n) => n === 1).length
    const many = back - one
    console.log(`\n[2] B 回退后的陈旧度（回退 ${back} 次）`)
    console.log(
      `  回退步数：1 步 ${one} 次（${pct(one, back)}）／≥2 步 ${many} 次（${pct(many, back)}）`,
    )
    console.log(`  跨回合回退：${stat.crossTurn} 次（占回退 ${pct(stat.crossTurn, back)}）`)
    console.log(
      `  时间差（被显示样本 vs 最新样本的 created）：中位 ${fmtMs(median(stat.backMs))}  最大 ${fmtMs(Math.max(...stat.backMs))}`,
    )
    console.log(
      `  首字差 B−C：中位 ${fmtMs(median(stat.backTtft))}   延迟差 B−C：中位 ${fmtMs(median(stat.backLat))}`,
    )
  }
  console.log(
    `\n[3] B 整组隐藏：${stat.hiddenAll} 次（占观察点 ${pct(stat.hiddenAll, stat.turns)}）`,
  )
  console.log(`   （这些观察点 A/C 仍能显示首字/延迟，B 会把整组三段一起隐掉）`)
  console.log(
    `\n[4] 无效速度分类：净生成 <${BASE_FLOOR_MS}ms ${stat.shortGuard} 次／其余 ${stat.burstGuard} 次`,
  )

  console.log(`\n[5] 被剔除步 vs 保留步的特征（中位数）`)
  console.log(`           步数    输出token   首字     延迟      净生成`)
  console.log(
    `  保留  ${String(keep.n).padStart(7)}  ${fmtTok(median(keep.tok)).padStart(9)}  ${fmtMs(median(keep.ttft)).padStart(7)}  ${fmtMs(median(keep.lat)).padStart(8)}  ${fmtMs(median(keep.gen)).padStart(9)}`,
  )
  console.log(
    `  剔除  ${String(drop.n).padStart(7)}  ${fmtTok(median(drop.tok)).padStart(9)}  ${fmtMs(median(drop.ttft)).padStart(7)}  ${fmtMs(median(drop.lat)).padStart(8)}  ${fmtMs(median(drop.gen)).padStart(9)}`,
  )

  console.log(`\n[6] 分模型（按有效样本降序）`)
  for (const [key, g] of [...byModel.entries()].sort((a, b) => b[1].valid - a[1].valid)) {
    console.log(`  ${key}`)
    console.log(
      `    有效样本 ${g.valid}  TPS null ${g.nullTps} (${pct(g.nullTps, g.valid)})  回合末观察 ${g.obs}  其中 null ${g.obsNull} (${pct(g.obsNull, g.obs)})`,
    )
  }

  // ── [7] MIN_GEN_MS 阈值扫描：新增放行的步是否物理可信 ──────────────────────
  // 判定条件直接复用 src/perf.ts 的 passesTpsGate。
  // 隐含 TPS 相对该模型保留样本 TPS 中位数的倍数——接近 1~2 倍说明是真实短步。
  const modelTpsMed = new Map<string, number>()
  for (const [key, g] of byModel) modelTpsMed.set(key, median(g.tps))
  /** 复算阈值组合下的保留步数、显示失效与相对基线的增删。 */
  function evalGate(floor: number, msPerTok: number) {
    let admitted = 0
    let obsCount = 0
    let obsNull = 0
    let hiddenAll = 0
    const gained: StepRec[] = [] // 新放行：基线记 null、本组合通过
    const lost: StepRec[] = [] // 新剔除：基线通过、本组合记 null
    for (const recs of sessionsRec) {
      let passSoFar = 0
      for (const r of recs) {
        const ok = passesTpsGate(r.genTok, r.genMs, floor, msPerTok)
        const okBase = passesTpsGate(r.genTok, r.genMs)
        if (ok) {
          admitted++
          passSoFar++
        }
        if (ok && !okBase) gained.push(r)
        if (!ok && okBase) lost.push(r)
        if (r.isObs) {
          obsCount++
          if (!ok) {
            obsNull++
            if (passSoFar === 0) hiddenAll++
          }
        }
      }
    }
    const impliedOf = (r: StepRec) => (r.genMs > 0 ? (r.genTok / r.genMs) * 1000 : NaN)
    const ratiosOf = (list: StepRec[]) => {
      const out: number[] = []
      for (const r of list) {
        const med = modelTpsMed.get(r.model)
        const imp = impliedOf(r)
        if (med && Number.isFinite(med) && med > 0 && Number.isFinite(imp)) out.push(imp / med)
      }
      return out
    }
    const gr = ratiosOf(gained)
    return {
      floor,
      msPerTok,
      admitted,
      obsCount,
      obsNull,
      hiddenAll,
      gained: gained.length,
      lost: lost.length,
      gainedRecs: gained,
      lostRecs: lost,
      gainedImplied: gained.map(impliedOf).filter((v) => Number.isFinite(v)),
      gainedGenMs: gained.map((r) => r.genMs),
      gainedRatioMed: median(gr),
      gainedRatioP90: pctile(gr, 90),
      gainedRatioMax: gr.length ? Math.max(...gr) : NaN,
      gainedSuspicious: gr.filter((v) => v > 3).length,
      gainedRatioN: gr.length,
      lostImplied: lost.map(impliedOf).filter((v) => Number.isFinite(v)),
    }
  }

  console.log(
    `\n[7] MIN_GEN_MS 阈值扫描（基线 ${BASE_FLOOR_MS}ms = 现状，每 token 下限不变 = ${BUFFER_MS_PER_TOKEN}）`,
  )
  console.log(
    `  阈值      保留步   新增放行  新增隐含TPS(中位/模型中位/p90/max)  隐含TPS中位  新增genMs中位  >3×中位  回合末null率  B整组隐藏`,
  )
  for (const floor of FLOORS) {
    const r = evalGate(floor, BUFFER_MS_PER_TOKEN)
    const ratioCol = r.gainedRatioN
      ? `${fmtX(r.gainedRatioMed)}/${fmtX(r.gainedRatioP90)}/${fmtX(r.gainedRatioMax)}`
      : "n/a"
    const genMsCol = r.gainedGenMs.length ? fmtMs(median(r.gainedGenMs)) : "n/a"
    console.log(
      `  ${String(floor).padStart(4)}ms  ${String(r.admitted).padStart(7)}  ${String(r.gained).padStart(8)}  ${ratioCol.padStart(31)}  ${(r.gainedImplied.length ? `${median(r.gainedImplied).toFixed(1)} tok/s` : "n/a").padStart(11)}  ${genMsCol.padStart(12)}  ${String(r.gainedSuspicious).padStart(7)}  ${`${r.obsNull}/${r.obsCount}=${pct(r.obsNull, r.obsCount)}`.padStart(12)}  ${String(r.hiddenAll).padStart(8)}`,
    )
  }
  console.log(
    `   （新增放行 = 本阈值通过、基线记 null 的步；>3×中位 = 新增放行中隐含 TPS 超该模型中位数 3 倍的步数；隐含TPS = genTok/genMs×1000）`,
  )

  // ── [8] 保留样本的 ms/token 经验下界：BUFFER_MS_PER_TOKEN 的锚点 ───────────
  console.log(
    `\n[8] 保留样本（TPS 非 null）的 ms/token 下界 → BUFFER_MS_PER_TOKEN=${BUFFER_MS_PER_TOKEN} 是否过松`,
  )
  console.log(`  模型                                        n      p1       p5      p50`)
  for (const [key, g] of [...byModel.entries()].sort((a, b) => b[1].valid - a[1].valid)) {
    const v = g.msPerTok.filter((x) => Number.isFinite(x) && x > 0)
    if (v.length < 5) {
      console.log(`  ${key.padEnd(42)}  ${String(v.length).padStart(5)}  (样本不足)`)
      continue
    }
    console.log(
      `  ${key.padEnd(42)}  ${String(v.length).padStart(5)}  ${pctile(v, 1).toFixed(2).padStart(7)}  ${pctile(v, 5).toFixed(2).padStart(7)}  ${median(v).toFixed(2).padStart(7)}`,
    )
  }
  const allMsPerTok = [...byModel.values()]
    .flatMap((g) => g.msPerTok)
    .filter((x) => Number.isFinite(x) && x > 0)
  if (allMsPerTok.length) {
    console.log(
      `  全部保留样本：n=${allMsPerTok.length}  p1=${pctile(allMsPerTok, 1).toFixed(2)}  p5=${pctile(allMsPerTok, 5).toFixed(2)}  p50=${median(allMsPerTok).toFixed(2)}  （p1 即观测量级下的速度上限：1/p1 tok/ms）`,
    )
  }

  // ── [9] 二维组合：绝对门槛 × 每 token 下限 ────────────────────────────────
  // 「新增放行」= 救回被误杀的短步（隐含 TPS 应落在模型分布内）；「新增剔除」= 拦下
  // 基线放过的可疑步（隐含 TPS 应显著偏高）。两者一起看才知道该怎么调。
  console.log(`\n[9] 组合扫描：绝对门槛 × 每 token 下限（新增放行 = 救回；新增剔除 = 拦下）`)
  console.log(
    `  门槛     ms/tok   保留步  新增放行  放行隐含TPS中位  放行>3×中位  新增剔除  剔除隐含TPS中位  回合末null率`,
  )
  for (const floor of [200, 300, 400, 500]) {
    for (const msPerTok of [0.2, 0.5, 1.0, 1.5]) {
      const r = evalGate(floor, msPerTok)
      const gMed = r.gainedImplied.length ? `${median(r.gainedImplied).toFixed(1)} tok/s` : "n/a"
      const lMed = r.lostImplied.length ? `${median(r.lostImplied).toFixed(1)} tok/s` : "n/a"
      console.log(
        `  ${String(floor).padStart(4)}ms  ${msPerTok.toFixed(2).padStart(6)}  ${String(r.admitted).padStart(7)}  ${String(r.gained).padStart(8)}  ${gMed.padStart(15)}  ${String(r.gainedSuspicious).padStart(11)}  ${String(r.lost).padStart(8)}  ${lMed.padStart(15)}  ${`${r.obsNull}/${r.obsCount}=${pct(r.obsNull, r.obsCount)}`.padStart(12)}`,
      )
    }
  }

  // ── [10] 增删按模型分解：可疑步是否集中在某条路由（缓冲网关 vs 直连） ──────
  console.log(`\n[10] 增删按模型分解（[9] 的「>3×中位」是否集中在某条路由）`)
  for (const combo of [
    [300, 0.2],
    [300, 1.0],
    [200, 1.0],
  ] as const) {
    const floor = combo[0]
    const msPerTok = combo[1]
    const r = evalGate(floor, msPerTok)
    console.log(
      `  ${floor}ms / ${msPerTok.toFixed(2)} ms·token⁻¹：新增放行 ${r.gained}，新增剔除 ${r.lost}`,
    )
    const per = new Map<string, number[]>()
    for (const rec of r.gainedRecs) {
      const imp = rec.genMs > 0 ? (rec.genTok / rec.genMs) * 1000 : NaN
      const arr = per.get(rec.model)
      if (arr) arr.push(imp)
      else per.set(rec.model, [imp])
    }
    for (const [key, v] of [...per.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const med = modelTpsMed.get(key)
      const vals = v.filter((x) => Number.isFinite(x))
      const sus = med && Number.isFinite(med) ? vals.filter((x) => x > 3 * med).length : 0
      console.log(
        `    放行 ${String(vals.length).padStart(3)}  ${key}  隐含TPS中位 ${fmtTok(median(vals))} tok/s（该模型保留样本中位 ${fmtTok(med ?? NaN)}）  >3×中位 ${sus}`,
      )
    }
    const lostPer = new Map<string, number>()
    for (const rec of r.lostRecs) lostPer.set(rec.model, (lostPer.get(rec.model) ?? 0) + 1)
    for (const [key, n] of [...lostPer.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`    剔除 ${String(n).padStart(3)}  ${key}`)
  }

  console.log(
    "\n判读：回退集中在 1 步且跨回合占比低 → B 的代价仅为「同回合上一步」；跨回合占比高或时间差达分钟级 → 无界回溯会把上一回合的数值当本回合显示，应改为回合内有界回溯。",
  )
  console.log(
    "整组隐藏 >0 → 存在「本来能显示首字/延迟却全隐」的观察点。剔除步的 token/净生成窗口若与保留步接近 → 守卫在误杀正常步。",
  )
  console.log(
    "阈值扫描：新增放行的隐含 TPS 若普遍 ≤2× 模型中位 → 门槛偏高可下调；若新增放行里仍有远离分布的量级 → 只降绝对门槛不够，需按 [8] 的 p1 同时收紧每 token 下限（见 [9] 组合）。",
  )
} finally {
  db.close()
}

/** @jsxImportSource @opentui/solid */

import { createMemo, Show, For } from "solid-js"
import type { Context } from "./types"
import type { PanelApi, PanelSignals } from "../panel/panel-api"
import { FALLBACK, MAX_SAT, desaturateTo } from "../ui"
import { fmtCompact, formatBalanceText } from "../currency"
import { createT } from "../i18n"
import { mapTheme } from "./theme"
import { computeLivePerf, lastPerfValues, hostTurnTps, currentModelKey } from "../perf"
import { collectUsageBySession } from "../stats"
import {
  createBusyTick,
  liveStatSegs,
  liveEnabled,
  anyLiveSegment,
  pushPerfSegs,
  createPerfRefreshTick,
  type StatSeg,
} from "../live"

/**
 * v2 底部状态栏（prompt.footer.status，append）：命中率(+趋势) · Tokens · 首字 · 速度 · 延迟 · 余额。
 * 内容段由 /cache-bar 逐段开关（默认 命中/速度/工具 开）；流式期间实时块接管
 * 速度/首字/延迟 槽位显示实时值——同一段信息同一时刻只出现一次，回合内间隙冻结为
 * 最近实时值、回合结束回落精确值，与 V1（右侧实时行 + 底栏精确段）口径一致。
 * 首字/延迟取最近有效样本，输出速度独立回溯到最近一次有效值。
 * /cache-tps 的体感模式优先取宿主回合 TPS，无有效回合时回落输出速度。
 * 颜色与侧边栏同源（mapTheme → desaturateTo）。
 * 仅会话内渲染：宿主在首页 Prompt 下方也挂此插槽（sessionID 为空），此时隐藏。
 */
export function StatusView(props: {
  context: Context
  api: PanelApi
  signals: PanelSignals
  sessionID: string
}) {
  const t = createT(() => props.signals.langCode())
  const sid = () => props.sessionID

  const perfVersion = createPerfRefreshTick(props.api)

  const pal = createMemo(() => {
    const th = mapTheme(props.context.theme) as unknown as Record<string, string>
    const sat = (k: string, fb: string) => desaturateTo(th[k], MAX_SAT, fb)
    return {
      text: sat("text", FALLBACK.text),
      muted: sat("textMuted", FALLBACK.muted),
      success: sat("success", FALLBACK.success),
      warning: sat("warning", FALLBACK.warning),
      error: sat("error", FALLBACK.error),
    }
  })

  // ── 命中率 + 用量（统一口径见 src/stats.ts；与侧边栏/V1 底栏同源）──
  const stats = createMemo(() => {
    const id = sid()
    if (!id) return null
    return collectUsageBySession(props.api, id)
  })

  const hitColor = createMemo(() => {
    const r = stats()?.hitRate ?? -1
    if (r >= 85) return pal().success
    if (r >= 70) return pal().warning
    return pal().error
  })

  const trend = createMemo(() => {
    const s = stats()
    if (!s || s.prevHitRate < 0 || s.hitRate < 0) return null
    const d = s.hitRate - s.prevHitRate
    return Math.abs(d) < 0.05 ? null : d
  })

  // ── 模型过滤键（过滤关闭 / 会话未知 → null=不过滤）：精确值与精确速度段共用，
  // 避免各自调用 currentModelKey（其回退分支会遍历全部消息）──
  const modelKey = createMemo(() => {
    const id = sid()
    if (!id || !props.signals.perfModelFilter()) return null
    return currentModelKey(props.api, id)
  })

  // ── 最近精确值（口径见 perf.ts lastPerfValues：首字/延迟同源同一步，速度独立回溯）──
  const perfValues = createMemo(() => {
    const id = sid()
    if (!id) return { sample: null, tps: null }
    void perfVersion()
    return lastPerfValues(props.api, id, modelKey())
  })

  // ── 流式实时块（段开关：首字/速度/延迟/工具，默认 速度/工具 开）：busy 时接管
  // 速度/首字/延迟 精确槽位；全关或非流式时空块，走精确分支。全关时心跳不启动。──
  const anyLiveOn = createMemo(() => anyLiveSegment(props.signals))
  const liveTick = createBusyTick(props.api, sid, anyLiveOn)
  const liveSegs = createMemo<StatSeg[]>(() => {
    if (!anyLiveOn()) return []
    liveTick()
    const lv = computeLivePerf(props.api, sid())
    if (!lv) return []
    return liveStatSegs(
      lv,
      t,
      pal().muted,
      pal().text,
      props.signals.style(),
      liveEnabled(props.signals),
    )
  })

  const balanceText = createMemo(() => {
    const s = props.signals.balanceState()
    if (s.status === "ok" && s.data)
      return formatBalanceText(
        s.data,
        props.signals.balanceCurrency(),
        props.signals.exchangeRate(),
      )
    if (s.status === "loading") return "…"
    if (s.status === "error") return "\u26a0"
    return "-"
  })

  const segs = createMemo<StatSeg[]>(() => {
    const s = stats()
    const plain = props.signals.style() === "min"
    const out: StatSeg[] = []
    // 段间分隔符：仅当已有内容时插入，避免关闭首段后出现前导「·」
    const sep = () => {
      if (out.length) out.push({ text: " · ", color: pal().muted })
    }
    // 无数据（首页/新会话）时省略命中率段：宿主在所有 Prompt 下方渲染
    // footer.status，常驻「命中率 --」占位没有信息量（对齐上游 9ff55be 思路）
    if (props.signals.barShowHit() && s && s.hitRate >= 0) {
      const hr = (Math.floor(s.hitRate * 10) / 10).toFixed(1) + "%"
      if (!plain) out.push({ text: t("barHit") + " ", color: pal().muted })
      out.push({ text: hr, color: hitColor() })
      const tr = trend()
      if (tr !== null)
        out.push({
          text: " " + (tr > 0 ? "↑" : "↓") + Math.abs(tr).toFixed(1) + "%",
          color: tr > 0 ? pal().success : pal().error,
        })
    }
    if (props.signals.barShowTokens() && s) {
      const total = s.input + s.read + s.write
      if (total > 0) {
        sep()
        if (!plain) out.push({ text: t("barTok") + " ", color: pal().muted })
        out.push({ text: fmtCompact(total), color: pal().text })
      }
    }
    // 性能段槽位（固定顺序 首字 → 速度 → 延迟，与实时块、侧边栏性能区一致）：
    // 流式实时块非空时由其接管（实时值，位置不变）——computeLivePerf 回合内冻结，
    // busy 期间几乎总非空；否则显示精确值：首字/延迟取最近有效样本，速度按 /cache-tps
    // 取输出速度（最近一次有效值，可来自更早的 step）或体感速度（宿主回合聚合，缺数据回落同一值）
    const lvBlock = liveSegs()
    if (lvBlock.length > 0) {
      sep()
      out.push(...lvBlock)
    } else {
      const { sample, tps: sampleTps } = perfValues()
      // 体感模式取最近有效匹配回合；无值时回落输出速度。
      const hostTps =
        props.signals.tpsMode() === "perceived" ? hostTurnTps(props.api, sid(), modelKey()) : null
      pushPerfSegs(out, sep, {
        style: props.signals.style(),
        t,
        sample,
        tps: hostTps ?? sampleTps,
        muted: pal().muted,
        text: pal().text,
        ttft: props.signals.barShowTtft(),
        speed: props.signals.barShowSpeed(),
        lat: props.signals.barShowLat(),
      })
    }
    if (props.signals.barShowBalance() && !props.signals.balanceUnsupported()) {
      sep()
      if (!plain) out.push({ text: t("barBal") + " ", color: pal().muted })
      out.push({ text: balanceText(), color: pal().text })
    }
    return out
  })

  // 无会话（首页）不渲染：宿主在首页 Prompt 下方同样挂 footer.status（sessionID 为空）
  return (
    <Show when={sid() && props.signals.sectionBottom() && segs().length > 0}>
      <text>
        <For each={segs()}>{(sg) => <span style={{ fg: sg.color }}>{sg.text}</span>}</For>
      </text>
    </Show>
  )
}

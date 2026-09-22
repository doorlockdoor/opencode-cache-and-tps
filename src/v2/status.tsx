/** @jsxImportSource @opentui/solid */

import { createMemo, onMount, Show, For } from "solid-js"
import type { Context } from "./types"
import type { PanelApi, PanelSignals } from "../panel/panel-api"
import { KV_PREFIX } from "../panel/panel-api"
import { num } from "../tokens"
import { FALLBACK, MAX_SAT, desaturateTo } from "../ui"
import { fmtCompact, formatBalanceText } from "../currency"
import { createT } from "../i18n"
import { mapTheme } from "./theme"
import { computeLivePerf, computePerfSample, modelKeyOf, currentModelKey } from "../perf"
import { collectUsageBySession } from "../stats"
import { createBusyTick, liveStatSegs, type StatSeg } from "../live"

/**
 * v2 底部状态栏（prompt.footer.status，append）：命中率(+趋势) · Tokens · 速度/实时段 · 余额。
 * 实时段默认关闭（/cache-bar「实时」开启）：默认只显示精确 命中率/速度，每 step 完成时刷新；
 * 开启后流式期间改显实时估算。颜色与侧边栏同源（mapTheme → desaturateTo）。
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

  onMount(() => {
    try {
      const v = props.api.kv.get<boolean>(`${KV_PREFIX}.section.bottom`, true)
      props.signals.setSectionBottom(v !== false)
    } catch {}
  })

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

  // ── 最近一次精确 TPS（与侧边栏性能同源：computePerfSample） ──
  const lastTps = createMemo(() => {
    const id = sid()
    if (!id) return null
    const mk = props.signals.perfModelFilter() ? currentModelKey(props.api, id) : null
    const msgs = props.api.state.session.messages(id)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant") continue
      if (mk && modelKeyOf(m) !== mk) continue
      const s = computePerfSample(m, props.api.state.part(m.id))
      if (s && s.tps !== null) return s.tps
    }
    return null
  })

  // ── 流式实时段（默认关闭，/cache-bar「实时」开启；关闭时心跳不启动，走下方精确分支）──
  const liveEnabled = createMemo(() => props.signals.barShowSpeed() && props.signals.barShowLive())
  const liveTick = createBusyTick(props.api, sid, liveEnabled)
  const live = createMemo(() => {
    if (!liveEnabled()) return null
    liveTick()
    return computeLivePerf(props.api, sid())
  })

  const balanceText = createMemo(() => {
    const s = props.signals.balanceState()
    if (s.status === "ok" && s.data) return formatBalanceText(s.data, props.signals.balanceCurrency(), props.signals.exchangeRate())
    if (s.status === "loading") return "\u2026"
    if (s.status === "error") return "\u26a0"
    return "-"
  })

  const segs = createMemo<StatSeg[]>(() => {
    const s = stats()
    const plain = props.signals.barStyle() === "min"
    const out: StatSeg[] = []
    // 段间分隔符：仅当已有内容时插入，避免关闭首段后出现前导「·」
    const sep = () => { if (out.length) out.push({ text: " \u00b7 ", color: pal().muted }) }
    // 无数据（首页/新会话）时省略命中率段：宿主在所有 Prompt 下方渲染
    // footer.status，常驻「命中率 --」占位没有信息量（对齐上游 9ff55be 思路）
    if (props.signals.barShowHit() && s && s.hitRate >= 0) {
      const hr = (Math.floor(s.hitRate * 10) / 10).toFixed(1) + "%"
      if (!plain) out.push({ text: t("barHit") + " ", color: pal().muted })
      out.push({ text: hr, color: hitColor() })
      const tr = trend()
      if (tr !== null) out.push({ text: " " + (tr > 0 ? "\u2191" : "\u2193") + Math.abs(tr).toFixed(1) + "%", color: tr > 0 ? pal().success : pal().error })
    }
    if (props.signals.barShowTokens() && s) {
      const total = s.input + s.read + s.write
      if (total > 0) {
        sep()
        if (!plain) out.push({ text: t("barTok") + " ", color: pal().muted })
        out.push({ text: fmtCompact(total), color: pal().text })
      }
    }
    if (props.signals.barShowSpeed()) {
      // 无实时估算（默认关闭或非流式）→ 最近一次精确 TPS；开启且流式中 → 实时估算替代
      const lv = live()
      if (lv) {
        sep()
        out.push(...liveStatSegs(lv, t, pal().muted, pal().text, props.signals.liveStyle()))
      } else {
        const tps = lastTps()
        if (tps !== null) {
          sep()
          if (!plain) out.push({ text: t("barTPS") + " ", color: pal().muted })
          out.push({ text: tps.toFixed(1) + " " + t("tokS"), color: pal().text })
        }
      }
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

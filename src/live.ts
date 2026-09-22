// ── live (streaming) perf helpers ──
// 流式心跳、样式注册表与实时分段；V1 壳（输入框行）与 V2 底栏共用，避免口径漂移。
import { createSignal, createEffect, onCleanup } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk"
import { createT, type Translation } from "./i18n"
import { fmtSec } from "./ui"
import type { LivePerf } from "./perf"
import { KV_PREFIX, type PanelApi, type LiveStyle, type BarStyle } from "./panel/panel-api"

// dist/perf 纯统计在 ./dist.ts 与 ./perf.ts：不建响应式依赖，调用方须 untrack。

// 流式期间 250ms 心跳（空闲或 enabled 关闭时不建 interval）：活跃判定读
// session.status，API 不可用回退「最后一条 assistant 未完成」。返回 signal
// getter，在 memo 中读取以建立 250ms 重算依赖。
export function createBusyTick(api: PanelApi, sid: () => string, enabled?: () => boolean): () => number {
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    if (enabled && !enabled()) return
    let active = false
    try {
      const st = api.state.session.status?.(sid()) as { type?: string } | string | undefined
      const mode = typeof st === "string" ? st : st?.type
      if (mode) active = mode === "busy" || mode === "running"
      else {
        const msgs = api.state.session.messages(sid())
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role !== "assistant") continue
          const am = msgs[i] as AssistantMessage
          active = !am.time?.completed && !am.error && !am.summary
          break
        }
      }
    } catch {}
    if (!active) return
    const timer = setInterval(() => setTick((v) => v + 1), 250)
    onCleanup(() => clearInterval(timer))
  })
  return tick
}

export type StatSeg = { text: string; color: string | undefined }
type Translate = ReturnType<typeof createT>
/** 实时行/底栏样式注册表：新增样式在此追加（菜单与 KV 校验自动跟随），渲染分支与 i18n 文案手动补。 */
export const LIVE_STYLES = [
  { id: "default", labelKey: "styleDefault" },
  { id: "dsh",     labelKey: "styleDsh" },
  { id: "min",     labelKey: "styleMin" },
] as const satisfies readonly { id: LiveStyle; labelKey: keyof Translation }[]

export const BAR_STYLES = [
  { id: "default", labelKey: "styleDefault" },
  { id: "min",     labelKey: "styleMin" },
] as const satisfies readonly { id: BarStyle; labelKey: keyof Translation }[]

/** 底栏内容段开关注册表（/cache-bar、偏好恢复与两壳渲染共用）；default 即 KV 缺失默认值。 */
export type BarItemId = "hit" | "tokens" | "speed" | "balance" | "live"
export const BAR_ITEMS = [
  { id: "hit",     labelKey: "barHit",  default: true  },
  { id: "tokens",  labelKey: "barTok",  default: false },
  { id: "speed",   labelKey: "barTPS",  default: true  },
  { id: "balance", labelKey: "barBal",  default: false },
  // 实时段（仅 V2 底栏消费，菜单只在此壳露出）：默认关——关闭时底栏只显示每 step 刷新的精确值
  { id: "live",    labelKey: "barLive", default: false },
] as const satisfies readonly { id: BarItemId; labelKey: keyof Translation; default: boolean }[]

/** 读取某个底栏内容段的开关状态（KV 缺失时回落到注册表默认值）。 */
export function readBarItem(kv: PanelApi["kv"], id: BarItemId): boolean {
  const item = BAR_ITEMS.find((i) => i.id === id)
  return Boolean(kv.get<boolean>(`${KV_PREFIX}.bar.${id}`, item?.default ?? true))
}

// 流式实时估算的着色分段（V1 输入框右侧与 V2 底栏实时段共用）：
// prefill → 首字等待；streaming → 首字 · 速度（未达守卫省略）；tool → 工具计时。
// dsh 用 DeepSeek harness 文案；min 去掉全部标签。
export function liveStatSegs(lv: LivePerf, t: Translate, muted: string | undefined, text: string | undefined, style: LiveStyle = "default"): StatSeg[] {
  if (lv.phase === "tool") {
    const segs: StatSeg[] = []
    if (style !== "min") segs.push({ text: t("barTool") + " ", color: muted })
    segs.push({ text: fmtSec(lv.toolMs) + "\u2026", color: text })
    return segs
  }
  const dsh = style === "dsh"
  const min = style === "min"
  const label = dsh ? t("barFirstToken") : t("barTTFT")
  if (lv.phase === "prefill") {
    return min
      ? [{ text: fmtSec(lv.waitMs) + "\u2026", color: text }]
      : [
          { text: label + " ", color: muted },
          { text: fmtSec(lv.waitMs) + "\u2026", color: text },
        ]
  }
  const segs: StatSeg[] = min
    ? [{ text: fmtSec(lv.ttft), color: text }]
    : [
        { text: label + " ", color: muted },
        { text: fmtSec(lv.ttft), color: text },
      ]
  if (lv.tps !== null) {
    segs.push({ text: dsh || min ? " \u00b7 " : " \u00b7 " + t("barTPS") + " ", color: muted })
    segs.push({ text: lv.tps.toFixed(1) + " " + t("tokS"), color: text })
  }
  return segs
}

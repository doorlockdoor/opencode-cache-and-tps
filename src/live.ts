// ── live (streaming) perf helpers ──
// 流式心跳、样式注册表与实时分段；V1 壳（输入框行）与 V2 底栏共用，避免口径漂移。
import { createSignal, createEffect, onCleanup } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk"
import { createT, type Translation } from "./i18n"
import { fmtSec } from "./ui"
import type { LivePerf, PerfSample } from "./perf"
import { KV_PREFIX, type PanelApi, type PanelSignals, type DisplayStyle, type TpsMode } from "./panel/panel-api"

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
export type Translate = ReturnType<typeof createT>
/** 显示样式注册表（/cache-style；菜单与 KV 校验自动跟随，渲染分支与 i18n 文案手动补）。 */
export const STYLES = [
  { id: "default", labelKey: "styleDefault" },
  { id: "dsh",     labelKey: "styleDsh" },
  { id: "min",     labelKey: "styleMin" },
] as const satisfies readonly { id: DisplayStyle; labelKey: keyof Translation }[]

/**
 * 精确 TPS 计算方式注册表（/cache-tps 菜单与 KV 校验共用）。output 输出速度
 * （默认，偏解码速度）；perceived 体感速度（对齐宿主 footer，含首字等待，仅 V2 可算）。
 */
export const TPS_MODES = [
  { id: "output",    labelKey: "tpsOutput" },
  { id: "perceived", labelKey: "tpsPerceived" },
] as const satisfies readonly { id: TpsMode; labelKey: keyof Translation }[]

/**
 * 内容段开关注册表（/cache-bar、偏好恢复与两壳渲染共用）；default 即 KV 缺失默认值。
 * 每段一个开关管两态：命中率/Tokens/余额为常显精确值；首字/速度/延迟流式时显实时值
 * （V1 输入框右侧 / V2 底栏内联）、回合内间隙冻结为最近实时值、回合结束显精确值；
 * 工具仅在工具相位显示计时。
 */
export type BarItemId = "hit" | "tokens" | "balance" | "ttft" | "speed" | "lat" | "tool"
export const BAR_ITEMS = [
  { id: "hit",     labelKey: "barHit",  default: true  },
  { id: "tokens",  labelKey: "barTok",  default: false },
  { id: "balance", labelKey: "barBal",  default: false },
  { id: "ttft",    labelKey: "barTTFT", default: false },
  { id: "speed",   labelKey: "barTPS",  default: true  },
  { id: "lat",     labelKey: "barLat",  default: false },
  { id: "tool",    labelKey: "barTool", default: true  },
] as const satisfies readonly { id: BarItemId; labelKey: keyof Translation; default: boolean }[]

/**
 * 读取精确 TPS 计算方式及旧键迁移：新键 tps_mode 优先；旧布尔键 tps_host（曾在
 * /cache-bar 内的宿主速度开关）为 true 时迁移为 perceived；非法/缺失回落 output。
 */
export function readTpsMode(kv: PanelApi["kv"]): TpsMode {
  const saved = kv.get<string>(`${KV_PREFIX}.tps_mode`)
  if (saved && TPS_MODES.some((m) => m.id === saved)) return saved as TpsMode
  return kv.get<boolean>(`${KV_PREFIX}.tps_host`, false) ? "perceived" : "output"
}

/** 读取某个内容段的开关状态（KV 缺失时回落到注册表默认值）。 */
export function readBarItem(kv: PanelApi["kv"], id: BarItemId): boolean {
  const item = BAR_ITEMS.find((i) => i.id === id)
  return Boolean(kv.get<boolean>(`${KV_PREFIX}.bar.${id}`, item?.default ?? true))
}

/**
 * 读取显示样式及旧键迁移：新键 style 优先，其次 style_live、style_bar=min、tps_style；
 * 非法/缺失值回落 default（STYLES 为唯一校验源）。
 */
export function readDisplayStyle(kv: PanelApi["kv"]): DisplayStyle {
  const legacyBarStyle = kv.get<string>(`${KV_PREFIX}.style_bar`)
  const saved = kv.get<string>(`${KV_PREFIX}.style`)
    ?? kv.get<string>(`${KV_PREFIX}.style_live`)
    ?? (legacyBarStyle === "min" ? "min" : undefined)
    ?? kv.get<string>(`${KV_PREFIX}.tps_style`)
  return saved && STYLES.some((s) => s.id === saved) ? (saved as DisplayStyle) : "default"
}

/**
 * 性能段（首字/速度/延迟）精确值标签，与实时块 dsh/min 口径完全一致：
 * min 全省；dsh 首字用 DeepSeek 文案「首 Token」、速度/延迟省去标签；default 全带。
 * 返回 null 表示不渲染标签（命中率/Tokens/余额非性能段，仍只受 min 影响）。
 */
export function perfLabel(style: DisplayStyle, t: Translate, key: "ttft" | "tps" | "lat"): string | null {
  if (style === "min") return null
  if (style === "dsh") return key === "ttft" ? t("barFirstToken") : null
  return t(key === "ttft" ? "barTTFT" : key === "tps" ? "barTPS" : "barLat")
}

// 流式实时分段（V1 输入框右侧与 V2 底栏实时块共用）：
// prefill → 首字等待；streaming/tool → 首字 · 速度 · 延迟（值缺失的段省略）；
// tool 相位且「工具」项开启 → 仅工具计时（旧行为），否则显示冻结的实时值。
// dsh 用 DeepSeek harness 文案（仅实时值；精确值渲染不经过此函数）；min 去掉全部标签。enabled 由调用方按各段开关传入。
export interface LiveEnabled { ttft: boolean; tps: boolean; lat: boolean; tool: boolean }
/** 由信号派生实时段开关（首字/速度/延迟/工具），避免两壳各自拼装。 */
export function liveEnabled(
  signals: Pick<PanelSignals, "barShowTtft" | "barShowSpeed" | "barShowLat" | "barShowTool">,
): LiveEnabled {
  return { ttft: signals.barShowTtft(), tps: signals.barShowSpeed(), lat: signals.barShowLat(), tool: signals.barShowTool() }
}
/** 任一实时段开启（决定是否启动 250ms 心跳与实时估算；全关走精确分支）。 */
export function anyLiveSegment(
  signals: Pick<PanelSignals, "barShowTtft" | "barShowSpeed" | "barShowLat" | "barShowTool">,
): boolean {
  const e = liveEnabled(signals)
  return e.ttft || e.tps || e.lat || e.tool
}

export function liveStatSegs(
  lv: LivePerf,
  t: Translate,
  muted: string | undefined,
  text: string | undefined,
  style: DisplayStyle = "default",
  enabled: LiveEnabled,
): StatSeg[] {
  const segs: StatSeg[] = []
  const dsh = style === "dsh"
  const min = style === "min"
  const label = dsh ? t("barFirstToken") : t("barTTFT")
  if (lv.phase === "tool" && enabled.tool) {
    if (!min) segs.push({ text: t("barTool") + " ", color: muted })
    segs.push({ text: fmtSec(lv.toolMs ?? 0) + "\u2026", color: text })
    return segs
  }
  // 首字：prefill 显示等待进行中，其余显示本步首字（无产出时为回合内冻结值）
  if (enabled.ttft) {
    const ms = lv.phase === "prefill" ? lv.waitMs : lv.ttft
    if (ms !== null) {
      if (!min) segs.push({ text: label + " ", color: muted })
      segs.push({ text: fmtSec(ms) + (lv.phase === "prefill" ? "\u2026" : ""), color: text })
    }
  }
  // 速度/延迟：分隔符仅在已有前置段时插入（首字关闭时不残留前导「·」）；
  // dsh 只保留「首 Token」标签（DeepSeek harness 风格），速度/延迟标签同 min 一并省去
  if (enabled.tps && lv.tps !== null) {
    if (segs.length) segs.push({ text: " \u00b7 ", color: muted })
    if (!dsh && !min) segs.push({ text: t("barTPS") + " ", color: muted })
    segs.push({ text: lv.tps.toFixed(1) + " " + t("tokS"), color: text })
  }
  if (enabled.lat && lv.elapsed !== null) {
    if (segs.length) segs.push({ text: " \u00b7 ", color: muted })
    if (!dsh && !min) segs.push({ text: t("barLat") + " ", color: muted })
    segs.push({ text: fmtSec(lv.elapsed) + "\u2026", color: text })
  }
  return segs
}

/**
 * 精确性能段（首字/速度/延迟）按固定顺序追加到 out：受各段开关控制、标签经 perfLabel
 * 与实时块同口径。段间分隔由调用方 sep 负责（仅 out 非空时插入）。tps 由调用方给出
 * （V2 体感回合口径或最近样本），sample 为最近精确样本（速度取 null 时该段隐藏，首字/延迟照常）。
 */
export function pushPerfSegs(
  out: StatSeg[],
  sep: () => void,
  opts: {
    style: DisplayStyle
    t: Translate
    sample: PerfSample | null
    tps: number | null
    ttft: boolean
    speed: boolean
    lat: boolean
    muted: string | undefined
    text: string | undefined
  },
): void {
  const { style, t, sample, tps, muted, text } = opts
  if (opts.ttft && sample) {
    sep()
    const label = perfLabel(style, t, "ttft")
    if (label !== null) out.push({ text: label + " ", color: muted })
    out.push({ text: fmtSec(sample.ttft), color: text })
  }
  if (opts.speed && tps !== null) {
    sep()
    const label = perfLabel(style, t, "tps")
    if (label !== null) out.push({ text: label + " ", color: muted })
    out.push({ text: tps.toFixed(1) + " " + t("tokS"), color: text })
  }
  if (opts.lat && sample) {
    sep()
    const label = perfLabel(style, t, "lat")
    if (label !== null) out.push({ text: label + " ", color: muted })
    out.push({ text: fmtSec(sample.latency), color: text })
  }
}

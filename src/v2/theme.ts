import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Context } from "./types"

/**
 * v2 ResolvedTheme → 现有组件消费的 V1 主题形状。
 * 侧边栏（TokenCachePanel）与底部状态栏共用，保证命中率颜色同源。
 * - primary ← hue.interactive[300]（v1-migrate 官方映射：interactive = primary）
 * - text/textMuted ← text.base/muted（旧代 default/subdued 兜底）
 * - success/warning/error ← text.feedback.<kind>.base
 * - border ← border.base（缺失兜底到 textMuted）
 * 色值为 RGBA 对象；下游 desaturateTo/rgb 已兼容 0–1 浮点通道。
 */
export function mapTheme(theme: Context["theme"]): TuiThemeCurrent {
  const hue: any = theme?.hue ?? {}
  const text: any = theme?.text ?? {}
  const feedback: any = text.feedback ?? {}
  const border: any = theme?.border ?? {}
  const fx = (kind: string) => feedback[kind]?.base ?? feedback[kind]?.default
  return {
    primary: hue.interactive?.[300] ?? hue.accent?.[500] ?? hue.primary?.[300],
    text: text.base ?? text.default,
    textMuted: text.muted ?? text.subdued,
    success: fx("success"),
    warning: fx("warning"),
    error: fx("error"),
    border: border.base ?? text.muted ?? text.subdued,
  } as unknown as TuiThemeCurrent
}

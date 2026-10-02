// ── 界面工具 ──
// 终端宽度/CJK 视觉列、Morandi 去饱和配色、数值格式化。
// 由 V1 壳、V2 壳与共享面板共同消费（宿主无关，纯函数）。

// ── 终端宽度工具 ────────────────────────────────────────
// 中日韩字符通常占两列；padEnd/padStart 按字符串长度补齐，
// 无法正确对齐混合文本，因此按终端显示宽度计算。

function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0 // 控制字符
  if (code < 0x7f) return 1 // ASCII 字符
  if (code < 0xa0) return 0 // C1 控制字符
  // 东亚宽字符与全角字符区段
  if (
    (code >= 0x1100 && code <= 0x115f) || // 韩文字母
    (code >= 0x2e80 && code <= 0xa4cf) || // 中日韩部首至彝文区段
    (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
    (code >= 0xf900 && code <= 0xfaff) || // 中日韩兼容字符
    (code >= 0xfe10 && code <= 0xfe6f) || // 竖排与兼容形式
    (code >= 0xff01 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x1f300 && code <= 0x1f64f) || // 杂项符号（表情）
    (code >= 0x20000 && code <= 0x3fffd)
  )
    // 补充汉字区（SIP / TIP）
    return 2
  return 1
}

function visualWidth(s: string): number {
  let w = 0
  for (const c of s) w += charColumns(c)
  return w
}

function visualPadEnd(s: string, cols: number): string {
  const pad = cols - visualWidth(s)
  return pad > 0 ? s + " ".repeat(pad) : s
}

/** 将 s 截断至 maxCols 显示列，截断时追加省略号。 */
function truncateVisual(s: string, maxCols: number): string {
  if (visualWidth(s) <= maxCols) return s
  let result = "",
    w = 0
  for (const c of s) {
    const cw = charColumns(c)
    if (w + cw > maxCols - 1) {
      result += "…"
      break
    }
    result += c
    w += cw
  }
  return result
}

// ── 颜色工具 ────────────────────────────────────────────────

/** 从十六进制字符串或 RGBA 对象提取 0–255 的 RGB 通道值。 */
function rgb(raw: unknown): { r: number; g: number; b: number } | null {
  if (typeof raw === "string" && raw.startsWith("#")) {
    const h = raw.slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      // RGBA 通道可能为 0–1 浮点值，检测后换算为 0–255。
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255
      return {
        r: Math.round(o.r * scale),
        g: Math.round(o.g * scale),
        b: Math.round(o.b * scale),
      }
    }
  }
  return null
}

/** 计算 RGB 颜色的 HSL 饱和度（0–1）。 */
function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  if (delta === 0) return 0
  const L = (max + min) / 2
  return L <= 0.5 ? delta / (max + min) : delta / (2 - max - min)
}

/**
 * 饱和度超过 maxSat 时混入灰色，降低至上限；返回十六进制颜色。
 */
function desaturateTo(raw: unknown, maxSat: number, fallback: string): string {
  const c = rgb(raw)
  if (!c) return fallback
  const sat = saturation(c.r, c.g, c.b)
  if (sat <= maxSat) {
    // 饱和度已足够低，直接返回十六进制颜色。
    return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  }
  // 二分搜索混灰比例；12 次迭代已超过 8 位通道精度。
  // 使用 BT.601 感知亮度作为混灰基准。
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114
  let lo = 0,
    hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const nr = Math.round(c.r + (luma - c.r) * mid)
    const ng = Math.round(c.g + (luma - c.g) * mid)
    const nb = Math.round(c.b + (luma - c.b) * mid)
    if (saturation(nr, ng, nb) > maxSat) lo = mid
    else hi = mid
  }
  const nr = Math.round(c.r + (luma - c.r) * hi)
  const ng = Math.round(c.g + (luma - c.g) * hi)
  const nb = Math.round(c.b + (luma - c.b) * hi)
  return (
    "#" +
    [nr, ng, nb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
  )
}

/** 各颜色通道乘以 factor（0–1），使十六进制颜色变暗。 */
function dimColor(hex: string, factor = 0.5): string {
  const c = rgb(hex)
  if (!c) return hex
  const r = Math.round(c.r * factor)
  const g = Math.round(c.g * factor)
  const b = Math.round(c.b * factor)
  return (
    "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
  )
}

// 主题颜色无法解析时使用的莫兰迪默认色。
const FALLBACK = {
  primary: "#8B9DAF",
  text: "#C5C5BB",
  muted: "#7A7A72",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error: "#B08A8A",
  border: "#6B6B63",
} as const

/**
 * 莫兰迪配色的饱和度上限：0.28 可柔化鲜艳主题，同时保留命中率的绿、橙、红区分。
 * 值越低越偏灰，越高越接近原主题。
 */
const MAX_SAT = 0.28

function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  const empty = Math.max(0, width - filled)
  return "\u2588".repeat(filled) + "\u2591".repeat(empty)
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 10_000) return (n / 1_000).toFixed(1) + "K"
  return n.toLocaleString("en-US")
}

function fmtCost(n: number, symbol = "$", rate = 1): string {
  const v = n * rate
  if (v >= 1) return symbol + v.toFixed(2)
  if (v >= 0.01) return symbol + v.toFixed(3)
  return symbol + v.toFixed(4)
}

/** 时长格式化：<1s 显示 "834ms"，否则 "1.2s"。 */
function fmtMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + "ms"
  return (ms / 1000).toFixed(1) + "s"
}

/** 秒格式化（性能段实时值与精确值共用，三样式统一口径）：830 → "0.83s"，始终两位小数。 */
function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(2) + "s"
}

export {
  charColumns,
  visualWidth,
  visualPadEnd,
  truncateVisual,
  rgb,
  saturation,
  desaturateTo,
  dimColor,
  FALLBACK,
  MAX_SAT,
  progressBar,
  fmt,
  fmtCost,
  fmtMs,
  fmtSec,
}

// ── UI helpers ──
// 终端宽度/CJK 视觉列、Morandi 去饱和配色、数值格式化。
// 由 V1 壳、V2 壳与共享面板共同消费（宿主无关，纯函数）。

// ── terminal-width helpers ────────────────────────────────────────
// CJK characters occupy 2 terminal columns; padEnd/padStart count
// string length (=1 per char), which breaks alignment with mixed text.

function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0                              // control
  if (code < 0x7F) return 1                              // ASCII
  if (code < 0xA0) return 0                              // C1 controls
  // East-Asian wide / fullwidth ranges
  if ((code >= 0x1100 && code <= 0x115F) ||              // Hangul Jamo
      (code >= 0x2E80 && code <= 0xA4CF) ||              // CJK Radicals … Yi
      (code >= 0xAC00 && code <= 0xD7A3) ||              // Hangul
      (code >= 0xF900 && code <= 0xFAFF) ||              // CJK Compat
      (code >= 0xFE10 && code <= 0xFE6F) ||              // Vertical / Compat
      (code >= 0xFF01 && code <= 0xFF60) ||              // Fullwidth
      (code >= 0xFFE0 && code <= 0xFFE6) ||              // Fullwidth signs
      (code >= 0x1F300 && code <= 0x1F64F) ||            // Misc Symbols (emoji)
      (code >= 0x20000 && code <= 0x3FFFD))              // SIP / TIP
    return 2
  return 1
}

function visualWidth(s: string): number {
  let w = 0; for (const c of s) w += charColumns(c); return w
}

function visualPadEnd(s: string, cols: number): string {
  const pad = cols - visualWidth(s)
  return pad > 0 ? s + " ".repeat(pad) : s
}

/** Truncate `s` to fit within `maxCols` visual columns, appending "…" when cut. */
function truncateVisual(s: string, maxCols: number): string {
  if (visualWidth(s) <= maxCols) return s
  let result = "", w = 0
  for (const c of s) {
    const cw = charColumns(c)
    if (w + cw > maxCols - 1) { result += "\u2026"; break }
    result += c; w += cw
  }
  return result
}

// ── color helpers ────────────────────────────────────────────────

/** Extract { r, g, b } (0–255) from a hex string or RGBA-like object. */
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
      // RGBA channels may be 0-1 floats; detect and upscale.
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

/** HSL saturation of an RGB color (0–1). */
function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  if (delta === 0) return 0
  const L = (max + min) / 2
  return L <= 0.5 ? delta / (max + min) : delta / (2 - max - min)
}

/**
 * If the colour's saturation exceeds `maxSat`, pull it toward grey
 * until saturation drops to maxSat.  Returns a hex string.
 */
function desaturateTo(raw: unknown, maxSat: number, fallback: string): string {
  const c = rgb(raw)
  if (!c) return fallback
  const sat = saturation(c.r, c.g, c.b)
  if (sat <= maxSat) {
    // already muted — return as hex
    return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  }
  /**
   * Binary search for the optimal grey-mix ratio α (0…1).
   *
   * 12 iterations → 1/2^12 ≈ 1/4096 resolution.  The downstream RGB
   * channels are only 0–255 (8 bit), so 8 iterations (1/256) would
   * technically suffice; 12 is intentionally over-budget — the extra
   * precision costs almost nothing and guarantees the saturation probe
   * converges to within a fraction of an 8‑bit step, eliminating
   * colour banding in edge cases.
   */
  // Bt.601 luma (perceptual brightness used as the grey anchor)
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114
  let lo = 0, hi = 1
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
  return "#" + [nr, ng, nb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
}

/** Darken a hex colour by multiplying each channel by `factor` (0–1). */
function dimColor(hex: string, factor = 0.5): string {
  const c = rgb(hex)
  if (!c) return hex
  const r = Math.round(c.r * factor)
  const g = Math.round(c.g * factor)
  const b = Math.round(c.b * factor)
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
}

// Morandi fallbacks — used when a theme colour cannot be resolved
const FALLBACK = {
  primary: "#8B9DAF",
  text:    "#C5C5BB",
  muted:   "#7A7A72",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error:   "#B08A8A",
  border:  "#6B6B63",
} as const

/**
 * Desaturation ceiling for the Morandi-style palette.
 *
 * Morandi colours float around 0.15–0.30 saturation in HSL space.
 * 0.28 sits near the upper end of that range: it strips the aggressive
 * punch from high-saturation themes (Dracula, Solarized …) while
 * preserving enough colour identity that green / orange / red hit-rate
 * coding stays distinguishable.
 *
 * Lower → more grey, harder to tell colours apart.
 * Higher → bright themes bleed through and defeat the muted look.
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

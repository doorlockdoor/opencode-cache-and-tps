// ── currency helpers ──
import type { BalanceEntry } from "./balance-providers"

const CURRENCIES: Record<string, string> = {
  USD: "$", CNY: "¥", EUR: "€", JPY: "JP¥", GBP: "£", KRW: "₩",
}
/** Approximate USD exchange rates — used as defaults when switching currency.
 *  Users can override via /cache-rate.  Last updated 2026-05. */
const DEFAULT_RATES: Record<string, number> = {
  USD: 1, CNY: 7.2, EUR: 0.92, JPY: 150, GBP: 0.79, KRW: 1350,
}

/**
 * 将余额从来源币种换算为目标币种。
 * DEFAULT_RATES 以 USD=1 为基准：先折算为 USD，再换算到目标币种。
 */
function convertBalance(target: string, targetRate: number, amount: number, from: string): number {
  if (from === target) return amount
  const fromRate = DEFAULT_RATES[from] ?? 1
  const usd = from === "USD" ? amount : amount / fromRate
  return target === "USD" ? usd : usd * targetRate
}

/** 货币符号：优先取 /cache-currency 内置映射，未知币种回退为代码。 */
function balanceSymbol(currency: string): string {
  const sym = CURRENCIES[currency]
  return sym ?? currency + " "
}

/** 紧凑数字缩写（底部状态栏用）：1234 → "1.2K"，1234567 → "1.2M"。 */
function fmtCompact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(Math.round(n))
}

/** 余额数值格式化：≥1 或 0 显示固定 2 位小数；小额（<1）保留精度（最多 6 位），避免抹成 0.00。 */
function formatBalanceAmount(total: string): string {
  const n = parseFloat(total)
  if (!Number.isFinite(n)) return total
  if (n === 0 || n >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 })
}

/**
 * 将余额列表格式化为单行文本。
 * 优先直接显示偏好币种（CNY/USD…）；偏好币种为换算币种时按汇率折算第一条余额。
 */
function formatBalanceText(list: BalanceEntry[], pref: string, rate: number): string {
  const custom = list.find((x) => x.display)
  if (custom?.display) return custom.display
  const native = pref ? list.find((x) => x.currency === pref) : undefined
  if (native) return balanceSymbol(native.currency) + formatBalanceAmount(native.total)
  const base = list[0]
  const baseAmt = parseFloat(base.total)
  const converted = Number.isFinite(baseAmt)
    ? convertBalance(pref || base.currency, rate, baseAmt, base.currency)
    : baseAmt
  const shown = pref && base.currency !== pref
    ? converted.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : formatBalanceAmount(base.total)
  return balanceSymbol(pref || base.currency) + shown
}

export { CURRENCIES, DEFAULT_RATES, convertBalance, balanceSymbol, fmtCompact, formatBalanceAmount, formatBalanceText }

/**
 * v2 斜杠命令：此处只构建命令数组，由 app 插槽的 RuntimeRoot 经 keymap.layer 注册
 * （layer 须在组件渲染上下文调用）。
 */
import type { Context, KeymapCommand } from "./types"
import type { PanelApi, PanelSignals } from "../panel/panel-api"
import { KV_PREFIX } from "../panel/panel-api"
import { balanceProviders, getBalanceProvider, maskKey, type BalanceProvider } from "../balance-providers"
import { createT } from "../i18n"
import {
  applyBarItem, applyStyle, applyCurrency, applyLang,
  applyPerfFilter, applyRate, applySection, applyTpsMode, barItemChoices,
  configToast, currencyChoices, langChoices, sectionChoices, styleChoices, tpsModeChoices,
  type ToastMsg,
} from "../commands-shared"

declare const process: {
  env: Record<string, string | undefined>
  getBuiltinModule?: (id: string) => unknown
} | undefined

/** v2 余额 key 自动复用（尽力而为）：凭据已迁移进数据库，仅能读遗留 auth.json；未命中提示手动配置。 */
export function findOpencodeKeyV2(provider: BalanceProvider): string {
  try {
    const loader = typeof process !== "undefined" ? process?.getBuiltinModule : undefined
    const fs = loader?.("node:fs") as { readFileSync(path: string, encoding: "utf8"): string } | undefined
    if (!fs) return ""
    const home = typeof process !== "undefined" ? (process?.env.HOME || process?.env.USERPROFILE || "") : ""
    const dataHome = typeof process !== "undefined" ? process?.env.XDG_DATA_HOME : undefined
    const paths = [
      dataHome ? `${dataHome}/opencode/auth.json` : "",
      home ? `${home}/.local/share/opencode/auth.json` : "",
    ]
    const id = provider.id.toLowerCase()
    for (const path of paths) {
      if (!path) continue
      try {
        const auth = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, any>
        const hit = Object.keys(auth).find((k) => k.toLowerCase() === id)
          ?? Object.keys(auth).find((k) => k.toLowerCase().startsWith(id))
        if (!hit) continue
        const v = auth[hit]
        if (!v || typeof v !== "object") continue
        if (v.type === "api" && typeof v.key === "string") return v.key
        if (v.type === "wellknown" && typeof v.token === "string") return v.token
        if (v.type === "oauth" && typeof v.access === "string") return v.access
      } catch { /* try the next known auth path */ }
    }
    return ""
  } catch {
    return ""
  }
}

/** 当前会话 ID（v2 Route = { type:"session", sessionID }）。 */
export function currentSessionID(context: Context): string {
  try {
    const rt = context.ui.router.current()
    if (rt?.type === "session" && rt.sessionID) return String(rt.sessionID)
  } catch {}
  return ""
}

export function makeCommands(context: Context, api: PanelApi, signals: PanelSignals): KeymapCommand[] {
  const t = () => createT(() => signals.langCode())

  /** 宿主 toast 适配（commands-shared 返回宿主无关的 ToastMsg）。 */
  const show = (msg: ToastMsg) =>
    context.ui.toast.show({ title: msg.title, message: msg.message, duration: msg.duration })

  /** 菜单中 provider 选项标题：标注 key 来源（手动配置 / OpenCode 自动复用 / 未配置）。 */
  const providerOptionTitle = (p: BalanceProvider, current?: string) => {
    const hasManual = !!api.kv.get<string>(`${KV_PREFIX}.balance.${p.id}.key`, "")
    const hasAuto = !hasManual && !!findOpencodeKeyV2(p)
    const mark = hasManual ? t()("keyUser") : hasAuto ? t()("keyOpenCode") : t()("keyNotSet")
    return p.name + mark + (current && p.id === current ? " *" : "")
  }

  /** 弹出指定 provider 的 API Key 输入框（脱敏预填；空清除 / 含 * 保留原 key / 新 key 实时刷新）。 */
  const promptBalanceKey = async (provider: BalanceProvider): Promise<void> => {
    const current = api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "") ?? ""
    const val = await context.ui.dialog.prompt({
      title: provider.name,
      description: t()("balKeyPrompt", { p: provider.name }),
      placeholder: provider.keyPlaceholder ?? "sk-...",
      value: maskKey(current),
    })
    if (val === undefined) return
    const input = val.trim()
    const key = input === "" ? "" : input.includes("*") ? current : input
    await api.kv.set(`${KV_PREFIX}.balance.${provider.id}.key`, key)
    signals.setBalanceRefresh(signals.balanceRefresh() + 1)
    context.ui.toast.show({ message: key ? t()("keySaved") : t()("keyCleared") })
  }

  return [
    // ── /cache-currency ──
    {
      id: "opencode-visual-cache.cache.currency",
      title: "Cache: Set Currency",
      description: "Change the currency unit for cost display",
      group: "Cache",
      palette: true,
      slash: { name: "cache-currency" },
      run: async () => {
        const opt = await context.ui.dialog.select({ title: "Select Currency", options: currencyChoices() })
        if (!opt) return
        show(applyCurrency(api, signals, opt))
      },
    },
    // ── /cache-rate ──
    {
      id: "opencode-visual-cache.cache.rate",
      title: "Cache: Set Exchange Rate",
      description: "Set the exchange rate multiplier for the selected currency",
      group: "Cache",
      palette: true,
      slash: { name: "cache-rate" },
      run: async () => {
        const val = await context.ui.dialog.prompt({
          title: "Exchange Rate",
          description: "Enter the exchange rate from USD to your currency (e.g. 7.2 for CNY)",
          placeholder: "1.0",
          value: String(api.kv.get<number>(`${KV_PREFIX}.rate`, 1)),
        })
        if (val === undefined) return
        const msg = applyRate(api, signals, val)
        if (msg) show(msg)
      },
    },
    // ── /cache-perf-filter ──
    {
      id: "opencode-visual-cache.cache.perffilter",
      title: "Cache: Toggle Perf Model Filter",
      description: "Filter performance stats (TTFT/TPS/latency) to the current session model",
      group: "Cache",
      palette: true,
      slash: { name: "cache-perf-filter" },
      run: () => show(applyPerfFilter(api, signals)),
    },
    // ── /cache-style ──
    {
      id: "opencode-visual-cache.cache.style",
      title: "Cache: Set Display Style",
      description: "Set the display style for all info segments (default / dsh / minimal)",
      group: "Cache",
      palette: true,
      slash: { name: "cache-style" },
      run: async () => {
        const cur = api.kv.get<string>(`${KV_PREFIX}.style`) ?? "default"
        const opt = await context.ui.dialog.select({ title: t()("styleTitle"), options: styleChoices(signals, cur) })
        if (!opt) return
        show(applyStyle(api, signals, opt))
      },
    },
    // ── /cache-bar ──
    {
      id: "opencode-visual-cache.cache.bar",
      title: "Cache: Toggle Status Bar Items",
      description: "Show or hide info segments (hit / tokens / balance / ttft / speed / latency / tool; live while streaming, exact when idle)",
      group: "Cache",
      palette: true,
      slash: { name: "cache-bar" },
      run: async () => {
        const opt = await context.ui.dialog.select({ title: t()("barItemsTitle"), options: barItemChoices(api, signals) })
        if (!opt) return
        show(applyBarItem(api, signals, opt))
      },
    },
    // ── /cache-tps ──
    {
      id: "opencode-visual-cache.cache.tps",
      title: "Cache: Set Speed Calculation",
      description: "Exact TPS calc: output speed (decode only) or perceived speed (host footer, incl. first-token wait; v2 only), affecting bottom bar and sidebar",
      group: "Cache",
      palette: true,
      slash: { name: "cache-tps" },
      run: async () => {
        const opt = await context.ui.dialog.select({ title: t()("tpsModeTitle"), options: tpsModeChoices(signals, signals.tpsMode()) })
        if (!opt) return
        show(applyTpsMode(api, signals, opt))
      },
    },
    // ── /cache-section ──
    {
      id: "opencode-visual-cache.cache.section",
      title: "Cache: Toggle Section",
      description: "Show or hide a sidebar section",
      group: "Cache",
      palette: true,
      slash: { name: "cache-section" },
      run: async () => {
        const opt = await context.ui.dialog.select({ title: t()("secToggle"), options: sectionChoices(api, signals) })
        if (!opt) return
        show(applySection(api, signals, opt))
      },
    },
    // ── /cache-config ──
    {
      id: "opencode-visual-cache.cache.config",
      title: "Cache: Show Config",
      description: "Display the current plugin configuration",
      group: "Cache",
      palette: true,
      slash: { name: "cache-config" },
      run: () => show(configToast(api, signals)),
    },
    // ── /cache-lang ──
    {
      id: "opencode-visual-cache.cache.lang",
      title: "Cache: Switch Language",
      description: "Switch display language (Chinese / English / 日本語 / 한국어)",
      group: "Cache",
      palette: true,
      slash: { name: "cache-lang" },
      run: async () => {
        const cur = signals.langCode()
        const opt = await context.ui.dialog.select({ title: t()("langTitle"), options: langChoices(cur) })
        if (!opt) return
        show(applyLang(api, signals, opt))
      },
    },
    // ── /cache-balance ──
    {
      id: "opencode-visual-cache.cache.balance",
      title: "Cache: Switch Balance Provider",
      description: "切换余额提供商 / 自动切换当前会话提供商 | Switch balance provider / auto-switch session provider",
      group: "Cache",
      palette: true,
      slash: { name: "cache-balance" },
      run: async () => {
        const current = signals.balanceProviderId()
        const auto = signals.autoBalance()
        const autoLabel = `${t()("autoSwitchOpt")} [${auto ? "ON" : "OFF"}]`
        const opt = await context.ui.dialog.select<string>({
          title: t()("balProvTitle"),
          options: [
            { title: autoLabel, value: "__auto__" },
            ...balanceProviders.map((p) => ({ title: providerOptionTitle(p, current), value: p.id })),
          ],
        })
        if (!opt) return
        if (opt === "__auto__") {
          const next = !auto
          await api.kv.set(`${KV_PREFIX}.balance.auto`, next)
          signals.setAutoBalance(next)
          context.ui.toast.show({ message: next ? t()("autoSwitchOn") : t()("autoSwitchOff") })
        } else {
          const provider = getBalanceProvider(opt)
          await api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
          await api.kv.set(`${KV_PREFIX}.balance.auto`, false)
          signals.setBalanceProviderId(provider.id)
          signals.setAutoBalance(false)
          signals.setBalanceUnsupported(false)
          signals.setBalanceRefresh(signals.balanceRefresh() + 1)
          const hasKey = !!api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
          if (!hasKey) await promptBalanceKey(provider)
          else context.ui.toast.show({ message: t()("providerManual", { p: provider.name }) })
        }
      },
    },
    // ── /cache-balance-key ──
    {
      id: "opencode-visual-cache.cache.balance.key",
      title: "Cache: Set Balance API Key",
      description: "Select a provider and set its API key for balance display",
      group: "Cache",
      palette: true,
      slash: { name: "cache-balance-key" },
      run: async () => {
        const opt = await context.ui.dialog.select<string>({
          title: t()("balSelectTitle"),
          options: balanceProviders.map((p) => ({ title: providerOptionTitle(p), value: p.id })),
        })
        if (!opt) return
        const provider = getBalanceProvider(opt)
        await api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
        await api.kv.set(`${KV_PREFIX}.balance.auto`, false)
        signals.setBalanceProviderId(provider.id)
        signals.setAutoBalance(false)
        signals.setBalanceRefresh(signals.balanceRefresh() + 1)
        await promptBalanceKey(provider)
      },
    },
    // ── /cache-debug-skills ──
    {
      id: "opencode-visual-cache.cache.debug-skills",
      title: "Cache: Debug Skills Detection",
      description: "Dump all tool parts found in the current session for skill detection debugging",
      group: "Cache",
      palette: true,
      slash: { name: "cache-debug-skills" },
      run: () => {
        const sid = currentSessionID(context)
        if (!sid) {
          context.ui.toast.show({ message: t()("runInSession"), variant: "warning" })
          return
        }
        const msgs = api.state.session.messages(sid)
        const byTool: Record<string, number> = {}
        const skillParts: string[] = []
        for (const msg of msgs) {
          // v2 技能是独立的 role="skill" 消息，其工具 part 由归一化层合成，
          // 必须一并扫描（否则 skill 检测永远报「未找到」）。
          if (msg.role !== "assistant" && msg.role !== "skill") continue
          for (const p of api.state.part(msg.id)) {
            if (p.type !== "tool") continue
            const tool = String(p.tool ?? "?")
            byTool[tool] = (byTool[tool] ?? 0) + 1
            if (tool === "skill") {
              skillParts.push(`state.metadata=${JSON.stringify(p.state?.metadata)} | state.title="${p.state?.title}" | output[:80]="${String(p.state?.output ?? "").slice(0, 80)}"`)
            }
          }
        }
        const summary = Object.entries(byTool).map(([k, v]) => `${k}: ${v}`).join(" | ")
        const extra = skillParts.length > 0
          ? "\n\nSkill parts:\n" + skillParts.join("\n")
          : "\n\n⚠ No skill tool parts found — AI may be reading SKILL.md instead."
        context.ui.toast.show({ title: `Tool Summary (${Object.keys(byTool).length} types)`, message: summary + extra })
      },
    },
    // ── /cache-session ──
    {
      id: "opencode-visual-cache.cache.session",
      title: "Cache: Sub-Agent Stats",
      description: "View token cache statistics for a sub-agent by session ID",
      group: "Cache",
      palette: true,
      slash: { name: "cache-session" },
      run: async () => {
        const parentSid = currentSessionID(context)
        const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])
        const children: { title: string; value: string; description: string }[] = []
        if (parentSid) {
          try {
            for (const msg of api.state.session.messages(parentSid)) {
              if (msg.role !== "assistant") continue
              for (const p of api.state.part(msg.id)) {
                if (p.type !== "tool") continue
                const tool = String(p.tool ?? "")
                if (!SUBAGENT_TOOLS.has(tool)) continue
                const st = p.state as Record<string, unknown> | undefined
                const stMeta = st?.metadata as Record<string, unknown> | undefined
                const subSid = stMeta?.session_id ?? stMeta?.sessionId
                if (!subSid) continue
                const sidStr = String(subSid)
                const input = st?.input as Record<string, unknown> | undefined
                const agent = String(p.subagent_type ?? input?.subagent_type ?? input?.category ?? tool)
                const prompt = String(input?.prompt ?? "")
                const desc = input?.description ? String(input.description) : ""
                const title = desc || prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || agent
                children.push({ title, value: sidStr, description: `${agent} · ${sidStr.slice(0, 24)}…` })
              }
            }
          } catch {}
        }
        const seen = new Set<string>()
        const unique = children.filter((c) => { if (seen.has(c.value)) return false; seen.add(c.value); return true })
        if (unique.length > 0) {
          const currentSid = signals.overrideSessionId() ?? api.kv.get<string>(`${KV_PREFIX}.session`, "")
          const options = unique.map((c, i) => ({ title: `${i + 1}. ${c.title}`, value: c.value, description: c.description }))
          const backValue = "__main__"
          const backTitle = `\u2500 ${t()("backToMainTitle")}`
          options.unshift({ title: backTitle, value: backValue, description: "" })
          options.push({ title: backTitle, value: backValue, description: "" })
          const currentIdx = currentSid ? options.findIndex((o) => o.value === currentSid) : -1
          const opt = await context.ui.dialog.select<string>({
            title: t()("subSelectTitle"),
            options,
            current: currentIdx >= 0 ? options[currentIdx].value : undefined,
          })
          if (!opt) return
          if (opt === backValue) {
            signals.setOverrideSessionId(undefined)
            await api.kv.set(`${KV_PREFIX}.session`, "")
            context.ui.toast.show({ message: t()("backToMain") })
          } else {
            signals.setOverrideSessionId(opt)
            await api.kv.set(`${KV_PREFIX}.session`, opt)
            context.ui.toast.show({ message: t()("subAgentSwitched", { s: opt.slice(0, 24) + "\u2026" }) })
          }
        } else {
          const val = await context.ui.dialog.prompt({
            title: signals.overrideSessionId() ? t()("subSwitchTitle") : t()("subViewTitle"),
            description: t()("subNoFound"),
            placeholder: "ses_...",
            value: signals.overrideSessionId() ?? api.kv.get<string>(`${KV_PREFIX}.session`, "") ?? "",
          })
          if (val === undefined) return
          const sid = val.trim()
          if (sid) {
            signals.setOverrideSessionId(sid)
            await api.kv.set(`${KV_PREFIX}.session`, sid)
            context.ui.toast.show({ message: t()("subAgentSwitched", { s: sid.slice(0, 24) + "\u2026" }) })
          }
        }
      },
    },
    // ── /cache-session-back ──
    {
      id: "opencode-visual-cache.cache.session.back",
      title: "Cache: Back to Main",
      description: "Return to main session stats",
      group: "Cache",
      palette: true,
      slash: { name: "cache-session-back" },
      run: async () => {
        signals.setOverrideSessionId(undefined)
        await api.kv.set(`${KV_PREFIX}.session`, "")
        context.ui.toast.show({ message: t()("backToMain") })
      },
    },
  ]
}

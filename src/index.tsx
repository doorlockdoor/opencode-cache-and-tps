import { childSessionChoices } from "./child-sessions"
/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotContext,
  TuiSlotPlugin,
  TuiPluginModule,
  TuiDialogStack,
  TuiPromptRef,
  SequenceBindingLike,
} from "@opencode-ai/plugin/tui"
import type { Message, AssistantMessage } from "@opencode-ai/sdk"
import { createMemo, createSignal, createEffect, onCleanup, Show, For, untrack } from "solid-js"
import {
  balanceProviders,
  getBalanceProvider,
  maskKey,
  type BalanceProvider,
} from "./balance-providers"
import { syncAutoBalance } from "./balance"
import { collectUsageBySession } from "./stats"
import {
  applyBarItem,
  applyStyle,
  applyCurrency,
  applyLang,
  applyPerfFilter,
  applyRate,
  applySection,
  barItemChoices,
  notifySetting,
  configToast,
  currencyChoices,
  langChoices,
  sectionChoices,
  styleChoices,
  restorePanelPrefs,
} from "./commands-shared"
import { createT } from "./i18n"
import { num } from "./tokens"
import { computeLivePerf, lastPerfValues, currentModelKey } from "./perf"
import { FALLBACK, MAX_SAT, desaturateTo, fmtCost, visualWidth, truncateVisual } from "./ui"
import { fmtCompact, formatBalanceText } from "./currency"
import {
  liveStatSegs,
  liveEnabled,
  anyLiveSegment,
  pushPerfSegs,
  createBusyTick,
  createPerfRefreshTick,
  type StatSeg,
} from "./live"
import { KV_PREFIX, type PanelSignals } from "./panel/panel-api"
import { TokenCachePanel } from "./panel/TokenCachePanel"

import { createPanelSignals } from "./panel/signals"
import { createBalanceController, BALANCE_POLL_MS } from "./balance-controller"
import { persistPreference } from "./preferences"

// OpenCode TUI 进程在运行时提供的 Bun / Node 全局变量。
declare const process:
  | {
      env: Record<string, string | undefined>
      getBuiltinModule?: (id: string) => unknown
    }
  | undefined

// ── 语言 ──────────────────────────────────────────────────────
// 初始化：CACHE_TUI_LANG 覆盖 → 系统 locale；/cache-lang 偏好在 KV 就绪后覆盖。

/** 从 OpenCode 已认证 provider 读 API key 兜底（先精确后前缀匹配；OpenAI 优先 OAuth）；无则空串。 */
function readOpenAIOAuthToken(api: TuiPluginApi): string {
  try {
    // OpenAI OAuth 凭据与 provider.key 分开保存。
    const loader = typeof process !== "undefined" ? process?.getBuiltinModule : undefined
    const fs = loader?.("node:fs") as
      { readFileSync(path: string, encoding: "utf8"): string } | undefined
    if (!fs) return ""
    const stateDir = api.state.path.state.replace(/[\\/]+$/, "")
    const home =
      typeof process !== "undefined" ? process?.env.HOME || process?.env.USERPROFILE || "" : ""
    const dataHome = typeof process !== "undefined" ? process?.env.XDG_DATA_HOME : undefined
    const paths = [
      stateDir ? `${stateDir}/auth.json` : "",
      dataHome ? `${dataHome}/opencode/auth.json` : "",
      home ? `${home}/.local/share/opencode/auth.json` : "",
    ]
    for (const path of paths) {
      if (!path) continue
      try {
        const auth = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>
        const openai = auth.openai
        if (openai && typeof openai === "object") {
          const record = openai as Record<string, unknown>
          if (record.type === "oauth" && typeof record.access === "string") return record.access
        }
      } catch {
        /* 尝试下一个已知凭据路径 */
      }
    }
    return ""
  } catch {
    return ""
  }
}

function findOpencodeKey(api: TuiPluginApi, provider: BalanceProvider): string {
  try {
    const provs = api.state.provider as unknown as Array<{
      id: string
      key?: string
      options?: { apiKey?: string }
    }>
    const id = provider.id.toLowerCase()
    const hit =
      provs.find((p) => p.id.toLowerCase() === id) ??
      provs.find((p) => p.id.toLowerCase().startsWith(id))
    const isOpenAI = id === "openai"
    // OAuth token 优先于 provider.key，避免把配置占位值当成 access token
    if (isOpenAI) {
      const oauth = readOpenAIOAuthToken(api)
      if (oauth) return oauth
    }
    if (!hit) return ""
    const k = typeof hit.key === "string" ? hit.key : ""
    if (k) return k
    return typeof hit.options?.apiKey === "string" ? hit.options.apiKey : ""
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/** 当前会话 ID（route 为 session 时）；非会话视图返回空串。自动切换余额 provider 用。 */
function currentSessionIdV1(api: TuiPluginApi): string {
  try {
    const rt = api.route.current
    if (rt?.name === "session" && rt.params) return String(rt.params.sessionID ?? "")
  } catch {
    /* 忽略可选数据的读取失败 */
  }
  return ""
}

/** 路径截断的固定布局开销（列数；marginLeft=1 + space-between 余量）。 */
const PATH_CHROME = 2
/** 路径可用宽度低于此列数时整体隐藏（极窄下让位给统计与 commands）。 */
const HIDE_PATH_BELOW = 14

/** 从宿主 keymap 读取命令快捷键显示文本（与宿主 Prompt 同源），取不到回退默认值。 */
function keyShortcut(api: TuiPluginApi, command: string, fallback: string): string {
  try {
    const binds = api.tuiConfig.keybinds.get(command)
    const seq = binds?.map((b) => ({ key: b.key }))
    const s = api.keys.formatBindings(seq as unknown as SequenceBindingLike[])
    return s || fallback
  } catch {
    return fallback
  }
}

/**
 * 输入框 hint 行（session_prompt 的 hint）：路径 · 命中率 · TPS（min 样式去标签）。
 * 经 ui.Prompt 的 hint prop 注入，宿主右侧 token/commands 提示自动保留。
 */
function BottomStatusBar(props: {
  api: TuiPluginApi
  signals: PanelSignals
  sessionId: string
}): JSX.Element {
  const t = createT(() => props.signals.langCode())

  const sid = props.sessionId

  const perfVersion = createPerfRefreshTick(props.api)

  // ── 命中率 + 用量（口径见 src/stats.ts，与侧边栏/V2 底栏同源）──
  const stats = createMemo(() => {
    const id = sid
    if (!id) return null
    return collectUsageBySession(props.api, id)
  })

  // ── 模型过滤键（过滤关闭 / 会话未知 → null=不过滤）：单独成 memo，避免每次 part 事件
  // 都走 currentModelKey 的回退分支（遍历全部消息）──
  const modelKey = createMemo(() => {
    const id = sid
    if (!id || !props.signals.perfModelFilter()) return null
    return currentModelKey(props.api, id)
  })

  // ── 最近精确值（口径见 perf.ts lastPerfValues）：首字/延迟取最近有效样本，速度独立
  // 回溯到最近一次有效值；与 V2 底栏、侧边栏同一实现 ──
  const perfValues = createMemo(() => {
    const id = sid
    if (!id) return { sample: null, tps: null }
    void perfVersion()
    return lastPerfValues(props.api, id, modelKey())
  })

  // ── 会话累计 tokens（tokens 段开启时显示）──
  const tokTotal = createMemo(() => {
    const s = stats()
    if (!s) return null
    const total = s.input + s.read + s.write
    return total > 0 ? total : null
  })

  // ── 余额文本（共享 balanceState，与侧边栏同源）──
  const balanceText = createMemo(() => {
    const st = props.signals.balanceState()
    if (st.status === "ok" && st.data)
      return formatBalanceText(
        st.data,
        props.signals.balanceCurrency(),
        props.signals.exchangeRate(),
      )
    if (st.status === "loading") return "…"
    if (st.status === "error") return "\u26a0"
    return "-"
  })

  // 余额轮询与自动切换 provider 都在 tui() 常驻层（见 src/balance.ts），与侧栏挂载无关

  // ── 主题色（与侧边栏同口径）──
  const pal = createMemo(() => {
    const th = props.api.theme.current as Record<string, unknown>
    const sat = (k: string, fb: string) => desaturateTo(th[k], MAX_SAT, fb)
    return {
      text: sat("text", FALLBACK.text),
      muted: sat("textMuted", FALLBACK.muted),
      success: sat("success", FALLBACK.success),
      warning: sat("warning", FALLBACK.warning),
      error: sat("error", FALLBACK.error),
    }
  })

  const hitColor = createMemo(() => {
    const r = stats()?.hitRate ?? -1
    if (r >= 85) return pal().success
    if (r >= 70) return pal().warning
    return pal().error
  })

  // 命中率趋势：最后一条与上一条的差值；|Δ| < 0.05 视为无变化（null = 不显示）
  const trend = createMemo(() => {
    const s = stats()
    if (!s || s.prevHitRate < 0 || s.hitRate < 0) return null
    const d = s.hitRate - s.prevHitRate
    return Math.abs(d) < 0.05 ? null : d
  })

  // 路径显示（替换宿主默认 hint 左侧的 cwd 文本）
  const directory = createMemo(() => {
    try {
      return props.api.state.path.directory
    } catch {
      return ""
    }
  })

  // 终端宽度信号：resize 事件更新（宿主不约束 hint 行宽，路径截断按终端宽手算）。
  // ResizeEmitter：项目未装 @types/node，CliRenderer 继承的 EventEmitter 类型不可见的最小声明。
  interface ResizeEmitter {
    on(event: "resize", cb: () => void): unknown
    off(event: "resize", cb: () => void): unknown
  }
  const [termW, setTermW] = createSignal(props.api.renderer.terminalWidth)
  // resize 事件为主通道；接口不可用时退化为 1s 轮询兜底（值不变不触发更新）
  createEffect(() => {
    const r = props.api.renderer as unknown as ResizeEmitter
    const hasEvent = typeof r.on === "function" && typeof r.off === "function"
    if (hasEvent) {
      const onResize = () => setTermW(props.api.renderer.terminalWidth)
      r.on("resize", onResize)
      onCleanup(() => r.off("resize", onResize))
      return
    }
    const timer = setInterval(() => setTermW(props.api.renderer.terminalWidth), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // 统计分段（单一数据源，渲染逐段着色）：各段 /cache-bar 独立开关；min 样式去标签。
  const statsSegs = createMemo<StatSeg[]>(() => {
    const s = stats()
    const plain = props.signals.style() === "min"
    const segs: StatSeg[] = []
    // 段间分隔符：仅当已有内容时插入，避免关闭首段后出现前导「·」
    const sep = () => {
      if (segs.length) segs.push({ text: " · ", color: pal().muted })
    }
    // 无数据（新会话）时省略命中率段，避免「命中率 --」占位（与 V2 底栏统一；
    // hint 行左侧路径不受影响，照常显示）
    if (props.signals.barShowHit() && s && s.hitRate >= 0) {
      const hr = (Math.floor(s.hitRate * 10) / 10).toFixed(1) + "%"
      if (!plain) segs.push({ text: t("barHit") + " ", color: pal().muted })
      segs.push({ text: hr, color: hitColor() })
      const tr = trend()
      if (tr !== null) {
        segs.push({
          text: " " + (tr > 0 ? "↑" : "↓") + Math.abs(tr).toFixed(1) + "%",
          color: tr > 0 ? pal().success : pal().error,
        })
      }
    }
    if (props.signals.barShowTokens()) {
      const total = tokTotal()
      if (total !== null) {
        sep()
        if (!plain) segs.push({ text: t("barTok") + " ", color: pal().muted })
        segs.push({ text: fmtCompact(total), color: pal().text })
      }
    }
    // 性能段固定顺序 首字 → 速度 → 延迟（/cache-bar 开关），与实时块、侧边栏性能区一致；
    // 标签/开关经 pushPerfSegs 与实时块同口径（dsh：首 Token 文案 + 速度/延迟省去）；
    // 流式期间宿主将 hint 行整体替换为忙碌行，与右侧实时值天然互斥，不存在同屏双值
    const { sample, tps } = perfValues()
    pushPerfSegs(segs, sep, {
      style: props.signals.style(),
      t,
      sample,
      tps,
      muted: pal().muted,
      text: pal().text,
      ttft: props.signals.barShowTtft(),
      speed: props.signals.barShowSpeed(),
      lat: props.signals.barShowLat(),
    })
    if (props.signals.barShowBalance() && !props.signals.balanceUnsupported()) {
      sep()
      if (!plain) segs.push({ text: t("barBal") + " ", color: pal().muted })
      segs.push({ text: balanceText(), color: pal().text })
    }
    // 末尾分隔符：宿主会在同行拼接 context/cost 文字
    if (segs.length) segs.push({ text: " · ", color: pal().muted })
    return segs
  })
  const statsW = createMemo(() => {
    let w = 0
    for (const sg of statsSegs()) w += visualWidth(sg.text)
    return w
  })

  // 宿主右侧 usage 文本复刻（1.18.16 Prompt 口径，仅用于估算宽度而非渲染）：
  // 最后一条 output>0 的 assistant → tokens 合计 + context 百分比 + 费用。
  // 硬编码宿主格式；宿主升级若改渲染需同步，否则路径截断漂移（truncateVisual 兜底）。
  const sessionCost = createMemo(() => {
    try {
      return num(props.api.state.session.get(sid)?.cost)
    } catch {
      return 0
    }
  })
  const usageText = createMemo(() => {
    const id = sid
    if (!id) return ""
    const msgs = props.api.state.session.messages(id) as Message[]
    let last: AssistantMessage | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant") continue
      const tk = (m as AssistantMessage).tokens
      if (tk && num(tk.output) > 0) {
        last = m as AssistantMessage
        break
      }
    }
    if (!last) return ""
    const tk = last.tokens
    if (!tk) return ""
    const tokens =
      num(tk.input) +
      num(tk.output) +
      num(tk.reasoning) +
      num(tk.cache?.read) +
      num(tk.cache?.write)
    if (tokens <= 0) return ""
    let pct = ""
    try {
      const p = props.api.state.provider.find((x) => x.id === last.providerID)
      const limit = p?.models?.[last.modelID]?.limit?.context
      if (typeof limit === "number" && limit > 0) pct = ` (${Math.round((tokens / limit) * 100)}%)`
    } catch {}
    const context = fmtCompact(tokens) + pct
    const cost = sessionCost()
    return cost > 0 ? context + " · " + fmtCost(cost) : context
  })

  // 宿主右侧文本：usage（有数据）或 "快捷键 agents" + commands，快捷键动态读取
  const rightText = createMemo(() => {
    const cmds = keyShortcut(props.api, "command.palette.show", "ctrl+p") + " commands"
    const u = usageText()
    if (u) return u + " " + cmds
    return keyShortcut(props.api, "agent.cycle", "") + " agents " + cmds
  })
  const rightW = createMemo(() => visualWidth(rightText()))

  // 输入框宽度 = 终端宽 - 侧边栏(可见时 42) - 4（与宿主 session 布局 contentWidth 口径一致）
  const inputW = createMemo(() => termW() - (props.signals.sidebarVisible() ? 42 : 0) - 4)

  // 路径可用宽度 = 输入框 - 统计 - 宿主右侧 - 布局开销；低于阈值整体隐藏让位
  const dirDisplay = createMemo(() => {
    const avail = inputW() - statsW() - rightW() - PATH_CHROME
    if (avail < HIDE_PATH_BELOW) return ""
    return truncateVisual(directory(), avail)
  })
  // 状态栏关闭（仅路径）时同样在极窄条件下隐藏路径
  const dirFallback = createMemo(() => {
    const avail = inputW() - rightW() - PATH_CHROME
    if (avail < HIDE_PATH_BELOW) return ""
    return truncateVisual(directory(), avail)
  })

  // 恢复显隐偏好（默认显示）；关闭时回退为仅显示路径，与宿主默认 hint 行一致

  return (
    <Show
      when={props.signals.sectionBottom()}
      fallback={<text fg={pal().muted}>{dirFallback()}</text>}
    >
      <box
        marginLeft={1}
        flexGrow={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={pal().muted}>{dirDisplay()}</text>
        <box flexDirection="row">
          <text>
            <For each={statsSegs()}>{(sg) => <span style={{ fg: sg.color }}>{sg.text}</span>}</For>
          </text>
        </box>
      </box>
    </Show>
  )
}

/**
 * 输入框行右侧（session_prompt_right）：流式期间显示实时分段（按内容段开关：
 * 首字/速度/延迟/工具，默认 速度/工具 开）。busy 时宿主把 hint 行整体替换为
 * 忙碌行，输入框右侧不受影响；无实时内容（非流式或相关段全关）回落插槽透传。
 */
function PromptRightStatus(props: {
  api: TuiPluginApi
  signals: PanelSignals
  sessionId: string
}): JSX.Element {
  const sid = props.sessionId
  const t = createT(() => props.signals.langCode())

  const pal = createMemo(() => {
    const th = props.api.theme.current as Record<string, unknown>
    return {
      muted: desaturateTo(th.textMuted, MAX_SAT, FALLBACK.muted),
      text: desaturateTo(th.text, MAX_SAT, FALLBACK.text),
    }
  })

  // 任一实时态段开启才启动心跳与估算（全关 = 无实时显示，纯透传宿主右槽）
  const anyLiveOn = createMemo(() => anyLiveSegment(props.signals))
  const liveTick = createBusyTick(props.api, () => sid, anyLiveOn)
  const live = createMemo(() => {
    if (!anyLiveOn()) return null
    liveTick()
    return computeLivePerf(props.api, sid)
  })
  const segs = createMemo(() => {
    const lv = live()
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

  return (
    <Show
      when={segs().length > 0}
      fallback={<props.api.ui.Slot name="session_prompt_right" session_id={sid} />}
    >
      <text wrapMode="none">
        <For each={segs()}>{(sg) => <span style={{ fg: sg.color }}>{sg.text}</span>}</For>
      </text>
    </Show>
  )
}

function createSidebarSlot(api: TuiPluginApi, signals: PanelSignals): TuiSlotPlugin {
  return {
    order: 55,
    slots: {
      sidebar_content(ctx: TuiSlotContext, input: { session_id: string }): JSX.Element {
        return (
          <TokenCachePanel
            theme={ctx.theme.current}
            api={api}
            sessionId={input.session_id}
            signals={signals}
          />
        )
      },
    },
  }
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const signals = createPanelSignals()
  const { balanceProviderId, balanceUnsupported, balanceRefresh, langCode, setBalanceRefresh } =
    signals

  api.slots.register(createSidebarSlot(api, signals))

  // 输入框 hint 行（session_prompt，replace）：重渲染 Prompt 仅替换 hint 行左侧，
  // 在路径与右侧 token/commands 之间插入 命中率(+趋势) · 首字 · 速度 · 延迟（精确口径，顺序同实时块）。
  api.slots.register({
    order: 55,
    slots: {
      session_prompt(
        _ctx: TuiSlotContext,
        input: {
          session_id: string
          visible?: boolean
          disabled?: boolean
          on_submit?: () => void
          ref?: (ref: TuiPromptRef | undefined) => void
        },
      ): JSX.Element {
        return (
          <api.ui.Prompt
            sessionID={input.session_id}
            visible={input.visible}
            disabled={input.disabled}
            onSubmit={input.on_submit}
            ref={input.ref}
            hint={<BottomStatusBar api={api} signals={signals} sessionId={input.session_id} />}
            // 透传宿主 session_prompt_right 插槽（无注册时为 null），避免遮挡其他插件
            right={<PromptRightStatus api={api} signals={signals} sessionId={input.session_id} />}
          />
        )
      },
    },
  })

  // ── 运行时设置的斜杠命令 ──

  // ── 显示偏好恢复：KV 就绪后优先用户设置（/cache-lang、/cache-style、/cache-bar） ──
  const restorePrefs = () => {
    try {
      restorePanelPrefs(api, signals)
    } catch {}
  }
  if (api.kv.ready) {
    restorePrefs()
  } else {
    const prefTimer = setInterval(() => {
      if (api.kv.ready) {
        clearInterval(prefTimer)
        restorePrefs()
      }
    }, 10)
    api.lifecycle.onDispose(() => clearInterval(prefTimer))
  }

  const balance = createBalanceController(api, signals, (provider) =>
    findOpencodeKey(api, provider),
  )
  createEffect(() => {
    balanceRefresh()
    balanceProviderId()
    balanceUnsupported()
    if (!api.kv.ready) return
    untrack(() => {
      void balance.poll(true)
    })
  })
  const balanceTimer = setInterval(() => {
    void balance.poll()
  }, BALANCE_POLL_MS)
  api.lifecycle.onDispose(() => {
    clearInterval(balanceTimer)
    balance.dispose()
  })

  let lastMainSid = currentSessionIdV1(api)
  createEffect(() => {
    const sid = currentSessionIdV1(api)
    if (sid === lastMainSid) return
    lastMainSid = sid
    signals.setOverrideSessionId(undefined)
    persistPreference(api, KV_PREFIX + ".session", "")
  })

  // 自动切换余额 provider（实现见 src/balance.ts）：跟随当前会话模型；手动切换即关闭 auto
  createEffect(() => {
    syncAutoBalance(api, signals, signals.overrideSessionId() ?? currentSessionIdV1(api))
  })

  /** 菜单中 provider 选项标题：标注 key 来源（手动配置 / OpenCode 自动复用 / 未配置）。 */
  const providerOptionTitle = (p: BalanceProvider, current?: string) => {
    const t = createT(() => langCode())
    const hasManual = !!api.kv.get<string>(`${KV_PREFIX}.balance.${p.id}.key`, "")
    const hasAuto = !hasManual && !!findOpencodeKey(api, p)
    const mark = hasManual ? t("keyUser") : hasAuto ? t("keyOpenCode") : t("keyNotSet")
    return p.name + mark + (current && p.id === current ? " *" : "")
  }

  /** 弹出指定 provider 的 API Key 输入框（脱敏预填；空清除 / 含 * 保留原 key / 新 key 实时刷新）。 */
  const promptBalanceKey = (dialog: TuiDialogStack | undefined, provider: BalanceProvider) => {
    const t = createT(() => langCode())
    const current = api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
    const masked = maskKey(current)
    dialog?.replace(() => (
      <api.ui.DialogPrompt
        title={provider.name}
        description={() => <text>{t("balKeyPrompt", { p: provider.name })}</text>}
        placeholder={provider.keyPlaceholder ?? "sk-..."}
        value={masked}
        onConfirm={(val) => {
          const input = val.trim()
          let key: string
          if (input === "") {
            key = ""
          } else if (input.includes("*")) {
            key = current
          } else {
            key = input
          }
          api.kv.set(`${KV_PREFIX}.balance.${provider.id}.key`, key)
          setBalanceRefresh(balanceRefresh() + 1)
          if (key) {
            api.ui.toast({ message: t("keySaved") })
          } else {
            api.ui.toast({ message: t("keyCleared") })
          }
          dialog?.clear()
        }}
        onCancel={() => dialog?.clear()}
      />
    ))
  }

  api.command?.register(() => [
    {
      title: "Cache: Set Currency",
      value: "cache.currency",
      description: "Change the currency unit for cost display",
      slash: { name: "cache-currency" },
      onSelect: (dialog) => {
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title="Select Currency"
            options={currencyChoices()}
            onSelect={(opt) => {
              void notifySetting(
                applyCurrency(api, signals, opt.value),
                (message) => api.ui.toast(message),
                signals,
              )
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Set Exchange Rate",
      value: "cache.rate",
      description: "Set the exchange rate multiplier for the selected currency",
      slash: { name: "cache-rate" },
      onSelect: (dialog) => {
        dialog?.replace(() => (
          <api.ui.DialogPrompt
            title="Exchange Rate"
            description={() => (
              <text>Enter the exchange rate from USD to your currency (e.g. 7.2 for CNY)</text>
            )}
            placeholder="1.0"
            value={String(signals.exchangeRate())}
            onConfirm={(val) => {
              const msg = applyRate(api, signals, val)
              void notifySetting(msg, (message) => api.ui.toast(message), signals)
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Toggle Perf Model Filter",
      value: "cache.perffilter",
      description: "Filter performance stats (TTFT/TPS/latency) to the current session model",
      slash: { name: "cache-perf-filter" },
      onSelect: () => {
        void notifySetting(
          applyPerfFilter(api, signals),
          (message) => api.ui.toast(message),
          signals,
        )
      },
    },
    {
      title: "Cache: Set Display Style",
      value: "cache.style",
      description: "Set the display style for all info segments (default / dsh / minimal)",
      slash: { name: "cache-style" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        const cur = signals.style()
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("styleTitle")}
            options={styleChoices(signals, cur)}
            onSelect={(opt) => {
              void notifySetting(
                applyStyle(api, signals, opt.value),
                (message) => api.ui.toast(message),
                signals,
              )
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Toggle Status Bar Items",
      value: "cache.bar",
      description:
        "Show or hide info segments (hit / tokens / balance / ttft / speed / latency / tool; live while streaming, exact when idle)",
      slash: { name: "cache-bar" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("barItemsTitle")}
            options={barItemChoices(signals)}
            onSelect={(opt) => {
              void notifySetting(
                applyBarItem(api, signals, opt.value),
                (message) => api.ui.toast(message),
                signals,
              )
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Toggle Section",
      value: "cache.section",
      description: "Show or hide a sidebar section",
      slash: { name: "cache-section" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("secToggle")}
            options={sectionChoices(signals)}
            onSelect={(opt) => {
              void notifySetting(
                applySection(api, signals, opt.value),
                (message) => api.ui.toast(message),
                signals,
              )
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Show Config",
      value: "cache.config",
      description: "Display the current plugin configuration",
      slash: { name: "cache-config" },
      onSelect: (dialog) => {
        api.ui.toast(configToast(signals))
        dialog?.clear()
      },
    },
    {
      title: "Cache: Switch Language",
      value: "cache.lang",
      description: "Switch display language (Chinese / English / 日本語 / 한국어)",
      slash: { name: "cache-lang" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        const cur = langCode()
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("langTitle")}
            options={langChoices(cur)}
            onSelect={(opt) => {
              void notifySetting(
                applyLang(api, signals, opt.value),
                (message) => api.ui.toast(message),
                signals,
              )
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Switch Balance Provider",
      value: "cache.balance",
      description:
        "切换余额提供商 / 自动切换当前会话提供商 | Switch balance provider / auto-switch session provider",
      slash: { name: "cache-balance" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        const current = signals.balanceProviderId()
        const auto = signals.autoBalance()
        const autoLabel = `${t("autoSwitchOpt")} [${auto ? "ON" : "OFF"}]`
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("balProvTitle")}
            options={[
              {
                title: autoLabel,
                value: "__auto__",
              },
              ...balanceProviders.map((p) => ({
                title: providerOptionTitle(p, current),
                value: p.id,
              })),
            ]}
            onSelect={(opt) => {
              if (opt.value === "__auto__") {
                const next = !auto
                api.kv.set(`${KV_PREFIX}.balance.auto`, next)
                signals.setAutoBalance(next)
                api.ui.toast({ message: next ? t("autoSwitchOn") : t("autoSwitchOff") })
                dialog?.clear()
              } else {
                const provider = getBalanceProvider(opt.value)
                // 手动切换会关闭自动切换
                api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
                api.kv.set(`${KV_PREFIX}.balance.auto`, false)
                signals.setBalanceProviderId(provider.id)
                signals.setAutoBalance(false)
                signals.setBalanceUnsupported(false)
                // 切换后立即刷新显示，避免残留上一 provider 余额
                signals.setBalanceRefresh(signals.balanceRefresh() + 1)
                const hasKey = !!api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
                if (!hasKey) {
                  // 未配置 key → 进入设置流程（对话框保持打开）
                  promptBalanceKey(dialog, provider)
                } else {
                  api.ui.toast({ message: t("providerManual", { p: provider.name }) })
                  dialog?.clear()
                }
              }
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Set Balance API Key",
      value: "cache.balance.key",
      description: "Select a provider and set its API key for balance display",
      slash: { name: "cache-balance-key" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        // 步骤 1：选择 provider
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("balSelectTitle")}
            options={balanceProviders.map((p) => ({
              title: providerOptionTitle(p),
              value: p.id,
            }))}
            onSelect={(opt) => {
              const provider = getBalanceProvider(opt.value)
              // 手动指定 provider 会关闭自动切换
              api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
              api.kv.set(`${KV_PREFIX}.balance.auto`, false)
              signals.setBalanceProviderId(provider.id)
              signals.setBalanceUnsupported(false)
              signals.setAutoBalance(false)
              // 切换后立即刷新，防止取消输入残留旧余额
              signals.setBalanceRefresh(signals.balanceRefresh() + 1)
              // 步骤 2：输入 key
              promptBalanceKey(dialog, provider)
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Debug Skills Detection",
      value: "cache.debug-skills",
      description: "Dump all tool parts found in the current session for skill detection debugging",
      slash: { name: "cache-debug-skills" },
      onSelect: () => {
        const t = createT(() => langCode())
        const rt = api.route.current
        if (rt.name !== "session" || !rt.params) {
          api.ui.toast({ message: t("runInSession"), variant: "warning" })
          return
        }
        const sid = String(rt.params.sessionID)
        const msgs = api.state.session.messages(sid)
        const byTool: Record<string, number> = {}
        const skillParts: string[] = []
        for (const msg of msgs) {
          if (msg.role !== "assistant") continue
          let parts: readonly any[] = []
          try {
            parts = api.state.part(msg.id)
          } catch {}
          for (const p of parts) {
            if (p.type === "tool") {
              const t = String(p.tool ?? "?")
              byTool[t] = (byTool[t] ?? 0) + 1
              if (t === "skill") {
                const meta = p.state?.metadata
                const rootMeta = p.metadata
                skillParts.push(
                  `state.metadata=${JSON.stringify(meta)} | root.metadata=${JSON.stringify(rootMeta)} | state.title="${p.state?.title}" | state.output[:80]="${String(p.state?.output ?? "").slice(0, 80)}"`,
                )
              }
            }
          }
        }
        const summary = Object.entries(byTool)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" | ")
        const extra =
          skillParts.length > 0
            ? "\n\nSkill parts:\n" + skillParts.join("\n")
            : "\n\n⚠ No skill tool parts found — AI may be reading SKILL.md instead. Try: 'Use the skill tool to load karpathy-guidelines'"
        api.ui.toast({
          title: `Tool Summary (${Object.keys(byTool).length} types)`,
          message: summary + extra,
          duration: 15000,
        })
      },
    },
    {
      title: "Cache: Sub-Agent Stats",
      value: "cache.session",
      description: "View token cache statistics for a sub-agent by session ID",
      slash: { name: "cache-session" },
      onSelect: (dialog) => {
        // ── 扫描当前主 session 的子代理 session ID 列表 ──
        const rt = api.route.current
        const parentSid = rt.name === "session" && rt.params ? String(rt.params.sessionID) : ""
        const unique = childSessionChoices(api, parentSid)

        if (unique.length > 0) {
          // ── 有子代理 → DialogSelect 列表选择 ──
          const t = createT(() => langCode())
          const currentSid =
            signals.overrideSessionId() ?? api.kv.get<string>(`${KV_PREFIX}.session`, "")
          const options = unique.map((c, i) => ({
            title: `${i + 1}. ${c.title}`,
            value: c.value,
            description: c.description,
          }))
          // 首尾各放一个"回到主会话"，长列表时顶部底部均可直达
          const backValue = "__main__"
          const backTitle = `─ ${t("backToMainTitle")}`
          options.unshift({ title: backTitle, value: backValue, description: "" })
          options.push({ title: backTitle, value: backValue, description: "" })
          const currentIdx = currentSid ? options.findIndex((o) => o.value === currentSid) : -1
          dialog?.replace(() => (
            <api.ui.DialogSelect
              title={t("subSelectTitle")}
              options={options}
              current={currentIdx >= 0 ? options[currentIdx].value : undefined}
              onSelect={(opt) => {
                if (opt.value === backValue) {
                  signals.setOverrideSessionId(undefined)
                  api.kv.set(`${KV_PREFIX}.session`, "")
                  api.ui.toast({ message: t("backToMain") })
                } else {
                  signals.setOverrideSessionId(opt.value)
                  api.kv.set(`${KV_PREFIX}.session`, opt.value)
                  api.ui.toast({
                    message: t("subAgentSwitched", { s: opt.value.slice(0, 24) + "…" }),
                  })
                }
                dialog?.clear()
              }}
            />
          ))
        } else {
          // ── 无子代理 → DialogPrompt 手动粘贴 ──
          const t = createT(() => langCode())
          dialog?.replace(() => (
            <api.ui.DialogPrompt
              title={signals.overrideSessionId() ? t("subSwitchTitle") : t("subViewTitle")}
              description={() => <text>{t("subNoFound")}</text>}
              placeholder="ses_..."
              value={
                signals.overrideSessionId() ?? api.kv.get<string>(`${KV_PREFIX}.session`, "") ?? ""
              }
              onConfirm={(val) => {
                const sid = val.trim()
                if (sid) {
                  signals.setOverrideSessionId(sid)
                  api.kv.set(`${KV_PREFIX}.session`, sid)
                  api.ui.toast({ message: t("subAgentSwitched", { s: sid.slice(0, 24) + "…" }) })
                }
                dialog?.clear()
              }}
              onCancel={() => dialog?.clear()}
            />
          ))
        }
      },
    },
    {
      title: "Cache: Back to Main",
      value: "cache.session.back",
      description: "Return to main session stats",
      slash: { name: "cache-session-back" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        signals.setOverrideSessionId(undefined)
        api.kv.set(`${KV_PREFIX}.session`, "")
        api.ui.toast({ message: t("backToMain") })
        dialog?.clear()
      },
    },
  ])
}

const mod: TuiPluginModule & { id: string } = {
  id: "opencode-cache-and-tps",
  tui,
}

export default mod

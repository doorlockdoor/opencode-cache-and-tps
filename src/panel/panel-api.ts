// ---------------------------------------------------------------------------
// Panel API — TokenCachePanel 消费的宿主 API 子集。
// V1（TuiPluginApi）结构上天然满足；V2（opencode context）由 v2/panel-api 适配。
// ---------------------------------------------------------------------------

import type { LangCode } from "../i18n"
import type { BalanceEntry } from "../balance-providers"

/** KV 存储键前缀（单一来源，避免各组件间键名漂移）。 */
export const KV_PREFIX = "cache_panel"

/** 输入框实时行样式（默认 / DeepSeek harness / 极简）。 */
export type LiveStyle = "default" | "dsh" | "min"
/** 底部提示栏样式（默认 / 极简）。 */
export type BarStyle = "default" | "min"

/** 会话信息（面板消费的字段；宿主类型过严，用宽松接口）。 */
export interface PanelSession {
  id: string
  title?: string
  agent?: string
  model?: { providerID?: string; id?: string }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  [key: string]: unknown
}

/**
 * 面板 API 契约：仅包含 TokenCachePanel 需要的能力。
 * V1 壳直接传 TuiPluginApi；V2 壳传 createPanelApi(context)。
 * renderer/keys/tuiConfig/path 等仅壳层使用的能力不在此契约内。
 */
export interface PanelApi {
  kv: {
    ready: boolean
    get<T>(key: string, fallback?: T): T | undefined
    set(key: string, value: unknown): void | Promise<void>
  }
  state: {
    session: {
      get(id: string): PanelSession | undefined
      /** V1 返回 sdk/v2 的 Message、V2 返回归一化消息——统一放宽 */
      messages(id: string): readonly any[]
      /** V1 返回 { type } 对象、V2 返回 "idle"|"running" 字符串——壳层判定，统一放宽 */
      status?(id: string): unknown
    }
    provider: readonly Record<string, any>[]
    config: any
    part(messageID: string): readonly any[]
  }
  event: {
    on(type: string, handler: (event: unknown) => void): () => void
  }
}

export interface BalanceState {
  status: "idle" | "loading" | "ok" | "error"
  data: BalanceEntry[] | null
  lastFetch: number
  error?: string
  key?: string // 上次成功/尝试查询所用的 key，用于检测 key 是否更换
}

/** Signals shared between the panel component and slash commands. */
export interface PanelSignals {
  currencySymbol: () => string
  setCurrencySymbol: (v: string) => void
  exchangeRate: () => number
  setExchangeRate: (v: number) => void
  langCode: () => LangCode
  setLangCode: (v: LangCode) => void
  sectionDetail: () => boolean
  setSectionDetail: (v: boolean) => void
  sectionModel: () => boolean
  setSectionModel: (v: boolean) => void
  sectionDist: () => boolean
  setSectionDist: (v: boolean) => void
  sectionSkills: () => boolean
  setSectionSkills: (v: boolean) => void
  sectionPerf: () => boolean
  setSectionPerf: (v: boolean) => void
  /** 性能统计是否按当前模型过滤（切模型后中位数/最近值不混入其他模型）。 */
  perfModelFilter: () => boolean
  setPerfModelFilter: (v: boolean) => void
  /** 输入框右侧实时行样式。 */
  liveStyle: () => LiveStyle
  setLiveStyle: (v: LiveStyle) => void
  /** 下方提示栏样式。 */
  barStyle: () => BarStyle
  setBarStyle: (v: BarStyle) => void
  sectionBalance: () => boolean
  setSectionBalance: (v: boolean) => void
  /** Bottom status bar (prompt hint line) visibility. */
  sectionBottom: () => boolean
  setSectionBottom: (v: boolean) => void
  /** 底部状态栏各内容段显隐（/cache-bar 命令开关；默认 命中/速度 开、Tokens/余额 关）。 */
  barShowHit: () => boolean
  setBarShowHit: (v: boolean) => void
  barShowTokens: () => boolean
  setBarShowTokens: (v: boolean) => void
  barShowSpeed: () => boolean
  setBarShowSpeed: (v: boolean) => void
  barShowBalance: () => boolean
  setBarShowBalance: (v: boolean) => void
  /** 底栏流式实时段显隐（默认关；仅 V2 底栏消费，关闭时只显示每 step 刷新的精确值）。 */
  barShowLive: () => boolean
  setBarShowLive: (v: boolean) => void
  /** Increment to force a balance re-fetch. */
  balanceRefresh: () => number
  setBalanceRefresh: (v: number) => void
  /** Currently selected balance provider id (e.g. "deepseek"). */
  balanceProviderId: () => string
  setBalanceProviderId: (v: string) => void
  /** Auto-switch to the session's provider for balance display. Manual switch disables it. */
  autoBalance: () => boolean
  setAutoBalance: (v: boolean) => void
  /** True when the session's provider has no balance adapter (auto mode). Suppresses balance polling. */
  balanceUnsupported: () => boolean
  setBalanceUnsupported: (v: boolean) => void
  /** Shared balance query state — single source of truth for sidebar and bottom bar. */
  balanceState: () => BalanceState
  /** Preferred currency code for balance display (CNY / USD / …). Empty = first entry. */
  balanceCurrency: () => string
  setBalanceCurrency: (v: string) => void
  borderVisible: () => boolean
  setBorderVisible: (v: boolean) => void
  /** When set, the panel renders stats for this session instead of the main one. */
  overrideSessionId: () => string | undefined
  setOverrideSessionId: (v: string | undefined) => void
  /** True while our sidebar panel is mounted — host sidebar is visible. */
  sidebarVisible: () => boolean
  setSidebarVisible: (v: boolean) => void
}

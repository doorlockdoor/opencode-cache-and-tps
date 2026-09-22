// ---------------------------------------------------------------------------
// opencode v2 CLI 插件 API —— 最小本地类型（对齐 @opencode/plugin/tui 2.0.12）。
//
// 运行期由宿主提供，本文件仅用于本地类型检查与 IDE 提示；插件 bundle 不 import
// 任何 @opencode/plugin 运行时模块（默认导出纯对象 { id, setup } 即可被宿主识别）。
// 若宿主类型升级，请对照 packages/plugin/src/tui/context.ts 与本文件同步。
// ---------------------------------------------------------------------------

export interface App {
  readonly version: string
  readonly channel: string
}

/** location = { directory, workspaceID? }（packages/client generated types）。 */
export interface LocationRef {
  readonly directory: string
  readonly workspaceID?: string
}

export interface TokenUsage {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cache?: { readonly read?: number; readonly write?: number }
}

export interface SessionInfo {
  readonly id: string
  readonly title?: string
  readonly parentID?: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
  readonly cost?: number
  readonly tokens?: TokenUsage
  readonly time?: { readonly created: number; readonly updated: number }
  readonly [key: string]: unknown
}

export interface SessionMessageInfo {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number; readonly streamed?: number; readonly completed?: number }
  readonly [key: string]: any
}

export interface ModelInfo {
  readonly id?: string
  readonly modelID?: string
  readonly providerID?: string
  readonly name?: string
  readonly cost?: ReadonlyArray<Record<string, any>>
  readonly limit?: { readonly context?: number; readonly output?: number }
  readonly [key: string]: any
}

export interface ProviderInfo {
  readonly id: string
  readonly name?: string
  readonly [key: string]: any
}

export interface AgentInfo {
  readonly id: string
  readonly name?: string
  readonly system?: string
  readonly [key: string]: any
}

/** ResolvedTheme：色值为 RGBA 对象，文本/反馈 token 见 @opencode/theme/tui。 */
export interface Theme {
  readonly hue: Record<string, Record<number, any>>
  readonly text: {
    readonly base?: any
    readonly muted?: any
    /** 旧代命名兜底 */
    readonly default?: any
    readonly subdued?: any
    readonly feedback: Record<string, { readonly base?: any; readonly default?: any }>
  }
  readonly border?: { readonly base?: any }
  readonly [key: string]: any
}

export interface Storage {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  memory<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => void]
}

export interface LocationCollection<Value> {
  list(location?: LocationRef): Value[] | undefined
  sync(location?: LocationRef): Promise<void>
  invalidate(location?: LocationRef): void
}

export interface Data {
  on(type: string, handler: (event: any) => void): () => void
  listen(handler: (event: any) => void): () => void
  readonly session: {
    list(): SessionInfo[]
    get(sessionID: string): SessionInfo | undefined
    root(sessionID: string): string
    cost(sessionID: string): number
    status(sessionID: string): "idle" | "running"
    readonly message: {
      list(sessionID: string): SessionMessageInfo[]
      get(sessionID: string, messageID: string): SessionMessageInfo | undefined
    }
  }
  readonly location: {
    default(): LocationRef
    readonly agent: LocationCollection<AgentInfo>
    readonly model: LocationCollection<ModelInfo>
    readonly provider: LocationCollection<ProviderInfo>
  }
}

export type SlotPath =
  | "app"
  | "home.footer"
  | "home.footer.status"
  | "prompt.footer"
  | "prompt.footer.status"
  | "prompt.footer.file"
  | "session.composer.top"
  | "session.panel"
  | "sidebar.content"
  | "sidebar.footer"

export type SlotClaim = { readonly render: (input: any) => any } & (
  | { readonly prepend: SlotPath; readonly append?: never; readonly before?: never; readonly after?: never; readonly replace?: never }
  | { readonly append: SlotPath; readonly prepend?: never; readonly before?: never; readonly after?: never; readonly replace?: never }
  | { readonly before: SlotPath; readonly prepend?: never; readonly append?: never; readonly after?: never; readonly replace?: never }
  | { readonly after: SlotPath; readonly prepend?: never; readonly append?: never; readonly before?: never; readonly replace?: never }
  | { readonly replace: SlotPath; readonly prepend?: never; readonly append?: never; readonly before?: never; readonly after?: never }
)

export interface KeymapCommand {
  id?: string
  title?: string
  description?: string
  group?: string
  enabled?: boolean | (() => boolean)
  bind?: false | string
  palette?: true
  slash?: { name: string; aliases?: string[]; arguments?: true }
  suggested?: boolean | (() => boolean)
  run: (input?: string, event?: any) => void | false | Promise<void>
}

export interface KeymapLayer {
  mode?: string
  enabled?: boolean | (() => boolean)
  priority?: number
  commands?: readonly KeymapCommand[]
}

export interface Keymap {
  layer(input: () => KeymapLayer): void
  dispatch(id: string, input?: string): void
  shortcuts(id: string): readonly string[]
}

export interface Dialog {
  alert(options: { title: string; message: string }): Promise<void>
  confirm(options: { title: string; message: string; label?: { confirm?: string; cancel?: string } }): Promise<boolean | undefined>
  prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
  select<Value>(options: {
    title: string
    placeholder?: string
    options: readonly { title: string; value: Value; description?: string; category?: string; disabled?: boolean }[]
    current?: Value
  }): Promise<Value | undefined>
}

export interface Toast {
  show(options: { title?: string; message: string; variant?: string; duration?: number; sessionID?: string }): void
}

export interface Route {
  readonly type?: string
  readonly sessionID?: string
  readonly params?: Record<string, unknown>
}

export interface UI {
  readonly dialog: Dialog
  readonly toast: Toast
  readonly format: { path(value: string): string }
  readonly router: {
    current(): Route
    navigate(destination: any): void
    register(page: { name: string; render: (input: { data?: Record<string, any> }) => any }): () => void
  }
  readonly panel: {
    open(name: string, options?: { readonly presentation?: "panel" | "fullscreen" }): boolean
    close(): void
    current(): { readonly name: string; readonly sessionID: string } | undefined
  }
  slot(claim: SlotClaim): () => void
}

export interface Context {
  readonly options: Readonly<Record<string, any>>
  readonly location: LocationRef | undefined
  readonly app: App
  readonly renderer: { readonly terminalWidth: number; on?: (event: string, cb: () => void) => unknown; off?: (event: string, cb: () => void) => unknown }
  readonly client: any
  readonly data: Data
  readonly theme: Theme
  readonly themeMode: "dark" | "light"
  readonly keymap: Keymap
  readonly storage: Storage
  readonly ui: UI
}

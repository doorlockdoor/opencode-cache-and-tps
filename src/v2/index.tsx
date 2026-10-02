/** @jsxImportSource @opentui/solid */

import { createEffect, onMount, onCleanup, untrack } from "solid-js"
import type { Context } from "./types"
import { createPanelApi } from "./panel-api"
import { TokenCachePanel } from "../panel/TokenCachePanel"
import type { PanelApi } from "../panel/panel-api"
import { KV_PREFIX } from "../panel/panel-api"
import { StatusView } from "./status"
import { mapTheme } from "./theme"
import { makeCommands, findOpencodeKeyV2, currentSessionID } from "./commands"
import { credentialsDbReady, closeCredentialDatabase } from "./credentials"
import { restorePanelPrefs } from "../commands-shared"
import { persistPreference } from "../preferences"
import { syncAutoBalance } from "../balance"
import { createPanelSignals, type Signals } from "../panel/signals"
import { createBalanceController, BALANCE_POLL_MS } from "../balance-controller"

/** 常驻运行时根（app 插槽）：余额轮询、偏好恢复、自动切换、子代理清理、命令层——侧栏隐藏也生效。 */
function RuntimeRoot(props: { context: Context; api: PanelApi; signals: Signals }) {
  /** 当前统计目标会话：子代理 override 优先，否则当前路由会话。 */
  const currentSid = () => props.signals.overrideSessionId() ?? currentSessionID(props.context)

  // 语言 / 显示样式 / 内容段开关 / 性能过滤 / 余额偏好 恢复（KV 就绪后）
  const restorePrefs = () => {
    try {
      restorePanelPrefs(props.api, props.signals)
    } catch {}
  }
  onMount(restorePrefs)

  const balance = createBalanceController(props.api, props.signals, async (provider) => {
    await credentialsDbReady()
    return findOpencodeKeyV2(props.context, provider)
  })
  createEffect(() => {
    props.signals.balanceRefresh()
    props.signals.balanceProviderId()
    props.signals.balanceUnsupported()
    untrack(() => {
      void balance.poll(true)
    })
  })
  const balanceTimer = setInterval(() => {
    void balance.poll()
  }, BALANCE_POLL_MS)
  onCleanup(() => {
    clearInterval(balanceTimer)
    balance.dispose()
  })

  // 自动切换余额 provider（唯一实现见 src/balance.ts；侧栏隐藏也生效）
  createEffect(() => {
    syncAutoBalance(props.api, props.signals, currentSid())
  })

  // 子代理视图清理：主会话切换时清除 override（与 V1 对齐）
  let lastMainSid = currentSessionID(props.context)
  createEffect(() => {
    const main = currentSessionID(props.context)
    if (main !== lastMainSid) {
      lastMainSid = main
      if (props.signals.overrideSessionId()) {
        props.signals.setOverrideSessionId(undefined)
        persistPreference(props.api, `${KV_PREFIX}.session`, "")
      }
    }
  })

  // 命令层不能依赖侧栏挂载；窄屏或隐藏侧栏时仍需可用。
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: makeCommands(props.context, props.api, props.signals),
  }))
  return null
}

export default {
  id: "opencode-cache-and-tps",
  setup(context: Context) {
    const api = createPanelApi(context)
    const signals = createPanelSignals()

    // 常驻运行时（app 插槽）：余额轮询 / 偏好恢复 / 自动切换 / 命令层。
    const removeRuntime = context.ui.slot({
      append: "app",
      render: () => <RuntimeRoot context={context} api={api} signals={signals} />,
    })

    // 侧边栏完整面板（prepend，排在宿主官方信息之前）。纯展示，副作用在常驻层。
    const removePanel = context.ui.slot({
      prepend: "sidebar.content",
      render: (props: any) => (
        <TokenCachePanel
          theme={mapTheme(context.theme)}
          api={api}
          sessionId={String(props?.sessionID ?? "")}
          signals={signals}
        />
      ),
    })

    // 底部状态栏（含流式实时块，合并到 prompt.footer.status）。
    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: (props: any) => (
        <StatusView
          context={context}
          api={api}
          signals={signals}
          sessionID={String(props?.sessionID ?? "")}
        />
      ),
    })
    return async () => {
      removeStatus()
      removePanel()
      removeRuntime()
      api.dispose()
      await closeCredentialDatabase()
    }
  },
}

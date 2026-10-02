import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const server: Plugin = async () => ({})

/**
 * V2 要求默认导出包含 id 和 setup（或 effect）。本插件无需服务端逻辑，
 * 因此 setup 使用空实现以通过宿主校验；server 字段供 V1 识别。
 */
const setup = async () => {}

const mod: PluginModule & { setup: () => Promise<void> } = {
  id: "opencode-cache-and-tps",
  server,
  setup,
}

export default mod

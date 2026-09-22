// tui.js —— V1 / V2 共用入口（双格式）
// - V1（opencode 1.x）：package exports["./tui"] → 本文件；V1 读取 `tui` 字段
// - V2（opencode 2.x）：package exports["./tui"] → 本文件；V2 读取 `setup` 字段
//   （本地目录加载时 Host.resolve 解析 <dir>/tui，本文件为根级 tui.js，避免
//    目录 index 推断在 Node ESM 下失败）
import tuiMod from "./dist/tui.js"
import v2Mod from "./dist/v2.js"

export default {
  id: "opencode-visual-cache",
  tui: tuiMod.tui,
  setup: v2Mod.setup,
}

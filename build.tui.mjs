import * as esbuild from "esbuild"
import { readFile, writeFile } from "node:fs/promises"
import "./scripts/gen-version.mjs"
import { solidPlugin } from "esbuild-plugin-solid"

// 两版 TUI 产物均复用宿主的渲染器和 Solid 运行时。
const common = {
  format: "esm",
  platform: "node",
  bundle: true,
  external: ["@opencode-ai/*", "@opencode/plugin/*", "@opentui/*", "solid-js"],
}

await esbuild.build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/tui.js",
  ...common,
  plugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
})

// V2 使用 { id, setup } 插件协议。
await esbuild.build({
  entryPoints: ["src/v2/index.tsx"],
  outfile: "dist/v2.js",
  ...common,
  plugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
})

// V2（opencode 2.x）服务端入口：默认导出带 id + setup，供宿主 PluginModule
// schema 校验；本插件无服务端行为，setup 为空实现（@opencode-ai/* 仅 type-only）。
await esbuild.build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  ...common,
})

// esbuild 默认输出 LF，统一为项目约定的 CRLF。
for (const file of ["dist/tui.js", "dist/v2.js", "dist/server.js"]) {
  await writeFile(file, (await readFile(file, "utf8")).replace(/\r?\n/g, "\r\n"))
}

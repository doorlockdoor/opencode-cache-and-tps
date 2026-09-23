#!/usr/bin/env node

/**
 * Local-build installer for opencode-cache-and-tps.
 *
 * 按 README「本地构建」的方式安装（不依赖 npm 发布）：
 *   1. 执行 `npm run build`（可用 `--no-build` 跳过）
 *   2. 复制构建产物到 `~/.config/opencode/plugins`
 *      - v2：`tui.js` + `dist/tui.js` + `dist/v2.js` → `<plugins>/opencode-cache-and-tps/`
 *            （v2 自动发现该目录，无需写入 cli.json；同时清理会重复加载的旧条目）
 *      - v1：在 `tui.json` 注册 `<plugins>/opencode-cache-and-tps/dist/tui.js`
 *            （复用 v2 目录里的同一 V1 bundle，**不放**顶层 `plugins/*.js`——否则
 *             opencode 2.x server 会把 `plugins/` 下的 .js 当 server 插件加载，而
 *             TUI 插件依赖 @opentui/*，会因环境变量重复注册而加载失败）
 *   3. 修改配置文件（v1 的 tui.json；v2 的 cli.json 去重）
 *   4. 写入依赖文件 `~/.config/opencode/package.json`（@opentui/solid）
 *
 * 配置目录统一为 XDG：$OPENCODE_CONFIG_DIR → $XDG_CONFIG_HOME/opencode → ~/.config/opencode
 * （Windows 同样是 ~/.config/opencode，不使用 %APPDATA%）
 *
 * Usage:
 *   node install.mjs            # build + install
 *   node install.mjs --no-build # skip build, install existing dist
 */

import { readFile, writeFile, mkdir, access, copyFile, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const repoRoot = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"))
const PKG_NAME = String(pkg.name)
const BASE = PKG_NAME.split("/").pop() || "opencode-cache-and-tps"
const V1_PLUGIN_FILE = `${BASE}.js`
const V2_PLUGIN_DIR = BASE
const OPEN_TUI_SOLID = pkg.devDependencies?.["@opentui/solid"] ?? "^0.5.1"
const skipBuild = process.argv.includes("--no-build")

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** opencode 全局配置目录（XDG；Windows 亦为 ~/.config/opencode）。 */
function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

async function exists(p) {
  try { await access(p, constants.F_OK); return true } catch { return false }
}

async function readJSONC(p) {
  const raw = await readFile(p, "utf-8")
  // 去掉整行 // 注释后解析（覆盖 opencode 生成的配置；写回会丢失注释）
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
}

const writeJSON = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2) + "\n")

/** 该 plugin 条目的值（字符串或 {package}）。 */
const entryValue = (entry) => (typeof entry === "string" ? entry : entry?.package)

/** 是否指向本插件（包名、@latest、或指向本仓库路径）。 */
function isOurs(entry) {
  const v = entryValue(entry)
  if (typeof v !== "string") return false
  if (v === PKG_NAME || v === `${PKG_NAME}@latest` || v === BASE) return true
  return norm(v) === norm(repoRoot)
}

async function build() {
  if (skipBuild) { console.log("[opencode-cache-and-tps] --no-build：跳过构建"); return }
  // npm 分发的包不含源码（files 只带 dist/tui.js 与 tui.js），此时无法本地构建。
  // 直接使用随包提供的 dist/ 产物，避免已安装包运行 bin 时因缺 src/build.tui.mjs 必然失败。
  if (!(await exists(join(repoRoot, "src"))) || !(await exists(join(repoRoot, "build.tui.mjs")))) {
    console.log("[opencode-cache-and-tps] 未发现源码（src/build.tui.mjs），跳过构建，使用现有 dist/")
    return
  }
  console.log("[opencode-cache-and-tps] 构建中：npm run build")
  const r = spawnSync("npm run build", { cwd: repoRoot, stdio: "inherit", shell: true })
  if (r.status !== 0) throw new Error(`构建失败（exit ${r.status}）`)
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function installV1(pluginsDir) {
  // v1 单文件插件复用 v2 目录里的 dist/tui.js（同一个 V1 bundle）。
  // 关键：不要把 .js 放在 plugins/ 顶层——opencode 2.x 的 server 插件发现会扫描
  // <config>/plugin 与 <config>/plugins 下的 .js/.ts 文件并当作 server 插件加载，
  // 而 TUI 插件 import @opentui/solid → @opentui/core，会与宿主已注册的同名环境
  // 变量冲突，导致 “failed to load plugin”。放进目录内即不在扫描范围内。
  const ref = `./plugins/${V2_PLUGIN_DIR}/dist/tui.js`
  const legacy = `./plugins/${V1_PLUGIN_FILE}`

  const dir = configDir()
  const candidates = [join(dir, "tui.jsonc"), join(dir, "tui.json")]
  const file = (await exists(candidates[0])) ? candidates[0] : ((await exists(candidates[1])) ? candidates[1] : candidates[1])
  const cfg = (await exists(file)) ? await readJSONC(file) : { $schema: "https://opencode.ai/tui.json" }
  const kept = (Array.isArray(cfg.plugin) ? cfg.plugin : [])
    .filter((e) => !isOurs(e) && entryValue(e) !== ref && entryValue(e) !== legacy)
  cfg.plugin = [...kept, ref]
  await writeJSON(file, cfg)

  // 清理旧版顶层单文件（会被 v2 server 误加载为 server 插件而报错）
  const stale = join(pluginsDir, V1_PLUGIN_FILE)
  if (await exists(stale)) {
    await rm(stale, { force: true })
    console.log(`[v1] 已移除顶层旧文件 ${stale}`)
  }
  console.log(`[v1] 注册到 ${file} → ${ref}`)
}

async function installV2(pluginsDir) {
  const dir = join(pluginsDir, V2_PLUGIN_DIR)
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, "dist"), { recursive: true })
  // 只复制运行时真正需要的产物（两个自包含 bundle + 转发入口）
  await copyFile(join(repoRoot, "tui.js"), join(dir, "tui.js"))
  await copyFile(join(repoRoot, "dist", "tui.js"), join(dir, "dist", "tui.js"))
  await copyFile(join(repoRoot, "dist", "v2.js"), join(dir, "dist", "v2.js"))
  console.log(`[v2] ${dir}（tui.js + dist/{tui.js,v2.js}，宿主自动发现）`)

  // 清理 cli.json 中会重复加载的旧条目（npm 包名 / 指向本仓库的 package 路径）
  const cli = join(configDir(), "cli.json")
  if (await exists(cli)) {
    const cfg = await readJSONC(cli)
    if (Array.isArray(cfg.plugins)) {
      const kept = cfg.plugins.filter((e) => !isOurs(e))
      if (kept.length !== cfg.plugins.length) {
        if (kept.length) cfg.plugins = kept
        else delete cfg.plugins
        await writeJSON(cli, cfg)
        console.log(`[v2] 已从 ${cli} 移除本插件的重复条目`)
      }
    }
  }
}

async function writeDependencyFile() {
  const dir = configDir()
  const file = join(dir, "package.json")
  const cfg = (await exists(file)) ? await readJSONC(file) : {}

  // 优先沿用已安装版本，避免擅自升级破坏现有可用的运行时
  let spec = OPEN_TUI_SOLID
  const installedPkg = join(dir, "node_modules", "@opentui", "solid", "package.json")
  if (await exists(installedPkg)) {
    try {
      const v = JSON.parse(await readFile(installedPkg, "utf-8")).version
      if (typeof v === "string" && v) spec = `^${v}`
    } catch {}
  }

  if (cfg.type === undefined) cfg.type = "module"
  cfg.dependencies = { ...(cfg.dependencies ?? {}), "@opentui/solid": spec }
  await writeJSON(file, cfg)
  console.log(`[deps] ${file} += "type": "module", @opentui/solid ${spec}`)
  if (!(await exists(join(dir, "node_modules")))) {
    console.log(`       （未发现 node_modules；若插件加载报模块缺失，请在 ${dir} 执行 npm install）`)
  }
}

async function main() {
  await build()

  const dir = configDir()
  const pluginsDir = join(dir, "plugins")
  await mkdir(pluginsDir, { recursive: true })

  // 先装 v2（重建插件目录，供 v1 引用其 dist/tui.js），再改 v1 的 tui.json
  await installV2(pluginsDir)
  await installV1(pluginsDir)
  await writeDependencyFile()

  console.log("\nv1 重启 opencode 后生效，v2 自动重载。")
  console.log(`提示：v2 自动发现 ${join(pluginsDir, V2_PLUGIN_DIR)}；v1 用 tui.json 引用 ./plugins/${V2_PLUGIN_DIR}/dist/tui.js（不要在 plugins/ 顶层放 .js，会被 server 误加载）。`)
}

main().catch((err) => {
  console.error("Install failed:", err.message)
  process.exit(1)
})

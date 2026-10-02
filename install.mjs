#!/usr/bin/env node

// 构建本地产物或安装发布产物；替换文件前检查所有输入。
import { readFile, writeFile, mkdir, access, copyFile, rm, rename, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname, resolve, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { parse, modify, applyEdits, printParseErrorCode } from "jsonc-parser"

const repoRoot = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"))
const base = pkg.name.split("/").pop()
const configDir = resolve(
  process.env.OPENCODE_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode"),
)
const pluginDir = join(configDir, "plugins", base)
const files = ["tui.js", "dist/tui.js", "dist/v2.js"]
const v1Ref = `./plugins/${base}/dist/tui.js`

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

const norm = (path) => {
  const value = String(path).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? value.toLowerCase() : value
}
const entryValue = (entry) =>
  typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry?.package
function isOurs(entry) {
  const value = entryValue(entry)
  if (typeof value !== "string") return false
  if (value === pkg.name || value.startsWith(`${pkg.name}@`) || value === base) return true
  let path = value
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path)
    } catch {
      return false
    }
  } else if (path.startsWith("file:")) path = path.slice(5)
  const absolute = norm(resolve(configDir, path))
  return [
    repoRoot,
    pluginDir,
    join(pluginDir, "tui.js"),
    join(pluginDir, "dist/tui.js"),
    join(configDir, "plugins", `${base}.js`),
  ].some((p) => norm(p) === absolute)
}

async function config(path, initial = {}) {
  const original = (await exists(path)) ? await readFile(path, "utf8") : undefined
  let text = original ?? JSON.stringify(initial, null, 2) + "\n"
  const errors = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length)
    throw new Error(`${path}: ${printParseErrorCode(errors[0].error)} （位置 ${errors[0].offset}）`)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: 配置必须是对象`)
  return {
    path,
    original,
    value,
    set(key, next) {
      const path = Array.isArray(key) ? key : [key]
      const current = path.reduce((object, part) => object?.[part], value)
      if (JSON.stringify(current) === JSON.stringify(next)) return
      text = applyEdits(
        text,
        modify(text, path, next, {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: text.includes("\r\n") ? "\r\n" : "\n",
          },
        }),
      )
      let object = value
      for (const part of path.slice(0, -1)) object = object[part] ??= {}
      object[path.at(-1)] = next
    },
    text: () => text,
  }
}

// 递归清理仅限显式选定的配置目录。
function checkedPath(path) {
  const target = resolve(path)
  const rel = relative(configDir, target)
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  )
    throw new Error(`安装路径超出允许范围： ${target}`)
  return target
}
const removeTree = (path) => rm(checkedPath(path), { recursive: true, force: true })

async function writeAtomic(path, text) {
  const temporary = checkedPath(`${path}.cache-panel-${process.pid}.tmp`)
  const mode = (await exists(path)) ? (await stat(path)).mode : 0o600
  try {
    await writeFile(temporary, text, { mode })
    await rename(temporary, checkedPath(path))
  } finally {
    await rm(temporary, { force: true })
  }
}

async function main() {
  if (
    !process.argv.includes("--no-build") &&
    (await exists(join(repoRoot, "src"))) &&
    (await exists(join(repoRoot, "build.tui.mjs")))
  ) {
    const result = spawnSync("npm run build", { cwd: repoRoot, stdio: "inherit", shell: true })
    if (result.status !== 0) throw new Error(`构建失败（退出码 ${result.status}）`)
  }
  for (const file of files) {
    if (!(await stat(join(repoRoot, file))).isFile()) throw new Error(`缺少构建产物： ${file}`)
  }
  const tuiFile = join(
    configDir,
    (await exists(join(configDir, "tui.jsonc"))) ? "tui.jsonc" : "tui.json",
  )
  const tui = await config(tuiFile, { $schema: "https://opencode.ai/tui.json" })
  if (tui.value.plugin !== undefined && !Array.isArray(tui.value.plugin))
    throw new Error(`${tuiFile}: plugin 必须是数组`)
  tui.set("plugin", [...(tui.value.plugin ?? []).filter((entry) => !isOurs(entry)), v1Ref])
  const plans = [tui]
  for (const name of ["cli.jsonc", "cli.json"]) {
    const file = join(configDir, name)
    if (!(await exists(file))) continue
    const cli = await config(file)
    if (cli.value.plugins !== undefined && !Array.isArray(cli.value.plugins))
      throw new Error(`${file}: plugins 必须是数组`)
    if (Array.isArray(cli.value.plugins)) {
      const kept = cli.value.plugins.filter((entry) => !isOurs(entry))
      if (kept.length !== cli.value.plugins.length)
        cli.set("plugins", kept.length ? kept : undefined)
    }
    plans.push(cli)
  }
  const deps = await config(join(configDir, "package.json"))
  if (
    deps.value.dependencies !== undefined &&
    (!deps.value.dependencies ||
      typeof deps.value.dependencies !== "object" ||
      Array.isArray(deps.value.dependencies))
  )
    throw new Error("package.json: dependencies 必须是对象")
  let spec = deps.value.dependencies?.["@opentui/solid"]
  if (spec === undefined) {
    const installed = join(configDir, "node_modules/@opentui/solid/package.json")
    spec = (await exists(installed))
      ? JSON.parse(await readFile(installed, "utf8")).version
      : pkg.devDependencies["@opentui/solid"]
    deps.set(["dependencies", "@opentui/solid"], spec)
  }
  if (typeof spec !== "string" || !spec.trim()) throw new Error("@opentui/solid 依赖版本无效")
  if (deps.value.type === undefined) deps.set("type", "module")
  plans.push(deps)

  const stage = checkedPath(join(configDir, `.${base}-stage-${process.pid}`))
  const backup = checkedPath(join(configDir, `.${base}-backup-${process.pid}`))
  const legacy = checkedPath(join(configDir, "plugins", `${base}.js`))
  const legacyBackup = checkedPath(join(configDir, `.${base}-legacy-${process.pid}`))
  if ((await exists(stage)) || (await exists(backup)) || (await exists(legacyBackup)))
    throw new Error("安装暂存路径已存在")
  if ((await exists(legacy)) && !(await stat(legacy)).isFile())
    throw new Error(`旧插件路径必须是文件： ${legacy}`)
  const oldExists = await exists(pluginDir)
  let movedOld = false
  let installed = false
  let movedLegacy = false
  const written = []
  try {
    await mkdir(join(stage, "dist"), { recursive: true, mode: 0o700 })
    for (const file of files) await copyFile(join(repoRoot, file), join(stage, file))
    await writeFile(join(stage, "package.json"), JSON.stringify({ type: "module" }) + "\n")
    await mkdir(join(configDir, "plugins"), { recursive: true })
    if (oldExists) {
      await rename(checkedPath(pluginDir), backup)
      movedOld = true
    }
    await rename(stage, checkedPath(pluginDir))
    installed = true
    for (const plan of plans) {
      if (plan.text() === plan.original) continue
      await writeAtomic(plan.path, plan.text())
      written.push(plan)
    }
    if (await exists(legacy)) {
      await rename(legacy, legacyBackup)
      movedLegacy = true
    }
  } catch (error) {
    const recoveryErrors = []
    for (const plan of written.reverse()) {
      try {
        if (plan.original === undefined) await rm(checkedPath(plan.path), { force: true })
        else await writeAtomic(plan.path, plan.original)
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError)
      }
    }
    try {
      if (installed) await removeTree(pluginDir)
      if (movedOld) await rename(backup, checkedPath(pluginDir))
      if (movedLegacy) await rename(legacyBackup, legacy)
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError)
    }
    if (recoveryErrors.length)
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Install rollback incomplete. Recovery directory: ${backup}`,
      )
    throw error
  } finally {
    await removeTree(stage)
  }
  try {
    await removeTree(backup)
    await rm(legacyBackup, { force: true })
  } catch (error) {
    console.warn("安装已完成，但备份清理失败：", error.message)
  }
  console.log(`已安装到 ${pluginDir}。OpenCode v1 需要重启，v2 会自动重新加载。`)
}

main().catch((error) => {
  console.error("安装失败：", error.message)
  process.exitCode = 1
})

import assert from "node:assert/strict"
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises"
import { resolve, join, relative, isAbsolute } from "node:path"
import { spawnSync } from "node:child_process"
import { parse } from "jsonc-parser"

const root = resolve(".")
const fixture = await mkdtemp(join(root, ".installer-test-"))
const config = join(fixture, "config")
const target = join(config, "plugins/opencode-cache-and-tps")
const run = (preload) =>
  spawnSync(
    process.execPath,
    [...(preload ? ["--require", preload] : []), join(fixture, "install.mjs"), "--no-build"],
    {
      env: { ...process.env, OPENCODE_CONFIG_DIR: config },
      encoding: "utf8",
    },
  )
try {
  await mkdir(join(fixture, "dist"))
  await mkdir(target, { recursive: true })
  await copyFile(join(root, "install.mjs"), join(fixture, "install.mjs"))
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "opencode-cache-and-tps",
      type: "module",
      devDependencies: { "@opentui/solid": "^0.5.1" },
    }),
  )
  for (const file of ["tui.js", "dist/tui.js", "dist/v2.js"])
    await writeFile(join(fixture, file), "export default {}\n")
  await writeFile(join(target, "old.txt"), "old plugin")
  const tuiPath = join(config, "tui.jsonc")
  const cliPath = join(config, "cli.json")
  const packagePath = join(config, "package.json")
  const initialTui =
    '{\n /* 保留这条注释 */\n "theme": "https://example.com/theme", // 行内注释\n "plugin": ["other", "opencode-cache-and-tps@1.7.0",],\n}\n'
  const initialCli = '{"plugins":["opencode-cache-and-tps@latest", "other"]}'
  const initialPackage = '{"dependencies":{"@opentui/solid":"0.5.1"}}'
  await writeFile(tuiPath, initialTui)
  await writeFile(cliPath, initialCli)
  await writeFile(packagePath, initialPackage)

  // 在部分配置写入后模拟磁盘故障，验证安装目录与配置均能回滚。
  const preload = join(fixture, "fail.cjs")
  await writeFile(
    preload,
    `const fs = require('node:fs/promises'); const original = fs.rename; let failed = false;
fs.rename = async (from, to) => { if (!failed && String(from).endsWith('.tmp') && String(to).endsWith('package.json')) { failed = true; throw new Error('模拟写入失败') } return original(from, to) };
require('node:module').syncBuiltinESMExports();`,
  )
  assert.notEqual(run(preload).status, 0)
  assert.equal(await readFile(join(target, "old.txt"), "utf8"), "old plugin")
  assert.equal(await readFile(tuiPath, "utf8"), initialTui)
  assert.equal(await readFile(cliPath, "utf8"), initialCli)
  assert.equal(await readFile(packagePath, "utf8"), initialPackage)

  const success = run()
  assert.equal(success.status, 0, success.stderr)
  const tuiText = await readFile(tuiPath, "utf8")
  assert.match(tuiText, /保留这条注释/)
  assert.match(tuiText, /行内注释/)
  assert.deepEqual(parse(tuiText).plugin, ["other", "./plugins/opencode-cache-and-tps/dist/tui.js"])
  assert.deepEqual(parse(await readFile(cliPath, "utf8")).plugins, ["other"])
  assert.equal(parse(await readFile(packagePath, "utf8")).dependencies["@opentui/solid"], "0.5.1")
  assert.equal(run().status, 0)
  assert.equal(await readFile(tuiPath, "utf8"), tuiText, "重复安装保持幂等")

  await writeFile(tuiPath, '{"plugin": [')
  assert.notEqual(run().status, 0)
  assert.equal(await readFile(join(target, "tui.js"), "utf8"), "export default {}\n")
  await writeFile(tuiPath, tuiText)
  await rm(join(fixture, "dist/v2.js"))
  assert.notEqual(run().status, 0)
  assert.equal(
    await readFile(join(target, "tui.js"), "utf8"),
    "export default {}\n",
    "缺少产物时保留已安装的插件",
  )
} finally {
  const rel = relative(root, resolve(fixture))
  assert.ok(rel.startsWith(".installer-test-") && !rel.includes("..") && !isAbsolute(rel))
  await rm(fixture, { recursive: true, force: true })
}
console.log("安装器测试通过")

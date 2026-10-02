// 同步生成的版本信息；内容未变化时不重写文件。
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const file = resolve("src/_version.ts")
const pkg = JSON.parse(readFileSync("package.json", "utf-8"))
const content = `// 自动生成，请勿手动修改\r\nexport const PLUGIN_VERSION = ${JSON.stringify(pkg.version)}\r\n`
if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content)

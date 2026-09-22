// Generates src/_version.ts when missing (gitignored; the "version" npm
// script rewrites it with the real version on release). All tsc passes
// consume it, so this must run before any tsc on a fresh clone.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const file = resolve("src/_version.ts")
if (!existsSync(file)) {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"))
  writeFileSync(file, `// auto-generated\r\nexport const PLUGIN_VERSION=${JSON.stringify(pkg.version)};\r\n`)
}

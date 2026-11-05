/**
 * Add the plugin to the global OpenCode config.
 *
 * Usage: node scripts/register.mjs <plugin-directory> [keep-legacy-provider]
 */
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const pluginDir = process.argv[2]
const keepLegacy = process.argv[3] === "true"
if (!pluginDir) {
  console.error("usage: node scripts/register.mjs <plugin-directory> [keep-legacy-provider]")
  process.exit(1)
}

const configPath = join(homedir(), ".config", "opencode", "opencode.json")
const backupPath = `${configPath}.bak-commandcode-${new Date().toISOString().replace(/[:.]/g, "-")}`

const raw = (await readFile(configPath, "utf8")).replace(/^\uFEFF/, "")
const doc = JSON.parse(raw)
const pluginPath = pluginDir.replace(/\\/g, "/")

const plugins = Array.isArray(doc.plugins) ? doc.plugins.filter((entry) => {
  if (typeof entry === "string") return !entry.includes("opencode-commandcode")
  if (entry && typeof entry === "object" && typeof entry.package === "string") {
    return !entry.package.includes("opencode-commandcode")
  }
  return true
}) : []
plugins.push(pluginPath)
doc.plugins = plugins

if (!keepLegacy && doc.provider && typeof doc.provider === "object") {
  delete doc.provider.commandcode
}

await copyFile(configPath, backupPath)
await writeFile(configPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8")

console.log(`config: ${configPath}`)
console.log(`backup: ${backupPath}`)
console.log(`plugin: ${pluginPath}`)
console.log(`legacy provider: ${keepLegacy ? "kept" : "removed"}`)

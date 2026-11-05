import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveAuth } from "../src/api.js"

const dirs: string[] = []

async function authFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-auth-"))
  dirs.push(dir)
  const path = join(dir, "auth.json")
  await writeFile(path, content)
  return path
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("auth resolution", () => {
  it("reads the Command Code CLI login", async () => {
    const path = await authFile(JSON.stringify({ apiKey: "cc_test_key", userName: "tester" }))
    const auth = await resolveAuth({ authFile: path })
    expect(auth.apiKey).toBe("cc_test_key")
    expect(auth.source).toBe("command-code-cli")
    expect(auth.userName).toBe("tester")
  })

  it("prefers an explicit key", async () => {
    const path = await authFile(JSON.stringify({ apiKey: "file_key" }))
    const auth = await resolveAuth({ apiKey: "explicit", authFile: path })
    expect(auth.apiKey).toBe("explicit")
    expect(auth.source).toBe("config")
  })

  it("prefers a key saved from the plugin over the CLI file", async () => {
    const path = await authFile(JSON.stringify({ apiKey: "file_key" }))
    const auth = await resolveAuth({ authFile: path }, undefined, "plugin_key")
    expect(auth.apiKey).toBe("plugin_key")
    expect(auth.source).toBe("plugin")
  })

  it("falls back to an existing provider key", async () => {
    const path = await authFile(JSON.stringify({}))
    const auth = await resolveAuth({ authFile: path }, "provider_key")
    expect(auth.apiKey).toBe("provider_key")
    expect(auth.source).toBe("provider")
  })

  it("reports a missing login", async () => {
    const path = join(tmpdir(), `missing-${Date.now()}.json`)
    const auth = await resolveAuth({ authFile: path })
    expect(auth.apiKey).toBeUndefined()
    expect(auth.source).toBe("none")
    expect(auth.error).toContain("not signed in")
  })
})

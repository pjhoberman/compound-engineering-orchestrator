import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "os"
import { runScript as runScriptIn } from "./helpers/run-script"

const SCRIPTS_DIR = path.join(__dirname, "../skills/orch-fanout/scripts")
const FIXTURES_DIR = path.join(__dirname, "fixtures/orch-fanout")

const runScript = (scriptName: string, args: string[] = []) =>
  runScriptIn(SCRIPTS_DIR, scriptName, args)

let counter = 0
function outPath(): string {
  counter += 1
  return path.join(tmpdir(), `orch-manifest-test-${process.pid}-${counter}.json`)
}

async function write(fixture: string) {
  const out = outPath()
  const { stdout, stderr, exitCode } = await runScript("manifest.py", [
    "--out",
    out,
    "--state",
    path.join(FIXTURES_DIR, fixture),
  ])
  return { out, stdout, stderr, exitCode }
}

describe("manifest.py", () => {
  test("writes a normalized manifest and echoes it; tasks sorted by id", async () => {
    const { out, stdout, exitCode } = await write("state-basic.json")
    expect(exitCode).toBe(0)
    const manifest = JSON.parse(stdout)
    expect(manifest.tasks.map((t: any) => t.id)).toEqual(["n1", "n2", "n3"])
    expect(manifest.schema_version).toBe(1)
    expect(manifest.updated_at).toBe("2026-06-23T14:05:00Z")
    // the file on disk matches stdout exactly
    const onDisk = await Bun.file(out).text()
    expect(onDisk).toBe(stdout)
  })

  test("every task carries the full record shape with nulls filled in", async () => {
    const { stdout } = await write("state-basic.json")
    const m = JSON.parse(stdout)
    const n3 = m.tasks.find((t: any) => t.id === "n3")
    // n3 supplied no pr / last_clean_merge -> normalized to null, keys present
    expect(n3.pr).toBeNull()
    expect(n3.last_clean_merge).toBeNull()
    expect(n3).toHaveProperty("worktree")
    expect(n3).toHaveProperty("branch")
  })

  test("updated_at is stamped (ISO-8601 Z) when the state omits it", async () => {
    const { stdout, exitCode } = await write("state-no-timestamp.json")
    expect(exitCode).toBe(0)
    const m = JSON.parse(stdout)
    expect(m.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  test("an invalid task status exits 2 with a message", async () => {
    const { exitCode, stderr } = await write("state-bad-status.json")
    expect(exitCode).toBe(2)
    expect(stderr).toContain("status")
  })

  test("a missing required top-level field exits 2", async () => {
    const { exitCode, stderr } = await write("state-missing-field.json")
    expect(exitCode).toBe(2)
    expect(stderr).toContain("base_commit")
  })

  test("determinism: a state with a fixed updated_at yields identical output across runs", async () => {
    const a = await write("state-basic.json")
    const b = await write("state-basic.json")
    expect(a.stdout).toBe(b.stdout)
  })

  test("usage error: missing required args exits 2", async () => {
    const { exitCode } = await runScript("manifest.py", [])
    expect(exitCode).toBe(2)
  })
})

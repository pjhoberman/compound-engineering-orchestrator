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

describe("reconcile.py", () => {
  const RECOVER = path.join(FIXTURES_DIR, "recover")

  async function reconcile() {
    const { stdout, exitCode } = await runScript("reconcile.py", [
      "--manifest",
      path.join(RECOVER, "manifest.json"),
      "--facts",
      path.join(RECOVER, "facts.json"),
    ])
    return { result: JSON.parse(stdout), exitCode }
  }

  test("reconciles each task's status from manifest + live facts", async () => {
    const { result, exitCode } = await reconcile()
    expect(exitCode).toBe(0)
    const s = Object.fromEntries(result.tasks.map((t: any) => [t.id, t.reconciled_status]))
    expect(s.n1).toBe("in-progress") // worktree + branch, no PR
    expect(s.n2).toBe("in-review") // PR open
    expect(s.n4).toBe("interrupted") // worktree gone
    expect(s.n5).toBe("done") // manifest done
    expect(s.n8).toBe("abandoned") // explicitly abandoned
  })

  test("git is authoritative for in-flight tasks: a merged PR or branch -> done", async () => {
    const { result } = await reconcile()
    const s = Object.fromEntries(result.tasks.map((t: any) => [t.id, t.reconciled_status]))
    expect(s.n3).toBe("done") // manifest in-review, but the PR merged
    expect(s.n7).toBe("done") // manifest in-progress, but the branch merged
  })

  test("terminal manifest status is NOT overridden by a merged branch", async () => {
    // n6 is failed AND its branch merged (facts branch_merged:true) -> stays failed,
    // because terminal manifest states are deliberate records git must not silently flip.
    const { result } = await reconcile()
    const s = Object.fromEntries(result.tasks.map((t: any) => [t.id, t.reconciled_status]))
    expect(s.n6).toBe("failed")
  })

  test("a closed (unmerged) PR with a live worktree falls through to in-progress", async () => {
    // n9: pr_state 'closed' is neither merged nor open -> resume the worktree.
    const { result } = await reconcile()
    const s = Object.fromEntries(result.tasks.map((t: any) => [t.id, t.reconciled_status]))
    expect(s.n9).toBe("in-progress")
  })

  test("interrupted task carries a concrete re-dispatch action", async () => {
    const { result } = await reconcile()
    const n4 = result.tasks.find((t: any) => t.id === "n4")
    expect(n4.action).toContain("re-dispatch")
  })

  test("resume list names exactly the tasks needing action, sorted", async () => {
    const { result } = await reconcile()
    expect(result.resume).toEqual(["n1", "n2", "n4", "n6", "n9"])
  })

  test("a missing manifest file exits 2 with a message, not a traceback", async () => {
    const { exitCode, stderr } = await runScript("reconcile.py", [
      "--manifest",
      "/nonexistent/recovery.json",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("cannot read")
    expect(stderr).not.toContain("Traceback")
  })

  test("determinism: identical output across runs", async () => {
    const a = await reconcile()
    const b = await reconcile()
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
  })

  test("usage error: missing --manifest exits 2", async () => {
    const { exitCode } = await runScript("reconcile.py", [])
    expect(exitCode).toBe(2)
  })
})

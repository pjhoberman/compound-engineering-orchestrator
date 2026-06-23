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

describe("partition.py", () => {
  const PART = path.join(FIXTURES_DIR, "partition")

  async function partition(extra: string[] = []) {
    const { stdout, exitCode } = await runScript("partition.py", [
      "--graph",
      path.join(PART, "graph.json"),
      "--frontier",
      path.join(PART, "frontier.json"),
      ...extra,
    ])
    return { result: JSON.parse(stdout), exitCode }
  }

  function batchOf(result: any, id: string): string[] | undefined {
    return result.batches.find((b: string[]) => b.includes(id))
  }

  test("excludes non-work ready nodes with a reason, never silently drops them", async () => {
    const { result, exitCode } = await partition()
    expect(exitCode).toBe(0)
    const ex = Object.fromEntries(result.excluded.map((e: any) => [e.id, e.reason]))
    expect(Object.keys(ex).sort()).toEqual(["n4", "n6"]) // plan + brainstorm
    expect(ex.n4).toContain("plan")
    expect(ex.n6).toContain("brainstorm")
    expect(result.eligible_count).toBe(4) // n1, n2, n3, n5
  })

  test("packs collision-free nodes together and splits colliding ones", async () => {
    const { result } = await partition()
    // n1 touches a.py; n3 also touches a.py -> must be in different batches
    expect(batchOf(result, "n1")).not.toContain("n3")
    expect(batchOf(result, "n3")).toBeDefined() // n3 is batched, not silently dropped
    // n2 (c.py) and n5 (d.py) don't collide with n1 (a.py/b.py) -> share its batch
    expect(batchOf(result, "n1")).toContain("n2")
    expect(batchOf(result, "n1")).toContain("n5")
    // every eligible node lands in exactly one batch (no silent drops)
    const total = result.batches.reduce((n: number, b: string[]) => n + b.length, 0)
    expect(total).toBe(result.eligible_count)
  })

  test("normalizes paths so one file in different spellings never co-batches (collision safety)", async () => {
    // nP1 'a.py', nP2 './a.py', nP3 'dir/../a.py' are the SAME file -> must be pairwise split,
    // else parallel /lfg worktrees would edit it at once. Regression for the path-normalization P0.
    const { result } = await partitionIn("partition-paths")
    const b1 = batchOf(result, "nP1")
    expect(b1).not.toContain("nP2")
    expect(b1).not.toContain("nP3")
    expect(batchOf(result, "nP2")).not.toContain("nP3")
    expect(result.batch_count).toBeGreaterThanOrEqual(3)
    // nP5 omits slack entirely -> inf-fallback ranking, ranked last, still batched (not dropped)
    expect(batchOf(result, "nP5")).toBeDefined()
  })

  test("ranks by leverage: the highest-leverage node leads the first batch", async () => {
    const { result } = await partition()
    expect(result.batches[0][0]).toBe("n1") // slack 0, unblocks 2
  })

  test("respects --max-batch", async () => {
    const { result } = await partition(["--max-batch", "2"])
    for (const b of result.batches) expect(b.length).toBeLessThanOrEqual(2)
    expect(result.batch_count).toBeGreaterThanOrEqual(2) // 4 eligible, cap 2 -> >=2 batches
    const total = result.batches.reduce((n: number, b: string[]) => n + b.length, 0)
    expect(total).toBe(result.eligible_count) // cap must not drop nodes
  })

  test("--max-batch < 1 is a usage error (exit 2)", async () => {
    const { exitCode, stderr } = await runScript("partition.py", [
      "--graph",
      path.join(PART, "graph.json"),
      "--frontier",
      path.join(PART, "frontier.json"),
      "--max-batch",
      "0",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("max-batch")
  })

  test("determinism: identical output across runs", async () => {
    const a = await partition()
    const b = await partition()
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
  })

  async function partitionIn(dir: string) {
    const d = path.join(FIXTURES_DIR, dir)
    const { stdout, exitCode } = await runScript("partition.py", [
      "--graph",
      path.join(d, "graph.json"),
      "--frontier",
      path.join(d, "frontier.json"),
    ])
    return { result: JSON.parse(stdout), exitCode }
  }

  test("excludes no_pr ops nodes and nodes absent from node_meta; batches an empty-footprint work node", async () => {
    const { result } = await partitionIn("partition-edge")
    const ex = Object.fromEntries(result.excluded.map((e: any) => [e.id, e.reason]))
    expect(ex.nE2).toContain("no_pr") // work but no_pr -> not fan-out eligible
    expect(ex.nE4).toContain("node_meta") // absent from node_meta -> explicit reason, not "stage None"
    expect(result.eligible_count).toBe(2) // nE1, nE3
    // nE3 has an empty footprint -> collides with nothing -> batched, not excluded
    expect(batchOf(result, "nE3")).toBeDefined()
    expect(batchOf(result, "nE3")).toContain("nE1")
  })

  test("empty ready set yields empty batches and excluded, zero counts", async () => {
    const { result, exitCode } = await partitionIn("partition-empty")
    expect(exitCode).toBe(0)
    expect(result.batches).toEqual([])
    expect(result.excluded).toEqual([])
    expect(result.eligible_count).toBe(0)
    expect(result.batch_count).toBe(0)
  })

  test("a missing --graph file exits 2 with a message, not a traceback", async () => {
    const { exitCode, stderr } = await runScript("partition.py", [
      "--graph",
      "/nonexistent/graph.json",
      "--frontier",
      path.join(PART, "frontier.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("cannot read")
    expect(stderr).not.toContain("Traceback")
  })

  test("a missing --frontier file exits 2 with a message", async () => {
    const { exitCode, stderr } = await runScript("partition.py", [
      "--graph",
      path.join(PART, "graph.json"),
      "--frontier",
      "/nonexistent/frontier.json",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("cannot read")
  })

  test("a graph JSON without node_meta exits 2 (stale input surfaced)", async () => {
    const { exitCode, stderr } = await runScript("partition.py", [
      "--graph",
      path.join(FIXTURES_DIR, "partition-no-meta", "graph.json"),
      "--frontier",
      path.join(PART, "frontier.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("node_meta")
  })

  test("usage error: missing required args exits 2", async () => {
    const { exitCode } = await runScript("partition.py", [])
    expect(exitCode).toBe(2)
  })
})

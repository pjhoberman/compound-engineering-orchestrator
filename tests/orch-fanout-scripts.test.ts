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

describe("wave_plan.py", () => {
  const WP = path.join(FIXTURES_DIR, "wave-plan")

  async function wavePlan(partitionFile = "partition.json") {
    const { stdout, exitCode } = await runScript("wave_plan.py", [
      "--partition",
      path.join(WP, partitionFile),
      "--graph",
      path.join(WP, "graph.json"),
    ])
    return { result: JSON.parse(stdout), exitCode }
  }

  test("extracts exclusive_runtime nodes into solo waves; keeps the rest parallel", async () => {
    const { result, exitCode } = await wavePlan()
    expect(exitCode).toBe(0)
    // batch [n1,n2,n3] with n2 exclusive -> parallel [n1,n3] + solo n2
    const first = result.waves[0]
    expect(first.kind).toBe("parallel")
    expect(first.ids).toEqual(["n1", "n3"])
    expect(first.ids).not.toContain("n2")
    // a fully non-exclusive batch stays one parallel wave
    const parallels = result.waves.filter((w: any) => w.kind === "parallel")
    expect(parallels.some((w: any) => JSON.stringify(w.ids) === JSON.stringify(["n5", "n6"]))).toBe(true)
  })

  test("an exclusive node never shares a wave; each gets its own solo wave", async () => {
    const { result } = await wavePlan()
    const solos = result.waves.filter((w: any) => w.kind === "solo").map((w: any) => w.id)
    expect(solos.sort()).toEqual(["n2", "n4"]) // both exclusive nodes, separate solo waves
    for (const w of result.waves) {
      if (w.kind === "parallel") {
        expect(w.ids).not.toContain("n2")
        expect(w.ids).not.toContain("n4")
      }
    }
    expect(result.wave_count).toBe(4)
  })

  test("an empty partition yields no waves", async () => {
    const { result, exitCode } = await wavePlan("empty-partition.json")
    expect(exitCode).toBe(0)
    expect(result.waves).toEqual([])
    expect(result.wave_count).toBe(0)
  })

  test("determinism: identical output across runs", async () => {
    const a = await wavePlan()
    const b = await wavePlan()
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
  })

  test("a graph without node_meta exits 2", async () => {
    const { exitCode, stderr } = await runScript("wave_plan.py", [
      "--partition",
      path.join(WP, "partition.json"),
      "--graph",
      path.join(FIXTURES_DIR, "partition-no-meta", "graph.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("node_meta")
  })

  test("a missing --partition file exits 2", async () => {
    const { exitCode, stderr } = await runScript("wave_plan.py", [
      "--partition",
      "/nonexistent/partition.json",
      "--graph",
      path.join(WP, "graph.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("cannot read")
  })

  test("a batched node absent from node_meta exits 2 (stale graph/partition pair), not silently parallel", async () => {
    const { exitCode, stderr } = await runScript("wave_plan.py", [
      "--partition",
      path.join(WP, "partition-stale.json"),
      "--graph",
      path.join(WP, "graph.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("stale")
  })

  test("usage error: missing required args exits 2", async () => {
    const { exitCode } = await runScript("wave_plan.py", [])
    expect(exitCode).toBe(2)
  })
})

describe("circuit_breaker.py", () => {
  const CB = path.join(FIXTURES_DIR, "circuit")

  async function breaker(fixture: string, extra: string[] = []) {
    const { stdout, exitCode } = await runScript("circuit_breaker.py", [
      "--outcomes",
      path.join(CB, fixture),
      ...extra,
    ])
    return { result: JSON.parse(stdout), exitCode }
  }

  test("trips when trailing consecutive failures reach the threshold", async () => {
    const { result, exitCode } = await breaker("tripped.json") // 3 fails, default K=3
    expect(exitCode).toBe(0)
    expect(result.tripped).toBe(true)
    expect(result.consecutive_failures).toBe(3)
    expect(result.reason).toContain("halt")
  })

  test("does not trip below the threshold", async () => {
    const { result } = await breaker("streak2.json") // 2 fails, K=3
    expect(result.tripped).toBe(false)
    expect(result.consecutive_failures).toBe(2)
  })

  test("a pass resets the failure streak", async () => {
    const { result } = await breaker("reset.json", ["--threshold", "2"]) // fail,pass,fail
    expect(result.consecutive_failures).toBe(1) // trailing streak after the reset
    expect(result.tripped).toBe(false)
  })

  test("clean and empty runs never trip", async () => {
    expect((await breaker("clean.json")).result.consecutive_failures).toBe(0)
    expect((await breaker("empty.json")).result.tripped).toBe(false)
  })

  test("--threshold lowers the trip point", async () => {
    const { result } = await breaker("streak2.json", ["--threshold", "2"])
    expect(result.tripped).toBe(true)
  })

  test("K=1 trips on a single failure (boundary)", async () => {
    const { result } = await breaker("single-fail.json", ["--threshold", "1"])
    expect(result.tripped).toBe(true)
    expect(result.consecutive_failures).toBe(1)
  })

  test("a streak that resumes after a reset still trips", async () => {
    // fail,pass,fail,fail,fail with K=3 -> the trailing 3-run trips despite the earlier reset
    const { result } = await breaker("trip-after-reset.json")
    expect(result.tripped).toBe(true)
    expect(result.consecutive_failures).toBe(3)
  })

  test("non-list outcomes input exits 2", async () => {
    const { exitCode } = await runScript("circuit_breaker.py", [
      "--outcomes",
      path.join(CB, "not-list.json"),
    ])
    expect(exitCode).toBe(2)
  })

  test("an invalid outcome value exits 2 and names the bad value", async () => {
    // bad.json contains "boom" -> exit 2 before any JSON, so call runScript directly
    const { exitCode, stderr } = await runScript("circuit_breaker.py", [
      "--outcomes",
      path.join(CB, "bad.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("boom") // the offending value is named, not just any 'pass' substring
  })

  test("a non-string outcome element (JSON number/null) exits 2", async () => {
    const { exitCode } = await runScript("circuit_breaker.py", [
      "--outcomes",
      path.join(CB, "non-string.json"),
    ])
    expect(exitCode).toBe(2)
  })

  test("a trailing pass resets the streak to zero (no trip even after an earlier run)", async () => {
    // fail,fail,fail,pass with default K=3 -> trailing streak 0, not tripped
    const { result } = await breaker("trailing-pass.json")
    expect(result.consecutive_failures).toBe(0)
    expect(result.tripped).toBe(false)
  })

  test("a missing --outcomes file exits 2 with a message, not a traceback", async () => {
    const { exitCode, stderr } = await runScript("circuit_breaker.py", [
      "--outcomes",
      "/nonexistent/outcomes.json",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("cannot read")
    expect(stderr).not.toContain("Traceback")
  })

  test("--threshold < 1 exits 2", async () => {
    const { exitCode } = await runScript("circuit_breaker.py", [
      "--outcomes",
      path.join(CB, "clean.json"),
      "--threshold",
      "0",
    ])
    expect(exitCode).toBe(2)
  })

  test("determinism: identical output across runs", async () => {
    const a = await breaker("tripped.json")
    const b = await breaker("tripped.json")
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
  })

  test("usage error: missing required args exits 2", async () => {
    const { exitCode } = await runScript("circuit_breaker.py", [])
    expect(exitCode).toBe(2)
  })
})

describe("resolve_models.py", () => {
  const RES = path.join(FIXTURES_DIR, "resolve")

  async function resolve(extra: string[] = []) {
    const { stdout, stderr, exitCode } = await runScript("resolve_models.py", [
      "--waves",
      path.join(RES, "waves.json"),
      "--graph",
      path.join(RES, "graph.json"),
      ...extra,
    ])
    return { result: exitCode === 0 ? JSON.parse(stdout) : null, stdout, stderr, exitCode }
  }

  function nodeOf(result: any, id: string): any {
    for (const w of result.waves) {
      const n = w.nodes.find((n: any) => n.id === id)
      if (n) return n
    }
    return undefined
  }

  test("default (builtin claude-code) reproduces the prose mapping: ceiling->inherit, generation->sonnet", async () => {
    const { result, exitCode } = await resolve()
    expect(exitCode).toBe(0)
    expect(result.profile).toBe("claude-code")
    expect(result.profile_source).toBe("builtin")
    expect(nodeOf(result, "n1")).toMatchObject({ tier: "ceiling", resolved_tier: "ceiling", fallback: false, agent: "claude-code", model: "inherit" })
    expect(nodeOf(result, "n2")).toMatchObject({ tier: "generation", resolved_tier: "generation", fallback: false, agent: "claude-code", model: "sonnet" })
  })

  test("null and unrecognized tiers fall back to the profile's ceiling spec, flagged", async () => {
    const { result } = await resolve()
    // n3 model is null, n4 model is an unrecognized "wat" -> both fall back to ceiling
    expect(nodeOf(result, "n3")).toMatchObject({ tier: null, resolved_tier: "ceiling", fallback: true, model: "inherit" })
    expect(nodeOf(result, "n4")).toMatchObject({ tier: "wat", resolved_tier: "ceiling", fallback: true, model: "inherit" })
  })

  test("preserves wave order and kind; sorts nodes by id within a wave", async () => {
    const { result } = await resolve()
    expect(result.wave_count).toBe(2)
    expect(result.waves[0].kind).toBe("parallel")
    expect(result.waves[0].nodes.map((n: any) => n.id)).toEqual(["n1", "n3", "n4"]) // input was n3,n1,n4
    expect(result.waves[1].kind).toBe("solo")
    expect(result.waves[1].reason).toBe("exclusive_runtime")
    expect(result.waves[1].nodes.map((n: any) => n.id)).toEqual(["n2"])
  })

  test("builtin non-Claude profiles are selectable and carry agent + gateway env names", async () => {
    const { result } = await resolve(["--profile", "conductor-mixed"])
    expect(result.profile).toBe("conductor-mixed")
    expect(nodeOf(result, "n2")).toMatchObject({ agent: "codex", model: "gpt-5-codex" }) // generation node -> codex
    expect(nodeOf(result, "n1")).toMatchObject({ agent: "claude-code", model: "opus" })
  })

  test("a --profiles file overrides builtins; env-var names pass through; default_profile is honored", async () => {
    const { result } = await resolve(["--profiles", path.join(RES, "profiles-custom.json")])
    expect(result.profile).toBe("gw") // the file's default_profile
    expect(result.profile_source).toContain("profiles-custom.json")
    expect(nodeOf(result, "n2")).toMatchObject({ agent: "codex", model: "gpt-5-mini", base_url_env: "GW_URL", api_key_env: "GW_KEY" })
    // a claude-code node still gets null env fields, not missing keys
    expect(nodeOf(result, "n1").base_url_env).toBe("GW_URL")
  })

  test("an unknown --profile name exits 2 and lists what's available", async () => {
    const { exitCode, stderr } = await resolve(["--profile", "nope"])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("not found")
  })

  test("a profile missing a tier spec exits 2 (fallback target must exist)", async () => {
    const { exitCode, stderr } = await resolve(["--profiles", path.join(RES, "profiles-missing-tier.json")])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("generation")
  })

  test("an unknown agent in a profile exits 2", async () => {
    const { exitCode, stderr } = await resolve(["--profiles", path.join(RES, "profiles-bad-agent.json")])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("agent")
  })

  test("an unknown tier key in a profile exits 2 (catches typos)", async () => {
    const { exitCode, stderr } = await resolve(["--profiles", path.join(RES, "profiles-unknown-tier.json")])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("celing")
  })

  test("a present-but-empty gateway env field exits 2 (would be a bogus env-var name)", async () => {
    const { exitCode, stderr } = await resolve(["--profiles", path.join(RES, "profiles-empty-env.json")])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("base_url_env")
  })

  test("a graph without node_meta exits 2", async () => {
    const { exitCode, stderr } = await runScript("resolve_models.py", [
      "--waves",
      path.join(RES, "waves.json"),
      "--graph",
      path.join(FIXTURES_DIR, "partition-no-meta", "graph.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("node_meta")
  })

  test("a missing --waves file exits 2 with a message, not a traceback", async () => {
    const { exitCode, stderr } = await runScript("resolve_models.py", [
      "--waves",
      "/nonexistent/waves.json",
      "--graph",
      path.join(RES, "graph.json"),
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("cannot read")
    expect(stderr).not.toContain("Traceback")
  })

  test("determinism: identical output across runs", async () => {
    const a = await resolve()
    const b = await resolve()
    expect(a.stdout).toBe(b.stdout)
  })

  test("usage error: missing required args exits 2", async () => {
    const { exitCode } = await runScript("resolve_models.py", [])
    expect(exitCode).toBe(2)
  })
})

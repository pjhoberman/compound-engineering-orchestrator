import { describe, expect, test } from "bun:test"
import path from "path"
import { runScript as runScriptIn } from "./helpers/run-script"

const SCRIPTS_DIR = path.join(__dirname, "../skills/orch-ripen/scripts")
const FIXTURES_DIR = path.join(__dirname, "fixtures/orch-ripen")

const runScript = (scriptName: string, args: string[] = []) =>
  runScriptIn(SCRIPTS_DIR, scriptName, args)

async function planningFrontier(fixture: string) {
  const dir = path.join(FIXTURES_DIR, fixture)
  const { stdout, exitCode } = await runScript("ripen_frontier.py", [
    "--graph",
    path.join(dir, "graph.json"),
    "--status",
    path.join(dir, "status.json"),
  ])
  return { result: JSON.parse(stdout), exitCode }
}

const ids = (rows: any[]) => rows.map((r: any) => r.id)

describe("ripen_frontier.py — decision-dependency planning frontier", () => {
  // Acceptance sketch: n101 -> n102 -> {n103,n104,n105}, all plan-stage.
  // Wave 1 = n101 solo; wave 2 = n102; wave 3 = n103+n104+n105 in parallel.
  test("wave 1: only the root plan node is ready (siblings blocked on the undecided parent)", async () => {
    const { result, exitCode } = await planningFrontier("specimen-wave1")
    expect(exitCode).toBe(0)
    expect(result.cycle).toBe(false)
    expect(ids(result.plan_wave)).toEqual(["n101"])
    // the three siblings must NOT be planned while their shared decision-parent is unplanned
    expect(ids(result.blocked)).toEqual(["n102", "n103", "n104", "n105"])
    expect(result.brainstorm).toEqual([])
    expect(result.flipped).toEqual([])
  })

  test("wave 1: unblocks_planning counts only nodes whose sole unsatisfied dep is this one", async () => {
    const { result } = await planningFrontier("specimen-wave1")
    const n101 = result.plan_wave.find((r: any) => r.id === "n101")
    // approving n101 makes n102 plannable (its only dep) — but not the siblings (they still need n102)
    expect(n101.unblocks_planning).toBe(1)
  })

  test("wave 1: carries slack/critical through from graph_compute", async () => {
    const { result } = await planningFrontier("specimen-wave1")
    const n101 = result.plan_wave.find((r: any) => r.id === "n101")
    expect(n101.slack).toBe(0)
    expect(n101.critical).toBe(true)
  })

  test("wave 1: a blocked node names the unsettled decision it waits on", async () => {
    const { result } = await planningFrontier("specimen-wave1")
    const n102 = result.blocked.find((b: any) => b.id === "n102")
    expect(n102.blocked_on.map((x: any) => x.id)).toEqual(["n101"])
    expect(n102.blocked_on[0].reason).toContain("plan not yet authored")
  })

  test("wave 2: once n101 flips to work, n102 becomes plannable and n101 is 'flipped'", async () => {
    const { result } = await planningFrontier("specimen-wave2")
    expect(ids(result.plan_wave)).toEqual(["n102"])
    expect(result.flipped).toEqual(["n101"])
    // siblings still blocked — n102's plan isn't approved yet
    expect(ids(result.blocked)).toEqual(["n103", "n104", "n105"])
    // approving n102 unblocks all three siblings
    const n102 = result.plan_wave.find((r: any) => r.id === "n102")
    expect(n102.unblocks_planning).toBe(3)
  })

  test("wave 3: with n101 (done) and n102 (work) settled, the three siblings fan in parallel", async () => {
    const { result } = await planningFrontier("specimen-wave3")
    // a dependency is satisfied by EITHER a merge (done) OR a flip-to-work
    expect(ids(result.plan_wave)).toEqual(["n103", "n104", "n105"])
    expect(result.flipped).toEqual(["n102"])
    expect(result.done).toEqual(["n101"])
    expect(result.blocked).toEqual([])
  })
})

describe("ripen_frontier.py — brainstorm blocking", () => {
  test("a frontier brainstorm node is reported, never fanned into the plan wave", async () => {
    const { result } = await planningFrontier("brainstorm")
    expect(ids(result.brainstorm)).toEqual(["n1"])
    expect(ids(result.plan_wave)).not.toContain("n1")
    expect(result.plan_wave).toEqual([])
  })

  test("a plan node downstream of an unsettled brainstorm is blocked with that reason", async () => {
    const { result } = await planningFrontier("brainstorm")
    const n2 = result.blocked.find((b: any) => b.id === "n2")
    expect(n2.blocked_on.map((x: any) => x.id)).toEqual(["n1"])
    expect(n2.blocked_on[0].reason).toContain("brainstorm not settled")
  })
})

describe("ripen_frontier.py — mixed states", () => {
  test("a done dependency satisfies planning; root plan nodes are ready", async () => {
    const { result } = await planningFrontier("mixed")
    // n2 (dep n1 done) and n7 (root) are plannable
    expect(ids(result.plan_wave)).toEqual(["n2", "n7"])
  })

  test("already-flipped work nodes are 'flipped', not wave members", async () => {
    const { result } = await planningFrontier("mixed")
    expect(result.flipped).toEqual(["n3"])
    expect(ids(result.plan_wave)).not.toContain("n3")
  })

  test("a work node pinned blocked is surfaced as blocked, never mislabeled flipped", async () => {
    // n8 is stage:work but manual_status:blocked -- the human pin is terminal and must win
    // over the flipped bucket, so a parked flipped node isn't shown as ready context.
    const { result } = await planningFrontier("mixed")
    expect(ids(result.blocked)).toContain("n8")
    expect(result.flipped).not.toContain("n8")
  })

  test("a manually-pinned blocked plan node stays blocked even if its decisions are settled", async () => {
    const { result } = await planningFrontier("mixed")
    // n4 depends on n1 (done) but is pinned blocked -> must not be plannable
    expect(ids(result.plan_wave)).not.toContain("n4")
    const n4 = result.blocked.find((b: any) => b.id === "n4")
    expect(n4.blocked_on[0].reason).toContain("manual_status: blocked")
  })

  test("an in-progress plan node is bucketed active, not ready or blocked", async () => {
    const { result } = await planningFrontier("mixed")
    expect(result.active).toEqual(["n5"])
    expect(ids(result.plan_wave)).not.toContain("n5")
    expect(ids(result.blocked)).not.toContain("n5")
  })

  test("unblocks_planning excludes downstream nodes that can never enter a wave (blocked/active)", async () => {
    // n1 (plan root) has three plan children all depending solely on n1: n2 is manually
    // blocked, n3 is in-progress, n4 is plannable. Approving n1 can only unblock n4 -> 1,
    // not 3 -- blocked/active successors must not inflate the Phase 3 preview count.
    const { result } = await planningFrontier("unblocks")
    const n1 = result.plan_wave.find((r: any) => r.id === "n1")
    expect(n1.unblocks_planning).toBe(1)
    expect(ids(result.blocked)).toContain("n2")
    expect(result.active).toContain("n3")
  })
})

describe("ripen_frontier.py — robustness", () => {
  test("a cycle yields an empty planning frontier and surfaces the finding", async () => {
    const { result, exitCode } = await planningFrontier("cycle")
    expect(exitCode).toBe(0)
    expect(result.cycle).toBe(true)
    expect(result.plan_wave).toEqual([])
    expect(result.note).toContain("cycle")
  })

  test("the cycle branch keeps the same output shape as the happy path (counts present)", async () => {
    // a consumer must be able to read result.counts without first branching on cycle
    const { result } = await planningFrontier("cycle")
    expect(result.counts).toBeDefined()
    expect(result.counts.plan_wave).toBe(0)
  })

  test("determinism: identical output across runs", async () => {
    const a = await planningFrontier("specimen-wave1")
    const b = await planningFrontier("specimen-wave1")
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
  })

  test("usage error: missing required args exits 2", async () => {
    const { exitCode } = await runScript("ripen_frontier.py", [])
    expect(exitCode).toBe(2)
  })

  test("a missing/unreadable input file exits 2 with a message, not a traceback", async () => {
    const { exitCode, stderr } = await runScript("ripen_frontier.py", [
      "--graph",
      "/nonexistent/graph.json",
      "--status",
      "/nonexistent/status.json",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("cannot read")
    expect(stderr).not.toContain("Traceback")
  })
})

async function staleness(fixture: string, facts?: string) {
  const dir = path.join(FIXTURES_DIR, fixture)
  const args = [dir]
  if (facts) args.push("--facts", path.join(dir, facts))
  const { stdout, exitCode } = await runScript("staleness.py", args)
  return { result: JSON.parse(stdout), exitCode }
}

describe("staleness.py — pure state machine (via --facts)", () => {
  test("flags a work node whose base_commit predates a merged upstream", async () => {
    const { result, exitCode } = await staleness("stale", "facts.json")
    expect(exitCode).toBe(0)
    expect(result.nodes.n1.stale).toBe(true)
    expect(result.nodes.n1.stale_on).toEqual(["n3"])
    expect(result.nodes.n1.reason).toContain("predates")
  })

  test("does NOT flag a work node whose upstream merge is already in its base_commit", async () => {
    const { result } = await staleness("stale", "facts.json")
    expect(result.nodes.n2.stale).toBe(false)
  })

  test("a work node with no merged upstream is fresh", async () => {
    const { result } = await staleness("stale", "facts.json")
    expect(result.nodes.n3.stale).toBe(false)
  })

  test("a plan-stage node is never stale (no embedded plan to invalidate)", async () => {
    const { result } = await staleness("stale", "facts.json")
    expect(result.nodes.n4.stale).toBe(false)
  })

  test("a work node with merged upstream but no base_commit is flagged unverifiable", async () => {
    const { result } = await staleness("stale", "facts.json")
    expect(result.nodes.n5.stale).toBe(true)
    expect(result.nodes.n5.reason).toContain("no base_commit")
  })

  test("the top-level stale list is exactly the flagged nodes, sorted", async () => {
    const { result } = await staleness("stale", "facts.json")
    expect(result.stale).toEqual(["n1", "n5"])
  })

  test("a fully-verifiable run reports incomplete: false", async () => {
    const { result } = await staleness("stale", "facts.json")
    expect(result.incomplete).toBe(false)
  })

  test("an unverifiable upstream (gh/git couldn't check) is surfaced, never silently 'fresh'", async () => {
    // n1's dep n3 is merged but its ancestry couldn't be verified (shallow clone / gh outage).
    // It must NOT be reported stale (that would be a false positive) NOR silently fresh -- it
    // lands in `unverifiable` and flips the run-level `incomplete` flag.
    const { result } = await staleness("stale", "facts-incomplete.json")
    expect(result.incomplete).toBe(true)
    expect(result.nodes.n1.stale).toBe(false)
    expect(result.nodes.n1.unverifiable).toEqual(["n3"])
    // n5 (no base_commit + merged upstream) is still definitively stale
    expect(result.stale).toEqual(["n5"])
  })

  test("determinism: identical output across runs", async () => {
    const a = await staleness("stale", "facts.json")
    const b = await staleness("stale", "facts.json")
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
  })

  test("usage error: no project dir exits 2", async () => {
    const { exitCode } = await runScript("staleness.py", [])
    expect(exitCode).toBe(2)
  })

  test("a missing index.md exits 2 with a message, not a traceback", async () => {
    const { exitCode, stderr } = await runScript("staleness.py", ["/nonexistent/project-dir"])
    expect(exitCode).toBe(2)
    expect(stderr).not.toContain("Traceback")
  })
})

import { describe, expect, test } from "bun:test"
import path from "path"
import { runScript as runScriptIn } from "./helpers/run-script"

const SCRIPTS_DIR = path.join(__dirname, "../skills/orch-next/scripts")
const FIXTURES_DIR = path.join(__dirname, "fixtures/orch-next")

const runScript = (scriptName: string, args: string[] = []) =>
  runScriptIn(SCRIPTS_DIR, scriptName, args)

async function frontier(fixture: string) {
  const dir = path.join(FIXTURES_DIR, fixture)
  const { stdout, exitCode } = await runScript("frontier.py", [
    "--graph",
    path.join(dir, "graph.json"),
    "--status",
    path.join(dir, "status.json"),
  ])
  return { result: JSON.parse(stdout), exitCode }
}

describe("frontier.py", () => {
  test("partitions done / ready / blocked from graph + status", async () => {
    const { result, exitCode } = await frontier("basic")
    expect(exitCode).toBe(0)
    expect(result.cycle).toBe(false)
    expect(result.done).toEqual(["n1", "n2"])
    expect(result.ready.map((r: any) => r.id)).toEqual(["n3", "n4"])
    expect(result.blocked.map((b: any) => b.id)).toEqual(["n5", "n6"])
    expect(result.active).toEqual([])
  })

  test("unblocks counts nodes whose only remaining unsatisfied dep is this one", async () => {
    const { result } = await frontier("basic")
    const byId = Object.fromEntries(result.ready.map((r: any) => [r.id, r]))
    // n5 and n6 both depend solely on n3 -> completing n3 makes both ready
    expect(byId.n3.unblocks).toBe(2)
    // nothing depends solely on n4
    expect(byId.n4.unblocks).toBe(0)
  })

  test("carries slack/critical through from graph_compute", async () => {
    const { result } = await frontier("basic")
    const byId = Object.fromEntries(result.ready.map((r: any) => [r.id, r]))
    expect(byId.n3.slack).toBe(0)
    expect(byId.n3.critical).toBe(true)
    // n4 is off the critical path -> positive slack
    expect(byId.n4.slack).toBeGreaterThan(0)
    expect(byId.n4.critical).toBe(false)
  })

  test("blocked nodes report their unsatisfied dependencies", async () => {
    const { result } = await frontier("basic")
    const n5 = result.blocked.find((b: any) => b.id === "n5")
    expect(n5.blocked_on).toEqual(["n3"])
  })

  test("active nodes (in-progress/in-review) are bucketed as active, not ready or blocked", async () => {
    const { result } = await frontier("mixed")
    // n5 is in-progress
    expect(result.active).toEqual(["n5"])
    expect(result.ready.map((r: any) => r.id)).not.toContain("n5")
    expect(result.blocked.map((b: any) => b.id)).not.toContain("n5")
  })

  test("a human-pinned 'blocked' node stays blocked even when its deps are done", async () => {
    // regression: n4 depends on n2 (done) but is pinned blocked -> must NOT be ready
    const { result } = await frontier("mixed")
    expect(result.ready.map((r: any) => r.id)).not.toContain("n4")
    expect(result.blocked.map((b: any) => b.id)).toContain("n4")
  })

  test("a node present in the graph but absent from status defaults to not-started", async () => {
    // n7 is in graph edges (deps [n1], done) but omitted from status -> ready
    const { result } = await frontier("mixed")
    expect(result.ready.map((r: any) => r.id)).toContain("n7")
  })

  test("a cycle yields an empty frontier and surfaces the finding", async () => {
    const { result, exitCode } = await frontier("cycle")
    expect(exitCode).toBe(0)
    expect(result.cycle).toBe(true)
    expect(result.ready).toHaveLength(0)
    expect(result.note).toContain("cycle")
  })

  test("determinism: identical output across runs", async () => {
    const a = await frontier("basic")
    const b = await frontier("basic")
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
  })

  test("usage error: missing required args exits 2", async () => {
    const { exitCode } = await runScript("frontier.py", [])
    expect(exitCode).toBe(2)
  })

  test("a missing/unreadable input file exits 2 with a message, not a traceback", async () => {
    const { exitCode, stderr } = await runScript("frontier.py", [
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

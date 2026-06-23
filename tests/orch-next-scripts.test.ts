import { describe, expect, test } from "bun:test"
import path from "path"

const SCRIPTS_DIR = path.join(__dirname, "../skills/orch-next/scripts")
const FIXTURES_DIR = path.join(__dirname, "fixtures/orch-next")

async function runScript(
  scriptName: string,
  args: string[] = []
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["python3", path.join(SCRIPTS_DIR, scriptName), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

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
})

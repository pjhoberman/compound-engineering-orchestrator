import path from "path"

/**
 * Run a stdlib-Python skill script under python3 and capture its output.
 * Shared by the per-skill test suites so the spawn boilerplate lives in one place.
 */
export async function runScript(
  scriptsDir: string,
  scriptName: string,
  args: string[] = []
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["python3", path.join(scriptsDir, scriptName), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

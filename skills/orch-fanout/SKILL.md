---
name: orch-fanout
description: "Execute a task-graph's ready work in parallel: sequence the collision-free batches into runtime-safe waves, show a visible preview, and drive each wave's nodes through /lfg in worktree-isolated parallel runs, merging in dependency order and checkpointing recovery state at every wave boundary. Runtime-exclusive nodes run as solo waves. Manual-invoke only. Use when a committed task-graph has multiple ready nodes you want shipped as parallel PRs. Builds on the compound-engineering plugin (ce-work / lfg) and the sibling orch-decompose, orch-next, and recovery-manifest scripts."
disable-model-invocation: true
argument-hint: "[path to a docs/plans/<project-slug>/ task-graph dir. Blank to discover the project interactively]"
---

# Execute Ready Work in Runtime-Safe Parallel Waves

`orch-fanout` is the autonomous executor at the top of the orchestrator family. It reads an [`orch-decompose`](../orch-decompose/SKILL.md) task-graph, takes the collision-free [[Fan-out batch]]es the partitioner produces, sequences them into **waves** that are safe to run at once, and drives each wave's nodes through `/lfg` in worktree-isolated parallel runs — merging in dependency order and writing a recovery checkpoint at every wave boundary.

It composes shipped machinery: `ce-work`'s worktree dispatch + dependency-order merge, `/lfg` as the per-node pipeline, and the sibling orchestrator scripts. The new surface here is the drain-the-batch loop and the gates — not new execution machinery.

> **Requires the compound-engineering plugin** (`ce-work`, `/lfg`), the sibling **`orch-decompose`** (`graph_compute.py`, `reorient.py`) and **`orch-next`** (`frontier.py`) skills, plus **Claude Code** for the bundled scripts. Off-platform invocations report unavailability explicitly rather than degrading. Manual-invoke only. **The visible preview (Phase 3) is non-negotiable** — it is the antidote to autonomous rubber-stamping and the safety net for an un-flagged runtime-exclusive node.

## Phase 1: Locate the task-graph

Resolve the project directory (`docs/plans/<project-slug>/`): use the argument if given; else glob `docs/plans/*/index.md` and, if several, ask which (the platform's blocking question tool — `AskUserQuestion` in Claude Code, `ToolSearch` `select:AskUserQuestion` first if needed). If none exists, tell the user to run `orch-decompose` first and stop.

## Phase 2: Compute the wave plan

Run the pipeline and pipe the JSON through. `partition.py` and `wave_plan.py` live in this skill; `graph_compute.py`/`reorient.py` live in the sibling `orch-decompose`, `frontier.py` in `orch-next` — all resolved relative to this skill's directory. Use the guard so it resolves on Claude Code and degrades visibly elsewhere (`<dir>` is the project dir from Phase 1):

```bash
SELF="${CLAUDE_SKILL_DIR}/scripts"
OD="${CLAUDE_SKILL_DIR}/../orch-decompose/scripts"
ON="${CLAUDE_SKILL_DIR}/../orch-next/scripts"
if [ -n "${CLAUDE_SKILL_DIR}" ] && [ -f "${SELF}/wave_plan.py" ] && [ -f "${SELF}/partition.py" ] \
   && [ -f "${OD}/graph_compute.py" ] && [ -f "${OD}/reorient.py" ] && [ -f "${ON}/frontier.py" ]; then
  python3 "${OD}/graph_compute.py" <dir> > /tmp/orch-graph.json
  python3 "${OD}/reorient.py"      <dir> > /tmp/orch-status.json
  python3 "${ON}/frontier.py"  --graph /tmp/orch-graph.json --status /tmp/orch-status.json > /tmp/orch-frontier.json
  python3 "${SELF}/partition.py" --graph /tmp/orch-graph.json --frontier /tmp/orch-frontier.json > /tmp/orch-partition.json
  python3 "${SELF}/wave_plan.py" --partition /tmp/orch-partition.json --graph /tmp/orch-graph.json
else
  echo "orch-fanout requires Claude Code and the sibling orch-decompose/orch-next skills: bundled computation is unavailable on this platform."
fi
```

If the guard's `else` branch fired, say so plainly and stop. If `graph_compute.py` reported a cycle (non-zero exit / a `cycle` finding), surface it and stop — there is no well-formed frontier until the cycle is broken. Also surface `partition`'s `excluded` list (non-`work`, `no_pr`, and absent-from-graph nodes) so the user sees what was held out of fan-out and why.

**Do not recompute** the waves, batches, or statuses — present and drive only.

## Phase 3: Visible preview (non-negotiable)

Present the wave plan before spawning anything. For each wave, in order, show:

- **Parallel wave:** the node ids, their target worktrees, the model tier each will run on, and the reason they're safe together (file-disjoint + runtime-independent).
- **Solo wave:** the single node id and why it is alone (`exclusive_runtime` — needs a non-shareable server/DB/port/singleton).

Also restate which ready nodes were **excluded** from fan-out entirely (from Phase 2) and that they must be driven by hand. This preview is the user's gate: a node that should have been `exclusive_runtime` but wasn't is visible here as a member of a parallel wave — the user can stop and re-flag it before any run starts.

## Phase 4: Drive the waves

Gate with the platform's blocking question tool (consolidated — **one confirmation per wave**, not per node):

1. **Run this wave** — execute the previewed wave.
2. **Skip this wave** — move to the next.
3. **Stop** — end; nothing further spawns.

On confirm, for the wave:

- **Parallel wave:** spawn one worktree-isolated `/lfg` run per node, reusing `ce-work`'s worktree creation, pre-dispatch file-collision check, and dependency-order merge (abort + re-dispatch on conflict). Run them concurrently.
- **Solo wave:** run the single node's `/lfg` to completion before anything else — never concurrent with another run.

After each wave completes and merges, **write the recovery manifest** via `scripts/manifest.py` (the wave boundary) so a dead or context-compacted session resumes by reading it. On resume, reconstruct state with `scripts/reconcile.py` (git is authoritative; the manifest is a hint) and continue from the first unfinished wave.

Mid-wave gate decisions are collected into the single per-wave checkpoint above — not surfaced one-by-one per node.

**Circuit breaker.** After each wave, append its outcome (`pass`/`fail`) to a running list, write that list to a JSON file (e.g. `/tmp/orch-outcomes.json`, following the Phase 2 file-passing convention), and consult `python3 "${SELF}/circuit_breaker.py" --outcomes /tmp/orch-outcomes.json [--threshold K]`. If it reports `tripped`, **halt the run and escalate** — a systematic problem (bad base commit, broken harness, environment fault) is failing every wave, and continuing would burn the rest of the batch. On a trip: stop spawning, surface the breaker's reason, and leave the recovery manifest at the last wave boundary so the run resumes after the root cause is fixed. A pass resets the streak, so isolated flakes don't trip it.

After a run's PRs merge, re-running `orch-fanout` (or `orch-next`) refreshes the frontier from git — the graph is the durable record, so a later session resumes by reading it.

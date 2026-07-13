---
name: orch-ripen
description: "Mature a task-graph's plan-stage nodes into work-ready nodes in parallel planning waves: compute the planning frontier (nodes whose upstream DECISIONS are settled, not whose code has merged), fan ce-plan over each wave in worktree-isolated runs, gate every stage-flip on human approval, write the approved plans back into the graph, re-audit, and repeat until the frontier is exhausted. Closes the gap between orch-decompose (which leaves a plan-heavy graph) and orch-fanout (which only executes work-stage nodes). Manual-invoke only. Use when a committed task-graph has plan-stage nodes you want ripened into fan-out-ready work. Builds on the compound-engineering plugin (ce-plan / ce-brainstorm) and the sibling orch-decompose, orch-next, and orch-fanout scripts."
disable-model-invocation: true
argument-hint: "[path to a docs/plans/<project-slug>/ task-graph dir. Blank to discover the project interactively]"
---

# Mature the Planning Frontier into Work-Ready Nodes

`orch-ripen` sits between [`orch-decompose`](../orch-decompose/SKILL.md) and [`orch-fanout`](../orch-fanout/SKILL.md). A fresh `orch-decompose` graph is legitimately plan-heavy — deferring per-node depth is the whole point of stage tags — so most nodes come out `plan`/`brainstorm` and `orch-fanout` (which only executes `work`-stage nodes) starves until planning catches up. `orch-ripen` owns the loop that converts the **planning frontier** into work-ready nodes: it computes which plan nodes are ready to plan, fans `ce-plan` over them in parallel **waves**, gates each stage-flip on human approval, writes the approved plans back into the graph, re-audits, and repeats.

It composes shipped machinery: `ce-plan` as the per-node planner, `ce-work`'s worktree isolation for concurrent runs, and the sibling orchestrator scripts. The new surface is the planning-frontier compute, the stage-flip write-back contract, and the approval gate — not new planning machinery.

> **Requires the compound-engineering plugin** (`ce-plan`, `ce-brainstorm`), the sibling **`orch-decompose`** (`graph_compute.py`, `reorient.py`) and **`orch-fanout`** (worktree isolation) skills, plus **Claude Code** for the bundled scripts. Off-platform invocations report unavailability explicitly rather than degrading. Manual-invoke only (`disable-model-invocation: true`). **The visible preview (Phase 3) and the per-wave approval gate (Phase 4) are non-negotiable** — a plan encodes decisions (edge identity, module boundaries, directionality), and auto-flipping to work-ready silently transfers decision ownership to the model.

## The load-bearing concept: decision dependencies, not execution dependencies

An **execution** dependency (what `orch-next`/`orch-fanout` schedule on) is satisfied when the upstream node's code has **MERGED**. A **planning** dependency is satisfied when the upstream node's **DECISION is settled** — its plan is authored and approved (stage flipped to `work`), *not* when its PR merges. A plan node needs no merged code upstream; it needs the upstream decisions its own plan will build on.

Concretely (the specimen shape): `n103`/`n104`/`n105` all depend on `n101` (segment data model) + `n102` (decomposition pipeline). They cannot be coherently planned until `n101`'s edge-identity decision exists — but they need no merged code. Once `n101`/`n102`'s plans are approved (stage flipped to `work`), all three siblings are safe to plan in parallel, long before implementation starts. Conversely, **never fan siblings whose shared decision-parent is still unplanned** — parallel plans against an undecided parent come out incoherent. This is why the wave-membership predicate is: a `plan`-stage node all of whose `depends_on` entries are `done` **or** already flipped to `work`. `ripen_frontier.py` computes exactly this; the distinction is documented in `../orch-decompose/references/task-graph-schema.md`.

## Phase 1: Locate the task-graph

Resolve the project directory (`docs/plans/<project-slug>/`): use the argument if given; else glob `docs/plans/*/index.md` and, if several, ask which (the platform's blocking question tool — `AskUserQuestion` in Claude Code, `ToolSearch` `select:AskUserQuestion` first if its schema isn't loaded). If none exists, tell the user to run `orch-decompose` first and stop.

## Phase 2: Compute the planning frontier

Run the pipeline and pipe the JSON through. `ripen_frontier.py` and `staleness.py` live in this skill; `graph_compute.py`/`reorient.py` live in the sibling `orch-decompose`, all resolved relative to this skill's directory. Use the guard so it resolves on Claude Code and degrades visibly elsewhere (`<dir>` is the project dir from Phase 1):

```bash
SELF="${CLAUDE_SKILL_DIR}/scripts"
OD="${CLAUDE_SKILL_DIR}/../orch-decompose/scripts"
if [ -n "${CLAUDE_SKILL_DIR}" ] && [ -f "${SELF}/ripen_frontier.py" ] && [ -f "${SELF}/staleness.py" ] \
   && [ -f "${OD}/graph_compute.py" ] && [ -f "${OD}/reorient.py" ]; then
  python3 "${OD}/graph_compute.py" <dir> > /tmp/orch-graph.json
  python3 "${OD}/reorient.py"      <dir> > /tmp/orch-status.json
  python3 "${SELF}/ripen_frontier.py" --graph /tmp/orch-graph.json --status /tmp/orch-status.json
else
  echo "orch-ripen requires Claude Code and the sibling orch-decompose skill: bundled computation is unavailable on this platform."
fi
```

If the guard's `else` branch fired, say so plainly and stop. If `graph_compute.py` reported a cycle (non-zero exit / a `cycle` finding), surface it and stop — there is no well-formed frontier until the cycle is broken (re-run `orch-decompose` to fix the graph). `ripen_frontier.py` also returns `"cycle": true` defensively.

`ripen_frontier.py` returns `plan_wave` (the plan-stage nodes ready to plan this wave, each with `slack`/`critical`/`unblocks_planning`), `brainstorm` (frontier brainstorm nodes — see Phase 5), `blocked` (plan nodes not yet plannable, each with `blocked_on` naming the unsettled decision), `flipped` (already at `work`), plus `active`/`done`/`counts`. **Do not recompute** — present and drive only.

## Phase 3: Visible preview (non-negotiable)

Present the wave before spawning anything. **Render every node as `id (title)`, never a bare ID** (the title is the `title` column in `index.md`). For the `plan_wave`, show each node with its target worktree, the model it will run on (from its `model` tier — see Phase 4), and one line on *why it is ready now* (which upstream decisions are settled). Restate:

- **`brainstorm` frontier nodes** — reported as "needs interactive session," never fanned (Phase 5), with the `ce-brainstorm` handoff.
- **`blocked` plan nodes** — with the specific unsettled decision each waits on, so the user sees why the wave is the size it is.

This preview is the user's gate on wave *shape* — a sibling that shouldn't be planned yet against an undecided parent is visible here as absent from the wave, and the user can stop and re-stage before any run starts.

## Phase 4: Execute the wave (approval gates the flip, not the plan)

Gate with the platform's blocking question tool (**one confirmation per wave**, not per node):

1. **Plan this wave** — fan `ce-plan` over the wave's nodes.
2. **Skip this wave** — move on without planning these.
3. **Stop** — end; nothing further spawns.

On confirm, spawn one **worktree-isolated** `ce-plan` run per `plan_wave` node, reusing `ce-work`/`orch-fanout`'s worktree creation so concurrent runs don't collide. Run them concurrently. **Honor the per-node `model` column** when dispatching (from `node_meta`): `ceiling` → the session's top model (inherit), `generation` → the platform's mid-tier model (e.g. `sonnet`); a null/absent/unrecognized tier falls back to the top model. A ceiling node can plan on the top model alongside generation nodes on the mid tier in the same wave.

Plan outputs are independent node-file writes, so collisions are only on `index.md` — **serialize the index write to the wave boundary** (Phase 5), never per concurrent run.

## Phase 5: Write the approved plans back (the stage-flip contract)

`ce-plan` produces plans; nothing else specifies how a plan gets *into* the graph. `orch-ripen` owns it — see `references/stage-flip-writeback.md` for the full contract. In short, for each node the human **approves**:

- Embed the plan into the node file per `../orch-decompose/references/embedded-unit-schema.md`, including machine-parseable `Files:` bullets with `(create)`/`(modify)` markers (the granularity guard keys on these).
- Flip the index `stage` cell `plan` → `work`.
- Stamp `base_commit` = current HEAD at plan time.
- Keep the node file and index consistent: the node's `Dependencies` field mirrors the index `depends_on` cell.

**The human approval gate precedes every flip.** Present each wave's plans as a per-node *decision summary* (edge identity, module boundaries, directionality — not the full plan text) via the blocking question tool, and flip only approved nodes. A **rejected/revise** node stays `plan`-stage with the feedback appended to its brief, to be re-planned in a later wave. **Brainstorm nodes are never fanned** — they are interview-shaped; report them with the `ce-brainstorm` handoff command and leave their downstream plan nodes blocked until the brainstorm settles (stage moves to `plan`/`work`).

Commit the wave as a **single commit** once the index write-back is done: `ripen wave N: nX (title), nY (title) → work`. One serialized index write per wave keeps the concurrent plan runs collision-free.

## Phase 6: Re-audit and re-validate staleness

Ripening is when edge validation gets teeth: a fresh graph's edges are essentially unvalidated (`graph_compute`'s dependency checks skip brief-stage nodes — "no file list"), but the `Files:` lists this wave just added make the missing/spurious-dependency guard meaningful. After each wave's write-back:

- Re-run `graph_compute.py` (Phase 2's first step) and surface any **new** findings (missing/spurious dependency, over-decomposition) before the next wave.
- Run the staleness re-validation over the nodes already flipped to `work`:

```bash
python3 "${SELF}/staleness.py" <dir>
```

For every flipped `work` node whose `base_commit` predates a merged upstream node, `staleness.py` flags "plan may be stale — re-plan?" — feeding the drive-time staleness check (`orch-decompose` Phase 4 / `orch-next` Phase 4) *earlier*, so a stale plan is caught here rather than failing at drive time. Surface the `stale` list; offer to re-plan those nodes in an upcoming wave.

## Phase 7: Report and loop

At the end of each run, report:

- **What `orch-fanout` could now execute** — the nodes flipped to `work` this run (fan-out-eligible).
- **The next planning frontier** — what `ripen_frontier.py` will return on the next call (the nodes the just-approved flips unblock, via `unblocks_planning`).

Then loop back to Phase 2 for the next wave, or stop if the frontier is exhausted or the user ends the run.

**Steady-state framing (document, don't over-build):** the intended cadence is ripening wave N+1 while `orch-fanout` executes wave N, keeping planning exactly one wave ahead so the executor never starves. `orch-ripen` reports what fanout can execute and what's next — but it **does not invoke `orch-fanout` itself.** Because status and stage are derived from the committed graph on read, a later or compacted session resumes by re-running from Phase 2.

---
name: orch-next
description: "Read an orch-decompose task-graph, compute the ready frontier, and recommend the single highest-leverage next move — with a one-line rationale and the exact command — then fire it inline. Manual-invoke only. Use when you have a committed task-graph and want to be told what to do next instead of scanning a list. Builds on the compound-engineering plugin (ce-plan / ce-brainstorm / ce-work / lfg) and the sibling orch-decompose skill."
disable-model-invocation: true
argument-hint: "[path to a docs/plans/<project-slug>/ task-graph dir. Blank to discover the project interactively]"
---

# Recommend the Next Move on a Task-Graph

`orch-next` sits on top of an [`orch-decompose`](../orch-decompose/SKILL.md) task-graph. Where `orch-decompose` builds and audits the graph, `orch-next` reads it and answers one question: **what should I do next?** It computes the dependency *ready frontier* (every node whose dependencies are all `done` and that is not started, blocked, or in progress), ranks it, and recommends a **single** highest-leverage move — with a one-line rationale and the exact command — then fires that command inline. The difference between a dashboard and an orchestrator is recommending one move, not handing over a list to triage.

It holds no state: on every call it reconstructs the frontier from the committed graph plus live git, so a fresh or compacted session produces the same recommendation.

> **Requires the compound-engineering plugin** (for the `ce-plan` / `ce-brainstorm` / `ce-work` / `lfg` handoffs) and the sibling **`orch-decompose`** skill (for the bundled `graph_compute.py` and `reorient.py`), plus **Claude Code** for the bundled scripts. Off-platform invocations report unavailability explicitly rather than degrading. Manual-invoke only (`disable-model-invocation: true`).

## Phase 1: Locate the task-graph

Resolve the project directory (`docs/plans/<project-slug>/` — the dir holding `index.md`):

- If a path was given in the argument, use it.
- Otherwise glob `docs/plans/*/index.md`. If exactly one project exists, use it. If several, ask the user which using the platform's blocking question tool (`AskUserQuestion` in Claude Code — `ToolSearch` `select:AskUserQuestion` first if needed; `request_user_input` in Codex; `ask_user` in Gemini/Pi).
- If none exists, tell the user to run `orch-decompose` first and stop.

## Phase 2: Compute the frontier

Run the three bundled scripts and pipe them together. `frontier.py` lives in this skill; `graph_compute.py` and `reorient.py` live in the sibling `orch-decompose` skill, resolved relative to this skill's directory. Use the guard so it resolves on Claude Code and degrades visibly elsewhere (`<project-dir>` is the dir from Phase 1):

```bash
ORCH="${CLAUDE_SKILL_DIR}/../orch-decompose/scripts"
if [ -n "${CLAUDE_SKILL_DIR}" ] && [ -f "${CLAUDE_SKILL_DIR}/scripts/frontier.py" ] \
   && [ -f "${ORCH}/graph_compute.py" ] && [ -f "${ORCH}/reorient.py" ]; then
  python3 "${ORCH}/graph_compute.py" <project-dir> > /tmp/orch-graph.json
  python3 "${ORCH}/reorient.py"      <project-dir> > /tmp/orch-status.json
  python3 "${CLAUDE_SKILL_DIR}/scripts/frontier.py" \
    --graph /tmp/orch-graph.json --status /tmp/orch-status.json
else
  echo "orch-next requires Claude Code and the sibling orch-decompose skill: bundled computation is unavailable on this platform."
fi
```

If the guard's `else` branch fired, say so plainly and stop — the graph is still hand-inspectable, but the bundled computation did not run.

`graph_compute.py` exits non-zero when the graph has a correctness finding (e.g. a `cycle`). If it reports a cycle, surface that finding and stop: there is no well-formed frontier until the cycle is broken (re-run `orch-decompose` to fix the graph). `frontier.py` also returns `"cycle": true` defensively in that case.

## Phase 3: Rank and recommend one move

`frontier.py` returns `ready` (each with `slack`, `critical`, `unblocks`), `active`, `blocked` (with `blocked_on`), and `done`. **Do not recompute these** — present and rank only.

Rank the `ready` set and pick the single best move:

1. **Lowest `slack` first** — schedule-critical nodes (slack 0) before nodes with float.
2. **Tie-break by `unblocks` descending** — among equally-critical nodes, prefer the one that frees the most downstream work.
3. **Then by node id** — stable final tiebreak.

Present the **one** top-ranked node with a one-line rationale naming the signal that won it (e.g. "on the critical path, unblocks 2"). Name the runner-up only on a genuine tie. Also show, compactly: the count ready / active / blocked / done, and any `active` nodes (work already in flight) so the user sees the whole state in one glance without a triage list.

Read the recommended node's `stage` and `model` from `index.md` to form the command (Phase 4).

## Phase 4: Drive the move

**Staleness check before driving a `work` node.** Compare the node's `base_commit` (from `index.md`) against current HEAD. If HEAD has advanced — especially if upstream nodes merged since the plan was authored — warn that the embedded plan may be stale and offer to re-plan (route to `ce-plan`) instead of driving it directly. A fresh `base_commit` means no warning.

**Offer the move** using the platform's blocking question tool (load `AskUserQuestion` via `ToolSearch` `select:AskUserQuestion` first on Claude Code if needed):

1. **Drive the recommended node (`nX`)** — run the recommended move.
2. **Drive a different ready node** — let the user name which.
3. **Stop** — just show the state.

**Fire the invocation inline; do not just tell the user what to type.** For the chosen node, invoke the matching skill via the platform's skill primitive (the `Skill` tool in Claude Code), passing the node file path:

- node `stage: work` → invoke `lfg` (or `ce-work` for a non-autonomous run) on the node file.
- node `stage: plan` → invoke `ce-plan` on the node file.
- node `stage: brainstorm` → invoke `ce-brainstorm`, seeded with the node's brief.

After a node is driven and its work merges, re-running `orch-next` refreshes the frontier from git — the graph is the durable record, so a later session resumes by reading it.

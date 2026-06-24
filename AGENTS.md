# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A Claude Code plugin that adds **project decomposition and orchestration** on top of the
compound-engineering plugin. It is a hard dependency on compound-engineering — its skills
compose CE skills (`ce-plan`, `ce-brainstorm`, `ce-work`, `lfg`), never reimplement them.

## Skills

- **`orch-decompose`** (`skills/orch-decompose/`) — decompose a project into a committed
  task-graph under `docs/plans/`, audit it, and hand off the first ready node. Manual-invoke
  only (`disable-model-invocation: true`). Read its `references/` before producing or
  auditing a graph; the bundled `scripts/graph_compute.py` and `scripts/reorient.py` own all
  DAG math and status derivation — present their JSON, never recompute it.
- **`orch-next`** (`skills/orch-next/`) — read the task-graph, compute the ready frontier
  (`scripts/frontier.py`, a pure consumer of graph_compute + reorient JSON), and recommend
  the single highest-leverage next move. Manual-invoke only.
- **`orch-fanout`** (`skills/orch-fanout/`) — execute ready work in runtime-safe parallel
  waves: partition into collision-free batches, sequence them with `scripts/wave_plan.py`
  (exclusive-runtime nodes run solo), run each node on its own `model` tier (`node_meta`),
  drive each wave through `/lfg` behind a visible
  preview, checkpoint recovery state (`scripts/{manifest,reconcile}.py`) per wave, and halt
  on systematic failure via `scripts/circuit_breaker.py` (trip after K consecutive failed waves).
  Manual-invoke only. Composes `ce-work`/`lfg` + the sibling orch-decompose/orch-next scripts.

## Conventions

- **Task-graph vocabulary** is defined in `CONCEPTS.md`. Use those terms precisely.
- **`docs/solutions/`** — documented solutions to past problems (bugs, conventions, workflow learnings), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- **Scripts are stdlib Python**, resolved at runtime via `CLAUDE_SKILL_DIR`. Off-platform
  invocations must report unavailability explicitly rather than degrade.
- **Tests** are a Bun/TypeScript harness (`tests/*.test.ts`) that shells out to the Python
  scripts. Run `bun test`. Keep them green; add a regression test with any script change.
- **Status is derived, never stored** as truth — git and `gh` are authoritative; the
  `status` column is a refreshable cache.

## Roadmap

Foundation (`orch-decompose`) is in. Next rungs, each on the same task-graph: `orch-next`
(ready-frontier recommender), `orch-fanout` (parallel worktree `/lfg` executor),
`orch-tracker-sync` (Linear), and a cross-session recovery manifest. See `docs/`.

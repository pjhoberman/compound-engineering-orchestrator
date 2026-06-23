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

## Conventions

- **Task-graph vocabulary** is defined in `CONCEPTS.md`. Use those terms precisely.
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

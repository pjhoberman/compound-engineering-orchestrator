# n1 — orch-next: ready-frontier compute

- **Stage:** work · **Model:** generation · **Depends on:** (none — root)
- **Base commit:** `a95f5f5`

## Goal

Compute the dependency **ready frontier** for a task-graph — the set of nodes whose every
`depends_on` is `done`, partitioned against done/blocked, with the per-node inputs a
recommender needs to rank them (critical-path slack, count of nodes each would unblock).
This is the mechanical core that `orch-next` (n2) turns into a single recommendation.

## Requirements

- Emit, as JSON: `ready` (frontier node IDs), `blocked` (with their unsatisfied deps), and
  `done`, plus per-ready-node `slack` and `unblocks` (how many nodes become ready if it
  completes).
- **Compose, do not re-parse.** Consume the JSON already emitted by `graph_compute.py`
  (edges, `critical_path`, per-node `slack`) and `reorient.py` (derived `status` per node).
  Do not re-implement graph parsing or status derivation — skills are self-contained, so the
  script takes those two JSON blobs as inputs rather than importing across skill dirs.
- Deterministic: identical inputs yield byte-identical output (stable key order, sorted IDs).
- A graph with a cycle (no topo order from `graph_compute`) yields an empty `ready` set and
  surfaces the upstream `cycle` finding rather than inventing a frontier.

## Files

- `skills/orch-next/scripts/frontier.py` (create) — read `--graph <graph_compute.json>` and
  `--status <reorient.json>` (or paths to re-run them), emit the frontier JSON.
- `tests/orch-next-scripts.test.ts` (create) — Bun harness mirroring the orch-decompose
  tests: feed fixture JSON, assert ready/blocked partition, slack/unblocks, determinism.
- `tests/fixtures/orch-next/basic/graph.json` (create) — a small fixture pair (graph +
  status) exercising done/ready/blocked.
- `tests/fixtures/orch-next/basic/status.json` (create) — matching derived-status fixture.

## Approach

Mirror the existing `skills/orch-decompose/scripts/*.py` conventions: stdlib-only Python,
`argparse`, JSON to stdout, usage error exits 2, clean run exits 0. `frontier.py` is a pure
function of (graph JSON, status JSON): a node is `ready` iff it is not `done` and every
`depends_on` is `done`; `blocked` otherwise; `unblocks(n)` counts nodes whose only remaining
unsatisfied dep is `n`. Reuse `graph_compute`'s `slack` verbatim — do not recompute. Keep all
DAG math in `graph_compute`; this script only joins and partitions.

## Patterns to follow

`skills/orch-decompose/scripts/graph_compute.py` and `reorient.py` (the module set being
mirrored — same CLI shape, JSON-out contract, determinism guarantee, and test-harness style).
This node intentionally mirrors that existing pattern and is one coherent unit.

## Test scenarios

- A graph with two done roots, two ready children, two blocked leaves partitions correctly.
- `unblocks` is correct: a node gating two downstream nodes reports `unblocks: 2`.
- A ready node off the critical path reports positive `slack`; a critical node reports 0.
- Cycle input (graph_compute reported `cycle`, empty topo) → empty `ready`, finding surfaced.
- Determinism: two runs on identical input produce identical bytes.

## Verification

`bun test` passes including the new `orch-next-scripts.test.ts`; `frontier.py` run on the
committed `docs/plans/orchestrator-roadmap/` graph reports n1 and n4 as the initial ready
frontier (the two roots) and the rest blocked. No regression in the orch-decompose suite.

---
title: Fan-out eligibility is narrower than the ready frontier — exclude manual-completion nodes
date: 2026-06-23
category: conventions
module: orch-fanout
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Selecting which ready nodes an autonomous executor (orch-fanout) may drive"
  - "Building any batch/parallel executor over a task-graph"
  - "Deciding whether a node can be handed to /lfg unattended"
tags: [fan-out, eligibility, no_pr, ready-frontier, autonomous-execution]
---

# Fan-out eligibility is narrower than the ready frontier — exclude manual-completion nodes

## Context

`orch-next`'s ready frontier answers "what *could* start now" — every node whose
dependencies are satisfied. It's tempting to feed that set straight into the fan-out
executor. But "ready to start" is not the same as "safe to drive unattended," and the gap
is easy to miss: the n6 partitioner originally treated every `work`-stage ready node as
fan-out eligible, which would have handed a `no_pr` node to `/lfg`.

## Guidance

An autonomous executor's eligible set is a strict subset of the ready frontier. Filter out,
with an explicit reason (never silently), nodes that are ready but must not be driven
unattended:

- **Non-`work` stages** (`plan`, `brainstorm`) — no file footprint, no embedded plan to
  execute; drive them through `ce-plan` / `ce-brainstorm` by hand.
- **`no_pr` nodes** — a manual-completion ops/activation step that produces no PR. Driving
  it via `/lfg` (which exists to produce a PR) is semantically wrong; it awaits a human.

```python
if stage != "work":
    exclude(nid, f"stage {stage!r} is not fan-out eligible — drive it directly")
elif meta.get("no_pr"):
    exclude(nid, "no_pr ops node — requires manual completion, not fan-out")
else:
    eligible.append(nid)
```

## Why This Matters

Conflating "ready" with "drivable" is how an autonomous executor does something destructive
or nonsensical — running an unattended code pipeline on a node whose value is a manual data
load or activation. The exclusion must be **visible** (report excluded nodes with reasons),
so the human sees what the executor declined to touch rather than silently getting a
short batch. The producer (`graph_compute`) already exposes the `stage` and `no_pr` signals
in `node_meta`; the executor's job is to *honor* them, not re-derive them.

## When to Apply

- Any orch-fanout batching / dispatch logic (`partition.py`, and the n7 executor on top).
- Any future "run all ready work" automation over the task-graph — the eligibility filter
  belongs at the boundary where work becomes unattended.

## Examples

- `skills/orch-fanout/scripts/partition.py` excludes non-`work` and `no_pr` ready nodes into
  an `excluded` list with reasons; only the remainder is packed into parallel batches.
- A `no_pr` canopy-data-load node (see the golden task-graph fixture) is ready and
  `work`-stage, yet must never be fanned out — it is completed by a human and pinned.

## Related

- `CONCEPTS.md` — `no_pr node`, `Ready frontier` (now notes the eligibility narrowing).
- `docs/solutions/conventions/verify-tool-output-contract-before-work-ready-node.md`.

---
title: Verify a tool's output contract before marking a composing node work-ready
date: 2026-06-23
category: conventions
module: orch-decompose
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Decomposing a node whose job is to consume another script or tool's output"
  - "Marking an orch-decompose node stage:work (embedding a ready ce-plan-shaped plan)"
  - "Writing a plan that assumes an existing JSON/API contract already exposes a field"
tags: [task-graph, decomposition, plan-quality, json-contract, composition]
---

# Verify a tool's output contract before marking a composing node work-ready

## Context

While building the orchestrator's `orch-next` ready-frontier compute (`frontier.py`),
the node had been decomposed as `stage: work` with an embedded plan that said: "consume
the JSON `graph_compute.py` already emits (edges, slack) — do no parsing of your own."
But `graph_compute.py` did **not** emit the dependency edges in its JSON; it only emitted
`per_node` slack/critical and a `roots` list. The plan's core premise — that the edges
were available to consume — was false, and that only surfaced when the code was written.

## Guidance

When a node's whole job is to *compose* or *join* the output of an existing tool, the
decompose/plan step must verify the upstream **output contract** actually exposes the
fields the node depends on — by reading the producer's output (or running it), not by
assuming the data "must be in there." A node is only genuinely `work`-ready (files
knowable, no open questions) once its inputs are confirmed to exist.

When the contract turns out to lack a needed field, prefer extending the producer with an
**additive** field over re-deriving the data in the consumer:

```python
# graph_compute.py — additive: expose the edges it already parsed
result = {
    "schema_version": schema_version,
    "critical_path": chain,
    "edges": deps,          # <-- added so consumers don't re-parse the graph
    "per_node": per_node,
    ...
}
```

`frontier.py` then reads `graph["edges"]` instead of re-implementing the index-table
parser. All DAG parsing stays in one place; the consumer only joins.

## Why This Matters

A `work`-stage node carries an embedded plan that `ce-work`/`lfg` execute with little
further design. If that plan rests on an unverified contract assumption, the gap is
discovered mid-build (best case) or produces a subtly wrong implementation (worst case).
Re-parsing the upstream artifact in the consumer to "work around" a missing field
duplicates parsing logic and invites drift — the opposite of the compose-don't-rebuild
intent. Catching the gap at plan time keeps the node honestly `work`-ready and the
producer the single source of parsing truth.

## When to Apply

- Any node whose Approach says "consume / join / read the output of <other tool>".
- Before stamping a node `stage: work` when its inputs come from another script's JSON.
- During review of an embedded plan: does the cited input field actually exist today?

## Examples

- **Before (plan assumption):** "frontier.py consumes graph_compute's JSON (edges, slack)."
  Reality: `graph_compute` emitted slack but not edges — premise false.
- **After (verified + additive fix):** `graph_compute` extended to emit `edges` (one line,
  additive, suite stayed green via a regression test); `frontier.py` consumes it with no
  re-parsing. Verified live: ready frontier `[n1, n4]` on the real roadmap graph.

## Related

- This surfaced via the dogfood practice in
  `docs/solutions/developer-experience/dogfood-decomposition-on-its-own-roadmap.md`.
- Schema/parse rules: `skills/orch-decompose/references/task-graph-schema.md`.

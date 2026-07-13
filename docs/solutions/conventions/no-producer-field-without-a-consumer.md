---
title: Don't add a producer output field ahead of its consumer — a field no one reads is dead code plus a false comment
date: 2026-07-13
category: conventions
module: orch-decompose
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Extending a script's JSON/output contract with an additive field for a downstream consumer"
  - "A comment or commit message claims a new field is 'so X consumes it' before X actually reads it"
  - "Two scripts share a producer/consumer relationship over a serialized contract"
tags: [json-contract, producer-consumer, dead-code, yagni, additive-field, drift]
---

# Don't add a producer output field ahead of its consumer — a field no one reads is dead code plus a false comment

## Context

Building `orch-ripen`'s staleness check, the plan was for it to consume `base_commit` from
`graph_compute.py`'s `node_meta` JSON. So `graph_compute` was extended additively — `node_meta[id]`
gained a `base_commit` field, with the comment *"surfaced additively so orch-ripen's staleness check
consumes it rather than re-parsing index.md"* — and a regression test was added asserting the
pass-through value.

But `staleness.py` never read it. Like its sibling `reorient.py`, it parses `index.md` directly (it
needs `depends_on` and `pr_refs` too, which `node_meta` doesn't carry), so it read `base_commit`
straight off the parsed index row. The new field had **no consumer anywhere** — the only thing that
touched it was the test asserting it existed. Two independent code-review reviewers flagged it: the
comment asserted a data flow that did not exist, and the field plus its test were dead weight that
would silently drift from the index. It was reverted (`graph_compute.py` is unchanged from `main` in
PR #11).

## Guidance

Add a producer field and its consumer **in the same change**, or not at all. An additive output field
justified only by an intended future reader is speculative — it is dead code the moment it lands, and
its explanatory comment is false until the reader exists.

This is the converse of
[verify-tool-output-contract-before-work-ready-node](./verify-tool-output-contract-before-work-ready-node.md).
That learning says: before a consumer depends on a producer field, verify the field is really emitted —
and if it isn't, prefer extending the producer additively over re-deriving in the consumer. This one is
the guard on the other side of the same contract: extend the producer **only when a consumer actually
joins on the new field in the same change**. Together: producer field and consumer move as a unit —
neither is added ahead of the other.

Before adding a field to a shared output contract, confirm:

- **A reader exists in this change.** Grep for who consumes it. If the answer is "a test asserting it's
  present" and nothing else, the field is dead.
- **The consumer can't already get it.** If the intended consumer parses the source artifact directly
  for other fields anyway (as `staleness.py` parses `index.md` for `depends_on`/`pr_refs`), routing one
  field through the producer's JSON buys nothing and splits one value across two sources that can drift.
- **The comment describes reality, not intent.** "surfaced so X consumes it" must be true when written,
  not aspirational.

## Why This Matters

A field with no reader is invisible dead code: it passes tests (the test asserts the pass-through), it
looks like a real contract, and its comment actively misleads the next person into thinking a data flow
exists. Worse, it manufactures a **drift surface** — now `base_commit` would have two sources (the index
column and the `node_meta` copy) that can disagree, which is the exact duplication the
verify-tool-output-contract learning exists to prevent, reintroduced from the opposite direction. YAGNI
applies with teeth to shared contracts: the additive field feels harmless, but its cost is a false
signal that outlives the intention that created it.

## When to Apply

- Any time you extend a script's emitted JSON (or any shared serialized contract) with a field "for"
  another component.
- In review of a producer change: ask "who reads this field in this diff?" A field whose only reader is
  its own regression test is the smell.
- When the intended consumer already parses the underlying source for other data — prefer having it read
  the one more field from the same source over threading it through the producer.

## Examples

**Before — additive field justified by an intended reader that never materialized:**

```python
# graph_compute.py node_meta
"exclusive_runtime": is_exclusive_runtime(nodes_by_id[i]),
# base_commit ... surfaced additively so orch-ripen's staleness check
# consumes it rather than re-parsing index.md. "" when unset.
"base_commit": nodes_by_id[i].get("base_commit", ""),   # <- no consumer reads this
```

```python
# staleness.py — actually parses the index itself and reads base_commit from the row
nodes = parse_index(index_path)
...
base = (node.get("base_commit") or "").strip()          # from the index row, not node_meta
```

**After — the speculative field and its test removed; the consumer keeps its single source:**

`graph_compute.py`'s `node_meta` returns to `main`'s shape (no `base_commit`); `staleness.py` reads
`base_commit` from the index row it already parses. One value, one source, no drift, and no comment
promising a data flow that doesn't exist. If a real consumer of `node_meta.base_commit` later appears,
the field is added *with* that consumer in the same change.

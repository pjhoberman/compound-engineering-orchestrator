---
title: Partition on the full derived-status vocabulary, not just done/active
date: 2026-06-23
category: logic-errors
module: orch-next
problem_type: logic_error
component: tooling
symptoms:
  - "A node pinned manual_status:blocked was recommended as ready once its deps were done"
  - "frontier.py routed an unhandled status value through the deps-satisfied branch"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [task-graph, status, enum-handling, frontier, ready-set]
---

# Partition on the full derived-status vocabulary, not just done/active

## Problem

`frontier.py` partitions task-graph nodes into ready / active / blocked / done. It
special-cased `done` and the active set (`in-progress`, `in-review`), then treated
*everything else* as: deps satisfied -> ready, else blocked. But `reorient.py` also emits
`blocked` (for a human `manual_status` pin). A node a human had explicitly pinned
`blocked` would fall through to the deps check and, if its dependencies were done, be
recommended as **ready** — overriding the human's block.

## Symptoms

- A node with derived status `blocked` and all dependencies `done` appeared in the `ready`
  frontier instead of staying blocked.
- The bug was invisible in tests because every fixture used only `not-started` and `done`.

## What Didn't Work

- The original partition assumed the only "don't start this" states were the active ones;
  it implicitly trusted that any non-active, non-done node was schedulable if deps were met.
  That holds only if `not-started` is the sole remaining status — which is false.

## Solution

Give `blocked` its own terminal branch in the partition, before the deps check:

```python
if st == "done":
    continue
if st in ACTIVE:                 # in-progress / in-review
    active_ids.append(n)
elif st == "blocked":            # human-pinned block — terminal, never ready
    blocked_ids.append(n)
elif all(d in done for d in edges.get(n, [])):
    ready_ids.append(n)
else:
    blocked_ids.append(n)
```

Add a fixture exercising the full vocabulary in one run (a `blocked`-pinned node with deps
done, an `in-progress` node, a node missing from status, plus ready/blocked/done) and
assert the pinned node is **not** in `ready`.

## Why This Works

The derived-status enum has five values (`not-started`, `in-progress`, `in-review`,
`done`, `blocked`). A consumer that branches on a subset and lumps the rest into a default
will mishandle any value it forgot. Enumerating every status — and routing the
human-authored `blocked` to a terminal bucket — makes the partition exhaustive and honors
the pin.

## Prevention

- When branching on an enum produced by another component, enumerate **every** value the
  producer can emit (here: `reorient.py`'s status set) rather than handling a few and
  defaulting the rest.
- Cover each enum value in a fixture; a partition tested only on `done`/`not-started`
  silently leaves the `active` and `blocked` branches unexercised.
- Treat human-authored signals (manual pins) as terminal — derivation must never override
  an explicit human decision.

## Related Issues

- Status vocabulary and pin semantics: `skills/orch-decompose/references/task-graph-schema.md`.
- Found by `/ce-code-review` (P1, correctness) on the orch-next frontier compute.

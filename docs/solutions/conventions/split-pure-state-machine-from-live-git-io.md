---
title: Split a pure --facts state machine from real-mode git/gh I/O so the logic stays testable
date: 2026-06-23
category: conventions
module: orch-fanout
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Writing a script whose decision logic depends on live git/gh state"
  - "A reorient/reconcile-style status derivation that shells out per item"
  - "You want the decision rules unit-tested without a live-git CI harness"
tags: [testability, git, state-machine, facts-injection, reorient, reconcile]
---

# Split a pure --facts state machine from real-mode git/gh I/O so the logic stays testable

## Context

Several orchestrator scripts decide a status by combining a stored record with live git/`gh`
facts: `reorient.py` derives a task-graph node's status, and `reconcile.py` reconciles a
recovery manifest against reality. Shelling out to git/`gh` is slow, network/auth-dependent,
and awkward to set up deterministically in CI — but the *decision logic* on top of those
facts is exactly what's worth testing.

## Guidance

Separate the two concerns explicitly:

1. A **pure state-machine function** that takes already-gathered facts and returns the
   decision — no I/O. `reconcile_task(manifest_status, facts) -> (status, action)`.
2. A **real-mode gatherer** that runs git/`gh` and produces those facts —
   `gather_facts_live(...)`.
3. A CLI **`--facts <json>` flag** that injects facts directly, bypassing the gatherer.

Tests drive the pure machine through every branch by injecting `--facts` fixtures; the
real-mode gatherer is verified manually (and, where cheap, with a one-off smoke test against
the real repo). Document in the script's docstring that the real-mode path is manually
verified — no silent pretense of coverage.

```python
def reconcile_task(manifest_status, facts):   # pure — unit-tested via --facts
    ...

def gather_facts_live(task, base_commit, base_ref):   # real I/O — manually verified
    ...

# main(): facts = facts_by_id.get(tid, {}) if facts_by_id is not None else gather_facts_live(...)
```

## Why This Matters

The split is what makes the decision rules trustworthy without a live-git harness. But it
has a sharp edge: **the untested half is where bugs hide.** In review, the worst defect found
in `reconcile.py` was entirely in the real-mode gatherer — a `git merge-base --is-ancestor`
that compared the branch against the *frozen* dispatch commit instead of the current base
head, so an empty branch false-reported as merged. The `--facts` tests all passed because
they inject `branch_merged` directly and never exercise the git command that computes it.

So the convention comes with an obligation: because the gatherer is unit-test-blind, give it
a **real-mode smoke test** against the actual repo before trusting it (run it once on a
known-merged branch, a known-in-flight branch, and a missing worktree, and eyeball the
output), and keep its logic a thin, readable mapping from git output to fact — not where
subtle decisions live.

### Variant: the orchestrator owns the state, the script is a stateless oracle

Sometimes there is no real-mode gatherer at all — the orchestrator (e.g. the `orch-fanout`
executor) already holds the running state and the script is a pure policy oracle it consults
**incrementally**. `circuit_breaker.py` is consulted after every wave with the *growing* list
of `pass`/`fail` outcomes; it must therefore **re-derive its answer from the full input each
call and hold no state between calls** — the executor owns accumulation, the script owns only
the policy decision.

This makes a usage *contract* load-bearing: the breaker reports the *trailing* failure streak,
which is correct only because the executor halts on a trip and never feeds it post-trip
history. Document that contract in the script, and don't switch a trailing-streak reading to a
max-streak reading (or add hidden state) without revisiting it. The stateless-by-design shape
is the point: it keeps the oracle trivially deterministic and testable by injected input,
exactly like the `--facts` half above.

## When to Apply

- Any new script that branches on live git/`gh` (or any external) state.
- When mirroring `reorient.py` / `reconcile.py` — keep the same three-part shape and the
  manual-verification note.
- When a script is an incrementally-consulted policy oracle (the orchestrator owns state) —
  keep it stateless, re-derive from full input each call, and document the consult contract.

## Examples

- `skills/orch-decompose/scripts/reorient.py` — the original `--facts` split.
- `skills/orch-fanout/scripts/reconcile.py` — mirrors it; its real-mode merge-detection bug
  (invisible to `--facts` tests) is the cautionary case above, now smoke-tested for real.

## Related

- `docs/solutions/logic-errors/partition-on-full-derived-status-vocabulary.md` — another
  status-derivation bug caught in review.

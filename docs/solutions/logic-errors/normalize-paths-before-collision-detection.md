---
title: Normalize paths before detecting collisions by string identity
date: 2026-06-23
category: logic-errors
module: orch-fanout
problem_type: logic_error
component: tooling
symptoms:
  - "Two nodes editing the same file were packed into one parallel batch"
  - "'a.py', './a.py', and 'dir/../a.py' treated as three distinct files by the collision check"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [collision-detection, path-normalization, fan-out, parallel-execution, adversarial-review]
---

# Normalize paths before detecting collisions by string identity

## Problem

`orch-fanout`'s partitioner groups ready nodes into parallel batches such that no two nodes
in a batch touch the same file — the invariant that lets each batch run as independent
worktree `/lfg` jobs without merge corruption. The collision check compared file paths by
**raw string** set-intersection. Non-canonical spellings of the same path therefore read as
distinct files, so two nodes editing the same file could be placed in one batch.

## Symptoms

- A node with `files: [["a.py", ...]]` and another with `[["./a.py", ...]]` were co-batched.
- Empirically: `partition.py` returned `batches: [["n1","n2"]]` for two nodes both editing
  `a.py` (spelled `a.py` vs `./a.py`) — a collision the batcher exists to prevent.

## What Didn't Work

- An earlier targeted review pass (correctness, maintainability, testing) **verified the
  "collision-free guarantee"** by tracing the set-intersection logic — but only over the
  canonical paths in the fixtures. The guarantee held *for the inputs tested*, which masked
  the gap. The defect only surfaced when an **adversarial reviewer** constructed inputs with
  non-canonical equivalents (`./a.py`, `dir/../a.py`, absolute paths) and ran them.

## Solution

Canonicalize each path before building the comparison set:

```python
# before — raw strings: './a.py' != 'a.py', collision missed
paths = frozenset(f[0] for f in meta.get("files", []) if isinstance(f, (list, tuple)) and f)

# after — normalized: './a.py', 'dir/../a.py', 'a.py' all collapse to 'a.py'
paths = frozenset(
    os.path.normpath(f[0])
    for f in meta.get("files", [])
    if isinstance(f, (list, tuple)) and f
)
```

`os.path.normpath` collapses `./`, `../`, and redundant separators. Absolute-vs-relative
(`/repo/a.py` vs `a.py`) is left out of scope deliberately — the embedded-unit schema
mandates repo-relative paths, so absolute paths are already out of contract.

## Why This Works

Collision detection by set membership is only correct if equal resources map to equal keys.
Two strings that denote the same file but differ in spelling are distinct set members, so the
intersection is empty and the check reports "no collision." Normalizing first makes the key a
canonical form, restoring the equality the set relies on.

## Prevention

- **Canonicalize any identifier you compare by string identity** — paths, URLs, names —
  before set/dict membership. A collision/dedup check over un-normalized keys is silently
  wrong for non-canonical inputs.
- **Test with non-canonical equivalents**, not just clean inputs. A fixture pairing `a.py`
  with `./a.py` and `dir/../a.py` and asserting they never co-batch pins the invariant.
- **Run an adversarial reviewer on safety-critical invariants.** Tracing the logic over
  well-formed fixtures confirms the happy path; only adversarial input construction exercises
  the spellings that defeat it. Here the targeted pass certified "collision-free" and the
  adversarial pass broke it — the difference between checking against known patterns and
  actively trying to construct a failure.

## Related Issues

- `docs/solutions/conventions/fan-out-eligibility-is-narrower-than-ready.md` — the other
  half of correct batching (which nodes are eligible at all).
- `docs/solutions/logic-errors/partition-on-full-derived-status-vocabulary.md` — a sibling
  partition-logic bug (incomplete enum handling) also caught in review.

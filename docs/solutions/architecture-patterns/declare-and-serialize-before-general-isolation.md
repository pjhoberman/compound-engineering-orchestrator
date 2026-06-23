---
title: Ship declare-and-serialize before building general isolation for a contention problem
date: 2026-06-23
category: architecture-patterns
module: orch-fanout
problem_type: architecture_pattern
component: tooling
applies_when:
  - "A parallel executor faces a shared-resource contention problem (ports, DB, env, a singleton)"
  - "General isolation (containers, per-run resource allocation) is expensive and not yet demanded"
  - "Some units of work need the exclusive resource and some don't"
tags: [fan-out, runtime-isolation, yagni, tiered-design, exclusive-runtime, parallel-execution]
---

# Ship declare-and-serialize before building general isolation for a contention problem

## Context

`orch-fanout` runs task-graph nodes in parallel worktrees through `/lfg`. Worktrees isolate
**code**, not **runtime**: parallel runs share ports, a dev database, `.env`, and singleton
local services, so two runs that each boot a server or migrate the dev DB corrupt each other.
The obvious-but-expensive fix is general per-run isolation (allocate a port per run, spin an
ephemeral DB, containerize). That is high-blast-radius, deeply project-specific, and — for the
executor's actual first users (this plugin, libraries, CLIs) — **not needed at all**, since
their runs share no runtime.

## Guidance

When a parallel executor hits shared-resource contention, ship the **declare-and-serialize**
tier before building general isolation:

1. **Declare** the contention as an explicit, default-safe signal on each unit of work — a
   field like `exclusive_runtime` (mirroring an existing optional field such as `no_pr`).
   Default is "no exclusive resource needed" so the common, contention-free case annotates
   nothing.
2. **Serialize** the declared units — run each as a solo step, never concurrent with
   anything; fan out the rest.
3. Make the declared field the **forward hook** for the deferred general solution: when real
   per-run isolation later exists, the executor allocates resources for declared units
   instead of serializing them. No rework of the signal, just a new branch on it.

Pair it with a **visible preview** as the safety net: show which units run in parallel
before spawning, so a unit that should have been declared but wasn't is caught by a human at
the gate rather than corrupting a run.

## Why This Matters

This applies YAGNI to the *expensive* axis (general isolation machinery) while still being
correct and safe on day one: full parallelism where nothing is shared, serial where it is,
never corruption. Building general isolation up front would be speculative complexity for a
demand that may never materialize in a given project. The declared signal costs almost
nothing (it mirrors an existing field), keeps the executor honest about what it can and can't
parallelize, and leaves a clean seam for the harder solution if a project ever needs it. The
failure mode it avoids: an executor that either (a) refuses to fan out at all because runtime
*might* collide, or (b) fans out blindly and corrupts shared state.

## When to Apply

- Any autonomous/parallel executor over a graph or queue where some units contend on a
  non-shareable resource and most don't.
- Whenever the "real" isolation is expensive and no concrete case demands it yet — declare +
  serialize first, design the signal so isolation slots in later.
- Not when contention is universal (every unit needs the resource) — then serialization is
  just "run serially" and the signal adds nothing.

## Examples

- **orch-fanout (this case):** `exclusive_runtime` is emitted in `graph_compute`'s `node_meta`
  (default false); `wave_plan.py` extracts declared nodes into solo [[Wave]]s while the rest
  stay parallel; the SKILL.md preview shows the split before any spawn. Tier-2 (per-run
  isolation that lets exclusive nodes parallelize) is deferred, with the field as its hook.
- **Generalizes to:** a CI fan-out where some jobs need an exclusive integration environment;
  a data pipeline where some steps lock a shared table.

## Related

- `docs/solutions/conventions/fan-out-eligibility-is-narrower-than-ready.md` — the eligibility
  filter this composes with (which nodes fan out at all).
- Origin decision: `docs/brainstorms/2026-06-23-orch-fanout-runtime-isolation-requirements.md`.

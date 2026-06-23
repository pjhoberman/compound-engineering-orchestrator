# n7 — orch-fanout: executor — preview + spawn + dep-order merge (BRIEF)

- **Stage:** plan · **Model:** ceiling · **Depends on:** n5, n6
- **Brief** (not a plan): the capstone; highest complexity and blast radius, with a genuinely unsolved sub-problem.

## Goal

The autonomous executor the whole family builds toward. Take a collision-free batch (n6), show
a **visible preview** of the planned wave (which nodes, which worktrees, which model each), and
on confirmation spawn one worktree-isolated sub-agent per node each running `/lfg` end-to-end,
then merge results in dependency order. Mid-wave gate decisions are collected into **one
consolidated checkpoint per wave**, not M gates × N tasks inline.

## What is already locked (constrains the design)

- Composes shipped primitives: `ce-work`'s worktree-isolated parallel dispatch + dependency-order
  merge, `ce-code-review`'s bounded backpressure scheduler, `lfg` as the per-node pipeline. The
  new surface is the drain-the-batch loop and the gates — not new execution machinery.
- The **visible preview is non-negotiable**: a documented LFG-autopilot rubber-stamp failure is
  the explicit reason a single-keystroke gate is forbidden.
- Recovery (n5) must exist first so a dead mid-wave run is recoverable — hence the dependency.

## Open questions to resolve in plan / brainstorm

- **Runtime isolation (the unsolved one).** Worktrees isolate *code*, not *runtime* — parallel
  `/lfg` runs can collide on ports, shared DB, and `.env` state. The ideation flags this as a
  "real, unsolved failure mode that must be scoped." This likely needs its own brainstorm before
  n7 can be safely planned; it may spawn a dedicated node.
- **Consolidated HITL shape.** How are mid-wave gates batched into one checkpoint without
  stalling the whole wave on the slowest task?
- **Merge-conflict handling at wave scale.** Reuse ce-work's abort-and-re-dispatch on conflict,
  or escalate to the human? Interaction with the circuit breaker (n8).
- **Wave boundary definition.** Drives n4's manifest write cadence.

## Rough scope signal

Largest node in the graph; almost certainly decomposes into a sub-graph (preview, spawn loop,
merge, runtime-isolation, HITL batching) when planned. Do not attempt as one unit — re-decompose.

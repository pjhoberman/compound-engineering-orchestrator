# n6 — orch-fanout: cross-ticket collision partitioner (BRIEF)

- **Stage:** plan · **Model:** ceiling · **Depends on:** n1
- **Brief** (not a plan): lifting collision detection to cross-ticket scope is an open design problem.

## Goal

Partition the ready set (from n1) into **collision-free parallel batches**: lift `ce-work`'s
pre-dispatch file-collision check from intra-feature to **cross-ticket** scope, so two ready
nodes that would touch the same files are never dispatched in the same wave. Bound each batch
by the documented ~5–7 fan-out crossover where delegation stops paying off.

## What is already locked (constrains the design)

- `ce-work` already performs intra-feature file-collision detection and dependency-order merge;
  this node generalizes that machinery rather than inventing it.
- The ~5–7 crossover is a known constant — batches are bounded, never unbounded (the
  "100 worktrees" saturating swarm was explicitly rejected: merge thrash, runaway cost).
- Input is n1's ready set; output is an ordered list of collision-free batches.

## Open questions to resolve in plan

- **Where file sets come from pre-execution.** A `work` node's files are in its embedded plan's
  `Files:` list (parseable today), but `plan`/`brainstorm` nodes have no file list yet — how is
  a not-yet-planned node's collision footprint estimated, or are only `work` nodes fan-out
  eligible? (Likely: only `work`-stage ready nodes are fanout candidates.)
- **Collision granularity.** File-path exact match, or directory/module-level conservative
  over-approximation to be safe?
- **Batch ordering.** Within the crossover bound, order by critical-path leverage (n1's slack)?

## Rough scope signal

Medium. The algorithm is the hard part (`ceiling`); it reuses ce-work's primitives. Gates n7.

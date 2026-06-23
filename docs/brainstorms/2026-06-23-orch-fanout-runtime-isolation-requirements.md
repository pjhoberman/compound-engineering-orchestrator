# orch-fanout executor (n7) — runtime isolation: requirements

- **Date:** 2026-06-23
- **Status:** requirements (brainstorm output) — ready for `ce-plan`
- **Roadmap node:** `docs/plans/orchestrator-roadmap/n7-orch-fanout-executor.md`
- **Scope tier:** Deep — feature (product shape set by the roadmap; this resolves the runtime-isolation approach)

## Outcome

`orch-fanout` can take a collision-free [[Fan-out batch]] and execute its nodes through `/lfg`
in parallel worktrees, **safely**, by isolating what it can (code, via worktrees) and
serializing what it can't (shared runtime), behind a visible preview — without ever putting
two runs that share a file *or* a runtime resource in flight at once.

## Problem & context

`ce-work` worktrees isolate **code**: each parallel run gets its own checkout. They do **not**
isolate **runtime** — parallel `/lfg` runs on one machine share ports, a dev database,
`.env`/secrets, build caches, and any singleton local service. Two runs that each boot a dev
server on :3000 or migrate the same dev DB corrupt each other. The decompose flagged this as
the executor's one unsolved problem.

Key framing established in brainstorm: **runtime-isolation severity is per-project, not
universal.** A `/lfg` run's runtime footprint depends on the project. The orchestrator's own
nodes run `bun test` + stdlib Python — no server, DB, ports, or secrets — so they are fully
parallel-safe today. App-style projects (a server + dev DB + ports) have nodes that are not.
The executor must therefore *distinguish* the two, not assume one.

## The decision: tiered, ship the scoped tier

**Tier 1 (this node — build):** isolate code (worktrees, reuse `ce-work`); **serialize**
nodes that need exclusive runtime. Runtime-independent nodes fan out in parallel; exclusive
nodes run one at a time. Correct and safe for every project — full parallelism where nothing
is shared, serial where it is.

**Tier 2 (deferred — design for, do not build):** real per-run runtime isolation (per-run
port/DB/env allocation or containerization) that lets exclusive nodes parallelize too. Not
built now: it is high-blast-radius, deeply project-specific, and nothing concrete demands it
yet (YAGNI). The `exclusive_runtime` signal below is its forward hook — when isolation exists,
the executor allocates per-run resources instead of serializing.

## Requirements

**R1 — Runtime-need is a declared, default-safe-parallel node signal.**
A node is treated as runtime-independent (parallel-safe) unless it carries an explicit
`exclusive_runtime: true` field (an optional node field, mirroring `no_pr`). The decompose
stamps it; a human can edit it. Runtime-independent projects annotate nothing.

**R2 — The executor never co-runs two nodes that collide on files OR runtime.**
Within a wave: file-collision-free batching comes from the partitioner (n6); among the
parallel-eligible nodes, those marked `exclusive_runtime` are pulled out and run serially
(one at a time, between or around the parallel waves). The invariant is: at most one
exclusive-runtime run in flight, ever; parallel runs are pairwise file-disjoint AND
runtime-independent.

**R3 — A visible preview gates every spawn.**
Before launching, show the planned wave: which nodes run in parallel, in which worktrees,
on which model, and which nodes are serialized and why. The human confirms once per wave.
This is non-negotiable (it is the antidote to the documented LFG-autopilot rubber-stamp
failure) and it is the safety net that makes R1's default-parallel acceptable — a node that
should have been `exclusive_runtime` but wasn't is visible here before any damage.

**R4 — Heuristic warning, never heuristic decision.**
The preview may *flag* a node as suspected runtime-coupled (e.g. it touches server/DB/CI
config files) to prompt the human. The flag only warns; the declared `exclusive_runtime`
field is the sole thing that changes execution. No silent inference of behavior.

**R5 — Merge in dependency order; checkpoint at every wave boundary.**
Completed runs merge back in dependency order (reuse `ce-work`'s order + abort/re-dispatch on
conflict). At each wave boundary the recovery manifest (n4) is written so a dead/compacted
session resumes via the reconciler (n5).

**R6 — Consolidated, per-wave human gates.**
Gate decisions arising mid-wave are collected into one checkpoint per wave, not M gates × N
nodes inline.

**R7 — Compose, don't rebuild.**
The executor is the drain-the-batch loop + the gates. Worktree-isolated dispatch, file-
collision detection, and dependency-order merge come from `ce-work`; the per-node pipeline is
`/lfg`; the ready set + batches come from `frontier`/`partition`; the circuit breaker is n8.

## Scope boundaries

**In scope (tier 1):** code isolation via worktrees; declared-runtime detection; parallel
fan-out of runtime-independent nodes; serialization of exclusive-runtime nodes; visible
preview; dependency-order merge; wave-boundary recovery checkpoints.

**Deferred for later (tier 2):** per-run port allocation, ephemeral per-run databases,
per-run env/secret injection, containerized runs — anything that would let `exclusive_runtime`
nodes parallelize. The field is the hook; the machinery is out of scope now.

**Outside this node's identity:** the circuit breaker (n8, separate node); decomposition or
status derivation (orch-decompose); choosing *what* to run next (orch-next). n7 executes a
batch it is handed.

## Success criteria

- On this plugin's own task-graph (no exclusive-runtime nodes), a ready batch fans out fully
  in parallel and merges in dependency order with no manual runtime juggling.
- A node marked `exclusive_runtime` never runs concurrently with any other run.
- The preview shows the parallel/serial split with reasons; nothing spawns without confirm.
- A session killed mid-wave resumes from the recovery manifest without orphaned worktrees.

## Dependencies & assumptions

- **Depends on:** `ce-work` (worktree/collision/merge machinery), `/lfg` (per-node pipeline),
  partitioner n6 (collision-free batches), recovery manifest n4/n5. Hard dependency on the
  compound-engineering plugin.
- **Assumption:** the partitioner (n6) is extended to also exclude/segregate
  `exclusive_runtime` nodes from the parallel batches, OR the executor applies that split on
  top of n6's file-collision batches. (Open question OQ1.)
- **Assumption:** `exclusive_runtime` is added to the task-graph schema as an optional node
  field; decompose learns to stamp it. (Touches orch-decompose schema — confirm at plan time.)

## Outstanding questions

- **OQ1 — split location:** does n6 (partitioner) own the runtime-exclusive split, or does n7
  apply it over n6's file-collision batches? (Leaning: n7 owns runtime, n6 owns files — keep
  concerns separate.)
- **OQ2 — serialized-node placement:** run exclusive-runtime nodes before the parallel wave,
  after it, or in their own serial wave? Interaction with dependency order.
- **OQ3 — concurrency bound:** the parallel width within a wave (the ~5–7 crossover n6
  already bounds) vs. machine resource limits — is a lower cap warranted for heavier runs?
- **OQ4 — preview heuristic (R4):** which file signals warrant a runtime-coupling warning,
  and is that worth building in tier 1 or deferring with the rest of inference?

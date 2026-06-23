# feat: orch-fanout executor (n7) — runtime-aware wave execution

- **Date:** 2026-06-23
- **Type:** feat · **Depth:** Deep
- **Origin:** `docs/brainstorms/2026-06-23-orch-fanout-runtime-isolation-requirements.md`
- **Roadmap node:** n7 (`docs/plans/orchestrator-roadmap/n7-orch-fanout-executor.md`)

---

## Summary

Build the `orch-fanout` executor: take the collision-free batches the partitioner (n6)
produces, sequence them into **waves** that are safe to run concurrently, and drive each
wave's nodes through `/lfg` in worktree-isolated parallel runs behind a visible preview,
merging in dependency order and checkpointing recovery state at every wave boundary. Runtime
safety is handled by the tier-1 decision from the brainstorm: nodes that need exclusive
runtime are declared and run as **solo waves**; everything else fans out.

## Problem Frame

Worktrees isolate code, not runtime. Parallel `/lfg` runs share ports, a dev DB, `.env`, and
local services, so two runs that each boot a server or migrate the dev DB corrupt each other.
The executor must therefore run file-disjoint **and** runtime-independent nodes in parallel,
while serializing nodes that need exclusive runtime — never co-scheduling an exclusive node
with anything. Scope is tier-1 (declare + serialize); real per-run isolation is deferred.

## Requirements (from origin)

- **R1** — runtime-need is a declared, default-safe-parallel node signal (`exclusive_runtime`).
- **R2** — never co-run two nodes that collide on files OR runtime; ≤1 exclusive run in flight.
- **R3** — a visible preview gates every spawn (the rubber-stamp antidote + the safety net for R1).
- **R4** — heuristic may warn, never decide (deferred to follow-up; tier-1 is declared-only).
- **R5** — merge in dependency order; write the recovery manifest at every wave boundary.
- **R6** — consolidated, per-wave human gates.
- **R7** — compose `ce-work` / `/lfg` / n6 / n4–n5; the new surface is the loop + gates.

## Key Technical Decisions

- **KTD1 — n7 owns the runtime split (OQ1).** The partitioner (n6) stays file-collision-only.
  A new `wave_plan` step takes n6's batches plus per-node `exclusive_runtime` and extracts
  exclusive nodes into their own solo waves. Keeps n6's concern (files) and n7's concern
  (runtime) separate and independently testable.
- **KTD2 — `exclusive_runtime` is a node field mirroring `no_pr`** (see origin R1; and
  `docs/solutions/conventions/fan-out-eligibility-is-narrower-than-ready.md`). Emitted in
  `graph_compute`'s `node_meta` exactly like `no_pr`, via an `is_exclusive_runtime` helper
  paired with the existing `is_no_pr`.
- **KTD3 — exclusive nodes run as solo waves, interleaved by dependency order (OQ2).** An
  exclusive node is its own wave of size 1; it is never concurrent with any other run.
- **KTD4 — concurrency bound is n6's `--max-batch` (OQ3).** No separate resource cap in
  tier-1; a machine-resource-aware cap is deferred.
- **KTD5 — `wave_plan.py` is a pure consumer** of partition + `node_meta` JSON (compose,
  don't re-parse — `docs/solutions/conventions/verify-tool-output-contract-before-work-ready-node.md`),
  deterministic, with a `fail()`→exit-2 contract matching the sibling scripts.

## High-Level Technical Design

Pipeline the executor composes (each arrow is an existing script except `wave_plan`):

```
graph_compute.py ─┐
reorient.py ──────┼─► frontier.py ─► partition.py ─► wave_plan.py ─► [waves]
                  │   (ready set)    (file-disjoint    (split exclusive
 (edges, node_meta:                  batches)           into solo waves)
  stage/no_pr/files/exclusive_runtime)
```

Per wave, the SKILL.md loop: **preview** (nodes, worktrees, model, parallel-vs-solo + why) →
confirm (consolidated HITL) → spawn worktree `/lfg` per node (reuse `ce-work`) → merge in
dependency order → write recovery manifest (`manifest.py`). Resume = `reconcile.py`. The
circuit breaker (n8) is the sibling failure-halt layer, not built here.

## Output Structure

```
skills/orch-fanout/
  SKILL.md                      # NEW (U3) — the executor procedure
  scripts/
    manifest.py                 # exists (n4)
    reconcile.py                # exists (n5)
    partition.py                # exists (n6)
    wave_plan.py                # NEW (U2)
  references/
    recovery-manifest-schema.md # exists
```

---

## Implementation Units

### U1. Add `exclusive_runtime` to the task-graph schema + node_meta

**Goal:** Surface a node's runtime-exclusivity to consumers, mirroring `no_pr`.
**Requirements:** R1, R2. **Dependencies:** none.
**Files:**
- `skills/orch-decompose/scripts/graph_compute.py` (modify) — add `is_exclusive_runtime(node)` paired with `is_no_pr`; include `"exclusive_runtime"` in each `node_meta` entry.
- `skills/orch-decompose/references/task-graph-schema.md` (modify) — document the optional `exclusive_runtime` column (default false) and when to set it.
- `skills/orch-decompose/SKILL.md` (modify) — one line in Phase 2 stamping guidance: mark `exclusive_runtime: true` for nodes that need a server/DB/port/singleton at runtime.
- `tests/orch-decompose-scripts.test.ts` (modify) — regression: `node_meta[n].exclusive_runtime` present + bool; defaults false when column absent.
**Approach:** Mirror the `no_pr` plumbing exactly — index column is parsed as a string and coerced via the helper. Additive to `node_meta`; existing consumers ignore the new key.
**Patterns to follow:** the `is_no_pr` helper and `no_pr` field in `graph_compute.py` (added this session).
**Test scenarios:**
- A node with `exclusive_runtime` column `true` → `node_meta[n].exclusive_runtime === true`.
- A node with the column absent/empty → `false`.
- `node_meta` still covers all nodes (count unchanged); existing `valid` fixture stays clean.
**Verification:** `bun test` green incl. the new assertions; `graph_compute` JSON carries `exclusive_runtime` for every node.

### U2. `wave_plan.py` — sequence batches into runtime-safe waves

**Goal:** Turn n6's file-collision batches + per-node `exclusive_runtime` into an ordered
list of waves where each wave is either a parallel batch of non-exclusive nodes or a single
exclusive node.
**Requirements:** R2, R5 (wave boundaries), KTD1/KTD3. **Dependencies:** U1.
**Files:**
- `skills/orch-fanout/scripts/wave_plan.py` (create) — `--partition <partition.json> --graph <graph_compute.json>`; emit `{ "waves": [ {"kind":"parallel","ids":[...]} | {"kind":"solo","id":"nX","reason":"exclusive_runtime"} ], "wave_count": N }`.
- `tests/orch-fanout-scripts.test.ts` (modify) — add a `wave_plan.py` describe block.
- `tests/fixtures/orch-fanout/wave-plan/{partition,graph}.json` (create).
**Approach:** For each batch from partition, partition its members by `node_meta[id].exclusive_runtime`: non-exclusive members stay as one parallel wave (preserve order); each exclusive member becomes its own solo wave. Order: keep partition's batch order; within a split batch, emit the parallel wave then the solo waves (or interleave deterministically by id). Pure consumer; `fail()`→exit-2 on bad/missing input or a graph lacking `node_meta` (mirror `partition.py`).
**Patterns to follow:** `skills/orch-fanout/scripts/partition.py` (CLI shape, `fail()`/`load()`, determinism, node_meta-presence guard).
**Test scenarios:**
- A batch of 3 non-exclusive nodes → one parallel wave of 3.
- A batch containing 1 exclusive + 2 non-exclusive → one parallel wave (the 2) + one solo wave (the exclusive), exclusive never in a parallel wave.
- Two exclusive nodes → two separate solo waves (never co-scheduled).
- Determinism: identical output across runs.
- Empty partition (no batches) → `waves: []`, `wave_count: 0`.
- Missing `--partition`/`--graph` file or a graph without `node_meta` → exit 2, stderr message, no traceback.
**Verification:** `bun test` green; run on a fixture with a mixed batch and confirm no exclusive node shares a wave.

### U3. `orch-fanout` SKILL.md — the executor procedure

**Goal:** The manual-invoke skill that runs the full pipeline and drives a wave at a time.
**Requirements:** R2, R3, R5, R6, R7. **Dependencies:** U2 (and existing n4/n5/n6).
**Files:**
- `skills/orch-fanout/SKILL.md` (create).
**Approach:** Mirror `orch-next/SKILL.md` structure. Phases: (1) locate the task-graph;
(2) compute — run `graph_compute` + `reorient` + `frontier` + `partition` + `wave_plan` via
the `${CLAUDE_SKILL_DIR}` + sibling `../orch-decompose/scripts` guard (same cross-skill
resolution as orch-next), degrade visibly off-platform; (3) **visible preview** of the wave
plan — for each wave: node ids, target worktrees, model tier, and parallel-vs-solo with the
reason (file-disjoint / exclusive_runtime); (4) consolidated per-wave HITL confirm; (5) on
confirm, spawn one worktree-isolated `/lfg` per node in a parallel wave (reuse `ce-work`'s
worktree + dependency-order merge + abort/re-dispatch-on-conflict), run solo waves one node
at a time; (6) write the recovery manifest (`manifest.py`) at each wave boundary; resume via
`reconcile.py`. Note the circuit breaker (n8) as the failure-halt layer that wraps the loop.
Manual-invoke (`disable-model-invocation: true`); hard dependency on compound-engineering +
sibling orch-decompose scripts stated up front.
**Execution note:** prose artifact — no unit tests; verified by `claude plugin validate` and a documented dry-run of the script chain.
**Patterns to follow:** `skills/orch-next/SKILL.md` (cross-skill `${CLAUDE_SKILL_DIR}/../orch-decompose/scripts` guard, phase structure, inline handoff); the visible-preview requirement from `docs/solutions/best-practices` rubber-stamp learning referenced in the brainstorm.
**Test scenarios:** `Test expectation: none — SKILL.md is orchestration prose. Verified by plugin validate + a dry-run of graph_compute→…→wave_plan on the real roadmap graph.`
**Verification:** `claude plugin validate .` passes; the documented script chain runs end-to-end on `docs/plans/orchestrator-roadmap/` and the preview correctly classifies each ready node.

### U4. Vocabulary + recovery wiring docs

**Goal:** Capture the resolved terms and confirm the manifest's wave-boundary contract.
**Requirements:** R1, R5. **Dependencies:** U1, U3.
**Files:**
- `CONCEPTS.md` (modify) — add `exclusive_runtime` (a node that needs a non-shareable runtime resource; runs as a solo [[Fan-out batch]]) and `Wave` (one step of an orch-fanout run: a parallel batch or a single exclusive node, the unit at which the recovery manifest is written).
- `skills/orch-fanout/references/recovery-manifest-schema.md` (modify, if needed) — confirm the "written at every wave boundary" line names the executor (U3) as the writer.
**Approach:** Glossary entries only; follow existing `CONCEPTS.md` format.
**Test scenarios:** `Test expectation: none — docs only.`
**Verification:** terms present and consistent with the `Fan-out batch` / `Ready frontier` neighborhood.

---

## Scope Boundaries

**In scope:** the wave sequencer (U2), the `exclusive_runtime` signal (U1), the executor
SKILL.md (U3) with visible preview + consolidated HITL + dependency-order merge + wave-boundary
recovery checkpoints, vocabulary (U4).

**Deferred for later (tier-2, per origin):** real per-run runtime isolation (port/DB/env
allocation, containerization) that would let exclusive nodes parallelize; the preview
heuristic warning (origin R4 / OQ4); a machine-resource-aware concurrency cap (OQ3).

**Outside this node's identity:** the circuit breaker (n8 — separate node); decomposition,
status derivation, and next-move recommendation (orch-decompose / orch-next).

## Risks & Dependencies

- **Hard dependency** on the compound-engineering plugin (`ce-work`, `/lfg`) and the sibling
  `orch-decompose` scripts; the guard must degrade visibly when absent.
- **Risk:** a node that should be `exclusive_runtime` but isn't declared → caught at the
  visible preview (R3) and recoverable via n8 + the manifest; not silent corruption in
  runtime-independent repos.
- **Risk:** spawning real parallel `/lfg` is high-blast-radius; tier-1 keeps the new surface
  to the loop + gates and reuses shipped machinery (R7).

## Assumptions

- `ce-work`'s worktree/merge machinery is invokable as the spawn primitive for parallel `/lfg`
  runs (composition assumed per origin R7; confirm the exact invocation seam in `ce-work`).
- `wave_plan` consuming partition + `node_meta` is the right seam for the runtime split
  (KTD1); if `ce-work` already exposes a wave abstraction, U2 adapts to it.

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-23-orch-fanout-runtime-isolation-requirements.md`.
- Learnings applied: `docs/solutions/conventions/fan-out-eligibility-is-narrower-than-ready.md`,
  `.../verify-tool-output-contract-before-work-ready-node.md`,
  `docs/solutions/logic-errors/normalize-paths-before-collision-detection.md`,
  `.../split-pure-state-machine-from-live-git-io.md`.
- Sibling code grounding: `skills/orch-fanout/scripts/{partition,manifest,reconcile}.py`,
  `skills/orch-next/SKILL.md`, `skills/orch-decompose/scripts/graph_compute.py` (all built this session).

# Stage-Flip Write-Back Contract

`ce-plan` writes standalone plan docs; nothing in the family specifies how a plan gets *into*
the task-graph. `orch-ripen` owns that glue. This is the contract it follows when a human
**approves** a wave's plan and the node flips `plan` → `work`. It exists nowhere else — the
sibling skills consume the result but do not produce it.

## The flip, per approved node

For each node the human approves at the Phase 5 gate, do all four — the node file and the
index row must stay consistent:

1. **Embed the plan into the node file** per
   `../../orch-decompose/references/embedded-unit-schema.md` — a level-3 heading carrying the
   node's ID, then the bold-leader fields (`Goal`, `Requirements`, `Dependencies`, `Files`,
   `Approach`, `Test scenarios`, `Verification`, …). This replaces the brief the node held at
   `plan`/`brainstorm` stage.

2. **Write machine-parseable `Files:` bullets.** Each file is its own bullet:
   `` - `path/to/file` (create) `` or `` - `path/to/file` (modify) ``, repo-relative, exactly
   one `(create)`/`(modify)` marker. `graph_compute.py` extracts these to run the
   missing/spurious-dependency guard (Phase 6) — a malformed `Files:` line makes the node's
   edges silently unvalidated, so this format is load-bearing, not cosmetic.

3. **Flip the index `stage` cell** `plan` → `work` in `index.md`. Leave the `status` cell
   alone — it is a derived cache (`reorient.py` rewrites it); never hand-set it.

4. **Stamp `base_commit` = current HEAD** in the index row, at plan time. This is what the
   Phase 6 staleness check (`staleness.py`) and the drive-time checks
   (`orch-decompose`/`orch-next` Phase 4) compare against: a plan authored against an older
   HEAD than a since-merged upstream is flagged "may be stale — re-plan?".

## Consistency invariants

- **`Dependencies` mirrors `depends_on`.** The node file's `Dependencies` field must name the
  same upstream IDs as the index row's `depends_on` cell. Ripening does not change edges; it
  matures a node in place, so the edge set is inherited from decompose. If planning surfaces a
  genuinely new edge, add it to *both* places (and let Phase 6's re-audit validate it).
- **IDs never change.** Ripening a node keeps its stable ID. It is the same node, matured — not
  a new one.

## Rejected / revise nodes

A node the human rejects or sends back for revision **stays `plan`-stage**. Append the
feedback to its brief (what to reconsider / what decision is still open) so the next wave's
`ce-plan` run has it. Do not flip a rejected node; do not discard the draft plan — fold it into
the brief as prior art.

## Serialize the index write to the wave boundary

Plan runs are worktree-isolated and write **independent node files** — those never collide. The
only shared file is `index.md` (every flip edits the `stage`/`base_commit` cells). So:

- Let the concurrent `ce-plan` runs finish and produce their node-file edits.
- Apply all approved index-cell flips **once, serially, at the wave boundary** — never from the
  concurrent runs.
- Commit the wave as a **single commit**: `ripen wave N: nX (title), nY (title) → work`.

This is the planning analogue of `orch-fanout`'s "declare and serialize before general
isolation" learning: isolate the parallel work, serialize the one shared write.

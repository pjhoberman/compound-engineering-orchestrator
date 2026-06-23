# n4 — recovery manifest: schema + writer (BRIEF)

- **Stage:** plan · **Model:** ceiling · **Depends on:** (none — root)
- **Brief** (not a plan): the durability tier and on-disk shape are open design decisions.

## Goal

Define and write a durable checkpoint at every batch boundary recording, per in-flight task:
status, the absolute worktree path and branch, whether a PR is open, and the last clean merge.
The precondition that makes an autonomous run (n7) trustworthy enough to walk away from — if a
session dies or context compacts mid-run, recovery becomes a *read*, not a detective exercise
across orphaned branches.

## What is already locked (constrains the design)

- The data to record already exists in `ce-work`'s cleanup sequence (worktree path + branch);
  this node makes the same data durable rather than inventing new fields.
- Git is authoritative; the manifest is a *hint* reconciled against git on read (n5) — it must
  never be treated as the source of truth, mirroring the status-is-derived principle.

## Open questions to resolve in plan

- **Durability tier / location.** Where does it live so it survives a session but stays out of
  the plan body and out of committed history noise? Candidates: a gitignored `.orch/` dir, a
  scratch path, or a committed-but-separate file. This is the central decision.
- **Format.** JSON for machine reconciliation (n5 reads it) vs. markdown for human inspection —
  or JSON with a rendered view. Lean JSON given n5/n3 consume it programmatically.
- **Write cadence.** "Every batch boundary" — define the boundary precisely against n7's wave
  loop, and make writes atomic (temp-file + rename) so a crash mid-write can't corrupt it.
- **Relationship to the task-graph.** Manifest = volatile run-state; graph = durable structure.
  Keep them separate, or is the manifest a derived projection? Settle the boundary.

## Rough scope signal

Schema design is the hard part (hence `ceiling`); the writer itself is small once the shape and
location are decided. Independently buildable — it has no upstream dependency.

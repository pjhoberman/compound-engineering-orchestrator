# n5 — recovery manifest: reconciler/reader (BRIEF)

- **Stage:** plan · **Model:** generation · **Depends on:** n4
- **Brief** (not a plan): its files depend on n4's not-yet-settled schema, so it can't be work-ready yet.

## Goal

On resume, reconstruct the true mid-run state by reconciling the manifest (n4) against live git
and `gh`: which worktrees actually still exist, which PRs are open, which branches merged, and
exactly where to resume. Treats git as authoritative and the manifest as a hint — a manifest
entry whose worktree is gone or whose PR merged is corrected, not trusted blindly.

## What is already locked (constrains the design)

- Reuses `orch-decompose`'s `reorient.py` git/gh derivation patterns and `ce-worktree`'s
  worktree-detection logic to re-discover existing worktrees — same authoritative-git stance.
- Reconciliation is mechanical once n4's schema is fixed; this is why the node is `generation`,
  not `ceiling`.

## Why this is a brief, not a plan

The reconciler's file list and exact reads are determined by n4's chosen manifest shape and
location. Once n4 lands, this node should re-plan to `work` cleanly (clear goal, mechanical
work, files knowable) and embed a plan.

## Open questions to resolve in plan (mostly inherited from n4)

- The reconciliation rules per field: manifest says worktree at path X but it's gone → mark
  abandoned; says PR open but it merged → advance to done; etc. Enumerate the matrix.
- Output shape: a resume report the human reads, plus a machine form n7 consumes to continue.

## Rough scope signal

Small and mechanical after n4 — primarily a reconcile pass plus a resume report.

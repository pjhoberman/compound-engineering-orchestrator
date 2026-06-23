<!-- orch-decompose task-graph · schema_version: 1 -->

# Orchestrator roadmap — task graph

Build out the remaining rungs of the compound-engineering-orchestrator: a what's-next
recommender (`orch-next`), a cross-session recovery manifest, and the autonomous parallel
executor (`orch-fanout`). The `orch-decompose` foundation is already shipped; this graph is
the work above it. (This graph is itself the plugin's first dogfood.)

Decisions locked at decompose time:
- Scope is the orchestration + durability rungs only — `orch-tracker-sync` (Linear) is
  deliberately deferred; state lives in git and the task-graph for now.
- Every new skill is `orch-`-namespaced and composes compound-engineering skills as a hard
  dependency (`ce-work`'s worktree/collision/merge machinery, `lfg`, `ce-plan`); it never
  reimplements them.
- The committed files own structure; live status is derived from git on read.
- `orch-fanout` is the capstone and sits downstream of the recovery/durability layer — a
  documented LFG-autopilot rubber-stamp failure makes the visible-preview gate non-negotiable.
- Compute composes, never duplicates: the ready-frontier pass consumes the JSON that
  `graph_compute.py` and `reorient.py` already emit rather than re-parsing the graph.

| id | title | stage | model | status | manual_status | depends_on | node_file | branch_ref | pr_refs | base_commit | no_pr | source |
|----|-------|-------|-------|--------|---------------|------------|-----------|------------|---------|-------------|-------|--------|
| n1 | orch-next: ready-frontier compute | work | generation | not-started |  |  | n1-orch-next-frontier-compute.md |  |  | a95f5f5 |  |  |
| n2 | orch-next: recommend-one-move skill + inline handoff | plan | ceiling | not-started |  | n1 | n2-orch-next-skill.md |  |  |  |  |  |
| n3 | orch-next: starvation detection | plan | generation | not-started |  | n1,n4 | n3-orch-next-starvation.md |  |  |  |  |  |
| n4 | recovery manifest: schema + writer | plan | ceiling | not-started |  |  | n4-recovery-manifest-schema.md |  |  |  |  |  |
| n5 | recovery manifest: reconciler/reader | plan | generation | not-started |  | n4 | n5-recovery-manifest-reconciler.md |  |  |  |  |  |
| n6 | orch-fanout: cross-ticket collision partitioner | plan | ceiling | not-started |  | n1 | n6-orch-fanout-partitioner.md |  |  |  |  |  |
| n7 | orch-fanout: executor (preview + spawn + dep-order merge) | plan | ceiling | not-started |  | n5,n6 | n7-orch-fanout-executor.md |  |  |  |  |  |
| n8 | orch-fanout: circuit breaker | plan | ceiling | not-started |  | n7 | n8-orch-fanout-circuit-breaker.md |  |  |  |  |  |

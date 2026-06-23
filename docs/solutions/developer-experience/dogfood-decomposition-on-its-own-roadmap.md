---
title: Dogfood the decomposer on its own roadmap to surface plan gaps early
date: 2026-06-23
category: developer-experience
module: compound-engineering-orchestrator
problem_type: developer_experience
component: development_workflow
severity: low
applies_when:
  - "Building orchestration/decomposition tooling that operates on a task-graph"
  - "A foundation skill exists but the rungs above it are not yet built"
  - "You want plan-quality feedback before committing to autonomous execution"
tags: [dogfooding, self-hosting, task-graph, orchestration, workflow]
---

# Dogfood the decomposer on its own roadmap to surface plan gaps early

## Context

The orchestrator plugin is built in rungs: `orch-decompose` (foundation, ships first),
then `orch-next`, recovery manifest, and `orch-fanout` on top. Full self-hosting is
impossible on day one — the thing that would *execute* the build (the fan-out executor)
is itself unbuilt. The question was how to get value and feedback from the tooling before
the higher rungs exist.

## Guidance

As soon as the foundation skill works, run it on the project's **own roadmap**. Concretely:
use `orch-decompose` to decompose the remaining rungs into the repo's own committed
task-graph (`docs/plans/<project>/`), audit it with the bundled scripts, then build the
first work-ready node by hand. Each rung you complete becomes the tool that drives the
next — progressive self-hosting rather than an all-or-nothing autonomous loop.

This does two things at once:
1. **Exercises the tool on a real, non-fixture graph** — the audit and re-orient scripts
   run against genuine input, not just test fixtures.
2. **Stress-tests the plans the tool produced** — building the first node surfaces whether
   its embedded plan was actually correct.

## Why This Matters

The first build off a fresh decomposition is the cheapest moment to catch a bad plan. In
this session, building the first node (`orch-next`'s frontier compute) immediately exposed
that its plan assumed an upstream script exposed data it did not (see
`docs/solutions/conventions/verify-tool-output-contract-before-work-ready-node.md`). That
gap would have been far more expensive to discover during an autonomous multi-node run.
Dogfooding on the roadmap turns the tool's own output into its first real test case.

## When to Apply

- After a foundation/decomposition skill is green but the orchestration rungs above it
  aren't built — decompose those rungs as the first dogfood.
- Whenever you can make the project's own backlog the tool's first real input.
- Before trusting autonomous execution: build a node or two by hand first to validate the
  plans the decomposer emits.

## Examples

- **Roadmap as task-graph:** `orch-decompose` run on the orchestrator roadmap produced an
  8-node graph (`docs/plans/orchestrator-roadmap/`); audit clean, re-orient correct, both
  bundled scripts exercised on a real graph rather than fixtures.
- **Honest staging:** only the one truly-settled node came out `stage: work` (embedded
  plan); the rest were `plan`/`brainstorm` briefs because they carry open design
  decisions — the decomposer correctly refusing to over-commit.
- **Gap caught on first build:** building the lone `work` node surfaced a false plan
  premise within minutes, fixed additively before it could propagate.

## Related

- `docs/solutions/conventions/verify-tool-output-contract-before-work-ready-node.md`
- The roadmap graph: `docs/plans/orchestrator-roadmap/index.md`.

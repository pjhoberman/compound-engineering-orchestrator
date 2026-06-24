---
title: Render node/unit IDs with their title in human-facing output
date: 2026-06-24
category: conventions
module: orchestrator
problem_type: convention
component: documentation
severity: low
applies_when:
  - "Surfacing a task-graph node ID (n3) or plan unit ID (U6) to a person"
  - "Writing PR bodies, commit messages, or code comments that reference nodes/units"
  - "A skill presents a recommendation, preview, status, or handoff menu"
tags: [readability, node-id, presentation, skill-output, pr-hygiene]
---

# Render node/unit IDs with their title in human-facing output

## Context

The orchestrator identifies work by stable opaque IDs — task-graph nodes (`n1`, `n2`, …) and
plan units (`U1`, `U2`, …). Those IDs are load-bearing for the *machine* (stable references
across edits, the dependency graph, status derivation). But they are meaningless to a *human*
reading them out of context: "drive `n7`" or "U6 is blocked" in a PR, comment, or preview tells
a person nothing weeks — or minutes — later.

## Guidance

Anywhere an ID is rendered **for a person**, pair it with its title: `n7 (CO canopy data load)`,
not bare `n7`. This applies to:

- PR bodies, commit messages, and code comments.
- The orchestrator skills' own presentation steps — `orch-next`'s recommendation, `orch-fanout`'s
  wave preview, `orch-decompose`'s status table and handoff menu.

The title is the `title` column in the task-graph `index.md` (or the unit heading in a plan).
**Machine-readable output stays bare** — the scripts' JSON (`graph_compute` / `frontier` /
`partition` / `wave_plan`) keys on raw IDs, which is correct; the pairing happens at the
presentation boundary, where a human reads it.

## Why This Matters

The whole value of the orchestrator is a human reading its previews, recommendations, and the
PRs it produces, and acting on them with confidence. A bare ID forces the reader to go look up
what it means — and in a PR or commit reviewed later, the lookup context may be gone entirely.
The ID carries identity; the title carries meaning. Showing both costs almost nothing and is the
difference between a self-explanatory artifact and an opaque one.

## When to Apply

- Every human-facing render of a node or unit ID.
- Skip only in machine-to-machine JSON, where bare IDs are the contract.

## Examples

- **Before:** `Drive n7.` / commit `feat(orch-fanout): circuit breaker (n8)`.
- **After:** `Drive n7 (CO canopy data load).` / `… circuit breaker (n8 — halt after K consecutive
  wave failures)` — the reader knows what the ID refers to without a lookup.

## Related

- `CONCEPTS.md` — `Node`, `Task-graph` (where IDs are defined).

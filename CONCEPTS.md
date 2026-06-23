# Concepts

Shared domain vocabulary for this plugin. Terms here are used precisely across skills,
scripts, and docs.

## Task-graph

The durable artifact this plugin owns: a committed, diffable set of markdown files under
`docs/plans/<project-slug>/` describing a multi-feature project as a directed acyclic
graph. One `index.md` holds a schema-versioned table (one row per node, with dependency
edges in `depends_on`); one node file per row holds either an embedded `ce-plan`-shaped
plan (work-ready nodes) or a brief (earlier-stage nodes).

The committed files own project **structure**. Live **status** is *derived* from git and
`gh` on read — never stored as the source of truth — so any session or machine reconstructs
the same state by reading the files. See `skills/orch-decompose/references/task-graph-schema.md`.

## Node

A feature-sized unit of work in the task-graph — meaningful, independently reviewable,
roughly one human's ticket. Carries a stable ID (`n1`, `n2`, …; never renumbered), a
**stage** (where it enters the CE pipeline), a **model** tier, and its dependency edges.

## Stage

The CE pipeline stage a node next enters: `brainstorm` (ambiguous problem/scope), `plan`
(clear goal, design still open), or `work` (settled and plannable; embeds a ready plan).
The stage tag defers per-node depth downstream instead of interrogating every node up front.

## Model tier

The recommended (human-overridable) model for a node: `generation` for well-specified
mechanical work, `ceiling` for cross-cutting or architectural judgment. Nudges toward
`ceiling` for security- or credential-sensitive surfaces.

## `no_pr` node

A node whose value is an activation, data load, or ops step that produces no PR. It never
derives `in-progress`/`done` from git; re-orient surfaces it as awaiting manual completion
until a `manual_status` pin is set. Splitting activation from code keeps status honest — a
merged feature whose data is not yet loaded is inert.

## Ready frontier

Every node whose dependencies are all `done` — the set eligible to start now. The basis for
the (planned) `orch-next` recommender and `orch-fanout` executor.

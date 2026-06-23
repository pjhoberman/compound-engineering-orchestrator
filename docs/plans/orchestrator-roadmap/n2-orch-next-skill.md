# n2 — orch-next: recommend-one-move skill + inline handoff (BRIEF)

- **Stage:** plan · **Model:** ceiling · **Depends on:** n1
- **Brief** (not a plan): the ranking heuristic is an open design decision, so this enters at `plan`.

## Goal

The `orch-next` skill itself: read the graph, run n1's frontier compute, and recommend **one**
highest-leverage next move with a one-line rationale and the exact command to run it
(`/lfg n7`, or `/ce-brainstorm n6` when the node's stage is still brainstorm) — then fire that
invocation inline rather than handing the user a menu to triage. The difference between a
dashboard and an orchestrator.

## What is already locked (constrains the design)

- n1 supplies the ready set + per-node `slack` and `unblocks`. This node ranks; it does not
  recompute the frontier.
- Routing by stage mirrors `orch-decompose`'s Phase-4 handoff exactly: `work`→`lfg`/`ce-work`,
  `plan`→`ce-plan`, `brainstorm`→`ce-brainstorm`, fired via the platform skill primitive.
- Manual-invoke, `orch-`-namespaced, hard dep on compound-engineering.

## Open questions to resolve in plan

- **The ranking heuristic.** "Highest-leverage" is genuinely heuristic and was flagged as
  needing calibration. Candidate signal: lowest slack first (critical-path position), tie-break
  by `unblocks` desc. Is that enough, or do we weight stage/model/cost? Must stay overridable.
- **Single recommendation vs. honest ambiguity.** When two moves tie, recommend one and name
  the runner-up, or ask? Avoid re-introducing the "scan N items" load the skill exists to remove.
- **Staleness interaction.** Reuse `orch-decompose`'s `base_commit`-vs-HEAD staleness warning
  before driving a `work` node — share that logic or duplicate it (skills are self-contained)?

## Rough scope signal

Small once n1 exists — primarily a SKILL.md plus a thin ranking step. The judgment is in the
heuristic and the one-move UX, hence `model: ceiling`.

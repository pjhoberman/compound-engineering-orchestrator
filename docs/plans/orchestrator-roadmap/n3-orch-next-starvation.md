# n3 — orch-next: starvation detection (BRIEF)

- **Stage:** plan · **Model:** generation · **Depends on:** n1, n4
- **Brief** (not a plan): requires cross-invocation history, whose home is the recovery manifest (n4).

## Goal

Detect the scheduler pathology the DAG makes visible but a single re-orient cannot: a node
that has been **ready across many cycles but never picked** (starvation). Surface it so the
human notices a perpetually-skipped task instead of it silently rotting at the frontier.
(Deadlock / cycle detection already lives in `graph_compute.py`; this is the other half.)

## What is already locked (constrains the design)

- n1 already emits the ready set per invocation — starvation is "ready for K consecutive
  observations without transitioning to in-progress."
- Detecting "across cycles" needs durable history between invocations, which is exactly what
  the recovery manifest (n4) persists — hence the dependency. No new persistence mechanism.

## Open questions to resolve in plan

- **Where history lives.** Piggyback on n4's manifest (add a per-node "times seen ready"
  counter), or a separate lightweight log? Depends on n4's chosen durability tier.
- **Threshold K.** How many observations before flagging starvation, and is it count-based or
  time-based? Must be a recommendation, not a hard alarm.
- **Whether this is worth building yet.** The ideation flagged starvation detection as adding
  value "only once enough of the family exists to produce real graphs." Re-confirm priority
  after n2/n4 land — this node may stay parked.

## Rough scope signal

Small, and explicitly low-priority — gated behind n4 and re-evaluated. A candidate to defer.

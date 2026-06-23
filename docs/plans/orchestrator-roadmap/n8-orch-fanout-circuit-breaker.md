# n8 — orch-fanout: circuit breaker (BRIEF)

- **Stage:** plan · **Model:** ceiling · **Depends on:** n7
- **Brief** (not a plan): a safety layer on the executor; its policy is an open design decision.

## Goal

Halt an autonomous batch after K consecutive failures, escalating to the human instead of
burning the whole run on a systematic problem (a bad base commit, a broken test harness, an
environment fault). Standard distributed-systems circuit-breaker prior art applied to the
fan-out loop — the difference between losing one task and losing a ten-task overnight run.

## What is already locked (constrains the design)

- Layers on n7's drain-the-batch loop — it observes per-task outcomes the executor already
  produces and trips when failures cluster.
- Escalation routes to the same consolidated-HITL checkpoint n7 defines; the breaker is a
  policy over the loop, not a parallel control path.

## Open questions to resolve in plan

- **Trip policy.** K consecutive failures, or a failure *rate* over a window? Consecutive is
  simpler and matches the "systematic fault" intuition — confirm.
- **What "failure" counts.** CI red after `/lfg`'s repair attempts? Merge conflict? Sub-agent
  crash? Define the failure signal precisely against n7's outcomes.
- **Recovery after trip.** On trip, halt-and-report only, or offer resume-after-fix using the
  recovery manifest (n5)?

## Rough scope signal

Small once n7's loop and outcome signals exist — a policy wrapper. Fast-follow to n7.

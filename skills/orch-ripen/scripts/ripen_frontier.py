#!/usr/bin/env python3
"""Compute the PLANNING frontier for an orch-decompose task-graph.

Where orch-next's frontier.py computes the *execution* frontier (a node is ready
when its upstream code has MERGED), orch-ripen needs the *planning* frontier: a
plan-stage node is ready to plan when its upstream DECISIONS are settled — every
dependency is either merged (`done`) OR already has an approved plan (`stage`
flipped to `work`). No merged code is required to plan a node; only settled
decisions upstream. This is the load-bearing distinction the whole skill turns on
(see references and task-graph-schema.md's decision-vs-execution dependency note).

Like frontier.py this does no graph parsing or status derivation of its own — it
joins the JSON the orch-decompose scripts already emit, keeping all DAG math there:

    graph_compute.py <project-dir>  -> --graph   (edges + node_meta.stage + per_node slack/critical)
    reorient.py      <project-dir>  -> --status   (derived per-node status)

Usage:
    python3 ripen_frontier.py --graph <graph_compute.json> --status <reorient.json>

Emits, to stdout:
  - `plan_wave`  : plan-stage nodes whose every dependency is satisfied (done OR
                   already flipped to work) — the nodes safe to fan ce-plan over
                   in one parallel wave. Each carries slack/critical (from
                   graph_compute) and `unblocks_planning` (how many further plan
                   nodes become plannable once this node's plan is approved).
  - `brainstorm` : brainstorm-stage frontier nodes. NEVER fanned — they are
                   interview-shaped and interactive. Reported so ripen can hand
                   them to ce-brainstorm; their downstream plan nodes stay blocked
                   until the brainstorm settles (stage moves to plan/work).
  - `blocked`    : plan-stage nodes not yet plannable, each with `blocked_on`
                   naming the unsatisfied dependency and why (an unsettled
                   brainstorm decision vs. a not-yet-planned upstream).
  - `flipped`    : nodes already at stage:work (their plan is authored) — context
                   for the write-back/staleness steps, not work for this wave.
  - `active`, `done`, and counts.

A graph with a cycle yields an empty planning frontier and surfaces the upstream
finding rather than inventing one. Exit 0 on a clean run, 2 on usage error.

Pure Python 3 standard library; pure function of its two JSON inputs (no git),
so the frontier semantics are unit-testable against fixture graphs.
"""
import argparse
import json
import sys

# statuses that mean "already being worked" — eligible for neither wave nor blocked
ACTIVE = {"in-progress", "in-review"}
# stages ripen matures; work nodes are already planned, so they are never wave members
PLANNABLE_STAGES = {"plan", "brainstorm"}


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        # match the sibling scripts' usage-error contract: a bad input file exits 2
        sys.stderr.write(f"ripen_frontier.py: cannot read {path}: {exc}\n")
        sys.exit(2)


def compute_planning_frontier(graph, status):
    edges = graph.get("edges", {})
    per_node = graph.get("per_node", {})
    node_meta = graph.get("node_meta", {})
    ids = sorted(edges.keys())

    # the graph's edge set is the authoritative node universe; a status file that
    # references nodes the graph doesn't know about is a mismatched pair — ignore
    # those nodes but say so, rather than dropping them silently (mirrors frontier.py).
    unknown = sorted(set(status.get("nodes", {}).keys()) - set(ids))
    if unknown:
        sys.stderr.write(
            "ripen_frontier.py: warning: %d status node(s) absent from graph edges, ignored: %s\n"
            % (len(unknown), ", ".join(unknown))
        )

    def status_of(n):
        return status.get("nodes", {}).get(n, {}).get("status", "not-started")

    def stage_of(n):
        return node_meta.get(n, {}).get("stage")

    done = {n for n in ids if status_of(n) == "done"}

    # A dependency's DECISION is settled when the upstream node is either merged
    # (`done`) or already has an approved plan (`stage:work`). This is the planning
    # readiness predicate — deliberately weaker than execution readiness (merged only).
    def satisfied(d):
        return d in done or stage_of(d) == "work"

    # a cycle means there is no well-formed frontier — surface it, don't invent one
    cycle = next((f for f in graph.get("findings", []) if f.get("kind") == "cycle"), None)
    if cycle:
        # keep the same bucket exclusivity and output shape as the happy path: a done node
        # is never also "flipped", and `counts` is always present so a consumer can read
        # result["counts"] without first branching on `cycle`.
        flipped = sorted(n for n in ids if stage_of(n) == "work" and n not in done)
        return {
            "plan_wave": [],
            "brainstorm": [],
            "blocked": [],
            "flipped": flipped,
            "active": sorted(n for n in ids if status_of(n) in ACTIVE),
            "done": sorted(done),
            "cycle": True,
            "note": cycle.get("detail", "dependency cycle — no planning frontier"),
            "counts": {"plan_wave": 0, "brainstorm": 0, "blocked": 0, "flipped": len(flipped)},
        }

    def unsatisfied_deps(n):
        return [d for d in edges.get(n, []) if not satisfied(d)]

    def blocker_reason(d):
        # why this dependency is not yet a settled decision
        if stage_of(d) == "brainstorm":
            return "brainstorm not settled — needs an interactive session first"
        return "plan not yet authored/approved (stage not flipped to work)"

    def unblocks_planning(n):
        # count nodes that would themselves become plan-wave members once n's plan is
        # approved — i.e. the planning analogue of frontier.py's `unblocks`. Restricted to
        # plan-stage nodes that are actually wave-eligible: a brainstorm successor never
        # enters a plan wave (it is reported for an interactive session), and a downstream
        # node that is done, active, or human-blocked can never be unblocked by approving n,
        # so counting any of those would overstate the wave the Phase 3 preview shows.
        count = 0
        for m in ids:
            if stage_of(m) != "plan":
                continue
            if status_of(m) == "done" or status_of(m) in ACTIVE or status_of(m) == "blocked":
                continue
            if n in edges.get(m, []) and unsatisfied_deps(m) == [n]:
                count += 1
        return count

    plan_wave, brainstorm, blocked = [], [], []
    flipped, active_ids, unknown_stage = [], [], []

    for n in ids:
        st = status_of(n)
        stage = stage_of(n)
        if st == "done":
            continue
        if st == "blocked":
            # a human-pinned block is terminal — checked before the stage buckets so a node
            # pinned blocked at ANY stage (including a flipped work node the human parked) is
            # surfaced as blocked, never silently mislabeled as flipped/plannable.
            blocked.append({"id": n, "stage": stage,
                            "blocked_on": [{"id": None, "reason": "manual_status: blocked (human pin)"}]})
            continue
        if stage == "work":
            # already planned — context for write-back/staleness, not a wave member
            flipped.append(n)
            continue
        if st in ACTIVE:
            active_ids.append(n)
            continue
        if stage not in PLANNABLE_STAGES:
            # A node absent from node_meta (stage None) or carrying an empty/unrecognized
            # stage falls out of every bucket. graph_compute only flags a *non-empty*
            # out-of-vocabulary stage (invalid_stage), so a missing/empty stage would vanish
            # here with no diagnostic — warn to stderr for parity with the unknown-status
            # mismatch above rather than dropping it silently.
            unknown_stage.append(n)
            continue

        unmet = unsatisfied_deps(n)
        if unmet:
            entry = {"id": n, "stage": stage,
                     "blocked_on": [{"id": d, "reason": blocker_reason(d)} for d in unmet]}
            blocked.append(entry)
        elif stage == "brainstorm":
            # ready to start, but NEVER fanned — reported for an interactive ce-brainstorm
            brainstorm.append({"id": n})
        else:  # plan-stage, all decisions upstream settled -> fan ce-plan
            plan_wave.append({
                "id": n,
                "slack": per_node.get(n, {}).get("slack"),
                "critical": per_node.get(n, {}).get("critical"),
                "unblocks_planning": unblocks_planning(n),
            })

    if unknown_stage:
        sys.stderr.write(
            "ripen_frontier.py: warning: %d node(s) absent from graph node_meta or with an "
            "empty/unrecognized stage, dropped from the frontier: %s\n"
            % (len(unknown_stage), ", ".join(sorted(unknown_stage)))
        )

    return {
        "plan_wave": sorted(plan_wave, key=lambda r: r["id"]),
        "brainstorm": sorted(brainstorm, key=lambda r: r["id"]),
        # every blocked entry's own id is a real node id (never None — the nullable id lives
        # nested in blocked_on for the manual-pin case), so a plain id sort is correct.
        "blocked": sorted(blocked, key=lambda r: r["id"]),
        "flipped": sorted(flipped),
        "active": sorted(active_ids),
        "done": sorted(done),
        "cycle": False,
        "counts": {
            "plan_wave": len(plan_wave),
            "brainstorm": len(brainstorm),
            "blocked": len(blocked),
            "flipped": len(flipped),
        },
    }


def main(argv):
    parser = argparse.ArgumentParser(description="Compute the planning frontier of a task-graph.")
    parser.add_argument("--graph", required=True, help="graph_compute.py JSON output")
    parser.add_argument("--status", required=True, help="reorient.py JSON output")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error
    result = compute_planning_frontier(load(args.graph), load(args.status))
    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

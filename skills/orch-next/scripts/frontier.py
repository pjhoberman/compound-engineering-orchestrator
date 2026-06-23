#!/usr/bin/env python3
"""Compute the dependency ready-frontier for an orch-decompose task-graph.

This script does no graph parsing or status derivation of its own — it joins and
partitions the JSON the orch-decompose scripts already emit, keeping all DAG math
in one place:

    graph_compute.py <project-dir>  -> --graph   (edges + per-node slack/critical)
    reorient.py      <project-dir>  -> --status   (derived per-node status)

Usage:
    python3 frontier.py --graph <graph_compute.json> --status <reorient.json>

Emits, to stdout: the `ready` frontier (every node whose dependencies are all
`done` and which is not itself started), each ready node's `slack` and `critical`
(from graph_compute) and `unblocks` (how many nodes become ready once it
completes); the `blocked` set with each node's unsatisfied deps; and the `active`
and `done` sets. A graph with a cycle yields an empty frontier and surfaces the
upstream finding rather than inventing one. Exit 0 on a clean run, 2 on usage error.
"""
import argparse
import json
import sys

# statuses that mean "already being worked" — eligible for neither ready nor blocked
ACTIVE = {"in-progress", "in-review"}


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def compute_frontier(graph, status):
    edges = graph.get("edges", {})
    per_node = graph.get("per_node", {})
    ids = sorted(edges.keys())

    def status_of(n):
        return status.get("nodes", {}).get(n, {}).get("status", "not-started")

    done = {n for n in ids if status_of(n) == "done"}

    # a cycle means there is no well-formed frontier — surface it, don't invent one
    cycle = next((f for f in graph.get("findings", []) if f.get("kind") == "cycle"), None)
    if cycle:
        return {
            "ready": [],
            "active": sorted(n for n in ids if status_of(n) in ACTIVE),
            "blocked": [],
            "done": sorted(done),
            "cycle": True,
            "note": cycle.get("detail", "dependency cycle — no ready frontier"),
        }

    ready_ids, active_ids, blocked_ids = [], [], []
    for n in ids:
        st = status_of(n)
        if st == "done":
            continue
        if st in ACTIVE:
            active_ids.append(n)
        elif all(d in done for d in edges.get(n, [])):
            ready_ids.append(n)
        else:
            blocked_ids.append(n)

    def unblocks(n):
        # count nodes whose ONLY remaining unsatisfied dependency is n
        return sum(
            1
            for m in ids
            if n in edges.get(m, [])
            and [d for d in edges[m] if d not in done] == [n]
        )

    ready = [
        {
            "id": n,
            "slack": per_node.get(n, {}).get("slack"),
            "critical": per_node.get(n, {}).get("critical"),
            "unblocks": unblocks(n),
        }
        for n in sorted(ready_ids)
    ]
    blocked = [
        {"id": n, "blocked_on": sorted(d for d in edges.get(n, []) if d not in done)}
        for n in sorted(blocked_ids)
    ]
    return {
        "ready": ready,
        "active": sorted(active_ids),
        "blocked": blocked,
        "done": sorted(done),
        "cycle": False,
    }


def main(argv):
    parser = argparse.ArgumentParser(description="Compute the ready-frontier of a task-graph.")
    parser.add_argument("--graph", required=True, help="graph_compute.py JSON output")
    parser.add_argument("--status", required=True, help="reorient.py JSON output")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error
    result = compute_frontier(load(args.graph), load(args.status))
    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

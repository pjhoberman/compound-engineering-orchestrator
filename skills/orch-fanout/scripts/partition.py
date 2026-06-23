#!/usr/bin/env python3
"""Partition the ready frontier into collision-free parallel batches for orch-fanout.

Given the ready frontier and each ready node's file footprint, group nodes into batches that
can run in parallel worktrees without stepping on each other: no two nodes in a batch touch
the same file. Batches are bounded by --max-batch (the ~5-7 fan-out crossover beyond which
delegation stops paying off). This lifts ce-work's intra-feature file-collision check to
cross-ticket scope; it does no parsing of its own — it consumes the JSON that graph_compute
(node_meta: stage + files) and frontier (the ready set + slack/unblocks) already emit.

Usage:
    python3 partition.py --graph <graph_compute.json> --frontier <frontier.json> [--max-batch N]

Only `work`-stage ready nodes are fan-out eligible — they carry a parseable Files footprint.
A `plan`/`brainstorm` ready node has no known footprint and is reported in `excluded` (handle
it sequentially / by hand), never silently dropped. Emits batches (ordered by critical-path
leverage), the excluded set with reasons, and counts. Exit 0, 2 on usage error.
"""
import argparse
import json
import os
import sys

DEFAULT_MAX_BATCH = 5


def fail(msg):
    sys.stderr.write(f"partition.py: {msg}\n")
    sys.exit(2)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {path}: {exc}")


def partition(graph, frontier, max_batch):
    if "node_meta" not in graph:
        # graph_compute predating the node_meta field would silently yield 0 eligible —
        # surface the stale input instead of partitioning into nothing.
        fail("graph JSON has no 'node_meta' — re-run graph_compute.py")
    node_meta = graph["node_meta"]
    ready = frontier.get("ready", [])

    # rank by critical-path leverage: lowest slack first, then most unblocks, then id —
    # the same ordering orch-next recommends, so the earliest batch is the highest-leverage.
    ranked = sorted(
        ready,
        key=lambda r: (
            r.get("slack") if r.get("slack") is not None else float("inf"),
            -r.get("unblocks", 0),
            r["id"],
        ),
    )

    eligible = []   # (id, frozenset(paths))
    excluded = []
    for r in ranked:
        nid = r["id"]
        if nid not in node_meta:
            # a ready node the graph doesn't know about means a stale graph/frontier pair —
            # say so explicitly rather than blaming a None stage.
            excluded.append({
                "id": nid,
                "reason": "absent from graph node_meta — stale graph/frontier pair; re-run graph_compute.py",
            })
            continue
        meta = node_meta[nid]
        stage = meta.get("stage")
        if stage != "work":
            excluded.append({
                "id": nid,
                "reason": f"stage {stage!r} is not fan-out eligible (no file footprint) — drive it directly",
            })
            continue
        if meta.get("no_pr"):
            # a no_pr node is a manual-completion ops step that produces no PR — driving it
            # via /lfg would be wrong, so it is never fanned out.
            excluded.append({
                "id": nid,
                "reason": "no_pr ops node — requires manual completion, not fan-out",
            })
            continue
        # normalize paths before the collision check: 'a.py', './a.py', and 'dir/../a.py' are
        # the same file, and treating them as distinct would co-batch two nodes that edit it —
        # the exact merge corruption the collision-free invariant exists to prevent. (Absolute
        # paths are out of contract per the embedded-unit schema — repo-relative only.)
        paths = frozenset(
            os.path.normpath(f[0])
            for f in meta.get("files", [])
            if isinstance(f, (list, tuple)) and f
        )
        eligible.append((nid, paths))

    # greedy first-fit packing: a node joins the first batch it doesn't collide with and that
    # has room; otherwise it opens a new batch. Deterministic given the ranked order.
    batches = []          # list of {"ids": [...], "paths": set()}
    for nid, paths in eligible:
        placed = False
        for b in batches:
            if len(b["ids"]) < max_batch and paths.isdisjoint(b["paths"]):
                b["ids"].append(nid)
                b["paths"] |= paths
                placed = True
                break
        if not placed:
            batches.append({"ids": [nid], "paths": set(paths)})

    return {
        "max_batch": max_batch,
        "batches": [b["ids"] for b in batches],
        "excluded": excluded,
        "eligible_count": len(eligible),
        "batch_count": len(batches),
    }


def main(argv):
    parser = argparse.ArgumentParser(description="Partition the ready frontier into parallel batches.")
    parser.add_argument("--graph", required=True, help="graph_compute.py JSON (node_meta)")
    parser.add_argument("--frontier", required=True, help="frontier.py JSON (ready set)")
    parser.add_argument("--max-batch", type=int, default=DEFAULT_MAX_BATCH,
                        help=f"max nodes per parallel batch (default {DEFAULT_MAX_BATCH})")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error
    if args.max_batch < 1:
        fail("--max-batch must be >= 1")

    result = partition(load(args.graph), load(args.frontier), args.max_batch)
    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

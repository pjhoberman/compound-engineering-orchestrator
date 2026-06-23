#!/usr/bin/env python3
"""Sequence orch-fanout batches into runtime-safe waves.

The partitioner (n6) produces file-collision-free batches. This step layers the runtime
concern on top (n7 owns it, not n6): within each batch, nodes that need exclusive runtime
(`exclusive_runtime` in node_meta) are pulled out into their own SOLO waves so they never run
concurrent with anything; the rest stay together as one parallel wave. It does no parsing of
its own — it consumes the JSON that partition.py and graph_compute (node_meta) already emit.

Usage:
    python3 wave_plan.py --partition <partition.json> --graph <graph_compute.json>

Emits, to stdout, an ordered `waves` list — each wave is either
`{"kind": "parallel", "ids": [...]}` (file-disjoint AND runtime-independent, run together) or
`{"kind": "solo", "id": "nX", "reason": "exclusive_runtime"}` (run alone) — plus `wave_count`.
The invariant: at most one exclusive-runtime node in flight, and every parallel wave is both
file-disjoint (from partition) and runtime-independent. Exit 0, 2 on usage error.
"""
import argparse
import json
import sys


def fail(msg):
    sys.stderr.write(f"wave_plan.py: {msg}\n")
    sys.exit(2)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {path}: {exc}")


def plan_waves(partition, graph):
    node_meta = graph.get("node_meta")
    if not isinstance(node_meta, dict):
        fail("graph JSON has no 'node_meta' dict — re-run graph_compute.py")

    def is_exclusive(nid):
        if nid not in node_meta:
            # partition only batches nodes the graph knows about; a batched id absent from
            # node_meta is a stale graph/partition pair — fail rather than silently treating
            # an unknown node as parallel-safe (the unsafe direction for the no-co-schedule invariant).
            fail(f"batched node {nid} is absent from graph node_meta — stale graph/partition pair")
        return str(node_meta[nid].get("exclusive_runtime", "")).lower() == "true"

    waves = []
    for batch in partition.get("batches", []):
        parallel = [nid for nid in batch if not is_exclusive(nid)]
        solo = sorted(nid for nid in batch if is_exclusive(nid))
        # the file-disjoint, runtime-independent remainder runs together as one wave
        if parallel:
            waves.append({"kind": "parallel", "ids": parallel})
        # each exclusive node is its own wave — never concurrent with anything
        for nid in solo:
            waves.append({"kind": "solo", "id": nid, "reason": "exclusive_runtime"})

    return {"waves": waves, "wave_count": len(waves)}


def main(argv):
    parser = argparse.ArgumentParser(description="Sequence partition batches into runtime-safe waves.")
    parser.add_argument("--partition", required=True, help="partition.py JSON (batches)")
    parser.add_argument("--graph", required=True, help="graph_compute.py JSON (node_meta)")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error

    result = plan_waves(load(args.partition), load(args.graph))
    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

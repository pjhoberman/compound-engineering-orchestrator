#!/usr/bin/env python3
"""Write an orch-fanout recovery manifest atomically.

The manifest is a durable checkpoint of an in-flight fan-out run so that a dead or
context-compacted session can recover by reading it (reconciled against live git by the
reconciler, roadmap n5) instead of hunting across orphaned worktrees. It is volatile
run-state — gitignored under `.orch/`, never committed. See
`references/recovery-manifest-schema.md` for the full contract.

Usage:
    python3 manifest.py --out <path> --state <state.json|->

Reads a run-state JSON (a path, or `-` for stdin), validates and normalizes it (tasks
sorted by id, stable key order, `updated_at` stamped if absent), writes it atomically to
<path> (temp file + os.replace), and echoes the normalized manifest to stdout. Exit 0 on
success, 2 on usage or validation error.
"""
import argparse
import datetime
import json
import os
import sys

SCHEMA_VERSION = 1
REQUIRED_TOP = ("schema_version", "project", "run_id", "base_commit", "wave", "tasks")
TASK_STATUSES = {"in-progress", "in-review", "done", "failed", "abandoned"}


def fail(msg):
    sys.stderr.write(f"manifest.py: {msg}\n")
    sys.exit(2)


def load(path):
    try:
        if path == "-":
            return json.load(sys.stdin)
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read state {path}: {exc}")


def now_iso():
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def normalize(state):
    for key in REQUIRED_TOP:
        if key not in state:
            fail(f"state missing required field '{key}'")
    if not isinstance(state["tasks"], list):
        fail("'tasks' must be an array")

    tasks = []
    for raw in state["tasks"]:
        if "id" not in raw:
            fail("every task needs an 'id'")
        status = raw.get("status")
        if status not in TASK_STATUSES:
            fail(f"task {raw['id']} has status {status!r} (expected one of {sorted(TASK_STATUSES)})")
        tasks.append({
            "id": raw["id"],
            "status": status,
            "worktree": raw.get("worktree"),
            "branch": raw.get("branch"),
            "pr": raw.get("pr"),
            "last_clean_merge": raw.get("last_clean_merge"),
        })
    tasks.sort(key=lambda t: t["id"])

    return {
        "schema_version": state.get("schema_version", SCHEMA_VERSION),
        "project": state["project"],
        "run_id": state["run_id"],
        "base_commit": state["base_commit"],
        "wave": state["wave"],
        "updated_at": state.get("updated_at") or now_iso(),
        "tasks": tasks,
    }


def write_atomic(path, payload):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(payload)
    os.replace(tmp, path)  # atomic on POSIX — a crash mid-write leaves the old manifest intact


def main(argv):
    parser = argparse.ArgumentParser(description="Write an orch-fanout recovery manifest.")
    parser.add_argument("--out", required=True, help="manifest output path (.orch/<slug>/recovery.json)")
    parser.add_argument("--state", required=True, help="run-state JSON path, or - for stdin")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error

    manifest = normalize(load(args.state))
    text = json.dumps(manifest, indent=2) + "\n"
    write_atomic(args.out, text)
    sys.stdout.write(text)
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

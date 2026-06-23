#!/usr/bin/env python3
"""Reconcile an orch-fanout recovery manifest against live git/gh — the resume read.

When a fan-out session dies or its context compacts mid-run, recovery is a read: load the
manifest (roadmap n4) and reconcile each in-flight task against reality. Git is
authoritative; the manifest is a hint. A manifest that says "PR open" when the PR merged,
or "in-progress" when the worktree is gone, is corrected here rather than trusted blindly.

Usage:
    python3 reconcile.py --manifest <recovery.json>            # gather facts from git + gh
    python3 reconcile.py --manifest <recovery.json> --facts <facts.json>   # inject facts (tests)

Emits, to stdout, a resume report: per task the manifest status, the reconciled status, and
the concrete next action; plus a `resume` list of task ids that need action to continue.
The pure state machine (reconcile_task) is exercised by --facts; real-mode git/gh gathering
is verified manually (no live-git CI harness — mirrors reorient.py). Exit 0, 2 on usage error.
"""
import argparse
import json
import subprocess
import sys


def fail(msg):
    sys.stderr.write(f"reconcile.py: {msg}\n")
    sys.exit(2)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {path}: {exc}")


def reconcile_task(manifest_status, facts):
    """Pure state machine: (manifest status, live facts) -> (reconciled status, action).

    facts keys (all optional, default falsy/None):
      worktree_exists: bool   branch_exists: bool
      branch_merged: bool     pr_state: "open"|"merged"|"closed"|None
    """
    wt = facts.get("worktree_exists", False)
    pr = facts.get("pr_state")
    merged = facts.get("branch_merged", False) or pr == "merged"

    # git is authoritative: a merged branch/PR is done no matter what the manifest claimed
    if merged:
        return "done", "merged — nothing to resume"
    if manifest_status == "done":
        return "done", "complete"
    if manifest_status == "failed":
        return "failed", "needs attention — last run failed"
    if manifest_status == "abandoned":
        return "abandoned", "explicitly abandoned — skip"
    if pr == "open":
        return "in-review", "awaiting review (PR open)"
    if not wt:
        return "interrupted", "worktree missing — re-dispatch from base_commit"
    return "in-progress", "resume in worktree"


def gather_facts_live(task, base_commit):
    """Real mode: derive a task's facts from git/gh. Manually verified (no CI harness)."""
    import os

    worktree = task.get("worktree")
    branch = task.get("branch")
    pr = task.get("pr") or {}

    wt_exists = bool(worktree) and os.path.isdir(worktree)

    branch_exists = False
    branch_merged = False
    if branch:
        branch_exists = _run(["git", "rev-parse", "--verify", "--quiet", branch]) is not None
        if branch_exists and base_commit:
            # merged iff the branch tip is an ancestor of the base
            branch_merged = _run(["git", "merge-base", "--is-ancestor", branch, base_commit], check_only=True)

    pr_state = None
    if pr.get("number") is not None:
        out = _run(["gh", "pr", "view", str(pr["number"]), "--json", "state", "-q", ".state"])
        if out:
            pr_state = out.strip().lower()  # OPEN/MERGED/CLOSED -> open/merged/closed

    return {
        "worktree_exists": wt_exists,
        "branch_exists": branch_exists,
        "branch_merged": branch_merged,
        "pr_state": pr_state,
    }


def _run(cmd, check_only=False):
    try:
        res = subprocess.run(cmd, capture_output=True, text=True)
    except (OSError, ValueError):
        return False if check_only else None
    if check_only:
        return res.returncode == 0
    return res.stdout if res.returncode == 0 else None


def main(argv):
    parser = argparse.ArgumentParser(description="Reconcile a recovery manifest against git/gh.")
    parser.add_argument("--manifest", required=True, help="recovery manifest JSON path")
    parser.add_argument("--facts", help="inject per-task facts JSON (keyed by id) for tests")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error

    manifest = load(args.manifest)
    facts_by_id = load(args.facts) if args.facts else None
    base_commit = manifest.get("base_commit")

    out_tasks = []
    resume = []
    for task in manifest.get("tasks", []):
        tid = task.get("id")
        if facts_by_id is not None:
            facts = facts_by_id.get(tid, {})
        else:
            facts = gather_facts_live(task, base_commit)
        status, action = reconcile_task(task.get("status"), facts)
        out_tasks.append({
            "id": tid,
            "manifest_status": task.get("status"),
            "reconciled_status": status,
            "action": action,
            "worktree": task.get("worktree"),
            "branch": task.get("branch"),
        })
        if status in ("in-progress", "interrupted", "in-review", "failed"):
            resume.append(tid)

    out_tasks.sort(key=lambda t: t["id"])
    report = {
        "project": manifest.get("project"),
        "run_id": manifest.get("run_id"),
        "base_commit": base_commit,
        "wave": manifest.get("wave"),
        "tasks": out_tasks,
        "resume": sorted(resume),
    }
    print(json.dumps(report, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

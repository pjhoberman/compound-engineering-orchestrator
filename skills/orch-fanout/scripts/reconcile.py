#!/usr/bin/env python3
"""Reconcile an orch-fanout recovery manifest against live git/gh — the resume read.

When a fan-out session dies or its context compacts mid-run, recovery is a read: load the
manifest (roadmap n4) and reconcile each in-flight task against reality. Git is
authoritative for in-flight work; the manifest is a hint. A manifest that says "PR open"
when the PR merged, or "in-progress" when the worktree is gone, is corrected here rather
than trusted blindly. Terminal manifest states the human recorded deliberately
(`done` / `failed` / `abandoned`) are NOT overridden by a git-derived merge.

Usage:
    python3 reconcile.py --manifest <recovery.json>            # gather facts from git + gh
    python3 reconcile.py --manifest <recovery.json> --facts <facts.json>   # inject facts (tests)

Emits, to stdout, a resume report: per task the manifest status, the reconciled status
(one of `done`, `in-review`, `in-progress`, `interrupted`, `failed`, `abandoned`), and the
concrete next action; plus a `resume` list of task ids needing action. The pure state
machine (reconcile_task) is exercised by --facts; real-mode git/gh gathering is verified
manually (no live-git CI harness — mirrors reorient.py). Exit 0, 2 on usage error.
"""
import argparse
import json
import os
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
      worktree_exists: bool   branch_merged: bool   pr_state: "open"|"merged"|"closed"|None
    """
    wt = facts.get("worktree_exists", False)
    pr = facts.get("pr_state")
    merged = facts.get("branch_merged", False) or pr == "merged"

    # Terminal manifest states are deliberate records — a git-derived merge never overrides
    # them (mirrors the "manual status pin is authoritative and terminal" principle).
    if manifest_status == "done":
        return "done", "complete"
    if manifest_status == "abandoned":
        return "abandoned", "explicitly abandoned — skip"
    if manifest_status == "failed":
        return "failed", "needs attention — last run failed"

    # For in-flight states, git is authoritative.
    if merged:
        return "done", "merged — nothing to resume"
    if pr == "open":
        return "in-review", "awaiting review (PR open)"
    if not wt:
        return "interrupted", "worktree missing — re-dispatch from base_commit"
    return "in-progress", "resume in worktree"


def _run(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=30)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, "", "command-unavailable"


def _flaggish(value):
    # A ref/value git could misread as an option — refuse to pass it (argument injection).
    return isinstance(value, str) and value.startswith("-")


def resolve_base_branch():
    # Remote-tracking ref (e.g. origin/main), not a bare local name, so ancestry checks work
    # without a local default branch checked out and never compare against a stale local main.
    rc, out, _ = _run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"])
    if rc == 0 and out:
        return out.replace("refs/remotes/", "", 1)  # refs/remotes/origin/main -> origin/main
    rc, out, _ = _run(["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])
    if rc == 0 and out:
        return f"origin/{out}"
    return "origin/main"


def gather_facts_live(task, base_commit, base_ref):
    """Real mode: derive a task's facts from git/gh. Never raises; verified manually."""
    worktree = task.get("worktree")
    branch = task.get("branch")
    pr = task.get("pr") or {}

    wt_exists = bool(worktree) and os.path.isdir(worktree)

    # A branch is "merged" iff its tip is an ancestor of the CURRENT base head AND it carried
    # real work (commits beyond the frozen dispatch base). The commits-ahead guard stops an
    # empty / never-advanced branch — which sits at base_commit, an ancestor of the advanced
    # base — from false-reporting as merged (and silently dropping a real task from resume).
    branch_merged = False
    if branch and not _flaggish(branch):
        rc_anc, _, _ = _run(["git", "merge-base", "--is-ancestor", branch, base_ref])
        is_ancestor = rc_anc == 0
        commits_ahead = 0
        if base_commit and not _flaggish(base_commit):
            rc_cnt, out_cnt, _ = _run(["git", "rev-list", "--count", f"{base_commit}..{branch}"])
            if rc_cnt == 0 and out_cnt.isdigit():
                commits_ahead = int(out_cnt)
        branch_merged = is_ancestor and commits_ahead > 0

    pr_state = None
    number = pr.get("number")
    if isinstance(number, bool):
        number = None  # guard: bool is an int subclass
    if isinstance(number, int) or (isinstance(number, str) and number.isdigit()):
        rc, out, _ = _run(["gh", "pr", "view", str(int(number)), "--json", "state", "-q", ".state"])
        if rc == 0 and out:
            pr_state = out.lower()  # OPEN/MERGED/CLOSED -> open/merged/closed

    return {"worktree_exists": wt_exists, "branch_merged": branch_merged, "pr_state": pr_state}


def main(argv):
    parser = argparse.ArgumentParser(description="Reconcile a recovery manifest against git/gh.")
    parser.add_argument("--manifest", required=True, help="recovery manifest JSON path")
    parser.add_argument("--facts", help="inject per-task facts JSON (keyed by id) for tests")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error

    manifest = load(args.manifest)
    facts_by_id = load(args.facts) if args.facts else None
    base_commit = manifest.get("base_commit")
    base_ref = resolve_base_branch() if facts_by_id is None else None

    out_tasks = []
    resume = []
    for task in manifest.get("tasks", []):
        tid = task.get("id")
        if facts_by_id is not None:
            facts = facts_by_id.get(tid, {})
        else:
            facts = gather_facts_live(task, base_commit, base_ref)
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

    out_tasks.sort(key=lambda t: (t["id"] is None, t["id"]))
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

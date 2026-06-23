# Recovery Manifest Schema

The recovery manifest is a durable checkpoint of an in-flight `orch-fanout` run. It exists
so that if a session dies or its context compacts mid-run, recovery becomes a **read**
(reconcile the manifest against live git — see `scripts/reconcile.py`, roadmap n5) rather
than a manual hunt across orphaned worktrees and branches.

## Volatile, not structural — and never committed

The task-graph (`docs/plans/<project>/`) owns durable **structure** and is committed. The
recovery manifest owns volatile **run-state** and is **gitignored** (`.orch/`). Committing
run-state would pollute history and conflict across machines. Git remains authoritative;
the manifest is a *hint* the reconciler corrects against reality on read (a worktree that's
gone, a PR that merged). It is written by `scripts/manifest.py` (roadmap n4) and read by
the reconciler (roadmap n5).

## Location

```
.orch/<project-slug>/recovery.json
```

One manifest per project (a fan-out run targets one project's graph). `<project-slug>`
matches the `docs/plans/<project-slug>/` directory. `.orch/` is gitignored.

## Atomicity

The writer writes to a temp file in the destination directory and `os.replace()`s it into
place, so a crash mid-write leaves the previous manifest intact rather than a truncated file.

## Format

```json
{
  "schema_version": 1,
  "project": "orchestrator-roadmap",
  "run_id": "20260623-140000-ab12",
  "base_commit": "a95f5f5",
  "wave": 2,
  "updated_at": "2026-06-23T14:05:00Z",
  "tasks": [
    {
      "id": "n7",
      "status": "in-progress",
      "worktree": "/abs/path/to/worktree-n7",
      "branch": "n7/fanout-executor",
      "pr": { "open": true, "number": 12, "url": "https://github.com/.../pull/12" },
      "last_clean_merge": null
    }
  ]
}
```

### Field contract

| Field | Required | Notes |
|-------|----------|-------|
| `schema_version` | yes | Integer; bump on incompatible shape changes. |
| `project` | yes | Project slug (matches `docs/plans/<slug>/`). |
| `run_id` | yes | Stable id for the fan-out run. |
| `base_commit` | yes | HEAD the wave was dispatched from — the reconciler compares against current HEAD. |
| `wave` | yes | Integer wave index; the manifest is rewritten at every wave boundary. |
| `updated_at` | yes | ISO-8601 UTC. Caller may supply it (deterministic tests); otherwise the writer stamps now. |
| `tasks` | yes | Array of in-flight task records, **sorted by `id`** by the writer. |

### Per-task record

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Node id from the task-graph (`n7`). |
| `status` | yes | One of `in-progress`, `in-review`, `done`, `failed`, `abandoned`. |
| `worktree` | yes | Absolute path to the node's worktree (or `null` if not yet created). |
| `branch` | yes | Branch name for the node's work (or `null`). |
| `pr` | no | `{open, number, url}` when a PR exists; `null` / omitted otherwise. |
| `last_clean_merge` | no | Commit SHA of the last successful dependency-order merge; `null` otherwise. |

## Determinism

`manifest.py` sorts `tasks` by `id` and emits stable key order, so an unchanged run-state
produces a byte-identical manifest. This keeps the reconciler's diffing and any review of a
checked-in fixture stable.

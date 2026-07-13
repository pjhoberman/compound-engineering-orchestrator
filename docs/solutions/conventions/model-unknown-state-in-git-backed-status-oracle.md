---
title: Model an explicit "unknown" state in a git/gh-backed status oracle — tool failure must never read as a negative verdict
date: 2026-07-13
category: conventions
module: orch-ripen
problem_type: convention
component: tooling
severity: high
applies_when:
  - "Writing a script that derives a status or verdict by shelling out to git or gh"
  - "A reorient / reconcile / staleness-style oracle returns a yes-or-no judgment per item"
  - "A failed or unavailable tool call is indistinguishable in the code from a legitimate negative result"
tags: [status-oracle, git, gh, error-handling, false-negative, staleness, reliability]
---

# Model an explicit "unknown" state in a git/gh-backed status oracle — tool failure must never read as a negative verdict

## Context

`orch-ripen`'s `staleness.py` flags work-stage nodes whose embedded plan may be stale — a node is
stale when a dependency has merged since the plan's `base_commit` was stamped. The real-mode
gatherer answers two questions by shelling out: *is this dependency merged?* (`gh`) and *is its
merge commit already contained in my base_commit?* (`git merge-base --is-ancestor`).

The first draft collapsed both questions to a plain boolean. `gh` failing — missing, unauthenticated,
rate-limited, offline, or timed out — returned the same "no merge commit" as a successful lookup
that found the PR genuinely isn't merged. `git merge-base` exiting non-zero for a *missing object*
(a shallow CI clone that never fetched the commit) read identically to a genuine "not an ancestor."
Because the verdict only fires staleness when a dependency is known-merged, a total `gh` outage
produced `"stale": []` — a clean bill of health that actually meant *"we couldn't check anything."*
For a tool whose entire job is surfacing staleness before drive time, a silent false-clean is the
worst possible failure: nothing downstream suspects the check never ran.

## Guidance

A status oracle that derives its answer from an external tool must model **three** outcomes, not
two: *yes*, *no*, and *unknown (couldn't determine)*. Never let a command failure fold into the
negative branch.

Concretely, in the same shape as `staleness.py`:

- **Return a lookup-success signal alongside the value.** `_merge_commit_for` returns
  `(merge_commit_or_None, lookup_ok)`. `lookup_ok` is `False` only when a `gh` call itself failed —
  deliberately distinct from a successful lookup that found the PR simply isn't merged
  (`(None, True)`).
- **Distinguish the tool's error exit from its meaningful exits.** `git merge-base --is-ancestor`
  returns 0 (ancestor), 1 (not an ancestor), or ~128 (object missing / bad rev). Map only 0 and 1 to
  a verdict; treat everything else — and the `_run` timeout/OS-error sentinel — as *unknown*:

  ```python
  rc, _, err = _run(["git", "merge-base", "--is-ancestor", merge_commit, base])
  if rc == 0:
      merge_in_base = True
  elif rc == 1 and err != "command-unavailable":
      merge_in_base = False          # genuine "not an ancestor"
  else:
      verifiable = False             # 128 / sentinel -> ancestry UNKNOWN, not "no"
  ```

- **Exclude unknowns from the verdict, don't guess them.** A merged dependency whose ancestry
  couldn't be checked is dropped from `stale_on` (so it isn't falsely flagged stale) and added to an
  `unverifiable` list on the node instead.
- **Propagate the uncertainty to the top-level output.** Emit a run-level `incomplete: true` whenever
  any node's verdict rested on an unverifiable lookup, so a consumer reading the JSON sees "this run
  couldn't check everything," never a false all-clear.

The **pure** half (`derive_staleness`) stays a function of injected facts, so every branch — including
the new unknown path — is unit-testable via `--facts` with no git required. This is the return-contract
companion to [split-pure-state-machine-from-live-git-io](./split-pure-state-machine-from-live-git-io.md):
that learning is about *keeping the live half thin and testable*; this one is about *what the live half
is allowed to return* when a command fails.

## Why This Matters

The failure is silent and asymmetric. A crash would be noticed; a confident wrong "all clear" is
trusted and acted on. Conflating "couldn't determine" with "determined negative" inverts the tool's
purpose — an environment problem (no `gh` auth, a shallow clone) masquerades as good news precisely
when the operator has the least reason to double-check. The tri-state is also directionally safe: the
shallow-clone case (a real object read as "not an ancestor") pushes toward a *false positive* (spurious
staleness noise), while the `gh`-outage case pushes toward a *false negative* (missed staleness) —
different directions, same root cause, both fixed by refusing to emit a verdict the tool didn't
actually support. This mirrors the org principle that a tool hitting an unexpected state should surface
it, not paper over it.

## When to Apply

- Any script that decides a per-item status/verdict from `git`, `gh`, or another external command
  whose non-zero exit can mean either "the answer is no" or "the call failed."
- When mirroring `reorient.py` / `reconcile.py` / `staleness.py`: keep the yes/no/unknown tri-state and
  surface an `incomplete`/degraded signal at the top level.
- During review of a status oracle: ask "if the tool is missing or the clone is shallow, does this
  return a *wrong* answer or an *honest* unknown?" A boolean return is the smell.

## Examples

**Before — a `gh` outage reads as "all fresh":**

```python
def _merge_commit_for(dep_node):
    ...
    rc, out, _ = _run(["gh", "pr", "view", num, ...])
    if rc == 0 and out:          # rc != 0 (auth/offline/timeout) silently -> None
        ...
    return candidates[0] if candidates else None

# gather: merged = merge_commit is not None   -> outage looks exactly like "not merged"
# derive: only flags when merged -> stale == [] on a total outage. False clean bill.
```

**After — the outage is surfaced, not swallowed:**

```python
merge_commit, lookup_ok = _merge_commit_for(dep_node)   # (None, False) on gh failure
merged = merge_commit is not None
verifiable = lookup_ok
...
if not verifiable:
    incomplete = True
upstream[dep_id] = {"merged": merged, "merge_in_base": merge_in_base, "verifiable": verifiable}

# derive_staleness excludes unverifiable deps from stale_on and lists them under `unverifiable`;
# main() emits {"incomplete": true, ...}. A run that couldn't check everything says so.
```

The `verifiable` flag defaults to `True` for injected `--facts` fixtures that predate it, so existing
tests keep their exact behavior while the unknown path gets its own coverage (a dep marked
`verifiable: false` must be neither flagged stale nor silently fresh — it lands in `unverifiable` and
flips the run-level `incomplete`).

The same conflation lived in the anchored-token PR search shared by `staleness.py` and the sibling
`reorient.py` (a malformed node id embedded straight into a `gh --search` string); both were guarded
with an `n\d+` shape check in the same pass, so a corrupt id reports unverifiable rather than matching
an unintended set of PRs.

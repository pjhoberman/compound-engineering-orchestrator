#!/usr/bin/env python3
"""Flag orch-ripen work nodes whose embedded plan may be stale.

A plan authored several waves ahead of implementation goes stale as upstream code
merges: the plan was written against a `base_commit` that predates a now-merged
dependency, so driving it risks conflicts or wrong assumptions. orch-ripen runs
this at each wave boundary to feed the drive-time staleness check (orch-decompose
Phase 4 / orch-next Phase 4) *earlier* — flagging "plan may be stale — re-plan?"
before a node reaches the executor, rather than letting it fail at drive time.

Only `stage:work` nodes (already flipped, plan authored) can be stale — earlier
stages have no plan to invalidate.

Following the split-pure-state-machine convention (docs/solutions/conventions):

  1. derive_staleness(node, facts)  — PURE decision logic, unit-tested via --facts.
  2. gather_facts_live(...)         — real git/gh I/O; a thin mapping, MANUALLY verified.
  3. --facts <json>                 — inject facts, bypassing the gatherer, for tests.

Usage:
    python3 staleness.py <project-dir>                 # gather facts from git + gh
    python3 staleness.py <project-dir> --facts <json>  # derive from injected facts (testing)

Emits one JSON object: {"base_branch", "nodes": {id: {stale, reason, stale_on}}, "stale"}.
Exit 0 normally; 2 on usage/parse error. Pure Python 3 standard library.
"""
import json
import os
import re
import subprocess
import sys

LIST_COLUMNS = {"depends_on", "pr_refs"}
# canonical node-id shape; a value off this shape means a corrupt index row, not a real id
NODE_ID_RE = re.compile(r"n\d+")


def fail(msg):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(2)


# --------------------------------------------------------------------------- #
# Index parsing (standalone — mirrors task-graph-schema.md, like the siblings)
# --------------------------------------------------------------------------- #
def parse_index(index_path):
    with open(index_path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    table = [ln for ln in lines if ln.lstrip().startswith("|")]
    if len(table) < 2:
        fail(f"No markdown table found in {index_path}")
    header = _split_row(table[0])
    rest = table[1:]
    if rest and _is_separator_row(rest[0]):
        rest = rest[1:]
    nodes = []
    for raw in rest:
        cells = _split_row(raw)
        if not any(cells):
            continue
        row = {}
        for col, val in zip(header, cells):
            row[col] = ([x.strip() for x in val.split(",") if x.strip()]
                        if col in LIST_COLUMNS else val)
        if row.get("id"):
            nodes.append(row)
    return nodes


def _is_separator_row(line):
    cells = _split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-+:?", c) for c in cells if c != "") \
        and any(c for c in cells)


def _split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    parts = re.split(r"(?<!\\)\|", line)
    return [p.replace("\\|", "|").strip() for p in parts]


# --------------------------------------------------------------------------- #
# Pure state machine (unit-tested via --facts)
# --------------------------------------------------------------------------- #
def derive_staleness(node, facts):
    """Return {"stale", "reason", "stale_on"} for one node. Pure: no I/O.

    `facts["upstream"]` maps each dependency id -> {"merged": bool, "merge_in_base": bool}:
      - merged        : the dependency's PR(s) are merged (its code is on the base branch).
      - merge_in_base : the dependency's merge commit is an ancestor of this node's
                        base_commit (i.e. the plan was authored AFTER that merge).
    A node is stale when a dependency merged but its merge is NOT contained in the
    node's base_commit — the plan predates upstream code it should build on.
    """
    if node.get("stage") != "work":
        # only flipped nodes carry a plan that can go stale
        return {"stale": False, "reason": None, "stale_on": []}

    base = (node.get("base_commit") or "").strip()
    upstream = facts.get("upstream", {})
    merged_deps = sorted(d for d, f in upstream.items() if f.get("merged"))
    # deps whose merged-ness or ancestry could not be determined. `verifiable` defaults True
    # so injected --facts fixtures that predate the flag keep their exact prior behavior.
    unverifiable = sorted(d for d, f in upstream.items() if not f.get("verifiable", True))

    def unverifiable_result():
        return {
            "stale": False,
            "reason": "could not verify upstream state for %s — check manually" % ", ".join(unverifiable),
            "stale_on": [],
            "unverifiable": unverifiable,
        }

    if not base:
        if merged_deps:
            return {
                "stale": True,
                "reason": "no base_commit stamped on a work node with merged upstream — cannot verify; re-stamp or re-plan",
                "stale_on": merged_deps,
            }
        if unverifiable:
            return unverifiable_result()
        return {"stale": False, "reason": None, "stale_on": []}

    # a merged dep whose ancestry we could not check is UNVERIFIABLE, not stale — excluding
    # it from stale_on avoids a false positive (it would otherwise look "not in base").
    unver = set(unverifiable)
    stale_on = [d for d in merged_deps if d not in unver and not upstream[d].get("merge_in_base")]
    if stale_on:
        return {
            "stale": True,
            "reason": "base_commit predates a merged upstream node — plan may be stale; re-plan?",
            "stale_on": stale_on,
        }
    if unverifiable:
        return unverifiable_result()
    return {"stale": False, "reason": None, "stale_on": []}


# --------------------------------------------------------------------------- #
# git / gh fact gathering (real mode — a thin mapping, MANUALLY verified)
# --------------------------------------------------------------------------- #
# NB per the split-pure-state-machine convention: this half is unit-test-blind.
# Keep it a thin git-output -> fact mapping and smoke-test it against a real repo
# (a known-stale node and a known-fresh node) before trusting it.
def _run(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=30)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, "", "command-unavailable"


def resolve_base_branch():
    rc, out, _ = _run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"])
    if rc == 0 and out:
        return out.replace("refs/remotes/", "", 1)
    rc, out, _ = _run(["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])
    if rc == 0 and out:
        return f"origin/{out}"
    return "origin/main"


def _is_valid_rev(value):
    """Conservative git-rev shape guard for a field-derived value.

    merge_commit / base_commit reach `git merge-base` from committed index.md (or a gh
    lookup). A value starting with '-' would be parsed as an option, and any other odd shape
    can only mean a corrupt field — reject it up front so the ancestry check reports
    "unverifiable" rather than emitting a wrong verdict or a confusing git usage error.
    """
    return bool(value) and not value.startswith("-") \
        and bool(re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._/-]*", value))


def _merge_commit_for(dep_node):
    """Return (merge_commit_or_None, lookup_ok).

    `lookup_ok` is False only when a gh call itself failed (missing / unauthenticated /
    offline / rate-limited / timed out) — deliberately distinct from a *successful* lookup
    that found the PR simply isn't merged (returns (None, True)). Conflating the two would
    let a gh outage read as "not merged" and silently clear a genuinely stale plan, the exact
    false-negative this tool exists to prevent.
    """
    pr_refs = dep_node.get("pr_refs", [])
    nid = dep_node["id"]
    if pr_refs:
        commit, ok = None, True
        for ref in pr_refs:
            num = ref.lstrip("#")
            rc, out, _ = _run(["gh", "pr", "view", num, "--json", "state,mergeCommit",
                               "-q", "[.state, (.mergeCommit.oid // \"\")] | @tsv"])
            if rc != 0:
                ok = False
                continue
            parts = out.split("\t")
            if len(parts) == 2 and parts[0].lower() == "merged" and parts[1]:
                commit = parts[1]
        return commit, ok
    if not NODE_ID_RE.fullmatch(nid):
        # a corrupt/out-of-shape node id must not be embedded in gh's search syntax — it could
        # match an unintended set of PRs. Report unverifiable rather than guess (input validation).
        return None, False
    rc, out, _ = _run(["gh", "pr", "list", "--search", f"[{nid}] in:title",
                       "--state", "merged", "--json", "mergeCommit",
                       "-q", ".[].mergeCommit.oid // empty"])
    if rc != 0:
        return None, False
    commits = [line for line in out.splitlines() if line]
    return (commits[0] if commits else None), True


def gather_facts_live(node, nodes_by_id):
    """Build derive_staleness facts for one node from git/gh. Never raises.

    Returns {"upstream": {dep: {merged, merge_in_base, verifiable}}, "incomplete": bool}.
    A dep is `verifiable: False` when its merged-ness or its merge/base ancestry could not be
    determined (gh/git unavailable, an out-of-shape rev, or a shallow clone missing the
    objects). The node's verdict then carries that uncertainty instead of a confident "fresh".
    """
    upstream = {}
    incomplete = False
    base = (node.get("base_commit") or "").strip()
    for dep_id in node.get("depends_on", []):
        dep_node = nodes_by_id.get(dep_id)
        if not dep_node:
            continue
        merge_commit, lookup_ok = _merge_commit_for(dep_node)
        merged = merge_commit is not None
        merge_in_base = False
        verifiable = lookup_ok
        if merged and base:
            if _is_valid_rev(merge_commit) and _is_valid_rev(base):
                rc, _, err = _run(["git", "merge-base", "--is-ancestor", merge_commit, base])
                if rc == 0:
                    merge_in_base = True          # merge already contained in base_commit
                elif rc == 1 and err != "command-unavailable":
                    merge_in_base = False         # genuine "not an ancestor"
                else:
                    # exit 128 (object missing — e.g. shallow clone) or the _run failure
                    # sentinel: ancestry is UNKNOWN, not "not an ancestor". Never a false verdict.
                    verifiable = False
            else:
                verifiable = False
        if not verifiable:
            incomplete = True
        upstream[dep_id] = {"merged": merged, "merge_in_base": merge_in_base, "verifiable": verifiable}
    return {"upstream": upstream, "incomplete": incomplete}


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main(argv):
    if len(argv) < 2:
        fail("Usage: python3 staleness.py <project-dir> [--facts <json>]")
    project_dir = argv[1]
    facts_path = None
    if "--facts" in argv:
        idx = argv.index("--facts")
        if idx + 1 >= len(argv):
            fail("--facts requires a path")
        facts_path = argv[idx + 1]

    index_path = os.path.join(project_dir, "index.md")
    if not os.path.isfile(index_path):
        fail(f"No index.md in {project_dir}")

    nodes = parse_index(index_path)
    nodes_by_id = {n["id"]: n for n in nodes}

    if facts_path:
        try:
            with open(facts_path, encoding="utf-8") as fh:
                facts_by_id = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            fail(f"cannot read {facts_path}: {exc}")
        base_branch = facts_by_id.get("__base__", "main")
    else:
        base_branch = resolve_base_branch()
        facts_by_id = {nid: gather_facts_live(n, nodes_by_id)
                       for nid, n in nodes_by_id.items()}

    result_nodes = {}
    for nid, n in nodes_by_id.items():
        result_nodes[nid] = derive_staleness(n, facts_by_id.get(nid, {}))

    stale = sorted(nid for nid, r in result_nodes.items() if r["stale"])
    # incomplete: any node whose verdict rests on an unverifiable upstream, or any gatherer
    # pass that reported a failed git/gh call. A run that could not check everything must say
    # so — an all-clear that is really "we couldn't look" is the worst outcome for this tool.
    incomplete = any(r.get("unverifiable") for r in result_nodes.values()) \
        or any(isinstance(f, dict) and f.get("incomplete") for f in facts_by_id.values())
    print(json.dumps({"base_branch": base_branch, "incomplete": incomplete,
                      "nodes": result_nodes, "stale": stale}, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

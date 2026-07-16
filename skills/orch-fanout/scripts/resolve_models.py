#!/usr/bin/env python3
"""Resolve each wave node's abstract model tier to a concrete spawn spec for orch-fanout.

`orch-decompose` stamps every node with a provider-agnostic capability *tier* (`generation` |
`ceiling`). `orch-fanout` Phase 4 has to turn that tier into a concrete model — and, once other
runtimes are in play (Conductor's Codex/Cursor/OpenCode agents, an OpenRouter/LiteLLM gateway),
into an agent + optional gateway env. That mapping used to live in the skill's prose ("ceiling ->
top model, generation -> sonnet"); this script makes it deterministic, testable, and the single
seam where a non-Claude provider plugs in — without touching the committed graph.

It composes upstream JSON, it does no parsing of its own: it joins `wave_plan.py`'s wave
structure with `graph_compute.py`'s per-node `model` tier (`node_meta`) and a *profile* (built-in
or a `--profiles` file) that maps tier -> spawn spec for one runtime.

Usage:
    python3 resolve_models.py --waves <wave_plan.json> --graph <graph_compute.json> \
        [--profiles <profiles.json>] [--profile <name>]

Profiles carry only env-var *names* (never secrets), so a profiles file is safe to commit; the
gateway URL/key stay in the environment. A node whose tier is null, absent, or unrecognized falls
back to the profile's `ceiling` spec (the safe default — `graph_compute` already flags an
unrecognized tier as `invalid_model` at decompose time). Emits the wave list with each node
annotated `{id, tier, resolved_tier, fallback, agent, model, base_url_env, api_key_env}`.
Exit 0, 2 on usage error.
"""
import argparse
import json
import sys

VALID_TIERS = ("ceiling", "generation")  # order fixed for determinism; both required per profile
ALLOWED_AGENTS = {"claude-code", "codex", "cursor", "opencode"}

# Built-in profiles. `claude-code` reproduces the pre-script prose mapping exactly, so the default
# path is a behavior-preserving refactor: ceiling -> inherit the session's top model, generation ->
# the platform mid-tier. Extra profiles are shipped as ready references for the two non-Claude
# routes (see references/model-profile-schema.md); a `--profiles` file overrides/extends these.
BUILTIN_PROFILES = {
    "default_profile": "claude-code",
    "profiles": {
        "claude-code": {
            "ceiling": {"agent": "claude-code", "model": "inherit"},
            "generation": {"agent": "claude-code", "model": "sonnet"},
        },
        # Fully automatic in-session route: point the whole fan-out session at an
        # Anthropic-compatible gateway via the named env vars, and these strings become gateway IDs.
        "openrouter": {
            "ceiling": {"agent": "claude-code", "model": "anthropic/claude-opus-4.8",
                        "base_url_env": "ORCH_GATEWAY_BASE_URL", "api_key_env": "ORCH_GATEWAY_API_KEY"},
            "generation": {"agent": "claude-code", "model": "openai/gpt-5-mini",
                           "base_url_env": "ORCH_GATEWAY_BASE_URL", "api_key_env": "ORCH_GATEWAY_API_KEY"},
        },
        # Human-dispatch route: fan-out can't spawn a Conductor workspace, so this profile is a
        # dispatch sheet — it tells the operator which agent to pick per node in Conductor's UI.
        "conductor-mixed": {
            "ceiling": {"agent": "claude-code", "model": "opus"},
            "generation": {"agent": "codex", "model": "gpt-5-codex"},
        },
    },
}


def fail(msg):
    sys.stderr.write(f"resolve_models.py: {msg}\n")
    sys.exit(2)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {path}: {exc}")


def validate_profiles(doc, source):
    """Validate a profiles document (built-in or file) and return its `profiles` dict.

    Every profile must define BOTH tiers so a fallback target always exists; each spec must carry a
    string `model` and, if present, a known `agent`. We reject unknown tier keys so a typo like
    `celing:` surfaces here rather than silently never matching a node.
    """
    if not isinstance(doc, dict) or not isinstance(doc.get("profiles"), dict):
        fail(f"{source}: expected an object with a 'profiles' map")
    profiles = doc["profiles"]
    if not profiles:
        fail(f"{source}: 'profiles' is empty")
    for name, prof in profiles.items():
        if not isinstance(prof, dict):
            fail(f"{source}: profile {name!r} must be an object")
        for tier in prof:
            if tier not in VALID_TIERS:
                fail(f"{source}: profile {name!r} has unknown tier {tier!r} (expected {list(VALID_TIERS)})")
        for tier in VALID_TIERS:
            spec = prof.get(tier)
            if not isinstance(spec, dict):
                fail(f"{source}: profile {name!r} is missing a spec for tier {tier!r}")
            if not isinstance(spec.get("model"), str) or not spec["model"]:
                fail(f"{source}: profile {name!r} tier {tier!r} needs a non-empty string 'model'")
            agent = spec.get("agent", "claude-code")
            if agent not in ALLOWED_AGENTS:
                fail(f"{source}: profile {name!r} tier {tier!r} has unknown agent {agent!r} "
                     f"(expected one of {sorted(ALLOWED_AGENTS)})")
            # Gateway env fields are optional, but a present one must name a real env var —
            # an empty or non-string value would reach Phase 4 as a bogus env-var name.
            for field in ("base_url_env", "api_key_env"):
                if field in spec and (not isinstance(spec[field], str) or not spec[field]):
                    fail(f"{source}: profile {name!r} tier {tier!r} field {field!r} must be a "
                         f"non-empty string when present")
    return doc


def select_profile(doc, requested):
    profiles = doc["profiles"]
    name = requested or doc.get("default_profile")
    if not name:
        fail("no --profile given and the profiles document has no 'default_profile'")
    if name not in profiles:
        fail(f"profile {name!r} not found (available: {sorted(profiles)})")
    return name, profiles[name]


def resolve_node(nid, node_meta, profile):
    """Map one node's tier to a concrete spawn spec, falling back to `ceiling` for an unknown tier."""
    tier = (node_meta.get(nid) or {}).get("model")
    resolved_tier = tier if tier in VALID_TIERS else "ceiling"
    fallback = resolved_tier != tier
    spec = profile[resolved_tier]
    return {
        "id": nid,
        "tier": tier,
        "resolved_tier": resolved_tier,
        "fallback": fallback,
        "agent": spec.get("agent", "claude-code"),
        "model": spec["model"],
        "base_url_env": spec.get("base_url_env"),
        "api_key_env": spec.get("api_key_env"),
    }


def resolve(waves_doc, graph, profile):
    node_meta = graph.get("node_meta")
    if not isinstance(node_meta, dict):
        fail("graph JSON has no 'node_meta' dict — re-run graph_compute.py")

    out_waves = []
    for wave in waves_doc.get("waves", []):
        kind = wave.get("kind")
        if kind == "parallel":
            ids = wave.get("ids", [])
        elif kind == "solo":
            ids = [wave["id"]] if "id" in wave else []
        else:
            fail(f"unknown wave kind {kind!r} — re-run wave_plan.py")
        nodes = [resolve_node(nid, node_meta, profile) for nid in sorted(ids)]
        out = {"kind": kind, "nodes": nodes}
        if kind == "solo" and "reason" in wave:
            out["reason"] = wave["reason"]
        out_waves.append(out)
    return {"waves": out_waves, "wave_count": len(out_waves)}


def main(argv):
    parser = argparse.ArgumentParser(description="Resolve node model tiers to concrete spawn specs.")
    parser.add_argument("--waves", required=True, help="wave_plan.py JSON (wave structure)")
    parser.add_argument("--graph", required=True, help="graph_compute.py JSON (node_meta model tiers)")
    parser.add_argument("--profiles", help="optional profiles JSON; overrides the built-in profiles")
    parser.add_argument("--profile", help="profile name to use (else the document's default_profile)")
    args = parser.parse_args(argv[1:])  # argparse exits 2 on usage error

    if args.profiles:
        doc = validate_profiles(load(args.profiles), args.profiles)
        source = args.profiles
    else:
        doc = validate_profiles(BUILTIN_PROFILES, "<builtin>")
        source = "builtin"
    name, profile = select_profile(doc, args.profile)

    result = resolve(load(args.waves), load(args.graph), profile)
    result["profile"] = name
    result["profile_source"] = source
    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

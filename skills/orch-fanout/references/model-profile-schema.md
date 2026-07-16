# Model Profile Schema

A **model profile** maps `orch-decompose`'s abstract capability *tier* (`generation` |
`ceiling`) to a concrete **spawn spec** for one runtime — the model, the agent, and (for a
gateway) which env vars hold its URL and key. `scripts/resolve_models.py` reads a profile and
annotates each wave node with the resolved spec; `orch-fanout` Phase 3 renders it and Phase 4
spawns from it.

Profiles are the seam where a **non-Claude provider** plugs in **without touching the committed
graph**. The graph keeps carrying provider-agnostic tiers; the profile — an environment concern —
decides what each tier becomes here.

## Why a profile and not a graph field

The task-graph is durable, diffable, and shared across machines; baking `gpt-5-mini` into a node
would rot and would force everyone who checks out the graph to have that provider. Tier is a fact
about the *work* (mechanical vs. architectural judgment); provider/model is a fact about the
*runtime*. They live in different places, and the profile is resolved at fan-out time — the only
step that knows what's actually reachable. This follows the repo's
`docs/solutions/conventions/no-producer-field-without-a-consumer.md` rule.

## Format

```json
{
  "default_profile": "claude-code",
  "profiles": {
    "<name>": {
      "ceiling":    { "agent": "claude-code", "model": "<id>", "base_url_env": "<ENV>", "api_key_env": "<ENV>" },
      "generation": { "agent": "codex",       "model": "<id>" }
    }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `default_profile` | no | Profile used when `--profile` is omitted. |
| `profiles` | yes | Map of profile name → tier specs. Must be non-empty. |
| `<profile>.ceiling` / `.generation` | **both required** | Spawn spec per tier. Both must exist so an unknown-tier node always has a fallback target. Any other tier key is a validation error (catches typos). |
| `spec.model` | yes | Non-empty string. A concrete model id, a gateway model id, or `inherit` (use the session's current model). |
| `spec.agent` | no | Runtime agent: `claude-code` (default), `codex`, `cursor`, `opencode`. |
| `spec.base_url_env` / `spec.api_key_env` | no | **Names of env vars** (never the secrets themselves) holding a gateway's base URL / API key. A profiles file is therefore safe to commit. |

## Resolution and fallback

For each node, `resolve_models.py` reads its `model` tier from `graph_compute.py`'s `node_meta`.
A tier that is **null, absent, or unrecognized** falls back to the profile's `ceiling` spec
(the safe default — `graph_compute` already flags an unrecognized tier as `invalid_model` at
decompose time). Each resolved node reports `{tier, resolved_tier, fallback, agent, model,
base_url_env, api_key_env}`, so the Phase 3 preview can show a fallback honestly.

## Where a profiles file lives

The script takes a `--profiles <path>`; the skill owns discovery. Default lookup order:

1. `--profiles` argument, if given.
2. A project override committed with the graph: `docs/plans/<project>/model-profiles.json`.
3. A user-global file: `~/.claude/orch-fanout-profiles.json` (provider keys are machine-specific).
4. The **built-in profiles** in `resolve_models.py` (no file needed).

The built-in `claude-code` profile reproduces the pre-script mapping exactly (`ceiling → inherit`,
`generation → sonnet`), so the zero-config path is behavior-preserving.

## Execution paths (what actually consumes a non-Claude spec)

Claude Code's own `/lfg` spawn model override only accepts Anthropic tiers, so a profile is only
as real as its runtime. Two routes work:

- **Gateway (automatic, in-session).** Point the whole fan-out session at an Anthropic-compatible
  gateway (OpenRouter / LiteLLM) by exporting the profile's `base_url_env` / `api_key_env` before
  running. The `model` strings become gateway ids; one gateway can serve both Anthropic and
  OpenAI/open models, so a mixed wave works **as long as every model in it is reachable through
  that one gateway**. Built-in profile: `openrouter`.
- **Conductor (human dispatch).** Conductor runs Claude Code, Codex, Cursor, and OpenCode, chosen
  per workspace in its **model picker** — but only by a person (`Cmd+N`); there is no API for a
  running agent to spawn a workspace or pick its agent. So a Conductor-targeted profile is a
  **dispatch sheet**: the Phase 3 preview tells the operator which agent to select per node.
  Built-in profile: `conductor-mixed`. These nodes do not auto-execute non-Claude.

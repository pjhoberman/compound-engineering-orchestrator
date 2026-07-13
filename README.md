# Compound Engineering Orchestrator

Project **decomposition and orchestration** layered on top of the
[compound-engineering](https://github.com/EveryInc/compound-engineering-plugin) plugin.

Compound Engineering ships excellent per-feature primitives — `ce-plan` decomposes one
feature into units, `ce-work` fans out worktree-isolated sub-agents, `lfg` runs the full
single-unit pipeline. What it doesn't do is operate one level *above* a single feature:
nothing decomposes a whole multi-feature project, maps dependencies across tickets, or
tracks where the project stands outside one chat session.

This plugin fills that layer. It is a **hard dependency** on compound-engineering: its
skills compose CE skills (`ce-plan`, `ce-brainstorm`, `ce-work`, `lfg`) rather than
reimplement them.

## The pipeline

The four skills operate over one durable artifact — a committed, diffable **task-graph**
under `docs/plans/<project-slug>/`. Structure lives in git; live status is *derived* from
git on read, so any session or machine resumes by reading the files.

```mermaid
flowchart TB
    P(["project / brainstorm doc"]) --> OD["/orch-decompose<br/>build + audit the task-graph"]
    OD --> TG[("task-graph<br/>committed in git;<br/>status derived on read")]
    TG --> ON["/orch-next<br/>ready frontier,<br/>recommend one move"]
    TG --> OR
    TG --> OF
    subgraph OR["/orch-ripen — parallel planning waves"]
        direction LR
        PF["planning frontier:<br/>decisions settled,<br/>not code merged"] --> CP["fan ce-plan<br/>over the wave<br/>(worktree-isolated)"]
        CP --> WB["approval gate →<br/>write plan back,<br/>flip plan→work"]
        WB --> RA["re-audit +<br/>staleness re-check"]
    end
    subgraph OF["/orch-fanout — runtime-safe parallel waves"]
        direction LR
        PA["partition:<br/>collision-free batches"] --> WP["wave-plan:<br/>exclusive-runtime<br/>nodes run solo"]
        WP --> EX["executor:<br/>worktree /lfg per node,<br/>per-node model tier,<br/>dependency-order merge"]
        EX --> CB["circuit breaker:<br/>halt after K<br/>consecutive fails"]
    end
    ON -.->|drive a node| OF
    OR -.->|nodes flipped to work| OF
    OF -.->|recovery manifest per wave| TG
```

In words: **`/orch-decompose`** builds the committed task-graph → **`/orch-ripen`** matures its
plan-stage nodes into work-ready nodes in parallel planning waves → **`/orch-fanout`** runs the
work-ready nodes in parallel execution waves (partition → wave-plan → executor → circuit breaker),
checkpointing recovery state each wave. **`/orch-next`** is the single-move advisor throughout —
ask it what to do next at any point. Every skill reads and writes the one task-graph; nothing
holds project state in a chat session.

## Skills

All four are **manual-invoke** (`disable-model-invocation: true`).

### `/orch-decompose`

Turns a big project (or a brainstorm/strategy doc) into the committed task-graph: a markdown
`index.md` plus one file per node. Each node is a feature-sized unit tagged with the CE stage
it next enters (`brainstorm` / `plan` / `work`), a model tier, and `exclusive_runtime`,
embedding a `ce-plan`-shaped plan when settled or a brief otherwise.

- Audits its own output: cycle / orphan / missing-dependency detection, forest-aware
  critical-path and slack, and a granularity guard (`scripts/graph_compute.py`).
- Derives live per-node status from git and `gh` (`scripts/reorient.py`).
- After building the graph, offers to drive the first ready node into `ce-plan`,
  `ce-brainstorm`, or `lfg`.

### `/orch-next`

Reads the task-graph, computes the dependency **ready frontier**, and recommends the single
highest-leverage next move (lowest slack, then most-unblocking) with the exact command to run
it — then fires it. A pure consumer (`scripts/frontier.py`) of the graph + status JSON.

### `/orch-ripen`

Matures the graph's **plan-stage** nodes into work-ready nodes so `/orch-fanout` has work to do.
Computes the **planning frontier** — plan nodes whose upstream *decisions* are settled (upstream
plan approved / stage flipped to `work`), not whose *code* has merged (`scripts/ripen_frontier.py`)
— fans `ce-plan` over each wave in worktree-isolated parallel runs (honoring each node's `model`
tier), gates every stage-flip on human approval, then writes the approved plans back into the
graph (embed the plan, flip `plan`→`work`, stamp `base_commit`; see
`references/stage-flip-writeback.md`). After each wave it re-audits the graph (the new `Files:`
lists give the dependency guard teeth) and re-validates staleness (`scripts/staleness.py`) so a
plan authored waves ahead of implementation is flagged before it reaches the executor. Brainstorm
nodes are reported for an interactive `ce-brainstorm` session, never fanned.

### `/orch-fanout`

Executes ready work in **runtime-safe parallel waves**: partition the ready set into
collision-free batches (`scripts/partition.py`), sequence them into waves where
`exclusive_runtime` nodes run solo (`scripts/wave_plan.py`), show a visible preview, then
drive each wave through `/lfg` in worktree-isolated runs (reusing `ce-work`), merging in
dependency order. Recovery state is checkpointed at every wave boundary
(`scripts/manifest.py`) and reconciled against live git on resume (`scripts/reconcile.py`); a
circuit breaker (`scripts/circuit_breaker.py`) halts the run after K consecutive wave failures.

## Concepts

Shared vocabulary (`CONCEPTS.md`): **task-graph**, **node**, **stage**, **model tier**,
**no_pr node**, **manual status pin**, **ready frontier**, **planning frontier**,
**decision dependency**, **fan-out batch**, **exclusive_runtime**, **wave**, **circuit breaker**.
Learnings captured along the way live in `docs/solutions/`.

## Install

This plugin is distributed as a Claude Code marketplace. It requires the
[compound-engineering](https://github.com/EveryInc/compound-engineering-plugin) plugin to be
installed as well.

```bash
# from GitHub
claude plugin marketplace add pjhoberman/compound-engineering-orchestrator
claude plugin install compound-engineering-orchestrator@compound-engineering-orchestrator

# or from a local checkout (for iterating)
claude plugin marketplace add /path/to/compound-engineering-orchestrator
claude plugin install compound-engineering-orchestrator@compound-engineering-orchestrator
```

## Requirements

- [compound-engineering](https://github.com/EveryInc/compound-engineering-plugin) plugin installed.
- Claude Code — the bundled scripts resolve via `CLAUDE_SKILL_DIR`; off-platform invocations
  report unavailability explicitly rather than degrading.
- `python3` (stdlib only) for the bundled scripts.

## Roadmap

The decompose → ripen → fanout family (with next as the single-move advisor, plus recovery) is
complete. The one deliberately deferred piece is **`orch-tracker-sync`** — making Linear a live,
two-way coordination bus so the task-graph and an external tracker stay in sync. See
`docs/brainstorms/` and `docs/plans/` for the originating ideation, requirements, and plans.

## Development

```bash
bun install
bun test                 # 115 script tests (TS harness over the Python scripts)
bun run plugin:validate  # claude plugin validate
```

The scripts are stdlib Python; the test harness is a thin Bun/TypeScript layer that shells
out to them. All compute scripts are deterministic, emit JSON, and exit 2 on usage error;
DAG/graph parsing lives in `orch-decompose`'s scripts and the rest are pure consumers of that
JSON (see `docs/solutions/conventions/`).

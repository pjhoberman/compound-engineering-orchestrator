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

## Skills

### `orch-decompose` (available)

Turns a big project (or a brainstorm/strategy doc) into a committed, diffable
**task-graph**: a markdown `index.md` plus one file per node under
`docs/plans/<project-slug>/`. Each node is a feature-sized unit tagged with the CE stage
it next enters (`brainstorm` / `plan` / `work`) and a model tier, embedding a
`ce-plan`-shaped plan when it's settled or a brief otherwise.

- **Structure lives in git; status is derived from git on read** — any session or machine
  resumes by reading the files.
- Audits its own output: cycle / orphan / missing-dependency detection, forest-aware
  critical-path and slack, and a granularity guard.
- After building the graph, offers to drive the first ready node into `ce-plan`,
  `ce-brainstorm`, or `lfg`.

Manual-invoke only. Run it with `/orch-decompose [project description or doc path]`.

## Roadmap

`orch-decompose` is the foundation (rungs 1–3 of the design). The orchestration payoff is
the layer above it, built progressively on the task-graph:

- **`orch-next`** — read the graph, compute the ready frontier, recommend the single
  highest-leverage next move (and run it).
- **`orch-fanout`** — pull the ready set, partition into collision-free parallel batches,
  and spawn worktree-isolated `/lfg` runs behind a visible preview and a circuit breaker.
- **`orch-tracker-sync`** — make Linear a live, two-way coordination bus.
- **Recovery manifest** — durable checkpoints so a dead mid-run session resumes as a read.

See `docs/` for the originating ideation, requirements, and plan.

## Requirements

- [compound-engineering](https://github.com/EveryInc/compound-engineering-plugin) plugin installed.
- Claude Code (the bundled computation scripts resolve via `CLAUDE_SKILL_DIR`; off-platform
  invocations report that explicitly rather than degrading).
- `python3` (stdlib only) for the graph-compute and re-orient scripts.

## Development

```bash
bun install
bun test               # 19 script tests (TS harness over the Python scripts)
bun run plugin:validate # claude plugin validate
```

The scripts are stdlib Python; the test harness is a thin Bun/TypeScript layer that shells
out to them.

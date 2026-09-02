---
name: multi-worker-pm
description: Run this session as an autonomous PM over a pool of parallel worker agents implementing backlog issues in herdr panes
argument-hint: "[--mode issues|renovate] [--cap N] [label-filter] [--dry-run]"
---

You are the PM session for a pool of autonomous worker agents.

## Scope

$ARGUMENTS

- _(empty)_ — run the full pool (cap 3) in the default `--mode issues` lane.
- `--mode issues` (default) — workers run `/ce-worktree` + `/lfg` on selected backlog issues.
- `--mode renovate` — workers tend stalled dependency-bump PRs with `/ce-babysit-pr` (see the skill's **Mode: renovate**).
- `--cap N` — cap the pool at N workers (hard-capped at 3); pass through to `run.mjs select --cap N`.
- `--dry-run` — print the would-spawn/would-tend list with selection reasoning and stop; no herdr required.
- any other token — treat it as a label the selected issues must also carry (passed as `--filter`; issue lane only).

## Workflow

Follow the `multi-worker-pm` skill exactly — its non-negotiable safety rules, numbered phases, and reporting. Do not restate or improvise the workflow here; the skill is the single owner. Invoke the deterministic helpers as `node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-worker-pm/run.mjs" <select|classify> [...]`.

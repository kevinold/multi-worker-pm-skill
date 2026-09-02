// Per-tick worker classification for the multi-worker-pm skill.
//
// Pure: snapshots, timestamps, and roster in — actions out. The edge (the PM
// session following SKILL.md) captures `herdr agent list` JSON, stamps tick
// times, and supplies per-worker reclaim status from `gh pr checks`.
//
// Settle rule: status idle/done AND state_change_seq unchanged across ≥2 ticks
// AND ≥30s elapsed between them. All three legs are enforced here so the
// false-positive defense is executable, not prose.

const MIN_SETTLE_INTERVAL_MS = 30_000;
const DEFAULT_STALL_BUDGET_MS = 45 * 60 * 1000;

const SETTLED_BY_RECLAIM = {
  "ci-decided": "settled-reclaim",
  "ci-pending": "settled-unattended",
  "no-pr": "settled-no-pr",
};

const requireField = (entry, field) => {
  if (entry[field] === undefined || entry[field] === null) {
    // A missing contract field is CLI-surface drift, never stability:
    // undefined === undefined must not read as an unchanged seq.
    throw new Error(`herdr agent entry for "${entry.name}" is missing ${field} — CLI surface drifted; halt the tick`);
  }
  return entry[field];
};

/**
 * @param {object} args
 * @param {{ok: boolean, agents: Array}} args.prev  previous tick snapshot
 * @param {{ok: boolean, agents: Array}} args.curr  current tick snapshot
 * @param {number} args.prevTickAt  epoch ms of the previous snapshot
 * @param {number} args.currTickAt  epoch ms of the current snapshot
 * @param {string[]} args.roster    worker names owned by this PM (roster scoping)
 * @param {Object<string,string>} args.reclaimStatus  per settled worker: no-pr | ci-pending | ci-decided
 * @param {Object<string,number>} args.workingSince   per worker: epoch ms it entered working
 * @param {number} [args.stallBudgetMs]
 * @param {"issues"|"renovate"} [args.mode]  "renovate" suppresses settle/stall: a babysit
 *   worker idles between polls and works >45min legitimately, so reclaim comes from the babysit
 *   terminal read off the pane, not the seq/interval rule. Only blocked/gone/tending emit.
 * @returns {{actions: Object, flags: Object, workingSince: Object}}
 */
export function classifyTick({
  prev,
  curr,
  prevTickAt,
  currTickAt,
  roster,
  reclaimStatus = {},
  workingSince = {},
  stallBudgetMs = DEFAULT_STALL_BUDGET_MS,
  mode = "issues",
}) {
  // Strict === true: a truthy non-boolean (e.g. the string "false") must not
  // pass as a healthy snapshot and let a live worker read as gone.
  if (curr?.ok !== true) throw new Error("current snapshot is failed or partial — halt the tick, do not classify");
  if (prev?.ok !== true) throw new Error("previous snapshot is failed or partial — halt the tick, do not classify");
  if (!Array.isArray(curr.agents) || !Array.isArray(prev.agents)) {
    throw new Error("snapshot has no agents array — wrap herdr output as {ok, agents} per SKILL Phase 4");
  }

  const byName = (snapshot) => new Map(snapshot.agents.filter((a) => a.name).map((a) => [a.name, a]));
  const prevByName = byName(prev);
  const currByName = byName(curr);

  const actions = {};
  const flags = {};
  const nextWorkingSince = { ...workingSince };

  for (const name of roster) {
    const currEntry = currByName.get(name);
    if (!currEntry) {
      // Only a validated snapshot may prove absence (the !ok throw above).
      actions[name] = "escalate-gone";
      delete nextWorkingSince[name];
      continue;
    }

    const status = requireField(currEntry, "agent_status");
    const seq = requireField(currEntry, "state_change_seq");

    if (status !== "working") delete nextWorkingSince[name];

    if (status === "blocked") {
      actions[name] = "attend-blocked";
      continue;
    }

    if (mode === "renovate") {
      // No settle/stall reclaim for a babysit worker — it legitimately sits
      // idle between CI polls and works past 45 min. Reclaim is edge-driven:
      // the SKILL reads ce-babysit-pr's terminal off the pane. Everything that
      // is not gone (handled above) or blocked is "tending".
      if (status === "working") nextWorkingSince[name] = workingSince[name] ?? currTickAt;
      actions[name] = "tending";
      continue;
    }

    if (status === "working") {
      const since = workingSince[name] ?? currTickAt;
      nextWorkingSince[name] = since;
      actions[name] = currTickAt - since > stallBudgetMs ? "stall-check" : "none";
      continue;
    }

    if (status === "idle" || status === "done") {
      const prevEntry = prevByName.get(name);
      const prevSettleable =
        prevEntry && (prevEntry.agent_status === "idle" || prevEntry.agent_status === "done");
      const stable =
        prevSettleable &&
        requireField(prevEntry, "state_change_seq") === seq &&
        currTickAt - prevTickAt >= MIN_SETTLE_INTERVAL_MS;
      actions[name] = stable ? (SETTLED_BY_RECLAIM[reclaimStatus[name]] ?? "settled") : "none";
      continue;
    }

    // unknown (or any unrecognized status): present but unclassifiable —
    // never proof of completion.
    actions[name] = "none";
    flags[name] = "unknown-status";
  }

  return { actions, flags, workingSince: nextWorkingSince };
}

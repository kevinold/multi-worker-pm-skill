import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "./expect-shim.mjs";
import { classifyTick } from "./classify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(join(HERE, "__fixtures__", "agent-list.json"), "utf8"));

// Timestamps are data, never wall clock (frozen-clock rule).
const T0 = 1_788_000_000_000;
const TICK = 35_000; // > the 30s minimum interval

const agent = (name, agent_status, state_change_seq, extra = {}) => ({
  name,
  agent_status,
  state_change_seq,
  pane_id: "w0:p9",
  ...extra,
});

const snap = (agents, ok = true) => ({ ok, agents });

const tick = (overrides) =>
  classifyTick({
    prev: snap([]),
    curr: snap([]),
    prevTickAt: T0,
    currTickAt: T0 + TICK,
    roster: ["w1"],
    reclaimStatus: {},
    workingSince: {},
    ...overrides,
  });

describe("snapshot validation (fail-loud)", () => {
  it("throws when the current snapshot is marked failed/partial", () => {
    expect(() => tick({ curr: snap([agent("w1", "idle", 5)], false) })).toThrow(/current snapshot/i);
  });

  it("throws when the previous snapshot is marked failed/partial", () => {
    expect(() => tick({ prev: snap([agent("w1", "idle", 5)], false), curr: snap([agent("w1", "idle", 5)]) })).toThrow(
      /previous snapshot/i,
    );
  });

  it("rejects a truthy non-boolean ok (the string \"false\")", () => {
    const bad = { ok: "false", agents: [agent("w1", "idle", 5)] };
    expect(() => tick({ curr: bad })).toThrow(/current snapshot/i);
  });

  it("throws when a snapshot has no agents array", () => {
    expect(() => tick({ curr: { ok: true } })).toThrow(/agents array/i);
  });

  it("throws when a roster member is missing state_change_seq", () => {
    const broken = { name: "w1", agent_status: "idle", pane_id: "w0:p9" };
    // undefined === undefined must never read as stability.
    expect(() => tick({ prev: snap([broken]), curr: snap([broken]) })).toThrow(/state_change_seq/);
  });

  it("throws when a roster member is missing agent_status", () => {
    const broken = { name: "w1", state_change_seq: 5, pane_id: "w0:p9" };
    expect(() => tick({ prev: snap([broken]), curr: snap([broken]) })).toThrow(/agent_status/);
  });
});

describe("gone and blocked", () => {
  it("escalates a roster worker absent from a valid snapshot", () => {
    const r = tick({ prev: snap([agent("w1", "working", 3)]), curr: snap([]) });
    expect(r.actions.w1).toBe("escalate-gone");
  });

  it("attends a blocked worker immediately, no persistence needed", () => {
    const r = tick({ prev: snap([agent("w1", "working", 3)]), curr: snap([agent("w1", "blocked", 4)]) });
    expect(r.actions.w1).toBe("attend-blocked");
  });
});

describe("settle detection", () => {
  it("idle beat: seq changed between ticks → not settled", () => {
    const r = tick({ prev: snap([agent("w1", "idle", 5)]), curr: snap([agent("w1", "working", 6)]) });
    expect(r.actions.w1).toBe("none");
  });

  it("first idle sighting → not settled", () => {
    const r = tick({ prev: snap([agent("w1", "working", 6)]), curr: snap([agent("w1", "idle", 7)]) });
    expect(r.actions.w1).toBe("none");
  });

  it("idle with stable seq across two ticks ≥30s apart → settled, routed by reclaimStatus", () => {
    const prev = snap([agent("w1", "idle", 7)]);
    const curr = snap([agent("w1", "idle", 7)]);
    expect(tick({ prev, curr, reclaimStatus: { w1: "ci-decided" } }).actions.w1).toBe("settled-reclaim");
    expect(tick({ prev, curr, reclaimStatus: { w1: "ci-pending" } }).actions.w1).toBe("settled-unattended");
    expect(tick({ prev, curr, reclaimStatus: { w1: "no-pr" } }).actions.w1).toBe("settled-no-pr");
  });

  it("settle with no reclaimStatus yet → generic settled (edge fetches PR state)", () => {
    const r = tick({ prev: snap([agent("w1", "idle", 7)]), curr: snap([agent("w1", "idle", 7)]) });
    expect(r.actions.w1).toBe("settled");
  });

  it("back-to-back ticks 2s apart → NOT settled (interval regression)", () => {
    const r = tick({
      prev: snap([agent("w1", "idle", 7)]),
      curr: snap([agent("w1", "idle", 7)]),
      currTickAt: T0 + 2_000,
    });
    expect(r.actions.w1).toBe("none");
  });

  it("done settles like idle; done stays done (CLI reads never mark seen)", () => {
    const r = tick({ prev: snap([agent("w1", "done", 9)]), curr: snap([agent("w1", "done", 9)]) });
    expect(r.actions.w1).toBe("settled");
  });

  it("unknown status → none with a flag, never settled", () => {
    const r = tick({ prev: snap([agent("w1", "unknown", 2)]), curr: snap([agent("w1", "unknown", 2)]) });
    expect(r.actions.w1).toBe("none");
    expect(r.flags.w1).toBe("unknown-status");
  });
});

describe("stall budget", () => {
  it("continuously working past the budget → stall-check", () => {
    const r = tick({
      prev: snap([agent("w1", "working", 3)]),
      curr: snap([agent("w1", "working", 8)]),
      workingSince: { w1: T0 - 46 * 60 * 1000 },
    });
    expect(r.actions.w1).toBe("stall-check");
  });

  it("working under the budget → none, and workingSince is tracked", () => {
    const r = tick({ prev: snap([agent("w1", "working", 3)]), curr: snap([agent("w1", "working", 8)]) });
    expect(r.actions.w1).toBe("none");
    expect(r.workingSince.w1).toBe(T0 + TICK);
  });

  it("leaving working resets the stall clock", () => {
    const r = tick({
      prev: snap([agent("w1", "working", 3)]),
      curr: snap([agent("w1", "blocked", 4)]),
      workingSince: { w1: T0 - 46 * 60 * 1000 },
    });
    expect(r.actions.w1).toBe("attend-blocked");
    expect(r.workingSince.w1).toBeUndefined();
  });
});

describe("renovate mode: settle/stall suppressed", () => {
  const rtick = (overrides) => tick({ mode: "renovate", ...overrides });

  it("idle + stable seq across two ticks ≥30s → tending, NOT settled", () => {
    const r = rtick({ prev: snap([agent("w1", "idle", 7)]), curr: snap([agent("w1", "idle", 7)]) });
    expect(r.actions.w1).toBe("tending");
  });

  it("working past the 45min budget → tending, NOT stall-check", () => {
    const r = rtick({
      prev: snap([agent("w1", "working", 3)]),
      curr: snap([agent("w1", "working", 8)]),
      workingSince: { w1: T0 - 46 * 60 * 1000 },
    });
    expect(r.actions.w1).toBe("tending");
  });

  it("blocked → attend-blocked (unblock whitelist applies)", () => {
    const r = rtick({ prev: snap([agent("w1", "working", 3)]), curr: snap([agent("w1", "blocked", 4)]) });
    expect(r.actions.w1).toBe("attend-blocked");
  });

  it("gone from a valid snapshot → escalate-gone", () => {
    const r = rtick({ prev: snap([agent("w1", "working", 3)]), curr: snap([]) });
    expect(r.actions.w1).toBe("escalate-gone");
  });

  it("done → tending (reclaim comes from the babysit terminal, not herdr done)", () => {
    const r = rtick({ prev: snap([agent("w1", "done", 9)]), curr: snap([agent("w1", "done", 9)]) });
    expect(r.actions.w1).toBe("tending");
  });

  it("unknown status → tending, never a false settle (catch-all is fail-safe)", () => {
    const r = rtick({ prev: snap([agent("w1", "unknown", 2)]), curr: snap([agent("w1", "unknown", 2)]) });
    expect(r.actions.w1).toBe("tending");
  });

  it("issue mode is the default and still settles (regression guard)", () => {
    const r = tick({ prev: snap([agent("w1", "idle", 7)]), curr: snap([agent("w1", "idle", 7)]) });
    expect(r.actions.w1).toBe("settled");
  });
});

describe("roster scoping", () => {
  it("ignores the operator's unnamed agent even when idle in both snapshots", () => {
    const prevAgents = LIVE.agents.map((a) => ({ ...a }));
    const currAgents = LIVE.agents.map((a) => ({ ...a }));
    const r = classifyTick({
      prev: snap(prevAgents),
      curr: snap(currAgents),
      prevTickAt: T0,
      currTickAt: T0 + TICK,
      roster: ["w42"],
      reclaimStatus: {},
      workingSince: {},
    });
    expect(Object.keys(r.actions)).toEqual(["w42"]);
  });
});

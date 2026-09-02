import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "./expect-shim.mjs";
import { selectIssues, selectStalledRenovatePRs, classifyDangerScope, pathsOverlap, normalizePath } from "./select.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const issue = (number, labels, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  body: "",
  labels,
  assignees: [],
  expectedFiles: null,
  ...extra,
});

const run = (issues, opts = {}) => selectIssues({ issues, openPRs: [], inFlight: [], cap: 3, ...opts });

const reasonOf = (result, number) => result.excluded.find((e) => e.number === number)?.reason;
const selectedNumbers = (result) => result.selected.map((s) => s.number);

describe("label filter", () => {
  it("accepts scope:small, rejects scope:medium", () => {
    const r = run([issue(1, ["scope:small"]), issue(2, ["scope:medium"])]);
    expect(selectedNumbers(r)).toContain(1);
    expect(reasonOf(r, 2)).toBe("label");
  });

  it("needs-human wins over a positive label", () => {
    const r = run([issue(3, ["autofix-candidate", "needs-human"])]);
    expect(reasonOf(r, 3)).toBe("needs-human");
  });

  it("matches labels by exact equality, not prefix", () => {
    const r = run([issue(4, ["scope:smallish"])]);
    expect(reasonOf(r, 4)).toBe("label");
  });

  it("source contains no prefix-glob label matching (dangerous form absent)", () => {
    const src = readFileSync(join(HERE, "select.mjs"), "utf8");
    // The classifier-guard learning: pin the matching rule, not just the list.
    expect(src).not.toMatch(/label\w*\.startsWith\(/i);
    expect(src).toMatch(/POSITIVE_LABELS\.has\(/);
  });

  it("applies an explicit label filter on top of the positive set", () => {
    const r = run([issue(5, ["scope:small"]), issue(6, ["scope:small", "work:platform"])], {
      filter: "work:platform",
    });
    expect(selectedNumbers(r)).toEqual([6]);
    expect(reasonOf(r, 5)).toBe("filter");
  });
});

describe("prod/ops/secrets classifier", () => {
  it("excludes an issue whose expected files include a workflow", () => {
    const r = run([issue(7, ["scope:small"], { expectedFiles: [".github/workflows/deploy.yml"] })]);
    expect(reasonOf(r, 7)).toBe("prod-ops-secrets");
  });

  it("excludes an issue whose body asks to rotate a secret", () => {
    const r = run([issue(8, ["scope:small"], { body: "We need to rotate the production API secret." })]);
    expect(reasonOf(r, 8)).toBe("prod-ops-secrets");
  });

  it("keeps an issue that mentions secrets only inside a URL", () => {
    const r = run([
      issue(9, ["scope:small"], { body: "See https://docs.example.com/secrets-guide for background on the tooltip fix." }),
    ]);
    expect(selectedNumbers(r)).toContain(9);
  });

  it("classifyDangerScope is exported and deterministic", () => {
    expect(classifyDangerScope({ body: "delete the sandbox stacks", title: "", expectedFiles: [] })).toBe(true);
    expect(classifyDangerScope({ body: "add a tooltip", title: "", expectedFiles: ["src/App.tsx"] })).toBe(false);
  });

  it("excludes issues touching .husky or .claude control surfaces", () => {
    const r = run([
      issue(30, ["scope:small"], { expectedFiles: [".husky/pre-push"] }),
      issue(31, ["scope:small"], { expectedFiles: [".claude/settings.json"] }),
    ]);
    expect(reasonOf(r, 30)).toBe("prod-ops-secrets");
    expect(reasonOf(r, 31)).toBe("prod-ops-secrets");
  });

  it("excludes an issue by a dangerous label alone", () => {
    const r = run([issue(32, ["scope:small", "ops"])]);
    expect(reasonOf(r, 32)).toBe("prod-ops-secrets");
  });

  it("excludes a bare root credential filename with no path separator", () => {
    expect(classifyDangerScope({ body: "", title: "", expectedFiles: ["credentials.json"] })).toBe(true);
    expect(classifyDangerScope({ body: "", title: "", expectedFiles: ["client-credentials.ts"] })).toBe(true);
  });
});

describe("claimed exclusion", () => {
  it("excludes an issue with an assignee", () => {
    const r = run([issue(10, ["scope:small"], { assignees: ["someone"] })]);
    expect(reasonOf(r, 10)).toBe("claimed");
  });

  it("excludes an issue referenced by an open PR", () => {
    const r = selectIssues({
      issues: [issue(11, ["scope:small"])],
      openPRs: [{ number: 500, title: "fix stuff", body: "Closes #11", headRefName: "fix-11-stuff" }],
      inFlight: [],
      cap: 3,
    });
    expect(reasonOf(r, 11)).toBe("claimed");
  });

  it("excludes an issue whose number appears in an open PR branch name", () => {
    const r = selectIssues({
      issues: [issue(12, ["scope:small"])],
      openPRs: [{ number: 501, title: "wip", body: "", headRefName: "chore-12-thing" }],
      inFlight: [],
      cap: 3,
    });
    expect(reasonOf(r, 12)).toBe("claimed");
  });

  it("recognizes a slash-style branch (fix/42-auth) as claiming issue 42", () => {
    const r = selectIssues({
      issues: [issue(42, ["scope:small"])],
      openPRs: [{ number: 502, title: "wip", body: "", headRefName: "fix/42-auth" }],
      inFlight: [],
      cap: 3,
    });
    expect(reasonOf(r, 42)).toBe("claimed");
  });

  it("does not claim on a coincidental number substring (142 vs 42)", () => {
    const r = selectIssues({
      issues: [issue(42, ["scope:small"], { expectedFiles: ["src/a.ts"] })],
      openPRs: [{ number: 503, title: "wip", body: "", headRefName: "fix-142-thing" }],
      inFlight: [],
      cap: 3,
    });
    expect(selectedNumbers(r)).toContain(42);
  });
});

describe("overlap and greedy batch reservation", () => {
  it("pathsOverlap respects path segment boundaries", () => {
    expect(pathsOverlap(["src/foo/a.ts"], ["src/foo"])).toBe(true);
    expect(pathsOverlap(["src/foobar/a.ts"], ["src/foo"])).toBe(false);
    expect(pathsOverlap(["src/a.ts"], ["src/a.ts"])).toBe(true);
  });

  it("excludes a candidate overlapping an in-flight worker", () => {
    const r = selectIssues({
      issues: [issue(13, ["scope:small"], { expectedFiles: ["src/components/Board/Board.tsx"] })],
      openPRs: [],
      inFlight: [{ issue: 99, files: ["src/components/Board"], degraded: false }],
      cap: 3,
    });
    expect(reasonOf(r, 13)).toBe("overlap");
  });

  it("greedily reserves within the batch: two overlapping eligibles pick only the higher-ranked", () => {
    const r = run([
      issue(14, ["agent-ready"], { expectedFiles: ["src/hooks/useThing.ts"] }),
      issue(15, ["scope:small"], { expectedFiles: ["src/hooks"] }),
    ]);
    expect(selectedNumbers(r)).toEqual([14]);
    expect(reasonOf(r, 15)).toBe("overlap");
  });

  it("disjoint candidates both spawn", () => {
    const r = run([
      issue(16, ["scope:small"], { expectedFiles: ["src/a.ts"] }),
      issue(17, ["scope:small"], { expectedFiles: ["src/b.ts"] }),
    ]);
    expect(selectedNumbers(r)).toEqual([16, 17]);
  });

  it("normalizes ./ paths so a leading-dot candidate still overlaps its sibling", () => {
    expect(pathsOverlap(["./src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(normalizePath("./src//a.ts/")).toBe("src/a.ts");
    const r = selectIssues({
      issues: [issue(40, ["scope:small"], { expectedFiles: ["./src/a.ts"] })],
      openPRs: [],
      inFlight: [{ issue: 99, files: ["src/a.ts"], degraded: false }],
      cap: 3,
    });
    expect(reasonOf(r, 40)).toBe("overlap");
  });
});

describe("degraded candidates", () => {
  it("flags a candidate with no file info as degraded and selects at most one", () => {
    const r = run([issue(18, ["scope:small"]), issue(19, ["scope:small"])]);
    const first = r.selected.find((s) => s.number === 18);
    expect(first.degraded).toBe(true);
    expect(reasonOf(r, 19)).toBe("degraded-cap");
  });

  it("excludes all degraded candidates while a degraded worker is in flight", () => {
    const r = selectIssues({
      issues: [issue(20, ["scope:small"])],
      openPRs: [],
      inFlight: [{ issue: 98, files: null, degraded: true }],
      cap: 3,
    });
    expect(reasonOf(r, 20)).toBe("degraded-cap");
  });
});

describe("ranking, cap, and drain", () => {
  it("ranks agent-ready before scope:small, stable by number for ties", () => {
    const r = run([
      issue(23, ["scope:small"], { expectedFiles: ["src/c.ts"] }),
      issue(21, ["agent-ready"], { expectedFiles: ["src/a.ts"] }),
      issue(22, ["scope:small"], { expectedFiles: ["src/b.ts"] }),
    ]);
    expect(selectedNumbers(r)).toEqual([21, 22, 23]);
  });

  it("caps the selected batch and queues the remainder", () => {
    const r = run(
      [
        issue(24, ["agent-ready"], { expectedFiles: ["src/a.ts"] }),
        issue(25, ["agent-ready"], { expectedFiles: ["src/b.ts"] }),
        issue(26, ["agent-ready"], { expectedFiles: ["src/c.ts"] }),
        issue(27, ["agent-ready"], { expectedFiles: ["src/d.ts"] }),
      ],
      { cap: 3 },
    );
    expect(selectedNumbers(r)).toEqual([24, 25, 26]);
    expect(r.backlog.map((b) => b.number)).toEqual([27]);
  });

  it("empty backlog yields a drain signal, not an error", () => {
    const r = run([]);
    expect(r.selected).toEqual([]);
    expect(r.drain).toBe(true);
  });

  it("caps the TOTAL roster: budget subtracts in-flight workers", () => {
    const r = selectIssues({
      issues: [
        issue(50, ["agent-ready"], { expectedFiles: ["src/p.ts"] }),
        issue(51, ["agent-ready"], { expectedFiles: ["src/q.ts"] }),
      ],
      openPRs: [],
      inFlight: [
        { issue: 90, files: ["src/x.ts"], degraded: false },
        { issue: 91, files: ["src/y.ts"], degraded: false },
      ],
      cap: 3,
    });
    // 2 in flight + cap 3 → budget 1: only the top-ranked candidate selects.
    expect(selectedNumbers(r)).toEqual([50]);
    expect(r.backlog.map((b) => b.number)).toEqual([51]);
  });

  it("a non-finite cap fails closed to the default, never unbounded", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      issue(60 + i, ["scope:small"], { expectedFiles: [`src/f${i}.ts`] }),
    );
    const r = selectIssues({ issues: many, openPRs: [], inFlight: [], cap: NaN });
    expect(r.selected.length).toBe(3);
  });

  it("transient-only exclusions do NOT drain (backfill must retry them)", () => {
    const r = selectIssues({
      issues: [issue(70, ["scope:small"], { expectedFiles: ["src/x.ts"] })],
      openPRs: [],
      inFlight: [{ issue: 88, files: ["src/x.ts"], degraded: false }],
      cap: 3,
    });
    expect(reasonOf(r, 70)).toBe("overlap");
    expect(r.deferred).toBe(1);
    expect(r.drain).toBe(false);
  });
});

// --- Renovate lane --------------------------------------------------------

const check = (name, conclusion, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});

// A CheckRun that has not decided yet (pending).
const pendingCheck = (name) => check(name, null, "IN_PROGRESS");

// A legacy commit-status entry (the shape an external CI reporter posts).
const statusContext = (context, state) => ({ __typename: "StatusContext", context, state });

const pr = (number, extra = {}) => ({
  number,
  title: `renovate PR ${number}`,
  headRefName: `fix-dep-thing-${number}`,
  isDraft: false,
  author: { login: "app/renovate", is_bot: true },
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
  statusCheckRollup: [check("vitest (1/4)", "SUCCESS")],
  ...extra,
});

const rrun = (prs, opts = {}) => selectStalledRenovatePRs({ prs, inFlight: [], escalated: [], cap: 3, ...opts });
const rSelected = (r) => r.selected.map((s) => s.number);

describe("renovate lane: stalled predicate", () => {
  for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]) {
    it(`a required check with conclusion ${conclusion} → selected (stalled)`, () => {
      const r = rrun([pr(100, { statusCheckRollup: [check("vitest (1/4)", conclusion)] })]);
      expect(rSelected(r)).toEqual([100]);
    });
  }

  it("merge state DIRTY → selected even with all checks green", () => {
    const r = rrun([pr(101, { mergeStateStatus: "DIRTY" })]);
    expect(rSelected(r)).toEqual([101]);
  });

  it("merge state BEHIND → selected", () => {
    const r = rrun([pr(102, { mergeStateStatus: "BEHIND" })]);
    expect(rSelected(r)).toEqual([102]);
  });

  it("all checks SUCCESS + CLEAN → excluded not-stalled", () => {
    const r = rrun([pr(103)]);
    expect(reasonOf(r, 103)).toBe("not-stalled");
  });

  it("empty rollup → undecided, never selected, never green", () => {
    const r = rrun([pr(104, { statusCheckRollup: [], mergeStateStatus: "UNSTABLE" })]);
    expect(reasonOf(r, 104)).toBe("undecided");
  });

  it("still-pending rollup → undecided", () => {
    const r = rrun([pr(105, { statusCheckRollup: [pendingCheck("vitest (1/4)")], mergeStateStatus: "UNSTABLE" })]);
    expect(reasonOf(r, 105)).toBe("undecided");
  });

  it("UNKNOWN merge-state → undecided (never recorded green)", () => {
    const r = rrun([pr(106, { mergeStateStatus: "UNKNOWN" })]);
    expect(reasonOf(r, 106)).toBe("undecided");
  });
});

describe("renovate lane: eligibility", () => {
  it("draft Renovate PR → excluded draft", () => {
    const r = rrun([pr(110, { isDraft: true, mergeStateStatus: "DIRTY" })]);
    expect(reasonOf(r, 110)).toBe("draft");
  });

  it("non-Renovate author on a fix-dep- branch → excluded not-renovate", () => {
    const r = rrun([pr(111, { author: { login: "someone" }, mergeStateStatus: "DIRTY" })]);
    expect(reasonOf(r, 111)).toBe("not-renovate");
  });

  it("Renovate PR on a non-fix branch → excluded not-renovate", () => {
    const r = rrun([pr(112, { headRefName: "feature-x", mergeStateStatus: "DIRTY" })]);
    expect(reasonOf(r, 112)).toBe("not-renovate");
  });

  it("PR in inFlight → claimed; PR in escalated → escalated (R7 loop guard)", () => {
    const r = rrun([pr(113, { mergeStateStatus: "DIRTY" }), pr(114, { mergeStateStatus: "DIRTY" })], {
      inFlight: [113],
      escalated: [114],
    });
    expect(reasonOf(r, 113)).toBe("claimed");
    expect(reasonOf(r, 114)).toBe("escalated");
    expect(rSelected(r)).toEqual([]);
  });
});

describe("renovate lane: required-context filter (R2a)", () => {
  it("a failing NON-required check with required checks green → not-stalled", () => {
    const r = rrun(
      [
        pr(120, {
          mergeStateStatus: "UNSTABLE",
          statusCheckRollup: [check("vitest (1/4)", "SUCCESS"), check("e2e", "FAILURE")],
        }),
      ],
      { requiredContexts: ["vitest (1/4)"] },
    );
    expect(reasonOf(r, 120)).toBe("not-stalled");
  });

  it("no required-context list → any failing check stalls", () => {
    const r = rrun(
      [pr(121, { mergeStateStatus: "UNSTABLE", statusCheckRollup: [check("e2e", "FAILURE")] })],
      { requiredContexts: null },
    );
    expect(rSelected(r)).toEqual([121]);
  });
});

describe("renovate lane: ordering, cap, drain", () => {
  it("fix-sec- sorts before fix-dep-", () => {
    const r = rrun([
      pr(130, { headRefName: "fix-dep-a", mergeStateStatus: "DIRTY" }),
      pr(131, { headRefName: "fix-sec-b", mergeStateStatus: "DIRTY" }),
    ]);
    expect(rSelected(r)).toEqual([131, 130]);
  });

  it("more stalled than budget → capped, remainder is backlog", () => {
    const prs = [140, 141, 142, 143].map((n) => pr(n, { mergeStateStatus: "DIRTY" }));
    const r = rrun(prs, { cap: 3 });
    expect(rSelected(r)).toEqual([140, 141, 142]);
    expect(r.backlog.map((b) => b.number)).toEqual([143]);
  });

  it("budget subtracts in-flight workers from the cap", () => {
    const prs = [150, 151].map((n) => pr(n, { mergeStateStatus: "DIRTY" }));
    const r = rrun(prs, { cap: 3, inFlight: [1, 2] });
    expect(rSelected(r)).toEqual([150]);
    expect(r.backlog.map((b) => b.number)).toEqual([151]);
  });

  it("empty stalled set → drain true", () => {
    const r = rrun([pr(160)]); // clean → not-stalled, nothing spawnable
    expect(r.selected).toEqual([]);
    expect(r.drain).toBe(true);
  });

  it("handles the real captured gh payload shape and reads the StatusContext stall", () => {
    const live = JSON.parse(readFileSync(join(HERE, "__fixtures__", "renovate-prs.json"), "utf8"));
    const r = selectStalledRenovatePRs({ prs: live, inFlight: [], escalated: [], cap: 3 });
    // Every fixture PR is a real Renovate PR (none read as not-renovate)…
    expect(r.excluded.every((e) => e.reason !== "not-renovate")).toBe(true);
    // …and #1912's report StatusContext is FAILURE, so it must be selected as
    // stalled — pins that the legacy-status shape is read.
    expect(r.selected.map((s) => s.number)).toContain(1912);
  });
});

describe("renovate lane: StatusContext (legacy commit-status) shape", () => {
  it("a StatusContext with state FAILURE → stalled (the external CI report case)", () => {
    const r = rrun([
      pr(200, { mergeStateStatus: "UNSTABLE", statusCheckRollup: [check("label", "SUCCESS"), statusContext("e2e/report", "FAILURE")] }),
    ]);
    expect(rSelected(r)).toEqual([200]);
  });

  it("a StatusContext with state PENDING → undecided", () => {
    const r = rrun([pr(201, { mergeStateStatus: "UNSTABLE", statusCheckRollup: [statusContext("build", "PENDING")] })]);
    expect(reasonOf(r, 201)).toBe("undecided");
  });

  it("a stateless StatusContext is inert: green CheckRun + CLEAN → not-stalled (Bug A guard)", () => {
    // The bare {__typename:"StatusContext"} placeholder gh sometimes emits must
    // not read as pending, or an all-green PR is stuck "undecided" forever.
    const r = rrun([
      pr(202, { mergeStateStatus: "CLEAN", statusCheckRollup: [check("vitest (1/4)", "SUCCESS"), { __typename: "StatusContext" }] }),
    ]);
    expect(reasonOf(r, 202)).toBe("not-stalled");
  });
});

describe("renovate lane: undecided edge cases", () => {
  it("missing/empty mergeStateStatus with a green check → undecided, never recorded green (Gap 2)", () => {
    const r = rrun([pr(210, { mergeStateStatus: "", statusCheckRollup: [check("vitest (1/4)", "SUCCESS")] })]);
    expect(reasonOf(r, 210)).toBe("undecided");
  });

  it("requiredContexts names a check absent from the rollup → undecided (Gap 3)", () => {
    const r = rrun([pr(211, { mergeStateStatus: "CLEAN", statusCheckRollup: [check("vitest (1/4)", "SUCCESS")] })], {
      requiredContexts: ["required-gate-that-never-reported"],
    });
    expect(reasonOf(r, 211)).toBe("undecided");
  });

  it("undecided is transient: it does NOT drain the run (Bug B guard)", () => {
    // A batch caught mid-CI (all pending) must keep the PM polling, not exit.
    const r = rrun([pr(212, { mergeStateStatus: "UNSTABLE", statusCheckRollup: [pendingCheck("vitest (1/4)")] })]);
    expect(rSelected(r)).toEqual([]);
    expect(reasonOf(r, 212)).toBe("undecided");
    expect(r.deferred).toBe(1);
    expect(r.drain).toBe(false);
  });
});

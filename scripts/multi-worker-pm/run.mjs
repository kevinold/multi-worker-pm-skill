#!/usr/bin/env node
// Dispatcher for the multi-worker-pm skill's deterministic logic.
//
//   node scripts/multi-worker-pm/run.mjs select [--dry-run] [--filter <label>] [--cap N] [--in-flight <json>]
//   node scripts/multi-worker-pm/run.mjs classify <prev.json> <curr.json> --roster a,b [--reclaim <json>] [--working-since <json>]
//
// The pure logic lives in select.mjs / classify.mjs; this file owns the gh
// fetches, triage.md parsing, and JSON plumbing. It uses gh's auto-detected
// {owner}/{repo}, so it never hardcodes an org or repo name — run it from
// inside a checkout of the target repo (or set GH_REPO).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { selectIssues, selectStalledRenovatePRs } from "./select.mjs";
import { classifyTick } from "./classify.mjs";

const ISSUE_LIMIT = 200;
const PR_LIMIT = 100;

// The protected base branch that PRs merge into. Auto-detected from the repo's
// default branch, overridable with MWPM_BASE_BRANCH. Used only for the
// renovate lane's required-status-check lookup (defense-in-depth, never the
// primary push guard).
const BASE_BRANCH = process.env.MWPM_BASE_BRANCH || "main";

// A transient GitHub throttle: retry once after a short backoff.
const isRateLimit = (err) => /\b429\b|rate limit|secondary rate/i.test(String(err?.message || err));
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded hang, one backoff-and-retry on a transient rate limit, named
// parse-failure error.
const EXEC_OPTS = { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120000 };

async function gh(args) {
  let raw;
  try {
    raw = execFileSync("gh", args, EXEC_OPTS);
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    await defaultSleep(2000);
    raw = execFileSync("gh", args, EXEC_OPTS);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} returned unparseable JSON`);
  }
}

// Best-effort gh: returns null on any failure (missing protection, 404, auth)
// instead of throwing. Used for the required-status-check set, which is
// optional context — its absence triggers the any-failing-check fallback.
async function ghSoft(args) {
  try {
    return await gh(args);
  } catch {
    return null;
  }
}

const argAfter = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

// An optional triage.md file (a table you maintain, or a triage step produces)
// carries expected files for agent-ready issues only; non-agent-ready rows use
// "—". Absent file → empty map, and selection falls back to issue-body
// extraction (degraded).
export function parseTriageExpectedFiles(markdown) {
  const map = new Map();
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const numIdx = cells.findIndex((c) => /^#\d+$/.test(c));
    if (numIdx < 0) continue;
    // Documented row: | #N | label | reason | expected files | verify command |
    // Read the expected-files column BY POSITION (numIdx + 3), never by "last
    // cell that looks path-y" — verify commands contain paths too and would
    // otherwise win, poisoning the overlap safety check.
    const fileCell = cells[numIdx + 3];
    if (!fileCell || fileCell === "—") continue;
    const files = fileCell
      .split(/[,\s]+/)
      .map((f) => f.replace(/^`|`$/g, ""))
      .filter((f) => f && f !== "—");
    if (files.length) map.set(Number(cells[numIdx].slice(1)), files);
  }
  return map;
}

// Cheap body extraction: backtick-quoted repo-relative paths. Anything more
// clever belongs in triage.md; unknown scope is handled by the degraded cap.
export function extractPathsFromBody(body) {
  const paths = new Set();
  for (const m of (body ?? "").matchAll(/`([\w@./-]+\/[\w@./-]+)`/g)) {
    if (!m[1].startsWith("http")) paths.add(m[1]);
  }
  return [...paths];
}

async function cmdSelect(argv) {
  const mode = argAfter(argv, "--mode") ?? "issues";
  if (mode === "renovate") return cmdSelectRenovate(argv);
  if (mode !== "issues") {
    console.error(`unknown --mode: ${mode} (expected "issues" or "renovate")`);
    process.exit(2);
  }
  const dryRun = argv.includes("--dry-run");
  const filter = argAfter(argv, "--filter") ?? null;
  // Fail closed: a non-finite --cap falls back to the default cap rather than
  // silently disabling the cap (NaN >= comparisons are always false).
  const rawCap = Number(argAfter(argv, "--cap") ?? 3);
  const cap = Number.isFinite(rawCap) ? rawCap : 3; // selectIssues hard-caps at 3
  const inFlight = JSON.parse(argAfter(argv, "--in-flight") ?? "[]");

  const rawIssues = await gh([
    "issue", "list", "--state", "open",
    "--json", "number,title,body,labels,assignees",
    "--limit", String(ISSUE_LIMIT),
  ]);
  if (rawIssues.length >= ISSUE_LIMIT) {
    console.error(
      `gh issue list returned ${rawIssues.length} rows (limit ${ISSUE_LIMIT}) — possible truncation; refusing to select from a partial backlog`,
    );
    process.exit(1);
  }
  const openPRs = await gh(["pr", "list", "--state", "open", "--json", "number,title,body,headRefName", "--limit", String(PR_LIMIT)]);
  if (openPRs.length >= PR_LIMIT) {
    console.error(`gh pr list returned ${openPRs.length} rows (limit ${PR_LIMIT}) — possible truncation; claimed-issue detection would be partial`);
    process.exit(1);
  }

  let triageFiles = new Map();
  try {
    triageFiles = parseTriageExpectedFiles(readFileSync("triage.md", "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const issues = rawIssues.map((i) => {
    const bodyPaths = extractPathsFromBody(i.body);
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      labels: (i.labels ?? []).map((l) => l.name),
      assignees: (i.assignees ?? []).map((a) => a.login),
      expectedFiles: triageFiles.get(i.number) ?? (bodyPaths.length ? bodyPaths : null),
    };
  });

  const result = selectIssues({ issues, openPRs, inFlight, cap, filter });
  const out = {
    mode: dryRun ? "dry-run" : "select",
    inFlightAssumption: inFlight.length === 0 ? "empty pool assumed (no --in-flight supplied)" : "live roster supplied",
    ...result,
  };
  console.log(JSON.stringify(out, null, 2));
  if (dryRun) {
    const list = result.selected.map((s) => `#${s.number}${s.degraded ? " (degraded scope)" : ""}`).join(", ") || "none";
    console.error(`\n[dry-run] would spawn ${result.selected.length} worker(s): ${list}`);
    console.error("[dry-run] this lists what would launch — it is not proof the run would succeed");
  }
}

// Required-status-check names from branch protection on the base branch. Legacy
// branch-protection API; null when unreadable (repo unprotected, or required
// checks enforced via rulesets rather than this endpoint) → the
// any-failing-check fallback applies. Protection is defense-in-depth for the
// push, never the primary guard (that is the own-ref push pin, rule 5/R5).
async function fetchRequiredContexts() {
  const legacy = await ghSoft([
    "api",
    `repos/{owner}/{repo}/branches/${BASE_BRANCH}/protection/required_status_checks`,
    "--jq", ".contexts",
  ]);
  if (Array.isArray(legacy) && legacy.length) return legacy;
  return null;
}

async function cmdSelectRenovate(argv) {
  const dryRun = argv.includes("--dry-run");
  const rawCap = Number(argAfter(argv, "--cap") ?? 3);
  const cap = Number.isFinite(rawCap) ? rawCap : 3; // selectStalledRenovatePRs hard-caps at 3
  const inFlight = JSON.parse(argAfter(argv, "--in-flight") ?? "[]"); // PR numbers being tended
  const escalated = JSON.parse(argAfter(argv, "--escalated") ?? "[]"); // PR numbers durably excluded (R7)

  const prs = await gh([
    "pr", "list", "--app", "renovate", "--state", "open",
    "--json", "number,title,headRefName,isDraft,author,statusCheckRollup",
    "--limit", String(PR_LIMIT),
  ]);
  if (prs.length >= PR_LIMIT) {
    console.error(`gh pr list --app renovate returned ${prs.length} rows (limit ${PR_LIMIT}) — possible truncation; refusing to select from a partial set`);
    process.exit(1);
  }

  // Bulk gh pr list returns mergeStateStatus UNKNOWN for un-computed
  // mergeability; a per-PR gh pr view forces the async compute (R2a). The
  // statusCheckRollup from the bulk list is reliable and reused. A PR deleted
  // or erroring between the list and the view is skipped (ghSoft → null), not
  // fatal — it re-appears on the next tick's fetch.
  const enriched = [];
  for (const pr of prs) {
    const view = await ghSoft(["pr", "view", String(pr.number), "--json", "mergeStateStatus"]);
    if (!view) {
      console.error(`gh pr view #${pr.number} failed — skipping this PR for this tick`);
      continue;
    }
    enriched.push({ ...pr, mergeStateStatus: view.mergeStateStatus });
  }

  const requiredContexts = await fetchRequiredContexts();

  const result = selectStalledRenovatePRs({ prs: enriched, inFlight, escalated, requiredContexts, cap });
  const out = {
    mode: dryRun ? "dry-run" : "select",
    lane: "renovate",
    requiredContexts: requiredContexts ?? "unavailable (any-failing-check fallback)",
    inFlightAssumption: inFlight.length === 0 ? "empty pool assumed (no --in-flight supplied)" : "live roster supplied",
    ...result,
  };
  console.log(JSON.stringify(out, null, 2));
  if (dryRun) {
    const list = result.selected.map((s) => `#${s.number} (${s.security ? "sec " : ""}${s.reason})`).join(", ") || "none";
    console.error(`\n[dry-run] would tend ${result.selected.length} stalled Renovate PR(s): ${list}`);
    console.error("[dry-run] this lists what would launch — it is not proof each tend would reach green");
  }
}

const USAGE_CLASSIFY =
  "usage: run.mjs classify <prev.json> <curr.json> --roster a,b --prev-at <ms> --curr-at <ms> [--reclaim <json>] [--working-since <json>]";

function cmdClassify(argv) {
  const [prevPath, currPath] = argv.filter((a) => !a.startsWith("--") && a.endsWith(".json"));
  const roster = (argAfter(argv, "--roster") ?? "").split(",").filter(Boolean);
  // Timestamps and roster are required — no wall-clock or epoch-zero defaults.
  // A dropped --prev-at would otherwise make the 30s settle interval (now - 0)
  // trivially pass, defeating the idle-beat defense; an empty roster would
  // silently monitor nothing.
  const prevTickAt = Number(argAfter(argv, "--prev-at"));
  const currTickAt = Number(argAfter(argv, "--curr-at"));
  if (!prevPath || !currPath || roster.length === 0 || !Number.isFinite(prevTickAt) || !Number.isFinite(currTickAt)) {
    console.error(USAGE_CLASSIFY);
    process.exit(2);
  }
  const result = classifyTick({
    prev: JSON.parse(readFileSync(prevPath, "utf8")),
    curr: JSON.parse(readFileSync(currPath, "utf8")),
    prevTickAt,
    currTickAt,
    roster,
    reclaimStatus: JSON.parse(argAfter(argv, "--reclaim") ?? "{}"),
    workingSince: JSON.parse(argAfter(argv, "--working-since") ?? "{}"),
    mode: argAfter(argv, "--mode") ?? "issues",
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "select") await cmdSelect(rest);
  else if (cmd === "classify") cmdClassify(rest);
  else {
    console.error("usage: run.mjs <select|classify> [...]");
    process.exit(2);
  }
}

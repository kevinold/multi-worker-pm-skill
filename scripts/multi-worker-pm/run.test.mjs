import { describe, it, expect } from "./expect-shim.mjs";
import { parseTriageExpectedFiles, extractPathsFromBody } from "./run.mjs";

describe("parseTriageExpectedFiles", () => {
  // Documented row: | #N | label | reason | expected files | verify command |
  const table = [
    "| Issue | Label | Reason | Expected files | Verify |",
    "|---|---|---|---|---|",
    "| #123 | agent-ready | tooltip copy wrong | `src/components/Foo.tsx` | `npx vitest run src/components/__test__/Foo.test.tsx` |",
    "| #200 | scope:small | ambiguous | — | — |",
  ].join("\n");

  it("reads the expected-files column by position, never the verify command", () => {
    const map = parseTriageExpectedFiles(table);
    // The verify command also contains a slash — a last-path-y-cell heuristic
    // would wrongly pick it. Position wins.
    expect(map.get(123)).toEqual(["src/components/Foo.tsx"]);
  });

  it("skips rows whose files column is the em-dash placeholder", () => {
    const map = parseTriageExpectedFiles(table);
    expect(map.has(200)).toBe(false);
  });

  it("returns an empty map for markdown with no issue rows", () => {
    expect(parseTriageExpectedFiles("no table here").size).toBe(0);
  });
});

describe("extractPathsFromBody", () => {
  it("extracts backtick-quoted repo-relative paths", () => {
    expect(extractPathsFromBody("Fix `src/a/b.ts` please")).toEqual(["src/a/b.ts"]);
  });

  it("excludes backtick-quoted URLs", () => {
    expect(extractPathsFromBody("see `https://example.com/docs/x` and `src/x.ts`")).toEqual(["src/x.ts"]);
  });

  it("returns [] for a body with no backtick paths", () => {
    expect(extractPathsFromBody("just prose, no paths")).toEqual([]);
    expect(extractPathsFromBody(undefined)).toEqual([]);
  });
});

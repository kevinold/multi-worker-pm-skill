// Tiny zero-dependency vitest-style `expect` over node:assert, so the tests
// run under the built-in runner (`node --test`) with no packages installed.
// Re-exports describe/it/test from node:test so a test file's only change from
// a vitest import is the module specifier.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

export { describe, it, test };

class Expectation {
  constructor(actual, negated = false) {
    this.actual = actual;
    this.negated = negated;
  }

  get not() {
    return new Expectation(this.actual, !this.negated);
  }

  toBe(expected) {
    if (this.negated) assert.notStrictEqual(this.actual, expected);
    else assert.strictEqual(this.actual, expected);
  }

  toEqual(expected) {
    if (this.negated) assert.notDeepStrictEqual(this.actual, expected);
    else assert.deepStrictEqual(this.actual, expected);
  }

  toContain(item) {
    const has = this.actual.includes(item);
    assert.ok(
      this.negated ? !has : has,
      `expected ${JSON.stringify(this.actual)} ${this.negated ? "not " : ""}to contain ${JSON.stringify(item)}`,
    );
  }

  toMatch(re) {
    if (this.negated) assert.doesNotMatch(String(this.actual), re);
    else assert.match(String(this.actual), re);
  }

  toThrow(expected) {
    // this.actual is a function that should throw synchronously.
    if (this.negated) assert.doesNotThrow(this.actual);
    else assert.throws(this.actual, expected);
  }

  toBeUndefined() {
    if (this.negated) assert.notStrictEqual(this.actual, undefined);
    else assert.strictEqual(this.actual, undefined);
  }
}

export function expect(actual) {
  return new Expectation(actual);
}

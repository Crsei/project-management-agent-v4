import assert from "node:assert/strict";
import test from "node:test";
import { findMatchRanges, nextMatchIndex } from "./thread-find-model.ts";

test("find matches are case-insensitive, literal, non-overlapping and bounded", () => {
  assert.deepEqual(findMatchRanges([], "x"), []);
  assert.deepEqual(findMatchRanges(["alpha"], "  "), []);
  assert.deepEqual(findMatchRanges(["Abc abc ABC"], "abc").map(r => [r.start, r.end]), [[0, 3], [4, 7], [8, 11]]);
  assert.deepEqual(findMatchRanges(["aaaa"], "aa").map(r => r.start), [0, 2]);
  assert.deepEqual(findMatchRanges(["a.a"], "."), [{ textIndex: 0, start: 1, end: 2 }]);
  assert.equal(findMatchRanges(["aaaa", "aaaa"], "a", 3).length, 3);
  assert.equal(findMatchRanges(["x"], "y").length, 0);
});

test("find navigation wraps and stays empty-safe", () => {
  assert.equal(nextMatchIndex(-1, 0, 1), -1);
  assert.equal(nextMatchIndex(-1, 3, 1), 0);
  assert.equal(nextMatchIndex(-1, 3, -1), 2);
  assert.equal(nextMatchIndex(2, 3, 1), 0);
  assert.equal(nextMatchIndex(0, 3, -1), 2);
});

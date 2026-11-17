import assert from "node:assert/strict";
import test from "node:test";
import { resolveActiveMinimapIndex } from "./thread-minimap-model.ts";

test("minimap active index follows the reading line and stays empty-safe", () => {
  assert.equal(resolveActiveMinimapIndex([], 0, 100), -1);
  assert.equal(resolveActiveMinimapIndex([{ top: 0 }, { top: 50 }, { top: 90 }], 0, 100), 0);
  assert.equal(resolveActiveMinimapIndex([{ top: 0 }, { top: 50 }, { top: 90 }], 45, 100), 0);
  assert.equal(resolveActiveMinimapIndex([{ top: 0 }, { top: 50 }, { top: 90 }], 55, 100), 1);
  assert.equal(resolveActiveMinimapIndex([{ top: 0 }, { top: 50 }, { top: 90 }], 100, 100), 2);
});

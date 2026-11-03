import assert from "node:assert/strict";
import test from "node:test";
import { captureWindowState, restoredWindowBounds } from "./window-state.mjs";

const defaults = { width: 1100, height: 800, minWidth: 620, minHeight: 640 };
const displays = [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];

test("offscreen and invalid window state uses visible defaults", () => {
  assert.deepEqual(restoredWindowBounds({ x: 9000, y: 0, width: 800, height: 700 }, defaults, displays), defaults);
  assert.deepEqual(restoredWindowBounds({ x: 0, y: 0, width: "800", height: 700 }, defaults, displays), defaults);
});

test("restored geometry remains in the current display work area", () => {
  assert.deepEqual(restoredWindowBounds({ x: 1300, y: -10, width: 1600, height: 1000 }, defaults, displays), {
    ...defaults, x: 0, y: 0, width: 1440, height: 900,
  });
  const window = { isDestroyed: () => false, getNormalBounds: () => ({ x: 1, y: 2, width: 800, height: 700, secret: "not geometry" }), isMaximized: () => true };
  assert.deepEqual(captureWindowState(window), { x: 1, y: 2, width: 800, height: 700, maximized: true });
  assert.equal(captureWindowState({ isDestroyed: () => true }), undefined);
});

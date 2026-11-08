import assert from "node:assert/strict";
import test from "node:test";
import {
  MACOS_TITLEBAR_HEIGHT, macosWindowButtonPosition, normalizeTitleBarTheme,
  TITLEBAR_HEIGHT, titleBarOverlay, windowTitleBarOptions,
} from "./window-chrome.mjs";

test("Windows and Linux use a transparent native overlay with theme-aware symbols", () => {
  assert.deepEqual(windowTitleBarOptions("win32", "light"), {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#01000000",
      height: TITLEBAR_HEIGHT,
      symbolColor: "#232322",
    },
  });
  assert.deepEqual(windowTitleBarOptions("linux", "dark").titleBarOverlay, {
    color: "#01000000",
    height: TITLEBAR_HEIGHT,
    symbolColor: "#ecece8",
  });
  assert.equal(TITLEBAR_HEIGHT, 40);
});

test("macOS keeps native traffic lights inset without an overlay", () => {
  assert.deepEqual(windowTitleBarOptions("darwin", "dark"), {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: Math.round(MACOS_TITLEBAR_HEIGHT / 2 - 7) },
  });
  assert.equal("titleBarOverlay" in windowTitleBarOptions("darwin"), false);
});

test("invalid themes fall back to light and macOS buttons track zoom", () => {
  assert.equal(normalizeTitleBarTheme("system"), null);
  assert.deepEqual(titleBarOverlay("unknown"), titleBarOverlay("light"));
  assert.deepEqual(macosWindowButtonPosition(1.5), {
    x: 16,
    y: Math.round((MACOS_TITLEBAR_HEIGHT * 1.5) / 2 - 7),
  });
  assert.deepEqual(macosWindowButtonPosition(Number.NaN), macosWindowButtonPosition(1));
});

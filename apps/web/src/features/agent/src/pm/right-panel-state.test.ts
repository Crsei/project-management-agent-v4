import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RIGHT_PANEL_STATE,
  pmRightPanelReducer,
  pmRightPanelSurfaceTitle,
  type PmRightPanelAction,
  type PmRightPanelState,
} from "./right-panel-state.ts";

const apply = (actions: PmRightPanelAction[], state = EMPTY_RIGHT_PANEL_STATE): PmRightPanelState =>
  actions.reduce(pmRightPanelReducer, state);

test("opening a surface activates it and repeats reuse singleton tabs", () => {
  const files = apply([{ type: "add", kind: "files" }]);
  assert.equal(files.activeId, "files");
  assert.equal(files.surfaces.length, 1);

  const repeated = apply([{ type: "add", kind: "files" }], files);
  assert.equal(repeated.surfaces.length, 1);
  assert.equal(repeated.activeId, "files");

  const terminal = apply([
    { type: "add", kind: "terminal" },
    { type: "add", kind: "terminal" },
  ]);
  assert.deepEqual(
    terminal.surfaces.map((surface) => surface.id),
    ["terminal"],
  );
  assert.equal(terminal.activeId, "terminal");
  assert.deepEqual(terminal.nextOrdinal, { browser: 0 });
});

test("closing the active tab selects its right neighbor, then its left neighbor", () => {
  const opened = apply([
    { type: "add", kind: "files" },
    { type: "add", kind: "browser" },
    { type: "add", kind: "terminal" },
  ]);
  const middleClosed = pmRightPanelReducer(opened, { type: "close", id: "browser:1" });
  assert.deepEqual(
    middleClosed.surfaces.map((surface) => surface.id),
    ["files", "terminal"],
  );
  assert.equal(middleClosed.activeId, "terminal");

  const lastClosed = pmRightPanelReducer(middleClosed, { type: "close", id: "terminal" });
  assert.equal(lastClosed.activeId, "files");

  const empty = pmRightPanelReducer(lastClosed, { type: "close", id: "files" });
  assert.deepEqual(empty.surfaces, []);
  assert.equal(empty.activeId, null);
});

test("closing a background tab keeps the active surface", () => {
  const opened = apply([
    { type: "add", kind: "files" },
    { type: "add", kind: "terminal" },
  ]);
  const closed = pmRightPanelReducer(opened, { type: "close", id: "files" });
  assert.equal(closed.activeId, "terminal");
  assert.deepEqual(closed.surfaces.map((surface) => surface.id), ["terminal"]);
});

test("close others, close to the right, and close all keep the panel state coherent", () => {
  const opened = apply([
    { type: "add", kind: "files" },
    { type: "add", kind: "browser" },
    { type: "add", kind: "terminal" },
  ]);

  const toRight = pmRightPanelReducer(opened, { type: "close-to-right", id: "browser:1" });
  assert.deepEqual(toRight.surfaces.map((surface) => surface.id), ["files", "browser:1"]);
  assert.equal(toRight.activeId, "browser:1");

  const others = pmRightPanelReducer(opened, { type: "close-others", id: "browser:1" });
  assert.deepEqual(others.surfaces.map((surface) => surface.id), ["browser:1"]);
  assert.equal(others.activeId, "browser:1");

  const all = pmRightPanelReducer(opened, { type: "close-all" });
  assert.deepEqual(all.surfaces, []);
  assert.equal(all.activeId, null);
  assert.deepEqual(all.nextOrdinal, { browser: 1 });
});

test("moving a tab preserves the active surface and clamps the target index", () => {
  const opened = apply([
    { type: "add", kind: "files" },
    { type: "add", kind: "browser" },
    { type: "add", kind: "terminal" },
  ]);
  const moved = pmRightPanelReducer(opened, { type: "move", id: "terminal", toIndex: 0 });
  assert.deepEqual(moved.surfaces.map((surface) => surface.id), ["terminal", "files", "browser:1"]);
  assert.equal(moved.activeId, "terminal");

  const tail = pmRightPanelReducer(moved, { type: "move", id: "terminal", toIndex: 99 });
  assert.deepEqual(tail.surfaces.map((surface) => surface.id), ["files", "browser:1", "terminal"]);
});

test("unknown ids do not mutate the state", () => {
  const opened = apply([{ type: "add", kind: "files" }]);
  assert.equal(pmRightPanelReducer(opened, { type: "activate", id: "missing" }), opened);
  assert.equal(pmRightPanelReducer(opened, { type: "close", id: "missing" }), opened);
  assert.equal(pmRightPanelReducer(opened, { type: "move", id: "missing", toIndex: 0 }), opened);
});

test("titles use the active locale and surface ordinal", () => {
  const zh = (value: string) => value;
  const en = (_zh: string, value: string) => value;
  assert.equal(
    pmRightPanelSurfaceTitle({ id: "files", kind: "files" }, zh),
    "文件",
  );
  assert.equal(
    pmRightPanelSurfaceTitle({ id: "terminal", kind: "terminal" }, zh),
    "终端",
  );
  assert.equal(
    pmRightPanelSurfaceTitle({ id: "browser:1", kind: "browser", ordinal: 1 }, en),
    "Browser 1",
  );
  assert.equal(
    pmRightPanelSurfaceTitle({ id: "browser:1", kind: "browser", ordinal: 1, title: "EasyuseUI · 项目管理" }, en),
    "EasyuseUI · 项目管理",
  );
});

test("browser title updates are idempotent", () => {
  const opened = apply([{ type: "add", kind: "browser" }]);
  const titled = pmRightPanelReducer(opened, { type: "title", id: "browser:1", title: "Preview" });
  assert.equal(titled.surfaces[0]?.title, "Preview");
  assert.equal(pmRightPanelReducer(titled, { type: "title", id: "browser:1", title: "Preview" }), titled);
  assert.equal(pmRightPanelReducer(titled, { type: "title", id: "browser:1", title: "   " }), titled);
  assert.equal(pmRightPanelReducer(titled, { type: "title", id: "missing", title: "x" }), titled);
});

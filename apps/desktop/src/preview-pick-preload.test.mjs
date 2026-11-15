import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./preview-pick-preload.cjs", import.meta.url), "utf8");

function loadPicker() {
  const window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2 });
  const channels = new Map();
  const sent = [];
  const element = {
    id: "selected", tagName: "BUTTON", nodeType: 1, className: "", innerText: "Chosen element",
    closest: () => null,
    getBoundingClientRect: () => ({ left: 20, top: 30, right: 140, bottom: 90 }),
  };
  const document = {
    documentElement: { append() {} },
    createElement: () => ({ style: {}, setAttribute() {}, append() {}, remove() {} }),
    elementFromPoint: () => element,
    querySelectorAll: () => [element],
  };
  runInNewContext(source, {
    window, document,
    require(name) {
      assert.equal(name, "electron");
      return { ipcRenderer: {
        on: (channel, listener) => channels.set(channel, listener),
        send: (channel, payload) => sent.push({ channel, payload: structuredClone(payload) }),
      } };
    },
  });
  const dispatch = (type, properties = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { clientX: 40, clientY: 50 }, properties);
    window.dispatchEvent(event);
    return event;
  };
  return { window, sent, dispatch, start: () => channels.get("pm-preview:start-pick")({}, {}) };
}

test("selection consumes the entire gesture before page handlers, then restores ordinary clicks", () => {
  const picker = loadPicker();
  const pageGestures = [];
  const gesture = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  // Page scripts run after the preload but can register before picking starts.
  for (const type of gesture) picker.window.addEventListener(type, () => pageGestures.push(type), true);
  picker.start();
  for (const type of gesture.slice(0, -1)) {
    assert.equal(picker.dispatch(type).defaultPrevented, true);
  }
  assert.equal(picker.dispatch("click").defaultPrevented, true);
  assert.deepEqual(pageGestures, []);
  assert.deepEqual(picker.sent, [{ channel: "pm-preview:element-picked", payload: {
    selector: "#selected", tagName: "button", text: "Chosen element",
    rect: { x: 20, y: 30, width: 120, height: 60 }, dpr: 2,
  } }]);
  for (const type of gesture) assert.equal(picker.dispatch(type).defaultPrevented, false);
  assert.deepEqual(pageGestures, gesture);
});

test("non-primary actions remain blocked until Escape cancels without a selection", () => {
  const picker = loadPicker();
  const pageActions = [];
  for (const type of ["contextmenu", "auxclick", "keydown"]) {
    picker.window.addEventListener(type, () => pageActions.push(type), true);
  }
  picker.start();
  assert.equal(picker.dispatch("contextmenu").defaultPrevented, true);
  assert.equal(picker.dispatch("auxclick").defaultPrevented, true);
  assert.equal(picker.sent.length, 0);
  assert.equal(picker.dispatch("keydown", { key: "Escape" }).defaultPrevented, true);
  assert.deepEqual(pageActions, []);
  assert.deepEqual(picker.sent, [{ channel: "pm-preview:pick-cancelled", payload: undefined }]);
  assert.equal(picker.dispatch("contextmenu").defaultPrevented, false);
  assert.equal(picker.dispatch("keydown", { key: "Escape" }).defaultPrevented, false);
  assert.deepEqual(pageActions, ["contextmenu", "keydown"]);
});

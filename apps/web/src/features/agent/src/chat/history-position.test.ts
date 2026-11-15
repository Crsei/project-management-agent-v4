import assert from "node:assert/strict";
import test from "node:test";
import { captureHistoryPosition, preserveThreadHistoryPosition, restoreHistoryPosition } from "./history-position.ts";

function viewport(messageTop: number, scrollTop = 300) {
  const node = { dataset: { historyMessage: "message" }, getBoundingClientRect: () => ({ top: messageTop, bottom: messageTop + 80 }) };
  return {
    scrollTop,
    scrollHeight: 2000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [node],
  } as unknown as HTMLElement;
}

test("reading position restores a message anchor rather than stale scroll pixels", () => {
  const saved = captureHistoryPosition(viewport(90));
  assert.deepEqual(saved, { messageId: "message", offset: -10, bottom: false });
  const reflowed = viewport(400);
  restoreHistoryPosition(reflowed, saved);
  assert.equal(reflowed.scrollTop, 610);
});

test("bottom reading follows appended content without forcing other readers down", () => {
  const saved = captureHistoryPosition(viewport(90, 1490));
  assert.equal(saved.bottom, true);
  const appended = viewport(400);
  restoreHistoryPosition(appended, saved);
  assert.equal(appended.scrollTop, 2000);
});

test("continuity restoration finds the reloaded same-thread viewport, never another session", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let currentViewport = viewport(90);
  let threadId = "thread-one";
  const toolbar = { get dataset() { return { historyThread: threadId }; }, closest: () => ({ querySelector: () => currentViewport }) };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => [toolbar] } });
  try {
    const restore = preserveThreadHistoryPosition("thread-one");
    currentViewport = viewport(400);
    restore();
    assert.equal(currentViewport.scrollTop, 610);
    threadId = "thread-two";
    currentViewport = viewport(400);
    restore();
    assert.equal(currentViewport.scrollTop, 300);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

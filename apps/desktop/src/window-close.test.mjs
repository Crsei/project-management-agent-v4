import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { protectWorkspaceClose } from "./window-close.mjs";

const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

class TestWindow extends EventEmitter {
  webContents = new EventEmitter();
  destroyed = false;
  guarded = false;
  unresponsive = false;
  closeCalls = 0;
  isDestroyed() { return this.destroyed; }
  close() {
    this.closeCalls++;
    if (this.unresponsive) return;
    const closing = event();
    this.emit("close", closing);
    if (closing.defaultPrevented) return;
    if (this.guarded) {
      const unload = event();
      this.webContents.emit("will-prevent-unload", unload);
      if (!unload.defaultPrevented) return;
    }
    this.destroyed = true;
    this.emit("closed");
  }
  destroy() { throw new Error("Guarded close must never destroy a window."); }
}

function protect(window, options = {}) {
  const prompts = [];
  const errors = [];
  let response = 0;
  let failure;
  const close = protectWorkspaceClose(window, {
    timeout: 25,
    dialog: { showMessageBoxSync: (parent, input) => {
      prompts.push({ parent, input });
      if (failure) throw failure;
      return response;
    } },
    onError: cause => errors.push(cause),
    ...options,
  });
  return { close, prompts, errors, respond: value => { response = value; }, fail: value => { failure = value; } };
}

test("a native guarded close asks in the exact workspace and keeps drafts by default", () => {
  const window = new TestWindow();
  window.guarded = true;
  const guard = protect(window);
  window.close();
  assert.equal(window.isDestroyed(), false);
  assert.equal(guard.prompts.length, 1);
  assert.equal(guard.prompts[0].parent, window);
  assert.equal(guard.prompts[0].input.defaultId, 0);
  assert.equal(guard.prompts[0].input.cancelId, 0);
  guard.respond(1);
  window.close();
  assert.equal(window.isDestroyed(), true);
});

test("orderly shutdown can cancel and retry the same guarded workspace", async () => {
  const window = new TestWindow();
  window.guarded = true;
  const guard = protect(window);
  await assert.rejects(guard.close(), /cancelled/);
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.listenerCount("closed"), 0);
  guard.respond(1);
  await guard.close();
  assert.equal(window.isDestroyed(), true);
  assert.equal(window.listenerCount("closed"), 0);
});

test("close completes only after closed, deduplicates requests and does not prompt clean pages", async () => {
  const window = new TestWindow();
  window.unresponsive = true;
  const guard = protect(window, { timeout: 1_000 });
  const first = guard.close();
  assert.equal(guard.close(), first);
  assert.equal(window.closeCalls, 1);
  let completed = false;
  void first.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  window.destroyed = true;
  window.emit("closed");
  await first;
  assert.equal(guard.prompts.length, 0);
  await guard.close();
  assert.equal(window.closeCalls, 1);
});

test("an unresponsive close is bounded and retryable without destroying the window", async () => {
  const window = new TestWindow();
  window.unresponsive = true;
  const guard = protect(window);
  await assert.rejects(guard.close(), /did not close/);
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.listenerCount("closed"), 0);
  window.unresponsive = false;
  await guard.close();
  assert.equal(window.isDestroyed(), true);
});

test("a failed native confirmation retains the window and reports the original failure", async () => {
  const window = new TestWindow();
  window.guarded = true;
  const guard = protect(window);
  const failure = new Error("Native dialog unavailable");
  guard.fail(failure);
  window.close();
  assert.equal(window.isDestroyed(), false);
  assert.deepEqual(guard.errors, [failure]);
  await assert.rejects(guard.close(), error => error === failure);
  assert.equal(window.isDestroyed(), false);
  guard.fail(undefined);
  guard.respond(1);
  await guard.close();
});

test("a native close exception rejects promptly and leaves the next attempt usable", async () => {
  const window = new TestWindow();
  const original = window.close;
  window.close = () => { throw new Error("OS close failed"); };
  const guard = protect(window);
  await assert.rejects(guard.close(), /OS close failed/);
  assert.equal(window.listenerCount("closed"), 0);
  window.close = original;
  await guard.close();
});

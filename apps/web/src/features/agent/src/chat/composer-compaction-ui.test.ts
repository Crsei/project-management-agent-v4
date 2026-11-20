import assert from "node:assert/strict";
import test from "node:test";
import {
  composerOperationError, executeComposerCompaction, reduceComposerCompaction, resolveComposerCompactionControls,
  type ComposerCompactionState,
} from "./composer-actions-model.ts";

const controls = {
  available: true, phase: "idle" as const, hasText: false, running: false,
  editingQueue: false, fanoutActive: false, blocked: false, sendBlocked: false,
};

test("compaction controls require the server capability, with an additional send action only for text", () => {
  assert.equal(resolveComposerCompactionControls({ ...controls, available: false }).visible, false);
  assert.deepEqual(resolveComposerCompactionControls(controls), { visible: true, showSend: false, disabled: false, sendDisabled: false });
  assert.equal(resolveComposerCompactionControls({ ...controls, hasText: true }).showSend, true);
  assert.equal(resolveComposerCompactionControls({ ...controls, editingQueue: true }).visible, false);
  assert.equal(resolveComposerCompactionControls({ ...controls, fanoutActive: true }).visible, false);
});

test("pending phases, running turns and session blocks disable compaction without invented token values", () => {
  for (const phase of ["compacting", "reloading", "sending"] as const)
    assert.equal(resolveComposerCompactionControls({ ...controls, phase }).disabled, true);
  assert.equal(resolveComposerCompactionControls({ ...controls, running: true }).disabled, true);
  assert.equal(resolveComposerCompactionControls({ ...controls, blocked: true }).disabled, true);
  assert.deepEqual(resolveComposerCompactionControls({ ...controls, hasText: true, sendBlocked: true }), {
    visible: true, showSend: true, disabled: false, sendDisabled: true,
  });
});

test("compaction state tracks real compact, reload and send phases and rejects duplicate start", () => {
  let state: ComposerCompactionState = { phase: "idle", available: false };
  assert.equal(reduceComposerCompaction(state, { type: "start" }), state);
  state = reduceComposerCompaction(state, { type: "availability", available: true });
  state = reduceComposerCompaction(state, { type: "start" });
  assert.equal(state.phase, "compacting");
  assert.equal(reduceComposerCompaction(state, { type: "start" }), state);
  state = reduceComposerCompaction(state, { type: "reloading" });
  assert.equal(state.phase, "reloading");
  state = reduceComposerCompaction(state, { type: "sending" });
  assert.equal(state.phase, "sending");
  state = reduceComposerCompaction(state, { type: "complete" });
  assert.deepEqual(state, { phase: "idle", available: false, completed: true });
  assert.deepEqual(reduceComposerCompaction(state, { type: "reset" }), { phase: "idle", available: false });
});

test("server failures retain both code and message without presenting a success", () => {
  const failure = Object.assign(new Error("尚未满足压缩策略"), { code: "compaction_not_due" });
  const error = composerOperationError(failure);
  assert.equal(error, "compaction_not_due: 尚未满足压缩策略");
  assert.deepEqual(reduceComposerCompaction({ phase: "compacting", available: true }, { type: "failed", error }), {
    phase: "idle", available: true, error,
  });
  assert.equal(composerOperationError(new Error("compaction_failed")), "compaction_failed");
});

test("compact-and-send awaits the native receipt and the main-thread reload before sending", async () => {
  const calls: string[] = [];
  const { promise: reloadDone, resolve: finishReload } = Promise.withResolvers<void>();
  const receipt = { id: "native-compaction" };
  const completion = executeComposerCompaction({
    compact: async () => { calls.push("compact"); return receipt; },
    reload: async value => { assert.equal(value, receipt); calls.push("reload"); await reloadDone; },
    send: () => { calls.push("send"); },
    isCurrent: () => true,
    onPhase: phase => { calls.push(phase); },
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["compact", "reloading", "reload"]);
  finishReload();
  assert.equal(await completion, true);
  assert.deepEqual(calls, ["compact", "reloading", "reload", "sending", "send"]);
});

test("compact context alone reloads the visible round without sending the preserved draft", async () => {
  const calls: string[] = [];
  assert.equal(await executeComposerCompaction({
    compact: async () => { calls.push("compact"); },
    reload: async () => { calls.push("reload"); },
    isCurrent: () => true,
    onPhase: phase => { calls.push(phase); },
  }), true);
  assert.deepEqual(calls, ["compact", "reloading", "reload"]);
});

test("compaction or reload failure never sends and propagates the actual error", async () => {
  for (const failing of ["compact", "reload"] as const) {
    const calls: string[] = [];
    const error = new Error(`${failing}_failed`);
    await assert.rejects(executeComposerCompaction({
      compact: async () => { calls.push("compact"); if (failing === "compact") throw error; },
      reload: async () => { calls.push("reload"); throw error; },
      send: () => { calls.push("send"); },
      isCurrent: () => true,
      onPhase: () => {},
    }), error);
    assert.equal(calls.includes("send"), false);
  }
});

test("switching sessions before or during reload prevents the delayed send", async () => {
  for (const switchAt of ["compact", "reload"] as const) {
    let current = true;
    const calls: string[] = [];
    assert.equal(await executeComposerCompaction({
      compact: async () => { calls.push("compact"); if (switchAt === "compact") current = false; },
      reload: async () => { calls.push("reload"); current = false; },
      send: () => { calls.push("send"); },
      isCurrent: () => current,
      onPhase: () => {},
    }), false);
    assert.equal(calls.includes("send"), false);
    assert.equal(calls.includes("reload"), switchAt === "reload");
  }
});

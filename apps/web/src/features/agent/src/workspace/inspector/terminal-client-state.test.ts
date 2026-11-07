import assert from "node:assert/strict";
import test from "node:test";
import { nextTerminalInput, reconcileTerminalInput, shouldRenderTerminalOutput, terminalClientIdentity } from "./terminal-client-state.ts";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("docking and reattaching reuse terminal input identity without reissuing input", () => {
  const storage = new MemoryStorage();
  const id = crypto.randomUUID();
  const first = terminalClientIdentity(id, storage);
  assert.deepEqual(nextTerminalInput(first, id, "pwd\r", storage), { type: "input", seq: 1, data: "pwd\r" });
  const reattached = terminalClientIdentity(id, storage);
  assert.equal(reattached, first);
  assert.equal(reattached.inputSeq, 1);
  assert.equal(storage.getItem(`pm-v4:terminal-input:${id}`), "1");
  assert.deepEqual(nextTerminalInput(reattached, id, "echo next\r", storage), { type: "input", seq: 2, data: "echo next\r" });
});

test("different PTYs have independent sequence numbers under the same browser identity", () => {
  const storage = new MemoryStorage();
  const first = terminalClientIdentity(crypto.randomUUID(), storage);
  const secondId = crypto.randomUUID();
  const second = terminalClientIdentity(secondId, storage);
  assert.equal(first.clientId, second.clientId);
  assert.notEqual(first, second);
  assert.equal(nextTerminalInput(second, secondId, "x", storage).seq, 1);
  assert.equal(first.inputSeq, 0);
});

test("browser refresh resumes a saved input sequence rather than replaying it", () => {
  const storage = new MemoryStorage();
  const terminalId = crypto.randomUUID();
  storage.setItem("pm-v4:terminal-client", "existing-browser-client");
  storage.setItem(`pm-v4:terminal-input:${terminalId}`, "42");
  const restored = terminalClientIdentity(terminalId, storage);
  assert.equal(restored.clientId, "existing-browser-client");
  assert.equal(restored.inputSeq, 42);
  assert.deepEqual(reconcileTerminalInput(restored, terminalId, 42, storage), { unreceivedInput: false });
  assert.equal(nextTerminalInput(restored, terminalId, "new-input", storage).seq, 43);
});

test("replayed or reordered terminal chunks do not render twice", () => {
  assert.equal(shouldRenderTerminalOutput(12, 12), false);
  assert.equal(shouldRenderTerminalOutput(12, 11), false);
  assert.equal(shouldRenderTerminalOutput(12, 13), true);
  assert.equal(shouldRenderTerminalOutput(12, NaN), false);
  assert.equal(shouldRenderTerminalOutput(12, 12.5), false);
});

test("lost unsent input does not strand fresh input behind a permanent sequence gap", () => {
  const storage = new MemoryStorage();
  const terminalId = crypto.randomUUID();
  const identity = terminalClientIdentity(terminalId, storage);
  const lost = nextTerminalInput(identity, terminalId, "lost-before-disconnect", storage);
  assert.equal(lost.seq, 1);
  assert.deepEqual(reconcileTerminalInput(identity, terminalId, 0, storage), { unreceivedInput: true });
  assert.equal(identity.inputSeq, 0);
  assert.equal(storage.getItem(`pm-v4:terminal-input:${terminalId}`), "0");
  const fresh = nextTerminalInput(identity, terminalId, "fresh-after-ready", storage);
  let serverAccepted = 0;
  assert.equal(fresh.seq, serverAccepted + 1);
  serverAccepted = fresh.seq;
  assert.equal(fresh.data, "fresh-after-ready");
  assert.deepEqual(reconcileTerminalInput(identity, terminalId, serverAccepted, storage), { unreceivedInput: false });
  assert.equal(nextTerminalInput(identity, terminalId, "next-fresh-input", storage).seq, 2);
});

test("invalid handshake sequence cannot authorize new input", () => {
  const identity = terminalClientIdentity(crypto.randomUUID());
  assert.throws(() => reconcileTerminalInput(identity, "terminal", -1), /Invalid terminal input acknowledgment/);
  assert.throws(() => reconcileTerminalInput(identity, "terminal", NaN), /Invalid terminal input acknowledgment/);
  assert.equal(identity.inputSeq, 0);
});

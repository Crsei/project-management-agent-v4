import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function preload() {
  let bridge;
  const invocations = [];
  const listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "desktopConnection"); bridge = value; } },
    ipcRenderer: {
      invoke: async (channel, input) => { invocations.push({ channel, input }); return "result"; },
      on: (channel, handler) => listeners.set(channel, handler),
      removeListener: (channel, handler) => { if (listeners.get(channel) === handler) listeners.delete(channel); },
    },
  };
  vm.runInNewContext(await readFile(new URL("./preload.cjs", import.meta.url), "utf8"), { require: name => { assert.equal(name, "electron"); return electron; } });
  return { bridge, invocations, listeners };
}

test("the connection bridge offers no generic filesystem, process, shell or IPC capability", async () => {
  const { bridge, invocations } = await preload();
  assert.equal(Object.isFrozen(bridge), true);
  for (const action of ["exec", "readFile", "openExternal", "openPath", "desktop:arbitrary", "constructor"])
    await assert.rejects(bridge.invoke(action, { path: "/private", command: "anything" }), /Unknown desktop action/);
  assert.equal(invocations.length, 0);
  assert.equal(await bridge.invoke("directory", { action: "exec", field: "dataDir", path: "/not-used", command: "not-used" }), "result");
  assert.equal(invocations[0].channel, "desktop:action");
  assert.equal(JSON.stringify(invocations[0].input), JSON.stringify({ action: "directory", field: "dataDir" }));
  await bridge.invoke("backup", { destination: "/renderer-must-not-choose-this" });
  assert.equal(JSON.stringify(invocations[1].input), JSON.stringify({ action: "backup" }));
});

test("state subscription removes the Electron event object and can be disposed", async () => {
  const { bridge, listeners } = await preload();
  let received;
  const dispose = bridge.onState(value => { received = value; });
  const state = { status: "idle" };
  listeners.get("desktop:state")({ privateEvent: true }, state);
  assert.equal(received, state);
  dispose();
  assert.equal(listeners.size, 0);
  assert.throws(() => bridge.onState(null), /listener/);
});

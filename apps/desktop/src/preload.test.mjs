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
  vm.runInNewContext(await readFile(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: name => { assert.equal(name, "electron"); return electron; },
    process: { platform: "linux" },
  });
  return { bridge, invocations, listeners };
}

test("the connection bridge offers no generic filesystem, process, shell or IPC capability", async () => {
  const { bridge, invocations } = await preload();
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal(bridge.platform, "linux");
  for (const action of ["exec", "readFile", "openExternal", "openPath", "desktop:arbitrary", "constructor"])
    await assert.rejects(bridge.invoke(action, { path: "/private", command: "anything" }), /Unknown desktop action/);
  assert.equal(invocations.length, 0);
  assert.equal(await bridge.invoke("directory", { action: "exec", field: "dataDir", path: "/not-used", command: "not-used" }), "result");
  assert.equal(invocations[0].channel, "desktop:action");
  assert.equal(JSON.stringify(invocations[0].input), JSON.stringify({ action: "directory", field: "dataDir" }));
  await bridge.invoke("backup", { destination: "/renderer-must-not-choose-this" });
  assert.equal(JSON.stringify(invocations[1].input), JSON.stringify({ action: "backup" }));
});

test("backup bridge forwards only ephemeral password and explicit legacy acknowledgement, not renderer paths or algorithms", async () => {
  const { bridge, invocations } = await preload();
  await bridge.invoke("backup", { password: "synthetic-backup-passphrase", destination: "/not-accepted", kdf: { N: 1 } });
  assert.equal(JSON.stringify(invocations[0].input), JSON.stringify({ action: "backup", password: "synthetic-backup-passphrase" }));
  await bridge.invoke("restore", { password: "synthetic-backup-passphrase", allowLegacyUnencrypted: "true", trustedSourceAcknowledged: "true", source: "/not-accepted", dataDir: "/not-accepted" });
  assert.equal(JSON.stringify(invocations[1].input), JSON.stringify({ action: "restore", password: "synthetic-backup-passphrase", allowLegacyUnencrypted: false, trustedSourceAcknowledged: false }));
  await bridge.invoke("restore", { allowLegacyUnencrypted: true, trustedSourceAcknowledged: true });
  assert.equal(JSON.stringify(invocations[2].input), JSON.stringify({ action: "restore", allowLegacyUnencrypted: true, trustedSourceAcknowledged: true }));
});

test("Quit forwards only the fixed action and no renderer-selected window or process", async () => {
  const { bridge, invocations } = await preload();
  await bridge.invoke("quit", { action: "connect", windowId: 99, webContentsId: 100, pid: 1234, force: true });
  assert.equal(invocations[0].channel, "desktop:action");
  assert.equal(JSON.stringify(invocations[0].input), JSON.stringify({ action: "quit" }));
});

test("update bridge accepts only fixed actions and strips URLs, tokens, paths and install flags", async () => {
  const { bridge, invocations } = await preload();
  for (const action of ["update-check", "update-download", "update-cancel", "update-install"])
    await bridge.invoke(action, { url: "https://untrusted.invalid/update.yml", token: "never-forward", path: "/arbitrary/installer", force: true, channel: "latest" });
  assert.deepEqual(invocations.map(value => JSON.parse(JSON.stringify(value))), ["update-check", "update-download", "update-cancel", "update-install"].map(action => ({ channel: "desktop:action", input: { action } })));
  await assert.rejects(bridge.invoke("update-configure", { url: "https://untrusted.invalid" }), /Unknown desktop action/);
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

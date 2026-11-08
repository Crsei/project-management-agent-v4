import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function loadPreload(name, exposedName, enabled = true) {
  const calls = [];
  const handlers = new Map();
  const exposures = new Map();
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key, value) => { exposures.set(key, value); },
    },
    ipcRenderer: {
      invoke: (channel, input) => {
        calls.push({ channel, input });
        return Promise.resolve({ ok: true });
      },
      send: (channel, payload) => { calls.push({ channel, payload }); },
      on: (channel, handler) => { handlers.set(channel, handler); },
      removeListener: (channel) => { handlers.delete(channel); },
    },
    webFrame: { getZoomFactor: () => 1 },
  };
  const source = readFileSync(name, "utf8");
  vm.runInNewContext(source, {
    require: (id) => { assert.equal(id, "electron"); return electron; },
    process: { argv: enabled ? ["--pm-native-preview"] : [], platform: "linux" },
  });
  return { exposed: exposures.get(exposedName) ?? null, exposures, calls, handlers };
}

test("workspace preview bridge stays absent for remote workspaces", () => {
  const { exposed } = loadPreload(join(here, "preload.workspace.cjs"), "desktopWorkspace", false);
  assert.equal(exposed, null);
});

test("desktop shell bridge exists in every workspace mode and accepts only light or dark", async () => {
  const { exposures, calls } = loadPreload(join(here, "preload.workspace.cjs"), "desktopShell", false);
  const shell = exposures.get("desktopShell");
  assert.equal(Object.isFrozen(shell), true);
  assert.equal(shell.platform, "linux");
  assert.equal(shell.titlebarHeight, 40);
  await shell.setTitlebarTheme("dark");
  assert.deepEqual(calls, [{ channel: "desktop:titlebar-theme", input: "dark" }]);
  await assert.rejects(shell.setTitlebarTheme("system"), /light or dark/);
  assert.equal(calls.length, 1);
});

test("workspace preload exposes only the preview and directory allowlists", async () => {
  const { exposed, calls } = loadPreload(join(here, "preload.workspace.cjs"), "desktopWorkspace");
  assert.ok(exposed?.preview);
  assert.equal(typeof exposed.preview.createTab, "function");
  assert.equal(typeof exposed.preview.invoke, "undefined");
  assert.equal(typeof exposed.preview.openExternal, "function");
  await exposed.preview.createTab("tab-1", { url: "http://127.0.0.1:3223/pm" });
  assert.deepEqual(calls[0], {
    channel: "desktop:preview",
    input: { action: "create-tab", tabId: "tab-1", options: { url: "http://127.0.0.1:3223/pm" } },
  });
  await exposed.preview.openExternal("http://127.0.0.1:3223/pm");
  assert.deepEqual(calls[1], {
    channel: "desktop:preview",
    input: { action: "open-external", url: "http://127.0.0.1:3223/pm" },
  });
});

test("local folder chooser exposes no renderer-selected path or general desktop action", async () => {
  const { exposed, calls } = loadPreload(join(here, "preload.workspace.cjs"), "desktopWorkspace");
  assert.deepEqual(Object.keys(exposed).sort(), ["directories", "preview"]);
  assert.deepEqual(Object.keys(exposed.directories), ["choose"]);
  assert.equal(Object.isFrozen(exposed.directories), true);
  await exposed.directories.choose({ path: "C:\\untrusted", action: "connect" });
  assert.deepEqual(calls, [{ channel: "desktop:choose-workspace-directory", input: undefined }]);
});

test("workspace preload rejects unknown actions before IPC", async () => {
  const { exposed } = loadPreload(join(here, "preload.workspace.cjs"), "desktopWorkspace");
  // The bridge has no generic invoke; every method maps to a fixed action.
  assert.deepEqual(Object.keys(exposed.preview).sort(), [
    "back", "cancelPick", "capture", "closePiP", "closeTab", "createTab",
    "forward", "navigate", "onOpenLink", "onState", "openDevTools", "openExternal",
    "openPiP", "pick", "registerWebview", "reload", "state", "stop",
  ]);
});

test("workspace preload state listener strips the event and can unsubscribe", () => {
  const { exposed, handlers } = loadPreload(join(here, "preload.workspace.cjs"), "desktopWorkspace");
  const received = [];
  const unsubscribe = exposed.preview.onState((state) => received.push(state));
  assert.equal(typeof unsubscribe, "function");
  handlers.get("desktop:preview-state")({ sender: "hidden" }, { tabId: "tab", url: "http://x" });
  assert.deepEqual(received, [{ tabId: "tab", url: "http://x" }]);
  unsubscribe();
  assert.equal(handlers.has("desktop:preview-state"), false);
});

test("PiP preload exposes frames and close only", () => {
  const { exposed, calls, handlers } = loadPreload(join(here, "preview-pip-preload.cjs"), "previewPictureInPicture");
  assert.deepEqual(Object.keys(exposed).sort(), ["close", "onFrame"]);
  const frames = [];
  const unsubscribe = exposed.onFrame((frame) => frames.push(frame));
  handlers.get("pm-preview:pip-frame")({ sender: "hidden" }, "data:image/jpeg;base64,AA");
  assert.deepEqual(frames, ["data:image/jpeg;base64,AA"]);
  unsubscribe();
  exposed.close();
  assert.deepEqual(calls.at(-1), { channel: "pm-preview:pip-close", payload: undefined });
});

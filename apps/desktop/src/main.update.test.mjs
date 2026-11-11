import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalServer } from "./local-server.mjs";
import { updateRelease } from "./tests/updater-fixture.mjs";

const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("electron-updater"))("semver");

test("packaged main update IPC preserves draft/stop guards and serializes desktop maintenance", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-main-update-"));
  const release = updateRelease();
  const installer = join(root, release.artifact.path);
  await writeFile(installer, release.payload);
  const windows = [], handlers = new Map(), sessions = new Map(), servers = [], errors = [];
  const paths = { appData: root, exe: join(root, "PM Agent v4.exe") };
  const available = Promise.withResolvers();
  let installResponse = 1, stopResponse = 1, draftResponse = 0, installs = 0, quits = 0, focused;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getVersion: () => release.current.version, setName() {}, setAppUserModelId() {},
    getPath: name => paths[name], setPath: (name, value) => { paths[name] = value; },
    requestSingleInstanceLock: () => true, isReady: () => true, whenReady: async () => {},
    quit() { quits++; },
  });
  function sessionFor(partition) {
    if (!sessions.has(partition)) {
      const value = Object.assign(new EventEmitter(), {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
        cookies: { remove: async () => {} }, fetch: async () => ({ ok: true, json: async () => ({ authorized: true, configured: true }) }),
        closeAllConnections: async () => {}, flushStorageData: async () => { if (value.flushFailure) throw new Error("Browser storage flush failed."); },
        webRequest: { onBeforeRequest() {} },
      });
      sessions.set(partition, value);
    }
    return sessions.get(partition);
  }
  class TestWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "about:blank", detached: false, isDestroyed: () => false }, isDestroyed: () => this.destroyed,
        getZoomFactor: () => 1, session: options.webPreferences.session || sessionFor(options.webPreferences.partition),
        setWindowOpenHandler() {}, send: (_channel, value) => { this.state = value; if (value.update?.status === "available" && !value.update.busy) available.resolve(this); },
      });
      windows.push(this);
    }
    static getFocusedWindow() { return focused; }
    isDestroyed() { return this.destroyed; } isMinimized() { return false; } isMaximized() { return false; } isFullScreen() { return false; }
    getNormalBounds() { return { x: 0, y: 0, width: 1080, height: 800 }; }
    setMenuBarVisibility() {} setTitleBarOverlay() {} setWindowButtonPosition() {} show() {} hide() {} restore() {} focus() { focused = this; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    close() {
      const closing = event(); this.emit("close", closing); if (closing.defaultPrevented) return;
      if (this.guarded) { const unload = event(); this.webContents.emit("will-prevent-unload", unload); if (!unload.defaultPrevented) return; }
      this.destroyed = true; this.emit("closed");
    }
    destroy() { throw new Error("Updates must not force-destroy a workspace."); }
  }
  const updater = Object.assign(new EventEmitter(), {
    currentVersion: parse(release.current.version), setFeedURL(value) { this.feed = value; },
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: release.info }), downloadUpdate: async () => [installer],
    quitAndInstall() { installs++; },
  });
  const electron = {
    app, BrowserWindow: TestWindow, ipcMain: Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) }),
    Menu: { setApplicationMenu() {}, buildFromTemplate: value => value },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }), session: { fromPartition: sessionFor },
    shell: { showItemInFolder() {} }, dialog: {
      showMessageBox: async (_parent, input) => ({ response: input.title === "Restart and install desktop update?" ? installResponse : stopResponse }),
      showMessageBoxSync: () => draftResponse, showErrorBox: (title, message) => { errors.push({ title, message }); available.reject(new Error(message)); },
    },
  };
  const key = Symbol.for("desktop-main-update-fixture");
  globalThis[key] = { electron, stamp: release.current, updater };
  const oldResources = process.resourcesPath;
  process.resourcesPath = root;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "electron") return { url: "desktop-update-fixture:electron", shortCircuit: true };
      if (specifier === "electron-updater") return { url: "desktop-update-fixture:updater", shortCircuit: true };
      if (specifier === "./install-stamp.mjs" && context.parentURL?.endsWith("/main.mjs")) return { url: "desktop-update-fixture:stamp", shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      const shared = 'globalThis[Symbol.for("desktop-main-update-fixture")]';
      if (url === "desktop-update-fixture:electron") return { format: "module", shortCircuit: true, source: `export const {app,BrowserWindow,Menu,dialog,ipcMain,nativeTheme,screen,session,shell}=${shared}.electron;` };
      if (url === "desktop-update-fixture:stamp") return { format: "module", shortCircuit: true, source: `export const readInstallStamp=async()=>${shared}.stamp;` };
      if (url === "desktop-update-fixture:updater") return { format: "module", shortCircuit: true, source: `export default {autoUpdater:${shared}.updater,CancellationToken:class {cancel(){this.cancelled=true;}}};` };
      return next(url, context);
    },
  });
  const originalSignals = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, new Set(process.listeners(signal))]));
  t.mock.method(globalThis, "fetch", release.fetch);
  t.mock.method(LocalServer.prototype, "start", async function () {
    Object.defineProperties(this, { running: { get: () => this.testRunning }, processCount: { get: () => this.testRunning ? 4 : 0 } });
    this.testRunning = true; this.stopCalls = 0; servers.push(this);
    return { phase: "ready", origin: "http://127.0.0.1:58764", instanceId: "update-test-instance", token: "private-test-token", runtime: "fixture" };
  });
  t.mock.method(LocalServer.prototype, "stop", async function () { this.stopCalls++; if (this.stopFailure) throw new Error("PostgreSQL checkpoint shutdown timed out."); this.testRunning = false; });
  try {
    await import("./main.mjs");
    const connection = await available.promise;
    const source = { sender: connection.webContents, senderFrame: connection.webContents.mainFrame };
    const action = (name, input = {}) => handlers.get("desktop:action")(source, { action: name, ...input });
    const workspace = () => windows.findLast(value => value !== connection && !value.isDestroyed());
    const prepare = async () => {
      assert.equal((await action("update-check")).update.status, "available");
      assert.equal((await action("update-download")).update.status, "downloaded");
    };
    await t.test("only trusted main frame and fixed update action shapes can control updates", async () => {
      const handler = handlers.get("desktop:action");
      await assert.rejects(handler({ ...source, senderFrame: { ...source.senderFrame } }, { action: "update-install" }), /trusted top-level/);
      await assert.rejects(action("update-check", { url: "https://untrusted.invalid", path: installer }), /fixed desktop update action/);
      await assert.rejects(action("update-configure"), /Unknown desktop update action/);
      assert.equal(installs, 0);
    });
    const connected = await action("connect", { configuration: { mode: "local", dataDir: join(root, "workspace"), projectRoot: join(root, "projects") } });
    assert.equal(connected.status, "connected", connected.error);
    const server = servers[0];
    await t.test("in-flight download rejects connect, disconnect and backup instead of stopping local work", async () => {
      const gate = Promise.withResolvers();
      updater.downloadUpdate = () => gate.promise;
      const pending = action("update-download");
      assert.equal(connection.state.update.busy, true);
      for (const name of ["connect", "disconnect", "backup"])
        await assert.rejects(action(name, { configuration: { mode: "local", dataDir: root }, password: "backup-password" }), /update operation/);
      assert.equal(server.stopCalls, 0);
      gate.resolve([installer]); await pending;
      updater.downloadUpdate = async () => [installer];
    });
    await t.test("declined install and declined active-task stop confirmation leave service and workspace alive", async () => {
      installResponse = 0;
      assert.equal((await action("update-install")).update.status, "downloaded");
      installResponse = 1; stopResponse = 0;
      assert.equal((await action("update-install")).update.status, "downloaded");
      assert.equal(server.stopCalls, 0); assert.ok(workspace()); assert.equal(installs, 0); assert.equal(quits, 0);
      stopResponse = 1;
    });
    await t.test("draft cancellation prevents service stop and installer invocation", async () => {
      workspace().guarded = true;
      const result = await action("update-install");
      assert.equal(result.update.status, "error"); assert.match(result.update.error, /close was cancelled/);
      assert.equal(server.stopCalls, 0); assert.ok(workspace()); assert.equal(installs, 0); assert.equal(quits, 0);
      draftResponse = 1;
    });
    await t.test("storage flush and graceful PostgreSQL stop errors do not authorize quit/install", async () => {
      const targetSession = workspace().webContents.session;
      await prepare(); targetSession.flushFailure = true;
      assert.match((await action("update-install")).update.error, /storage.*flushed/i);
      assert.equal(server.stopCalls, 0); assert.equal(server.running, true); assert.equal(installs, 0);
      targetSession.flushFailure = false; server.stopFailure = true;
      await prepare();
      assert.match((await action("update-install")).update.error, /checkpoint/);
      assert.equal(server.running, true); assert.equal(installs, 0); assert.equal(quits, 0);
      server.stopFailure = false;
    });
    await t.test("updater installer startup errors revoke quit authorization and leave a retryable app", async () => {
      await prepare();
      const start = updater.quitAndInstall;
      updater.quitAndInstall = () => { process.nextTick(() => updater.emit("error", new Error("Verified installer could not start."))); };
      const result = await action("update-install");
      assert.equal(result.update.status, "error"); assert.match(result.update.error, /could not start/);
      assert.equal(installs, 0); assert.equal(quits, 0);
      updater.quitAndInstall = start;
      assert.equal((await action("update-check")).update.status, "available", "failed startup releases the main-process lifecycle reservation");
    });
    await t.test("only confirmed, flushed and completely stopped state invokes the verified updater installer", async () => {
      await prepare();
      const result = await action("update-install");
      assert.equal(result.update.status, "installing"); assert.equal(server.running, false); assert.equal(installs, 1);
      assert.equal(result.localRunning, false); assert.equal(result.workspaceOpen, false);
      const before = event(); app.emit("before-quit", before); assert.equal(before.defaultPrevented, false);
    });
    assert.deepEqual(errors, []);
  } finally {
    hooks.deregister(); delete globalThis[key];
    if (oldResources === undefined) delete process.resourcesPath; else process.resourcesPath = oldResources;
    for (const [signal, before] of originalSignals) for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    await rm(root, { recursive: true, force: true });
  }
});

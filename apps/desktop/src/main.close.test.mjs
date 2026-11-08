import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalServer } from "./local-server.mjs";

const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

test("desktop close preserves drafts, IPC trust, owned services and retryable shutdown", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-close-"));
  const windows = [];
  const sessions = new Map();
  const handlers = new Map();
  const servers = [];
  const prompts = [];
  const failures = [];
  const paths = { appData: root };
  let focused;
  let stopResponse = 1;
  let discardResponse = 0;
  let quitCompleted = false;
  const ready = Promise.withResolvers();
  const quitReady = Promise.withResolvers();
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    setName() {}, setAppUserModelId() {},
    setPath: (name, path) => { paths[name] = path; },
    getPath: name => paths[name],
    requestSingleInstanceLock: () => true,
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    quit: () => {
      const before = event();
      app.emit("before-quit", before);
      if (before.defaultPrevented) return;
      for (const window of windows) if (!window.isDestroyed()) window.close();
      quitCompleted = windows.every(window => window.isDestroyed());
      if (quitCompleted) quitReady.resolve();
    },
  });
  function sessionFor(partition) {
    if (!sessions.has(partition)) {
      const target = Object.assign(new EventEmitter(), {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
        cookies: { remove: async () => {} },
        fetch: async () => ({ ok: true, json: async () => ({ authorized: true, configured: true }) }),
        connectionCloses: 0, flushes: 0,
        closeAllConnections: async () => { target.connectionCloses++; },
        flushStorageData: async () => { target.flushes++; if (target.flushFailure) throw target.flushFailure; },
        webRequest: { onBeforeRequest: (filter, callback) => { target.requestFilter = callback ?? filter; } },
      });
      sessions.set(partition, target);
    }
    return sessions.get(partition);
  }
  class TestWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = options.show !== false;
      this.minimized = false;
      this.guarded = false;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "about:blank", detached: false, isDestroyed: () => false },
        isDestroyed: () => this.destroyed,
        getZoomFactor: () => 1,
        session: options.webPreferences.session ?? sessionFor(options.webPreferences.partition),
        setWindowOpenHandler() {},
        send: (channel, value) => { this.lastChannel = channel; this.lastState = value; },
      });
      windows.push(this);
    }
    static getFocusedWindow() { return focused; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    setMenuBarVisibility(visible) { this.menuBarVisible = visible; }
    setTitleBarOverlay(overlay) { this.titleBarOverlay = overlay; }
    setWindowButtonPosition(position) { this.windowButtonPosition = position; }
    getNormalBounds() { return { x: 0, y: 0, width: 1080, height: 800 }; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { focused = this; }
    loadURL(url) {
      this.webContents.mainFrame.url = url;
      if (url.startsWith("file:")) ready.resolve(this);
      return Promise.resolve();
    }
    close() {
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
    destroy() { throw new Error("Desktop close must not bypass beforeunload with destroy()."); }
  }
  const ipcMain = Object.assign(new EventEmitter(), { handle: (channel, handler) => handlers.set(channel, handler) });
  const electron = {
    app, BrowserWindow: TestWindow, ipcMain,
    Menu: { setApplicationMenu() {}, buildFromTemplate: input => input },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { fromPartition: sessionFor },
    shell: { showItemInFolder() {} },
    dialog: {
      showMessageBox: async (parent, input) => { prompts.push({ parent, input }); return { response: stopResponse }; },
      showMessageBoxSync: (parent, input) => { prompts.push({ parent, input }); return discardResponse; },
      showErrorBox: (title, message) => failures.push({ title, message }),
    },
  };
  const key = Symbol.for("desktop-close-test-electron");
  globalThis[key] = electron;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "electron" ? { url: "desktop-close-test:electron", shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      if (url !== "desktop-close-test:electron") return next(url, context);
      return {
        format: "module", shortCircuit: true,
        source: 'export const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, session, shell } = globalThis[Symbol.for("desktop-close-test-electron")];',
      };
    },
  });
  const originalSignals = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, new Set(process.listeners(signal))]));
  t.mock.method(LocalServer.prototype, "start", async function () {
    Object.defineProperties(this, {
      running: { get: () => this.testRunning },
      processCount: { get: () => this.testRunning ? 4 : 0 },
    });
    this.testRunning = true;
    this.stopCalls = 0;
    servers.push(this);
    return { origin: "http://127.0.0.1:58763", instanceId: "isolated-close-test", token: "private-test-token", runtime: "test" };
  });
  t.mock.method(LocalServer.prototype, "stop", async function () {
    this.stopCalls++;
    if (this.stopFailure) throw this.stopFailure;
    this.testRunning = false;
  });
  try {
    await import("./main.mjs");
    const connection = await ready.promise;
    const source = { sender: connection.webContents, senderFrame: connection.webContents.mainFrame };
    const action = (name, input = {}) => handlers.get("desktop:action")(source, { action: name, ...input });
    const state = () => action("state");
    const workspace = () => windows.findLast(window => window !== connection && !window.isDestroyed());
    await t.test("untrusted or wrong-window controls cannot quit the desktop", async () => {
      const handler = handlers.get("desktop:action");
      await assert.rejects(handler({ ...source, senderFrame: { url: source.senderFrame.url } }, { action: "quit" }), /trusted top-level/);
      await assert.rejects(handler({ ...source, sender: {} }, { action: "quit" }), /trusted top-level/);
      const trustedUrl = source.senderFrame.url;
      source.senderFrame.url = "https://untrusted.invalid/";
      await assert.rejects(handler(source, { action: "quit" }), /trusted top-level/);
      source.senderFrame.url = trustedUrl;
      assert.equal(quitCompleted, false);
    });
    await t.test("maintenance IPC bounds and clears passwords before opening dialogs", async () => {
      const handler = handlers.get("desktop:action");
      for (const input of [{ action: "backup", password: "short" }, { action: "backup", password: "x".repeat(1025) }, { action: "restore", password: "" }, { action: "restore", password: "valid-password", allowLegacyUnencrypted: "yes" }, { action: "restore", password: "valid-password", trustedSourceAcknowledged: false }]) {
        const promptCount = prompts.length;
        await assert.rejects(handler(source, input), /password|legacy restore|trusted source/);
        assert.equal(input.password, "");
        assert.equal(input.trustedSourceAcknowledged, false);
        assert.equal(prompts.length, promptCount);
      }
    });
    await t.test("restore source trust is transient and native SQL-risk cancellation prevents any restore", async () => {
      stopResponse = 0;
      const input = { action: "restore", password: "private-backup-password", trustedSourceAcknowledged: true };
      const result = await handlers.get("desktop:action")(source, input);
      assert.match(prompts.at(-1).input.message, /PostgreSQL SQL.*local.*privileges/);
      assert.match(prompts.at(-1).input.detail, /key possession.*not trusted authorship/);
      assert.equal(input.password, "");
      assert.equal(input.trustedSourceAcknowledged, false);
      assert.equal(result.status, "idle");
      assert.equal(result.localRunning, false);
      stopResponse = 1;
    });
    await action("connect", { configuration: { mode: "local", dataDir: join(root, "workspace"), projectRoot: join(root, "projects") } });
    const server = servers[0];
    assert.ok(server);
    assert.equal((await state()).status, "connected");
    await t.test("the workspace bridge cannot target connection-window Quit", async () => {
      const contents = workspace().webContents;
      await assert.rejects(handlers.get("desktop:action")({ sender: contents, senderFrame: contents.mainFrame }, { action: "quit" }), /trusted top-level/);
      assert.equal(server.stopCalls, 0);
      assert.equal(quitCompleted, false);
    });
    await t.test("native clean close leaves services running and the connection recoverable", async () => {
      const first = workspace();
      first.close();
      assert.equal(first.isDestroyed(), true);
      assert.equal(connection.visible, true);
      assert.equal(server.stopCalls, 0);
      assert.equal((await state()).localRunning, true);
      await action("open");
      assert.ok(workspace());
    });
    await t.test("connection close returns focus to its own existing workspace", () => {
      const current = workspace();
      current.minimized = true;
      connection.show();
      connection.focus();
      connection.close();
      assert.equal(connection.isDestroyed(), false);
      assert.equal(connection.visible, false);
      assert.equal(current.minimized, false);
      assert.equal(focused, current);
    });
    await t.test("guarded native close is visible, cancellable and explicitly discardable", async () => {
      const current = workspace();
      current.guarded = true;
      current.close();
      assert.equal(current.isDestroyed(), false);
      assert.equal(prompts.at(-1).parent, current);
      discardResponse = 1;
      current.close();
      assert.equal(current.isDestroyed(), true);
      assert.equal(server.stopCalls, 0);
      await action("open");
      discardResponse = 0;
    });
    await t.test("connection rollback does not repeat a cancelled close of the old workspace", async () => {
      const current = workspace();
      current.guarded = true;
      connection.show();
      connection.focus();
      const before = prompts.length;
      const result = await action("connect", { configuration: { mode: "local", dataDir: join(root, "replacement"), projectRoot: join(root, "replacement-projects") } });
      assert.equal(prompts.length, before + 2);
      assert.equal(current.isDestroyed(), false);
      assert.equal(server.stopCalls, 0);
      assert.equal(servers.length, 1);
      assert.equal(result.localRunning, true);
      assert.match(result.error, /cancelled/);
      current.guarded = false;
    });
    await t.test("cancelled Disconnect retains the actual workspace and owned services", async () => {
      const current = workspace();
      current.guarded = true;
      connection.show();
      connection.focus();
      const result = await action("disconnect");
      assert.equal(current.isDestroyed(), false);
      assert.equal(server.stopCalls, 0);
      assert.equal(result.localRunning, true);
      assert.match(result.error, /cancelled/);
      assert.equal(connection.visible, true);
      const quit = await action("quit");
      assert.equal(quitCompleted, false);
      assert.equal(quit.workspaceOpen, true);
      assert.equal(quit.localRunning, true);
      assert.match(quit.error, /cancelled/);
      assert.equal(server.stopCalls, 0);
      current.guarded = false;
    });
    await t.test("flush failure retains the private session and services for a real retry", async () => {
      const privateSession = workspace().webContents.session;
      privateSession.flushFailure = new Error("Disk unavailable");
      const result = await action("disconnect");
      assert.equal(result.localRunning, true);
      assert.match(result.error, /storage could not be flushed/);
      assert.equal(server.stopCalls, 0);
      assert.equal(typeof privateSession.requestFilter, "function");
      assert.equal(result.maintenanceAllowed, false);
      privateSession.flushFailure = undefined;
      const retried = await action("disconnect");
      assert.equal(retried.status, "idle");
      assert.equal(retried.localRunning, false);
      assert.equal(privateSession.flushes, 2);
      assert.equal(privateSession.requestFilter, null);
      assert.equal(server.stopCalls, 1);
    });
    await action("connect", { configuration: { mode: "local", dataDir: join(root, "workspace"), projectRoot: join(root, "projects") } });
    const nextServer = servers[1];
    await t.test("failed Quit exposes retained ownership and permits retry without a deadlock", async () => {
      nextServer.stopFailure = new Error("Owned database is still shutting down");
      const failed = await action("quit");
      assert.equal(quitCompleted, false);
      assert.equal(failed.localRunning, true);
      assert.equal(failed.processCount, 4);
      assert.match(failed.error, /Owned database/);
      assert.equal(connection.visible, true);
      nextServer.stopFailure = undefined;
      stopResponse = 0;
      await action("quit");
      assert.equal(nextServer.stopCalls, 1);
      assert.equal(quitCompleted, false);
      stopResponse = 1;
      connection.close();
      await quitReady.promise;
      assert.equal(nextServer.stopCalls, 2);
      assert.equal(quitCompleted, true);
    });
    assert.deepEqual(failures, []);
  } finally {
    hooks.deregister();
    delete globalThis[key];
    for (const [signal, listeners] of originalSignals)
      for (const listener of process.listeners(signal)) if (!listeners.has(listener)) process.removeListener(signal, listener);
    for (const window of windows) window.emit("closed");
    await rm(root, { recursive: true, force: true });
  }
});

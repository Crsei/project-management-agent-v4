import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalServer } from "./local-server.mjs";

const cancellable = (details = {}) => ({ ...details, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
const frame = (url, parent = null) => ({ url, parent, detached: false, destroyed: false, isDestroyed() { return this.destroyed; } });
const sourceFor = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });
const settle = () => new Promise(resolve => setImmediate(resolve));

// These doubles supply Electron's transport only. Every security decision below
// runs the real registered main-process handlers, policy and PreviewManager.
// This is not a Chromium renderer/CSP, native sandbox or GUI execution test.
test("main enforces frame identity, sandbox preferences, navigation, guest and permission boundaries", { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-security-")));
  const windows = [];
  const sessions = new Map();
  const contentsById = new Map();
  const handlers = new Map();
  const failures = [];
  const external = [];
  const dialogs = [];
  const servers = [];
  const paths = { appData: root };
  const ready = Promise.withResolvers();
  let folderDialogs = 0;
  let focused;
  let nextId = 1;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    setName() {}, setAppUserModelId() {},
    setPath: (name, path) => { paths[name] = path; }, getPath: name => paths[name],
    requestSingleInstanceLock: () => true, isReady: () => true,
    whenReady: () => Promise.resolve(), quit() {},
  });
  function sessionFor(partition) {
    if (!sessions.has(partition)) {
      const target = Object.assign(new EventEmitter(), {
        partition,
        setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
        setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
        setDevicePermissionHandler(handler) { this.devicePermission = handler; },
        cookies: { remove: async () => {} },
        fetch: async () => ({ ok: true, json: async () => ({ authorized: true, configured: true }) }),
        closeAllConnections: async () => {}, flushStorageData: async () => {},
        webRequest: { onBeforeRequest: (_filter, handler) => { target.requestFilter = handler; } },
      });
      sessions.set(partition, target);
    }
    return sessions.get(partition);
  }
  function webContents(targetSession, url = "about:blank") {
    const contents = Object.assign(new EventEmitter(), {
      id: nextId++, session: targetSession, mainFrame: frame(url), destroyed: false,
      isDestroyed() { return this.destroyed; }, getZoomFactor: () => 1,
      setWindowOpenHandler(handler) { this.windowOpen = handler; },
      send() {}, getURL() { return this.mainFrame.url; },
    });
    contentsById.set(contents.id, contents);
    return contents;
  }
  class TestWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = webContents(options.webPreferences.session ?? sessionFor(options.webPreferences.partition));
      windows.push(this);
    }
    static getFocusedWindow() { return focused; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getNormalBounds() { return { x: 0, y: 0, width: 1080, height: 800 }; }
    setMenuBarVisibility() {} setWindowButtonPosition() {} restore() {} show() {} hide() {}
    setTitleBarOverlay(value) { this.overlay = value; }
    focus() { focused = this; }
    loadURL(url) {
      this.webContents.mainFrame.url = url;
      if (url.startsWith("file:")) ready.resolve(this);
      return Promise.resolve();
    }
    close() {
      const event = cancellable();
      this.emit("close", event);
      if (!event.defaultPrevented) { this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); }
    }
    destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); }
  }
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) });
  const electron = {
    app, BrowserWindow: TestWindow, ipcMain,
    Menu: { setApplicationMenu() {}, buildFromTemplate: value => value },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { fromPartition: sessionFor }, webContents: { fromId: id => contentsById.get(id) },
    shell: { openExternal: async url => { external.push(url); }, showItemInFolder() {} },
    dialog: {
      showMessageBox: async (...args) => {
        const input = args.at(-1);
        dialogs.push(input);
        return { response: input.buttons?.includes("Stop local services") ? 1 : 0 };
      },
      showMessageBoxSync: () => 0,
      showOpenDialog: async () => { folderDialogs++; return { canceled: true, filePaths: [] }; },
      showErrorBox: (title, message) => { failures.push({ title, message }); ready.reject(new Error(`${title}: ${message}`)); },
    },
  };
  const key = Symbol.for("desktop-security-test-electron");
  globalThis[key] = electron;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "electron" ? { url: "desktop-security-test:electron", shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      if (url !== "desktop-security-test:electron") return next(url, context);
      return {
        format: "module", shortCircuit: true,
        source: 'export const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, session, shell, webContents } = globalThis[Symbol.for("desktop-security-test-electron")];',
      };
    },
  });
  const signals = new Map(["SIGINT", "SIGTERM"].map(name => [name, new Set(process.listeners(name))]));
  t.mock.method(LocalServer.prototype, "start", async function () {
    this.testRunning = true;
    Object.defineProperties(this, {
      running: { get: () => this.testRunning }, processCount: { get: () => this.testRunning ? 4 : 0 },
    });
    servers.push(this);
    return { phase: "ready", origin: "http://127.0.0.1:58764", instanceId: "isolated-security-test", token: "isolated-private-token", runtime: "test" };
  });
  t.mock.method(LocalServer.prototype, "stop", async function () { this.testRunning = false; });
  try {
    await import("./main.mjs");
    const connection = await ready.promise;
    const connectionContents = connection.webContents;
    const connectionUrl = connectionContents.mainFrame.url;
    const connectionSource = sourceFor(connectionContents);
    const action = (name, input = {}) => handlers.get("desktop:action")(connectionSource, { action: name, ...input });
    assert.equal((await action("state")).status, "idle");
    await action("connect", { configuration: { mode: "local", dataDir: join(root, "workspace"), projectRoot: join(root, "projects") } });
    assert.equal((await action("state")).status, "connected");
    const workspace = windows.findLast(window => window !== connection && !window.isDestroyed());
    assert.ok(workspace);
    const contents = workspace.webContents;
    const origin = new URL(contents.mainFrame.url).origin;
    const workspaceSource = sourceFor(contents);
    const preview = (input, source = workspaceSource) => handlers.get("desktop:preview")(source, input);
    const created = await preview({ action: "create-tab", tabId: "security-preview" });
    const guest = webContents(sessionFor(created.partition), `${origin}/agent/workspace`);

    await t.test("actual window construction enables sandbox/isolation and denies renderer Node privileges", () => {
      for (const window of [connection, workspace]) {
        const preferences = window.options.webPreferences;
        for (const name of ["sandbox", "contextIsolation", "webSecurity", "safeDialogs"]) assert.equal(preferences[name], true, name);
        for (const name of ["nodeIntegration", "nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "allowRunningInsecureContent", "navigateOnDragDrop"]) assert.equal(preferences[name], false, name);
      }
      assert.equal(connection.options.webPreferences.webviewTag, false);
      assert.equal(workspace.options.webPreferences.webviewTag, true); // Intentionally local-only preview support.
      assert.notEqual(connectionContents.session, contents.session);
      assert.notEqual(guest.session, contents.session);
    });

    await t.test("first-run token is available only to the local setup page while pending", async () => {
      const server = servers[0];
      const invoke = () => handlers.get("desktop:first-run-token")(workspaceSource);
      await assert.rejects(invoke(), /not pending/);
      server.setupPending = true;
      server.setupToken = "A".repeat(43);
      assert.equal(await invoke(), server.setupToken);
      const setupUrl = contents.mainFrame.url;
      contents.mainFrame.url = `${origin}/agent/workspace`;
      await assert.rejects(invoke(), /setup page/);
      contents.mainFrame.url = `${origin}/pm/workspace/home`;
      await assert.rejects(invoke(), /setup page/);
      contents.mainFrame.url = setupUrl;
      assert.equal(await invoke(), server.setupToken);
      server.setupPending = false;
      server.setupToken = "";
    });

    await t.test("every privileged IPC rejects same-origin child frames, guests, wrong windows and invalidated senders", async () => {
      const cases = [
        ["desktop:action", connectionContents, { action: "state" }, workspaceSource],
        ["desktop:choose-workspace-directory", contents, undefined, connectionSource],
        ["desktop:preview", contents, { action: "state", tabId: "security-preview" }, connectionSource],
        ["desktop:titlebar-theme", contents, "dark", sourceFor(guest)],
      ];
      const folderCount = folderDialogs;
      const dialogCount = dialogs.length;
      const connectionOverlay = connection.overlay;
      const workspaceOverlay = workspace.overlay;
      const previewState = await preview({ action: "state", tabId: "security-preview" });
      for (const [channel, owner, input, wrongWindow] of cases) {
        const invoke = source => handlers.get(channel)(source, input);
        const topFrame = owner.mainFrame;
        const invalid = [
          { sender: owner, senderFrame: frame(topFrame.url, topFrame) },
          { sender: guest, senderFrame: guest.mainFrame }, wrongWindow,
          { sender: owner, senderFrame: null },
          { sender: owner, get senderFrame() { throw new Error("frame disposed"); } },
        ];
        for (const source of invalid) await assert.rejects(invoke(source), undefined, channel);
        const url = topFrame.url;
        for (const destination of ["https://untrusted.invalid/pm", `${origin.replace("58764", "58765")}/pm`, "about:blank", "file:///untrusted.html"]) {
          topFrame.url = destination;
          await assert.rejects(invoke(sourceFor(owner)), undefined, `${channel}: ${destination}`);
        }
        topFrame.url = url;
        topFrame.detached = true;
        await assert.rejects(invoke(sourceFor(owner)), undefined, `${channel}: detached`);
        topFrame.detached = false;
        topFrame.destroyed = true;
        await assert.rejects(invoke(sourceFor(owner)), undefined, `${channel}: destroyed frame`);
        topFrame.destroyed = false;
        owner.mainFrame = frame(url);
        await assert.rejects(invoke({ sender: owner, senderFrame: topFrame }), undefined, `${channel}: replaced frame`);
        owner.mainFrame = topFrame;
        owner.destroyed = true;
        await assert.rejects(invoke(sourceFor(owner)), undefined, `${channel}: destroyed contents`);
        owner.destroyed = false;
      }
      assert.equal(folderDialogs, folderCount);
      assert.equal(servers.length, 1);
      assert.equal(dialogs.length, dialogCount);
      assert.deepEqual(connection.overlay, connectionOverlay);
      assert.deepEqual(workspace.overlay, workspaceOverlay);
      assert.deepEqual(await preview({ action: "state", tabId: "security-preview" }), previewState);
      await handlers.get("desktop:titlebar-theme")(workspaceSource, "dark");
      assert.equal(await handlers.get("desktop:choose-workspace-directory")(workspaceSource), null);
      assert.equal(folderDialogs, folderCount + 1);
      assert.equal((await preview({ action: "state", tabId: "security-preview" })).tabId, "security-preview");
    });

    await t.test("connection navigation remains the exact local document and rejects child frames, redirects and guests", () => {
      for (const destination of [connectionUrl, `${connectionUrl}?injected=1`, `${connectionUrl}#injected`, `${origin}/pm`, "file:///other.html", "data:text/html,injected", "javascript:alert(1)"]) {
        const event = cancellable({ url: destination, isMainFrame: true });
        connectionContents.emit("will-navigate", event, destination, false, true);
        assert.equal(event.defaultPrevented, destination !== connectionUrl, destination);
        const frameEvent = cancellable({ url: destination, isMainFrame: true, isSameDocument: false, frame: connectionContents.mainFrame });
        connectionContents.emit("will-frame-navigate", frameEvent); // Electron 45's details-only signature.
        assert.equal(frameEvent.defaultPrevented, destination !== connectionUrl, destination);
      }
      const child = cancellable({ url: connectionUrl, isMainFrame: false, isSameDocument: false, frame: frame(connectionUrl, connectionContents.mainFrame) });
      connectionContents.emit("will-frame-navigate", child);
      assert.equal(child.defaultPrevented, true);
      const redirect = cancellable({ url: connectionUrl, isMainFrame: true });
      connectionContents.emit("will-redirect", redirect, connectionUrl, false, true);
      assert.equal(redirect.defaultPrevented, true);
      const attach = cancellable();
      connectionContents.emit("will-attach-webview", attach, {}, { src: `${origin}/pm`, partition: created.partition });
      assert.equal(attach.defaultPrevented, true);
      assert.deepEqual(connectionContents.windowOpen({ url: `${origin}/pm` }), { action: "deny" });
    });

    await t.test("workspace navigation preserves same-origin main/child pages but blocks protocol, credential and origin escapes", async () => {
      const destinations = [
        [`${origin}/pm/next`, true], [`${origin}/agent/workspace`, true],
        ["http://localhost:58764/pm", false], ["http://127.0.0.1:58765/pm", false],
        ["https://127.0.0.1:58764/pm", false], ["https://untrusted.invalid/pm", false],
        ["http://user:secret@127.0.0.1:58764/pm", false], ["about:blank", false],
        ["file:///untrusted.html", false], ["data:text/html,injected", false],
        [`blob:${origin}/injected`, false], ["javascript:alert(1)", false],
      ];
      for (const [destination, allowed] of destinations) {
        for (const isMainFrame of [true, false]) {
          const event = cancellable({ url: destination, isMainFrame, isSameDocument: false, frame: isMainFrame ? contents.mainFrame : frame(`${origin}/frame`, contents.mainFrame) });
          contents.emit("will-frame-navigate", event);
          assert.equal(event.defaultPrevented, !allowed, `${isMainFrame}: ${destination}`);
        }
        for (const name of ["will-navigate", "will-redirect"]) {
          const event = cancellable({ url: destination, isMainFrame: true });
          contents.emit(name, event, destination, false, true);
          assert.equal(event.defaultPrevented, !allowed, `${name}: ${destination}`);
          await settle(); // Browser prompts are deliberately cancelled by the operator double.
        }
      }
      assert.deepEqual(contents.windowOpen({ url: "file:///private" }), { action: "deny" });
      assert.deepEqual(contents.windowOpen({ url: "https://untrusted.invalid/" }), { action: "deny" });
      await settle();
      assert.equal(external.length, 0);
    });

    await t.test("workspace request callbacks deny cross-origin network access for all resource types", () => {
      for (const resourceType of ["mainFrame", "subFrame", "script", "xhr", "webSocket"]) {
        for (const [url, allowed] of [
          [`${origin}/api/v1/workspaces`, true], ["ws://127.0.0.1:58764/socket", true],
          ["https://untrusted.invalid/script.js", false], ["http://127.0.0.1:58765/api", false],
          ["http://user:secret@127.0.0.1:58764/api", false], ["file:///private", false],
          ["javascript:alert(1)", false], ["blob:https://untrusted.invalid/id", false],
        ]) {
          let result;
          contents.session.requestFilter({ url, resourceType }, value => { result = value; });
          assert.deepEqual(result, { cancel: !allowed }, `${resourceType}: ${url}`);
        }
      }
      for (const url of ["data:image/png;base64,aA==", `blob:${origin}/image`]) {
        let result;
        contents.session.requestFilter({ url, resourceType: "image" }, value => { result = value; });
        assert.deepEqual(result, { cancel: false });
      }
    });

    await t.test("permission request/check/device callbacks deny privileged access regardless of origin or frame", () => {
      const denied = ["media", "geolocation", "notifications", "midiSysex", "clipboard-read", "display-capture", "pointerLock", "unknown-permission"];
      for (const target of [connectionContents.session, contents.session, guest.session]) {
        for (const permission of denied) for (const requestingUrl of [connectionUrl, `${origin}/pm`, "https://untrusted.invalid/"]) for (const isMainFrame of [true, false]) {
          let result;
          let calls = 0;
          target.permissionRequest(guest, permission, allowed => { calls++; result = allowed; }, { requestingUrl, isMainFrame });
          assert.equal(calls, 1);
          assert.equal(result, false, permission);
          assert.equal(target.permissionCheck(guest, permission, requestingUrl, { isMainFrame }), false, permission);
        }
        for (const deviceType of ["usb", "serial", "hid", "unknown"]) assert.equal(target.devicePermission({ deviceType, origin }), false);
      }
      for (const target of [connectionContents.session, contents.session]) for (const permission of ["fullscreen", "clipboard-sanitized-write"]) {
        let allowed;
        target.permissionRequest(contents, permission, result => { allowed = result; }, { requestingUrl: origin, isMainFrame: true });
        assert.equal(allowed, false);
        assert.equal(target.permissionCheck(contents, permission, origin), false);
      }
    });

    await t.test("only local preview sessions attach guests and attacker preferences cannot weaken their sandbox", () => {
      for (const params of [
        undefined, { src: `${origin}/pm`, partition: contents.session.partition },
        { src: `${origin}/pm`, partition: "persist:pm-preview-0000000000000000" },
        { src: "file:///private", partition: created.partition },
        { src: "javascript:alert(1)", partition: created.partition },
        { src: "https://user:secret@untrusted.invalid/", partition: created.partition },
      ]) {
        const event = cancellable();
        contents.emit("will-attach-webview", event, {}, params);
        assert.equal(event.defaultPrevented, true, JSON.stringify(params));
      }
      const preferences = {
        preload: "/attacker/preload.cjs", sandbox: false, nodeIntegration: true,
        nodeIntegrationInWorker: true, nodeIntegrationInSubFrames: true,
        contextIsolation: true, webSecurity: false, allowRunningInsecureContent: true,
        webviewTag: true, additionalArguments: ["--attacker"], navigateOnDragDrop: true, safeDialogs: false,
      };
      const event = cancellable();
      contents.emit("will-attach-webview", event, preferences, { src: "https://preview.example.invalid/", partition: created.partition });
      assert.equal(event.defaultPrevented, false);
      assert.match(preferences.preload, /preview-pick-preload\.cjs$/);
      assert.notEqual(preferences.preload, "/attacker/preload.cjs");
      for (const name of ["sandbox", "webSecurity", "safeDialogs", "disableHtmlFullscreenWindowResize"]) assert.equal(preferences[name], true, name);
      for (const name of ["nodeIntegration", "nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "allowRunningInsecureContent", "webviewTag", "navigateOnDragDrop"]) assert.equal(preferences[name], false, name);
      assert.equal(preferences.contextIsolation, false); // Deliberate picker overlay, never the privileged workspace bridge.
      assert.deepEqual(preferences.additionalArguments, []);
    });

    await t.test("remote workspace never enables or attaches local preview guests", async () => {
      await action("connect", { configuration: { mode: "remote", remoteUrl: "https://workspace.example.invalid/pm" } });
      assert.equal((await action("state")).status, "connected");
      const remote = windows.findLast(window => window !== connection && !window.isDestroyed());
      assert.equal(remote.options.webPreferences.webviewTag, false);
      const event = cancellable();
      remote.webContents.emit("will-attach-webview", event, {}, { src: "https://preview.example.invalid/", partition: created.partition });
      assert.equal(event.defaultPrevented, true);
      await assert.rejects(handlers.get("desktop:preview")(sourceFor(remote.webContents), { action: "state", tabId: "security-preview" }));
      await assert.rejects(handlers.get("desktop:choose-workspace-directory")(sourceFor(remote.webContents)));
    });
    assert.deepEqual(failures, []);
  } finally {
    hooks.deregister();
    delete globalThis[key];
    for (const [signal, previous] of signals) for (const handler of process.listeners(signal)) if (!previous.has(handler)) process.removeListener(signal, handler);
    await settle();
    await rm(root, { recursive: true, force: true });
  }
});

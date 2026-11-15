import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PreviewManager } from "./preview/manager.mjs";

const START_PICK = "pm-preview:start-pick";
const ELEMENT_PICKED = "pm-preview:element-picked";

function fakeImage() {
  return {
    getSize: () => ({ width: 800, height: 600 }),
    toDataURL: () => "data:image/png;base64,FULL",
    toJPEG: () => Buffer.from("jpeg"),
    crop: (rect) => ({
      getSize: () => ({ width: rect.width, height: rect.height }),
      toDataURL: () => `data:image/png;base64,CROP:${rect.x},${rect.y},${rect.width},${rect.height}`,
      toJPEG: () => Buffer.from("jpeg"),
    }),
  };
}

class FakeWebContents extends EventEmitter {
  constructor(id, session) {
    super();
    this.id = id;
    this.session = session;
    this.ipc = new EventEmitter();
    this.url = "about:blank";
    this.title = "";
    this.loading = false;
    this.destroyed = false;
    this.sent = [];
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
    };
  }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  isFocused() { return true; }
  focus() {}
  send(channel, payload) { this.sent.push({ channel, payload }); }
  stop() {}
  reload() { this.emit("did-start-loading"); this.loading = true; }
  openDevTools() {}
  capturePage() { return Promise.resolve(fakeImage()); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  loadURL(url) {
    this.url = url;
    this.loading = true;
    this.emit("did-start-loading");
    return Promise.resolve();
  }
}

function fakeElectron() {
  const sessions = new Map();
  const contents = new Map();
  const ipcMain = new EventEmitter();
  const sessionFor = (partition) => {
    if (!sessions.has(partition)) {
      sessions.set(partition, {
        permissionRequest: null,
        permissionCheck: null,
        devicePermission: null,
        webRequest: { onBeforeRequest: (_filter, handler) => { sessions.get(partition).requestFilter = handler; } },
        downloads: [],
        setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
        setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
        setDevicePermissionHandler(handler) { this.devicePermission = handler; },
        removeAllListeners() {},
        on() {},
      });
    }
    return sessions.get(partition);
  };
  return {
    sessions,
    contents,
    electron: {
      BrowserWindow: class FakeBrowserWindow {
        constructor() { this.webContents = new FakeWebContents(999, sessionFor("pip")); }
        on() {}
        loadURL() { return Promise.resolve(); }
        isDestroyed() { return false; }
        destroy() {}
        setAlwaysOnTop() {}
        setVisibleOnAllWorkspaces() {}
      },
      ipcMain,
      nativeTheme: { shouldUseDarkColors: false },
      session: { fromPartition: sessionFor },
      webContents: { fromId: (id) => contents.get(id) ?? null },
    },
    register(contentsId, session) {
      const wc = new FakeWebContents(contentsId, session);
      contents.set(contentsId, wc);
      return wc;
    },
  };
}

function makeManager() {
  const fake = fakeElectron();
  const states = [];
  const manager = new PreviewManager({
    electron: fake.electron,
    guestPreloadPath: "/tmp/preview-pick-preload.cjs",
    pipPreloadPath: "/tmp/preview-pip-preload.cjs",
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, state) => states.push(state) } }),
  });
  manager.setWorkspaceOrigin("http://127.0.0.1:3224");
  return { manager, fake, states };
}

test("new preview tabs normalize navigation and restrict permissions", () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("tab-1", { url: "127.0.0.1:3223/pm" });
    assert.match(created.partition, /^persist:pm-preview-[a-f0-9]{16}$/);
    assert.equal(created.state.url, "http://127.0.0.1:3223/pm");
    assert.equal(created.state.navStatus.kind, "loading");
    const previewSession = fake.sessions.get(created.partition);
    assert.equal(typeof previewSession.permissionRequest, "function");
    assert.equal(previewSession.permissionCheck({}, "fullscreen"), true);
    assert.equal(previewSession.permissionCheck({}, "media"), false);
  } finally {
    manager.destroy();
  }
});

test("registered guest navigation, title and favicon flow into published state", async () => {
  const { manager, fake, states } = makeManager();
  try {
    const created = manager.createTab("tab-2", { url: "http://127.0.0.1:3223/pm" });
    const session = fake.sessions.get(created.partition);
    const wc = fake.register(2, session);
    await manager.registerWebview("tab-2", 2);
    assert.equal(wc.url, "http://127.0.0.1:3223/pm");
    wc.url = "http://127.0.0.1:3223/workspace";
    wc.title = "EasyuseUI · 项目管理";
    wc.emit("did-navigate", {}, wc.url);
    wc.emit("page-title-updated", {}, wc.title);
    wc.emit("page-favicon-updated", {}, ["http://127.0.0.1:3223/favicon.ico"]);
    wc.loading = false;
    wc.emit("did-stop-loading");
    const last = states.at(-1);
    assert.equal(last.url, "http://127.0.0.1:3223/workspace");
    assert.equal(last.navStatus.kind, "success");
    assert.equal(last.title, "EasyuseUI · 项目管理");
    assert.equal(last.faviconUrl, "http://127.0.0.1:3223/favicon.ico");
  } finally {
    manager.destroy();
  }
});

test("capture is serialized and returns a data URL", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("tab-3", { url: "http://127.0.0.1:3223/pm" });
    const wc = fake.register(3, fake.sessions.get(created.partition));
    await manager.registerWebview("tab-3", 3);
    wc.title = "Captured page";
    const [first, second] = await Promise.all([manager.capture("tab-3"), manager.capture("tab-3")]);
    assert.equal(first.dataUrl, "data:image/png;base64,FULL");
    assert.equal(second.dataUrl, first.dataUrl);
    assert.equal(first.url, wc.url);
    assert.equal(first.title, "Captured page");
    assert.notEqual(first.captureId, second.captureId);
    assert.match(first.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(wc.isDestroyed(), false);
  } finally {
    manager.destroy();
  }
});

test("element pick starts the guest overlay and crops by DPR", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("tab-4", { url: "http://127.0.0.1:3223/pm" });
    const wc = fake.register(4, fake.sessions.get(created.partition));
    await manager.registerWebview("tab-4", 4);
    const pending = manager.pick("tab-4");
    const start = wc.sent.find((entry) => entry.channel === START_PICK);
    assert.ok(start);
    wc.ipc.emit(ELEMENT_PICKED, {}, {
      rect: { x: 10, y: 20, width: 100, height: 50 },
      dpr: 2,
      selector: "#hero",
      tagName: "div",
      text: "Hello",
    });
    const result = await pending;
    assert.equal(result.selector, "#hero");
    assert.equal(result.tagName, "div");
    assert.equal(result.dataUrl, "data:image/png;base64,CROP:20,40,200,100");
    assert.equal(result.screenshotFailed, false);
    assert.equal(result.url, wc.url);
    assert.deepEqual(result.rect, { x: 10, y: 20, width: 100, height: 50 });
    assert.equal(result.devicePixelRatio, 2);
    assert.match(result.captureId, /^[a-f0-9-]{36}$/);
  } finally {
    manager.destroy();
  }
});

test("a failed screenshot keeps the selected element snapshot and its explicit error", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("failed-crop", { url: "http://127.0.0.1:3224/page" });
    const wc = fake.register(20, fake.sessions.get(created.partition));
    await manager.registerWebview("failed-crop", 20);
    wc.title = "Original page";
    wc.capturePage = () => Promise.reject(new Error("capture unavailable"));
    const pending = manager.pick("failed-crop");
    wc.ipc.emit(ELEMENT_PICKED, {}, { rect: { x: 4, y: 8, width: 80, height: 30 }, dpr: 1, selector: "#save", tagName: "button", text: "Save" });
    const result = await pending;
    assert.equal(result.url, "http://127.0.0.1:3224/page");
    assert.equal(result.title, "Original page");
    assert.equal(result.selector, "#save");
    assert.equal(result.text, "Save");
    assert.equal(result.dataUrl, null);
    assert.equal(result.screenshotFailed, true);
    assert.equal(result.screenshotError, "capture unavailable");
    assert.equal(wc.ipc.listenerCount(ELEMENT_PICKED), 0);
  } finally {
    manager.destroy();
  }
});

test("navigation during an accepted element capture preserves the old snapshot without a mismatched image", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("changing-crop", { url: "http://127.0.0.1:3224/original" });
    const wc = fake.register(21, fake.sessions.get(created.partition));
    await manager.registerWebview("changing-crop", 21);
    let finishCapture;
    wc.capturePage = () => new Promise(resolve => { finishCapture = resolve; });
    const pending = manager.pick("changing-crop");
    wc.ipc.emit(ELEMENT_PICKED, {}, { rect: { x: 0, y: 0, width: 50, height: 20 }, dpr: 1, selector: "h1", tagName: "h1", text: "Original heading" });
    await Promise.resolve();
    assert.equal(typeof finishCapture, "function");
    wc.url = "http://127.0.0.1:3224/replacement";
    wc.emit("did-start-navigation", {}, wc.url, false, true);
    finishCapture(fakeImage());
    const result = await pending;
    assert.equal(result.url, "http://127.0.0.1:3224/original");
    assert.equal(result.text, "Original heading");
    assert.equal(result.dataUrl, null);
    assert.equal(result.screenshotFailed, true);
    assert.match(result.screenshotError, /page changed/);
  } finally {
    manager.destroy();
  }
});

test("standalone captures reject a navigation race instead of attaching the wrong page", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("changing-page", { url: "http://127.0.0.1:3224/original" });
    const wc = fake.register(22, fake.sessions.get(created.partition));
    await manager.registerWebview("changing-page", 22);
    let finishCapture;
    wc.capturePage = () => new Promise(resolve => { finishCapture = resolve; });
    const pending = manager.capture("changing-page");
    await Promise.resolve();
    assert.equal(typeof finishCapture, "function");
    wc.emit("did-start-navigation", {}, wc.url, false, true);
    finishCapture(fakeImage());
    await assert.rejects(pending, /page changed/);
  } finally {
    manager.destroy();
  }
});

test("picker cancellation returns no element record and ignores a late guest selection", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("cancelled-pick", { url: "http://127.0.0.1:3224/page" });
    const wc = fake.register(23, fake.sessions.get(created.partition));
    await manager.registerWebview("cancelled-pick", 23);
    const pending = manager.pick("cancelled-pick");
    await manager.cancelPick("cancelled-pick");
    wc.ipc.emit(ELEMENT_PICKED, {}, { selector: "#late" });
    assert.deepEqual(await pending, { cancelled: true });
    assert.equal(wc.ipc.listenerCount(ELEMENT_PICKED), 0);
  } finally {
    manager.destroy();
  }
});

test("an empty native image keeps the element without claiming a screenshot", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("empty-crop", { url: "http://127.0.0.1:3224/page" });
    const wc = fake.register(24, fake.sessions.get(created.partition));
    await manager.registerWebview("empty-crop", 24);
    wc.capturePage = () => Promise.resolve({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) });
    const pending = manager.pick("empty-crop");
    wc.ipc.emit(ELEMENT_PICKED, {}, { rect: { x: 0, y: 0, width: 20, height: 20 }, dpr: 1, selector: "div", tagName: "div", text: "" });
    const result = await pending;
    assert.equal(result.text, "");
    assert.equal(result.dataUrl, null);
    assert.equal(result.screenshotFailed, true);
    assert.match(result.screenshotError, /empty/);
  } finally {
    manager.destroy();
  }
});

test("main-frame navigation cancels picking while subframe navigation preserves it", async () => {
  const { manager, fake } = makeManager();
  try {
    const created = manager.createTab("navigation-pick", { url: "http://127.0.0.1:3224/pm" });
    const wc = fake.register(12, fake.sessions.get(created.partition));
    await manager.registerWebview("navigation-pick", 12);
    const pending = manager.pick("navigation-pick");
    let result;
    void pending.then(value => { result = value; });
    wc.emit("did-start-navigation", {}, "http://127.0.0.1:3224/frame", false, false);
    await Promise.resolve();
    assert.equal(result, undefined);
    wc.emit("did-start-navigation", {}, "http://127.0.0.1:3224/next", false, true);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(result, { cancelled: true });
    assert.equal(wc.ipc.listenerCount(ELEMENT_PICKED), 0);
  } finally {
    manager.destroy();
  }
});

test("invalid preview URLs and unknown tabs are rejected", async () => {
  const { manager } = makeManager();
  try {
    assert.throws(() => manager.createTab("tab-5", { url: "file:///etc/passwd" }));
    assert.throws(() => manager.createTab("tab-6", { url: "ftp://example.com" }));
    await assert.rejects(manager.navigate("missing", "http://127.0.0.1:3223"));
    assert.throws(() => manager.createTab("x".repeat(129)));
  } finally {
    manager.destroy();
  }
});

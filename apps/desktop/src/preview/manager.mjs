import { pathToFileURL } from "node:url";
import {
  elementCropRect,
  isAllowedPreviewUrl,
  isPreviewPartition,
  normalizePreviewRect,
  normalizePreviewUrl,
  pipPageDataUrl,
  previewPartition,
  previewTabId,
} from "./preview-policy.mjs";

const START_PICK = "pm-preview:start-pick";
const CANCEL_PICK = "pm-preview:cancel-pick";
const ELEMENT_PICKED = "pm-preview:element-picked";
const PICK_CANCELLED = "pm-preview:pick-cancelled";
const PIP_FRAME = "pm-preview:pip-frame";
const PIP_CLOSE = "pm-preview:pip-close";
const CAPTURE_TIMEOUT_MS = 2_000;
const CAPTURE_ATTEMPTS = 2;
const PICK_TIMEOUT_MS = 30_000;
const PIP_INTERVAL_MS = Math.round(1_000 / 12);
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

const idleState = (tab) => ({
  tabId: tab.tabId,
  partition: tab.partition,
  url: tab.url,
  navStatus: tab.navStatus,
  canGoBack: tab.canGoBack,
  canGoForward: tab.canGoForward,
  title: tab.title,
  faviconUrl: tab.faviconUrl,
  loading: tab.loading,
});

const withTimeout = (promise, milliseconds, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The browser tab is a renderer-mounted <webview>; this main-process manager
 * owns its session, navigation state, screenshots, picker and floating preview.
 */
export class PreviewManager {
  constructor({ electron, guestPreloadPath, pipPreloadPath, getWindow, onOpenLink }) {
    if (!electron) throw new Error("The Electron API is required.");
    this.BrowserWindow = electron.BrowserWindow;
    this.ipcMain = electron.ipcMain;
    this.nativeTheme = electron.nativeTheme;
    this.session = electron.session;
    this.webContents = electron.webContents;
    if (typeof guestPreloadPath !== "string" || !guestPreloadPath) throw new Error("A guest preload path is required.");
    if (typeof pipPreloadPath !== "string" || !pipPreloadPath) throw new Error("A PiP preload path is required.");
    this.guestPreloadPath = guestPreloadPath;
    this.guestPreloadUrl = pathToFileURL(guestPreloadPath).href;
    this.pipPreloadPath = pipPreloadPath;
    this.getWindow = getWindow;
    this.onOpenLink = onOpenLink;
    this.tabs = new Map();
    this.pip = null;
    this.partition = null;
    this.workspaceOrigin = null;
    this.configuredPartitions = new Set();
    this.ipcMain.on(PIP_CLOSE, this.#onPipClose);
  }

  #onPipClose = (event) => {
    if (this.pip?.window && !this.pip.window.isDestroyed() && event.sender === this.pip.window.webContents) this.closePiP();
  };

  getState(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    return tab ? idleState(tab) : null;
  }

  setWorkspaceOrigin(origin) {
    const nextPartition = previewPartition(origin);
    if (this.partition && this.partition !== nextPartition) this.dispose();
    this.workspaceOrigin = origin;
    this.partition = nextPartition;
    this.configureSession(nextPartition);
  }

  configureSession(partition) {
    if (!isPreviewPartition(partition)) throw new Error("Invalid preview partition.");
    const target = this.session.fromPartition(partition);
    if (this.configuredPartitions.has(partition)) return target;
    this.configuredPartitions.add(partition);
    target.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    target.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
    target.setDevicePermissionHandler(() => false);
    target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      try {
        const protocol = new URL(details.url).protocol;
        callback({ cancel: !["http:", "https:", "data:", "blob:", "ws:", "wss:", "devtools:", "about:"].includes(protocol) });
      } catch {
        callback({ cancel: true });
      }
    });
    target.removeAllListeners("will-download");
    target.on("will-download", (_event, item) => {
      // Keep user-initiated downloads out of the workspace's managed files.
      item.setSaveDialogOptions({ title: "Save preview download" });
    });
    return target;
  }

  validateAttach(params) {
    if (!this.partition || !params || typeof params !== "object") return false;
    if (params.partition !== this.partition) return false;
    if (typeof params.src !== "string") return false;
    return params.src === "about:blank" || isAllowedPreviewUrl(params.src);
  }

  createTab(tabId, options = {}) {
    const id = previewTabId(tabId);
    if (!this.partition) throw new Error("The workspace preview session is not ready.");
    const existing = this.tabs.get(id);
    if (existing) return { partition: existing.partition, preload: this.guestPreloadUrl, state: idleState(existing) };
    const pendingUrl = options.url ? normalizePreviewUrl(options.url) : null;
    const tab = {
      tabId: id,
      partition: this.partition,
      url: pendingUrl,
      pendingUrl,
      navStatus: pendingUrl ? { kind: "loading", url: pendingUrl } : { kind: "idle" },
      canGoBack: false,
      canGoForward: false,
      title: "",
      faviconUrl: "",
      loading: Boolean(pendingUrl),
      wc: null,
      webContentsId: null,
      detach: null,
      captureQueue: Promise.resolve(),
      pick: null,
    };
    this.tabs.set(id, tab);
    this.publish(tab);
    return { partition: tab.partition, preload: this.guestPreloadUrl, state: idleState(tab) };
  }

  async registerWebview(tabId, webContentsId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab) throw new Error("Unknown preview tab.");
    if (!Number.isInteger(webContentsId) || webContentsId <= 0) throw new Error("Invalid preview webContents id.");
    const wc = this.webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error("The preview page is not attached.");
    if (wc.session !== this.session.fromPartition(tab.partition)) throw new Error("The preview page uses an unexpected session.");
    if (tab.wc === wc && tab.webContentsId === wc.id) return idleState(tab);
    this.detachWebview(tab);
    tab.wc = wc;
    tab.webContentsId = wc.id;
    this.attachListeners(tab, wc);
    this.publish(tab);
    if (tab.pendingUrl) {
      const target = tab.pendingUrl;
      tab.pendingUrl = null;
      await this.navigate(tab.tabId, target);
    } else if (tab.url && tab.url !== "about:blank") {
      await this.navigate(tab.tabId, tab.url);
    }
    return idleState(tab);
  }

  attachListeners(tab, wc) {
    const cleanups = [];
    const on = (event, handler) => {
      wc.on(event, handler);
      cleanups.push(() => wc.off(event, handler));
    };
    const update = () => {
      this.refreshNavigation(tab);
      this.publish(tab);
    };
    on("did-start-loading", () => {
      tab.loading = true;
      tab.navStatus = { kind: "loading", url: tab.url ?? "" };
      this.publish(tab);
    });
    on("did-stop-loading", () => {
      tab.loading = false;
      this.refreshNavigation(tab);
      if (tab.navStatus.kind !== "failed") tab.navStatus = { kind: "success", url: tab.url ?? "", title: tab.title };
      this.publish(tab);
    });
    on("did-navigate", (_event, url) => {
      tab.url = url;
      tab.loading = true;
      tab.navStatus = { kind: "loading", url };
      update();
    });
    on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      if (!tab.loading) tab.navStatus = { kind: "success", url, title: tab.title };
      update();
    });
    on("page-title-updated", (_event, title) => {
      tab.title = String(title ?? "").slice(0, 512);
      if (tab.navStatus.kind === "success") tab.navStatus = { kind: "success", url: tab.url ?? "", title: tab.title };
      this.publish(tab);
    });
    on("page-favicon-updated", (_event, favicons) => {
      const favicon = Array.isArray(favicons) ? favicons.find((value) => typeof value === "string" && value) : undefined;
      if (favicon) {
        tab.faviconUrl = favicon;
        this.publish(tab);
      }
    });
    on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.loading = false;
      tab.url = validatedURL || tab.url;
      tab.navStatus = { kind: "failed", url: tab.url ?? "", code, description: String(description ?? "") };
      this.publish(tab);
    });
    on("render-process-gone", (_event, details) => {
      tab.loading = false;
      tab.navStatus = { kind: "failed", url: tab.url ?? "", code: -1, description: `Renderer exited (${details?.reason ?? "unknown"}).` };
      this.publish(tab);
    });
    on("will-navigate", (event, url) => {
      if (!isAllowedPreviewUrl(url)) event.preventDefault();
    });
    on("will-redirect", (event, url) => {
      if (!isAllowedPreviewUrl(url)) event.preventDefault();
    });
    on("will-attach-webview", (event) => event.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedPreviewUrl(url)) this.onOpenLink?.({ tabId: tab.tabId, url });
      return { action: "deny" };
    });
    tab.detach = () => cleanups.forEach((cleanup) => cleanup());
  }

  detachWebview(tab) {
    tab.detach?.();
    tab.detach = null;
    tab.wc = null;
    tab.webContentsId = null;
    this.cancelPick(tab.tabId).catch(() => {});
  }

  refreshNavigation(tab) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) return;
    tab.url = wc.getURL() || tab.url;
    tab.title = wc.getTitle() || tab.title;
    tab.canGoBack = wc.navigationHistory.canGoBack();
    tab.canGoForward = wc.navigationHistory.canGoForward();
    tab.loading = wc.isLoading();
  }

  publish(tab) {
    const window = this.getWindow?.();
    if (!window || window.isDestroyed()) return;
    window.webContents.send("desktop:preview-state", idleState(tab));
  }

  async navigate(tabId, rawUrl) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab) throw new Error("Unknown preview tab.");
    const url = normalizePreviewUrl(rawUrl);
    tab.url = url;
    tab.loading = true;
    tab.navStatus = { kind: "loading", url };
    this.publish(tab);
    if (!tab.wc || tab.wc.isDestroyed()) {
      tab.pendingUrl = url;
      return idleState(tab);
    }
    try {
      await tab.wc.loadURL(url);
    } catch (error) {
      if (tab.url !== url || (error && error.code === "ERR_ABORTED") || /ERR_ABORTED/.test(String(error?.message))) return idleState(tab);
      tab.loading = false;
      tab.navStatus = { kind: "failed", url, code: -1, description: error instanceof Error ? error.message : String(error) };
      this.publish(tab);
      throw error;
    }
    return idleState(tab);
  }

  async back(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab?.wc || tab.wc.isDestroyed() || !tab.wc.navigationHistory.canGoBack()) return this.getState(tabId);
    tab.wc.navigationHistory.goBack();
    return idleState(tab);
  }

  async forward(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab?.wc || tab.wc.isDestroyed() || !tab.wc.navigationHistory.canGoForward()) return this.getState(tabId);
    tab.wc.navigationHistory.goForward();
    return idleState(tab);
  }

  async reload(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab) throw new Error("Unknown preview tab.");
    if (!tab.wc || tab.wc.isDestroyed()) {
      if (tab.url) return this.navigate(tab.tabId, tab.url);
      return idleState(tab);
    }
    tab.wc.reload();
    return idleState(tab);
  }

  async stop(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (tab?.wc && !tab.wc.isDestroyed()) tab.wc.stop();
    return tab ? idleState(tab) : null;
  }

  async openDevTools(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab?.wc || tab.wc.isDestroyed()) throw new Error("The preview page is not attached.");
    tab.wc.openDevTools({ mode: "detach" });
  }

  #capturePage(tab) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) throw new Error("The preview page is not attached.");
    const capture = () => withTimeout(wc.capturePage(), CAPTURE_TIMEOUT_MS, "Preview screenshot timed out.");
    const attempt = async (remaining) => {
      try {
        return await capture();
      } catch (error) {
        if (remaining <= 1) throw error;
        return attempt(remaining - 1);
      }
    };
    return attempt(CAPTURE_ATTEMPTS);
  }

  serializeCapture(tab, task) {
    const run = () => task();
    const next = tab.captureQueue.then(run, run);
    tab.captureQueue = next.catch(() => {});
    return next;
  }

  async capture(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab) throw new Error("Unknown preview tab.");
    return this.serializeCapture(tab, async () => {
      const image = await this.#capturePage(tab);
      const size = image.getSize();
      return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
    });
  }

  async pick(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab?.wc || tab.wc.isDestroyed()) throw new Error("The preview page is not attached.");
    this.cancelPick(tab.tabId);
    const wc = tab.wc;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        wc.ipc.removeListener(ELEMENT_PICKED, onPicked);
        wc.ipc.removeListener(PICK_CANCELLED, onCancelled);
        wc.off("destroyed", onDestroyed);
        wc.off("did-start-navigation", onNavigated);
        clearTimeout(timer);
        if (tab.pick === session) tab.pick = null;
      };
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onCancelled = () => finish({ cancelled: true });
      const onDestroyed = () => finish({ cancelled: true });
      const onNavigated = (_event, _url, _isInPlace, isMainFrame) => {
        if (isMainFrame) finish({ cancelled: true });
      };
      const onPicked = async (_event, payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          const rect = normalizePreviewRect(payload?.rect, "element rect");
          const dpr = typeof payload?.dpr === "number" && payload.dpr > 0 ? payload.dpr : 1;
          const image = await this.serializeCapture(tab, () => this.#capturePage(tab));
          const crop = elementCropRect(rect, dpr, image.getSize());
          const cropped = crop ? image.crop(crop) : null;
          if (!cropped) throw new Error("The selected element is outside the visible preview.");
          wc.send(CANCEL_PICK);
          resolve({
            dataUrl: cropped.toDataURL(),
            width: crop.width,
            height: crop.height,
            url: tab.url ?? wc.getURL(),
            title: tab.title || wc.getTitle(),
            selector: typeof payload?.selector === "string" ? payload.selector.slice(0, 512) : "",
            tagName: typeof payload?.tagName === "string" ? payload.tagName.slice(0, 64) : "",
            text: typeof payload?.text === "string" ? payload.text.slice(0, 2000) : "",
            screenshotFailed: false,
          });
        } catch (error) {
          wc.send(CANCEL_PICK);
          reject(error);
        }
      };
      const session = { cancel: () => finish({ cancelled: true }) };
      tab.pick = session;
      wc.ipc.on(ELEMENT_PICKED, onPicked);
      wc.ipc.once(PICK_CANCELLED, onCancelled);
      wc.once("destroyed", onDestroyed);
      wc.on("did-start-navigation", onNavigated);
      timer = setTimeout(() => {
        wc.send(CANCEL_PICK);
        finish({ cancelled: true });
      }, PICK_TIMEOUT_MS);
      if (!wc.isFocused()) wc.focus();
      wc.send(START_PICK, { dark: this.nativeTheme.shouldUseDarkColors });
    });
  }

  async cancelPick(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    const pending = tab?.pick;
    if (!pending) return { cancelled: true };
    pending.cancel();
    if (tab?.wc && !tab.wc.isDestroyed()) tab.wc.send(CANCEL_PICK);
    return { cancelled: true };
  }

  async openPiP(tabId) {
    const tab = this.tabs.get(previewTabId(tabId));
    if (!tab?.wc || tab.wc.isDestroyed()) throw new Error("The preview page is not attached.");
    this.closePiP();
    const window = new this.BrowserWindow({
      width: 480,
      height: 320,
      minWidth: 240,
      minHeight: 160,
      alwaysOnTop: true,
      skipTaskbar: true,
      frame: false,
      resizable: true,
      backgroundColor: "#111111",
      webPreferences: {
        preload: this.pipPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const pip = { window, tabId: tab.tabId, timer: null, inFlight: false };
    this.pip = pip;
    window.setAlwaysOnTop(true, "floating");
    try { window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* Platform-specific. */ }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("closed", () => {
      clearInterval(pip.timer);
      if (this.pip === pip) this.pip = null;
    });
    await window.loadURL(pipPageDataUrl());
    const sendFrame = async () => {
      if (pip.inFlight || window.isDestroyed() || !tab.wc || tab.wc.isDestroyed()) return;
      pip.inFlight = true;
      try {
        const image = await this.serializeCapture(tab, () => this.#capturePage(tab));
        if (!window.isDestroyed() && this.pip === pip) window.webContents.send(PIP_FRAME, `data:image/jpeg;base64,${image.toJPEG(78).toString("base64")}`);
      } catch { /* A frame may race a navigation; the next tick retries. */ }
      finally { pip.inFlight = false; }
    };
    pip.timer = setInterval(() => { void sendFrame(); }, PIP_INTERVAL_MS);
    await sendFrame();
    return { open: true };
  }

  closePiP() {
    const pip = this.pip;
    if (!pip) return;
    this.pip = null;
    clearInterval(pip.timer);
    if (!pip.window.isDestroyed()) pip.window.destroy();
  }

  isPiPOpen(tabId) {
    return this.pip?.tabId === tabId && !this.pip.window.isDestroyed();
  }

  closeTab(tabId) {
    const id = previewTabId(tabId);
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.pip?.tabId === id) this.closePiP();
    this.cancelPick(id).catch(() => {});
    this.detachWebview(tab);
    this.tabs.delete(id);
  }

  dispose() {
    this.closePiP();
    for (const tabId of [...this.tabs.keys()]) this.closeTab(tabId);
    this.tabs.clear();
    this.configuredPartitions.clear();
    this.partition = null;
    this.workspaceOrigin = null;
  }

  destroy() {
    this.dispose();
    this.ipcMain.removeListener(PIP_CLOSE, this.#onPipClose);
  }
}

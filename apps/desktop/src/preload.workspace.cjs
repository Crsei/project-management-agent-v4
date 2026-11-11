const { contextBridge, ipcRenderer, webFrame } = require("electron");

const platform = process.platform;

const actions = new Set([
  "state", "create-tab", "close-tab", "register-webview", "navigate",
  "back", "forward", "reload", "stop", "capture", "pick", "cancel-pick",
  "pip-open", "pip-close", "devtools", "open-external",
]);

const invoke = (action, payload = {}) => {
  if (!actions.has(action)) return Promise.reject(new Error("Unknown preview action."));
  const input = { action };
  if (typeof payload.tabId === "string") input.tabId = payload.tabId;
  if (action === "create-tab") input.options = payload.options ?? {};
  if (action === "register-webview") input.webContentsId = payload.webContentsId;
  if (action === "navigate") input.url = payload.url;
  if (action === "open-external") input.url = payload.url;
  return ipcRenderer.invoke("desktop:preview", input);
};

const subscribe = (channel, listener) => {
  if (typeof listener !== "function") throw new TypeError("A listener is required.");
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Window chrome is available in every desktop workspace mode, including remote
// workspaces. It exposes only the client platform and a theme setter; no
// filesystem, process, shell or generic IPC capability crosses the bridge.
contextBridge.exposeInMainWorld("desktopShell", Object.freeze({
  platform,
  titlebarHeight: platform === "darwin" ? 56 : 40,
  setTitlebarTheme: theme => {
    if (theme !== "light" && theme !== "dark") return Promise.reject(new TypeError("Title bar theme must be light or dark."));
    return ipcRenderer.invoke("desktop:titlebar-theme", theme);
  },
}));

if (platform === "darwin" && typeof document !== "undefined" && typeof window !== "undefined") {
  // Native traffic lights do not scale with Chromium zoom. Reserve their space
  // in native points so the React titlebar keeps clear at every zoom level.
  const syncWindowControlInset = () => {
    try {
      document.documentElement.style.setProperty("--desktop-window-controls-inset", `${90 / webFrame.getZoomFactor()}px`);
    } catch { /* The CSS fallback still reserves the default inset. */ }
  };
  window.addEventListener("DOMContentLoaded", syncWindowControlInset, { once: true });
  window.addEventListener("resize", syncWindowControlInset);
  syncWindowControlInset();
}

const enabled = typeof process !== "undefined" && Array.isArray(process.argv) && process.argv.includes("--pm-native-preview");
if (enabled) contextBridge.exposeInMainWorld("desktopWorkspace", Object.freeze({
  setup: Object.freeze({
    token: () => ipcRenderer.invoke("desktop:first-run-token"),
  }),
  directories: Object.freeze({
    choose: () => ipcRenderer.invoke("desktop:choose-workspace-directory"),
  }),
  preview: Object.freeze({
    state: (tabId) => invoke("state", { tabId }),
    createTab: (tabId, options = {}) => invoke("create-tab", { tabId, options }),
    closeTab: (tabId) => invoke("close-tab", { tabId }),
    registerWebview: (tabId, webContentsId) => invoke("register-webview", { tabId, webContentsId }),
    navigate: (tabId, url) => invoke("navigate", { tabId, url }),
    back: (tabId) => invoke("back", { tabId }),
    forward: (tabId) => invoke("forward", { tabId }),
    reload: (tabId) => invoke("reload", { tabId }),
    stop: (tabId) => invoke("stop", { tabId }),
    capture: (tabId) => invoke("capture", { tabId }),
    pick: (tabId) => invoke("pick", { tabId }),
    cancelPick: (tabId) => invoke("cancel-pick", { tabId }),
    openPiP: (tabId) => invoke("pip-open", { tabId }),
    closePiP: (tabId) => invoke("pip-close", { tabId }),
    openDevTools: (tabId) => invoke("devtools", { tabId }),
    openExternal: (url) => invoke("open-external", { url }),
    onState: (listener) => subscribe("desktop:preview-state", listener),
    onOpenLink: (listener) => subscribe("desktop:preview-open-link", listener),
  }),
}));

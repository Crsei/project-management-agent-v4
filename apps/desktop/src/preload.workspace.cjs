const { contextBridge, ipcRenderer } = require("electron");

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

const enabled = typeof process !== "undefined" && Array.isArray(process.argv) && process.argv.includes("--pm-native-preview");
if (enabled) contextBridge.exposeInMainWorld("desktopWorkspace", Object.freeze({
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

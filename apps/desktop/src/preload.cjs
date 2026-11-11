const { contextBridge, ipcRenderer, webFrame } = require("electron");

const platform = process.platform;

if (platform === "darwin" && typeof document !== "undefined" && typeof window !== "undefined") {
  const syncWindowControlInset = () => {
    try {
      document.documentElement.style.setProperty("--desktop-window-controls-inset", `${90 / webFrame.getZoomFactor()}px`);
    } catch { /* The CSS fallback still reserves the default inset. */ }
  };
  window.addEventListener("DOMContentLoaded", syncWindowControlInset, { once: true });
  window.addEventListener("resize", syncWindowControlInset);
  syncWindowControlInset();
}

// Bundled connection page only. Business/remote pages receive no native bridge.
const actions = new Set(["state", "connect", "open", "disconnect", "directory", "reveal", "node", "backup", "restore", "quit", "update-check", "update-download", "update-cancel", "update-install"]);
contextBridge.exposeInMainWorld("desktopConnection", Object.freeze({
  platform,
  invoke: (action, options = {}) => {
    if (!actions.has(action)) return Promise.reject(new Error("Unknown desktop action."));
    const input = { action };
    if (action === "connect") input.configuration = options.configuration;
    if (action === "directory" || action === "reveal") input.field = options.field;
    if ((action === "backup" || action === "restore") && typeof options.password === "string") input.password = options.password;
    if (action === "restore") input.allowLegacyUnencrypted = options.allowLegacyUnencrypted === true;
    if (action === "restore") input.trustedSourceAcknowledged = options.trustedSourceAcknowledged === true;
    return ipcRenderer.invoke("desktop:action", input);
  },
  onState: listener => {
    if (typeof listener !== "function") throw new TypeError("A listener is required.");
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("desktop:state", handler);
    return () => ipcRenderer.removeListener("desktop:state", handler);
  },
}));

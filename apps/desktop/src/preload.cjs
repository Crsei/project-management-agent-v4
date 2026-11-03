const { contextBridge, ipcRenderer } = require("electron");

// Bundled connection page only. Business/remote pages receive no native bridge.
const actions = new Set(["state", "connect", "open", "disconnect", "directory", "reveal", "node", "backup", "restore", "quit"]);
contextBridge.exposeInMainWorld("desktopConnection", Object.freeze({
  invoke: (action, options = {}) => {
    if (!actions.has(action)) return Promise.reject(new Error("Unknown desktop action."));
    const input = { action };
    if (action === "connect") input.configuration = options.configuration;
    if (action === "directory" || action === "reveal") input.field = options.field;
    return ipcRenderer.invoke("desktop:action", input);
  },
  onState: listener => {
    if (typeof listener !== "function") throw new TypeError("A listener is required.");
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("desktop:state", handler);
    return () => ipcRenderer.removeListener("desktop:state", handler);
  },
}));

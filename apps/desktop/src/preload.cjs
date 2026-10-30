const { contextBridge, ipcRenderer } = require("electron");

// This preload is attached only to the bundled connection page, never a workspace.
contextBridge.exposeInMainWorld(
  "desktopConnection",
  Object.freeze({
    invoke: (action, options = {}) => ipcRenderer.invoke("desktop:action", { ...options, action }),
    onState: (listener) => {
      if (typeof listener !== "function") throw new TypeError("A listener is required.");
      const handler = (_event, value) => listener(value);
      ipcRenderer.on("desktop:state", handler);
      return () => ipcRenderer.removeListener("desktop:state", handler);
    },
  }),
);

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("previewPictureInPicture", Object.freeze({
  onFrame: (listener) => {
    if (typeof listener !== "function") throw new TypeError("A frame listener is required.");
    const handler = (_event, dataUrl) => listener(String(dataUrl));
    ipcRenderer.on("pm-preview:pip-frame", handler);
    return () => ipcRenderer.removeListener("pm-preview:pip-frame", handler);
  },
  close: () => ipcRenderer.send("pm-preview:pip-close"),
}));

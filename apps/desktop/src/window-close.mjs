// Electron cancels renderer beforeunload guards without a browser confirmation UI.
// Keep that protection, but let the user explicitly decide in this exact window.
export function protectWorkspaceClose(window, { dialog, onError, timeout = 15_000 }) {
  let pending;
  const cancelled = () => new Error("Workspace close was cancelled. Save or verify pending changes in the workspace, then retry Disconnect or Quit.");

  window.webContents.on("will-prevent-unload", (event) => {
    try {
      const response = dialog.showMessageBoxSync(window, {
        type: "warning", title: "确认离开工作台", message: "工作台有未保存或尚待确认的更改。",
        detail: "返回工作台可保存更改或核对尚未完成的操作。仍然离开可能丢失未保存的内容；结果不明的操作请先核对，不要重复提交。",
        buttons: ["留在工作台", "仍然离开"], defaultId: 0, cancelId: 0, noLink: true,
      });
      // For this Electron event, preventDefault means allow the guarded unload.
      if (response === 1) event.preventDefault();
      else pending?.reject(cancelled());
    } catch (cause) {
      pending?.reject(cause);
      onError(cause);
    }
  });

  return function close() {
    if (window.isDestroyed()) return Promise.resolve();
    if (pending) return pending.promise;
    const { promise, resolve, reject } = Promise.withResolvers();
    let timer;
    const settle = (cause) => {
      clearTimeout(timer);
      window.removeListener("closed", closed);
      pending = undefined;
      if (cause) reject(cause);
      else resolve();
    };
    const closed = () => settle();
    pending = { promise, reject: settle };
    window.once("closed", closed);
    timer = setTimeout(() => settle(new Error("The workspace window did not close. Local services have not been stopped. Return to the workspace to finish any dialog, then retry Disconnect or Quit.")), timeout);
    try { window.close(); }
    catch (cause) { settle(cause); }
    return promise;
  };
}

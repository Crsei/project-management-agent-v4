import { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalServer } from "./local-server.mjs";
import { backupDesktop, restoreDesktop } from "./maintenance.mjs";
import { captureWindowState, restoredWindowBounds } from "./window-state.mjs";
import {
  absolutePath, initialSetup, publicConfiguration, readLaunchArguments, remoteAddress,
  safeDesktopMessage, sameService, serviceRequestAllowed, trustedConnectionFrame, workspacePartition,
} from "./policy.mjs";

app.setName("PM Agent v4");
app.setAppUserModelId("com.projectmanagementagent.v4");
app.setPath("userData", join(app.getPath("appData"), "PM Agent v4"));
const here = dirname(fileURLToPath(import.meta.url));
const connectionUrl = pathToFileURL(join(here, "connection.html")).href;
const repository = resolve(here, "../../..");
const serverRoot = app.isPackaged ? join(process.resourcesPath, "workspace-runtime") : repository;
const runtimeRoot = app.isPackaged
  ? join(process.resourcesPath, "desktop-runtime")
  : resolve(process.env.PM_DESKTOP_RUNTIME_ROOT || join(repository, "apps", "desktop", ".runtime", "desktop-runtime"));
let connectionWindow;
let workspaceWindow;
let localServer;
let workspaceSession;
let workspaceMode;
let workspaceUrl;
let allowQuit = false;
let quitting = false;
let quitPrompt = false;
let quitPromise;
let stopPromise;
let maintenancePromise;
let changingConnection = false;
let externalPrompt = false;
let configuration;
let settingsFile;
let windowStateFile;
let windowStates = {};
let windowStateWrite = Promise.resolve();
let transientSecrets = [];
const state = {
  status: "idle", message: "Choose where your workspace runs.", error: "", details: "", address: "", runtime: "", setupSuggested: true,
};

function localRunning() {
  return Boolean(localServer?.running || localServer?.processCount > 0);
}

function snapshot() {
  return {
    ...state,
    configuration: publicConfiguration(configuration || {}, !app.isPackaged),
    localRunning: localRunning(),
    processCount: localServer?.processCount || 0,
    developerRuntime: !app.isPackaged,
    workspaceOpen: Boolean(workspaceWindow && !workspaceWindow.isDestroyed()),
    maintenanceAllowed: !changingConnection && !maintenancePromise && !quitting && !quitPrompt && !localRunning() && !workspaceSession,
  };
}

function publish(patch) {
  for (const key of ["message", "error", "details"])
    if (key in patch) patch[key] = safeDesktopMessage(patch[key], transientSecrets);
  Object.assign(state, patch);
  if (connectionWindow && !connectionWindow.isDestroyed())
    connectionWindow.webContents.send("desktop:state", snapshot());
}

function rememberWindow(kind, window) {
  const saved = captureWindowState(window);
  if (!saved || !windowStateFile) return;
  windowStates[kind] = saved;
  const value = `${JSON.stringify(windowStates)}\n`;
  windowStateWrite = windowStateWrite.catch(() => {}).then(() => writeFile(windowStateFile, value, { mode: 0o600 })).catch(() => {});
}

function watchWindow(kind, window) {
  let timer;
  const remember = () => {
    clearTimeout(timer);
    timer = setTimeout(() => rememberWindow(kind, window), 300);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) window.on(event, remember);
  window.on("close", () => { clearTimeout(timer); rememberWindow(kind, window); });
  window.on("closed", () => clearTimeout(timer));
  if (windowStates[kind]?.maximized) window.maximize();
}

function securePreferences(partition, preload) {
  return {
    ...(partition ? { partition } : {}), ...(preload ? { preload } : {}),
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, navigateOnDragDrop: false, safeDialogs: true,
  };
}

function lockPermissions(targetSession) {
  targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDevicePermissionHandler(() => false);
}

function showConnection() {
  if (connectionWindow && !connectionWindow.isDestroyed()) {
    if (connectionWindow.isMinimized()) connectionWindow.restore();
    connectionWindow.show();
    connectionWindow.focus();
    return connectionWindow;
  }
  connectionWindow = new BrowserWindow({
    ...restoredWindowBounds(windowStates.connection, { width: 780, height: 900, minWidth: 620, minHeight: 660 }, screen.getAllDisplays()),
    title: "Workspace connection — PM Agent v4", backgroundColor: "#fafaf9", autoHideMenuBar: false,
    webPreferences: securePreferences("desktop-connection", join(here, "preload.cjs")),
  });
  const window = connectionWindow;
  watchWindow("connection", window);
  lockPermissions(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== connectionUrl) event.preventDefault(); });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (workspaceWindow && !workspaceWindow.isDestroyed()) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => { if (connectionWindow === window) connectionWindow = null; });
  void window.loadURL(connectionUrl).catch(() => {
    dialog.showErrorBox("Desktop connection unavailable", "The bundled connection page could not be loaded. Reinstall the complete desktop package.");
  });
  return window;
}

async function externalLink(value) {
  if (externalPrompt || quitting) return;
  let url;
  try {
    url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
  } catch { return; }
  externalPrompt = true;
  try {
    const result = await dialog.showMessageBox({
      type: "question", title: "Open your browser?", message: `Open ${url.hostname} outside PM Agent v4?`,
      detail: "The system browser has a separate login session. No desktop local access token is passed to it.",
      buttons: ["Cancel", "Open in browser"], defaultId: 0, cancelId: 0,
    });
    if (result.response === 1) await shell.openExternal(url.href);
  } catch (cause) {
    publish({ error: `Could not open your browser: ${safeDesktopMessage(cause)}` });
    showConnection();
  } finally { externalPrompt = false; }
}

function constrainSession(targetSession, origin) {
  lockPermissions(targetSession);
  targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: !serviceRequestAllowed(details.url, origin) });
  });
  // Session partitions can be reused on reconnect: do not accumulate download listeners.
  targetSession.removeAllListeners("will-download");
  targetSession.on("will-download", (_event, item) => item.setSaveDialogOptions({ title: "Save workspace download" }));
}

async function createWorkspace(url, targetSession, mode) {
  const origin = new URL(url).origin;
  const window = new BrowserWindow({
    ...restoredWindowBounds(windowStates.workspace, { width: 1440, height: 980, minWidth: 900, minHeight: 640 }, screen.getAllDisplays()),
    title: "PM Agent v4", backgroundColor: "#fafaf9", show: false,
    webPreferences: { ...securePreferences(), session: targetSession },
  });
  workspaceWindow = window;
  workspaceSession = targetSession;
  workspaceMode = mode;
  workspaceUrl = url;
  watchWindow("workspace", window);
  window.webContents.setWindowOpenHandler(({ url: destination }) => { void externalLink(destination); return { action: "deny" }; });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, destination) => {
    if (!sameService(destination, origin)) { event.preventDefault(); void externalLink(destination); }
  });
  window.webContents.on("will-redirect", (event, destination) => { if (!sameService(destination, origin)) event.preventDefault(); });
  window.webContents.on("did-navigate", (_event, destination) => {
    // Keep navigation in memory only. Do not persist account forms, auth redirects or URL parameters.
    if (sameService(destination, origin)) {
      const parsed = new URL(destination);
      workspaceUrl = `${origin}${parsed.pathname}`;
    }
  });
  window.webContents.on("did-fail-load", (_event, code, _description, _destination, mainFrame) => {
    if (!mainFrame || code === -3 || workspaceWindow !== window || changingConnection || quitting) return;
    rememberWindow("workspace", window);
    workspaceWindow = null;
    window.destroy();
    publish({ error: `Workspace page could not be loaded (network error ${code}). Check the connection, then use Open workspace or reconnect.`, details: "" });
    showConnection();
  });
  window.webContents.on("render-process-gone", () => {
    if (workspaceWindow !== window || quitting) return;
    workspaceWindow = null;
    window.destroy();
    publish({ error: "The workspace renderer stopped. Use Open workspace to reopen it. Local background tasks have not been cancelled." });
    showConnection();
  });
  window.on("closed", () => {
    if (workspaceWindow !== window) return;
    workspaceWindow = null;
    if (!quitting) {
      publish({ message: mode === "local"
        ? "Workspace window closed. Local services and scheduled tasks are still running. Open it again, or Quit to stop them."
        : "Workspace window closed. Remote tasks belong to the remote Server; quitting this app does not stop it." });
      showConnection();
    }
  });
  try { await window.loadURL(url); }
  catch {
    if (workspaceWindow === window) workspaceWindow = null;
    if (!window.isDestroyed()) window.destroy();
    throw new Error("Cannot load the workspace. Check the server URL, certificate and network, then reconnect.");
  }
  if (quitting) return;
  if (workspaceWindow !== window || window.isDestroyed())
    throw new Error("The workspace window closed before it was ready. Reconnect to open it again.");
  window.show();
  if (connectionWindow && !connectionWindow.isDestroyed()) connectionWindow.hide();
}

async function closeWorkspace() {
  const previous = workspaceWindow;
  workspaceWindow = null;
  if (previous && !previous.isDestroyed()) { rememberWindow("workspace", previous); previous.destroy(); }
  const previousSession = workspaceSession;
  workspaceSession = null;
  workspaceMode = null;
  workspaceUrl = null;
  if (previousSession) {
    previousSession.webRequest.onBeforeRequest(null);
    await previousSession.closeAllConnections();
    await previousSession.flushStorageData();
    // Never clear IndexedDB/localStorage: pending/unknown command journals must survive disconnect.
  }
}

async function stopConnection() {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    let browserError;
    try { await closeWorkspace(); } catch (cause) { browserError = cause; }
    const server = localServer;
    await server?.stop();
    if (localServer === server) localServer = null;
    if (browserError) throw new Error("Local services stopped, but browser storage could not be flushed. Keep the app open and retry Disconnect or Quit.");
  })();
  try { await stopPromise; } finally { stopPromise = null; }
}

async function confirmLocalStop(message) {
  if (!localRunning() && !(changingConnection && localServer)) return true;
  const result = await dialog.showMessageBox({
    type: "warning", title: "Stop local services?", message,
    detail: "Active local executions will be interrupted. Schedules and folder watches do not run while disconnected or quit. Saved workspace data and pending-command journals are kept. Close only the workspace window to keep tasks running.",
    buttons: ["Keep running", "Stop local services"], defaultId: 0, cancelId: 0,
  });
  return result.response === 1;
}

async function checkServer(targetSession, origin, token) {
  const response = await targetSession.fetch(`${origin}/agent/api/access`, {
    method: token ? "POST" : "GET", credentials: "include",
    ...(token ? { headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token }) } : {}),
    redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Server access check returned HTTP ${response.status}. Use the direct workspace Server origin; redirects are not followed.`);
  const result = await response.json().catch(() => null);
  if (!result || typeof result.authorized !== "boolean" || (!token && typeof result.configured !== "boolean"))
    throw new Error("The address is not a compatible Server: /agent/api/access did not return the expected access status.");
  if (token && result.authorized !== true) throw new Error("The local Server rejected the private desktop session.");
  if (token && !(await checkServer(targetSession, origin)).authorized)
    throw new Error("The local Server did not establish its private HttpOnly session cookie.");
  return result;
}

async function saveConfiguration(next) {
  const safe = publicConfiguration(next, !app.isPackaged);
  await writeFile(settingsFile, `${JSON.stringify({ version: 2, ...safe }, null, 2)}\n`, { mode: 0o600 });
  configuration = safe;
}

function normalizeConfiguration(input) {
  if (!input || !["local", "remote"].includes(input.mode)) throw new Error("Select Local or Remote.");
  const next = publicConfiguration(configuration, !app.isPackaged);
  next.mode = input.mode;
  if (input.mode === "remote") next.remoteUrl = remoteAddress(input.remoteUrl);
  else {
    next.dataDir = absolutePath(input.dataDir, "Workspace data directory");
    next.projectRoot = input.projectRoot?.trim() ? absolutePath(input.projectRoot, "Project root") : join(next.dataDir, "projects");
    if (!app.isPackaged) {
      if (input.nodePath?.trim()) next.nodePath = absolutePath(input.nodePath, "Development Node executable");
      else delete next.nodePath;
    }
  }
  return next;
}

async function connect(input) {
  if (quitting || quitPrompt || changingConnection || maintenancePromise) throw new Error("Another desktop operation is in progress.");
  const next = normalizeConfiguration(input);
  const setup = next.mode === "local" ? initialSetup(input.setup) : undefined;
  transientSecrets = setup ? Object.values(setup) : [];
  changingConnection = true;
  try {
    if (!(await confirmLocalStop("Changing the connection stops current local services.")) || quitting) return snapshot();
    publish({ status: "connecting", message: next.mode === "local" ? "Preparing the managed local workspace…" : "Checking the remote Server…", error: "", details: "", address: "", runtime: "" });
    await stopConnection();
    await saveConfiguration(next);
    if (quitting) throw new Error("Connection cancelled while quitting.");
    if (next.mode === "local") {
      const server = new LocalServer({
        serverRoot, webRoot: join(serverRoot, "apps", "web", "dist"), runtimeRoot,
        onProgress: (message) => {
          if (localServer === server && !quitting) publish({ message: typeof message === "string" ? message : message?.message || "Preparing local services…" });
        },
        onExit: (message, details) => {
          if (localServer !== server || quitting) return;
          publish({ status: "error", message: "Local services stopped unexpectedly.", error: message, details: details || "" });
          void closeWorkspace().catch(() => {}).finally(() => publish({}));
          showConnection();
        },
      });
      localServer = server;
      const started = await server.start({ ...next, ...(setup ? { setup } : {}) });
      if (quitting || localServer !== server) throw new Error("Connection cancelled while stopping.");
      const privateSession = session.fromPartition(workspacePartition("local", started.origin, started.instanceId));
      constrainSession(privateSession, started.origin);
      workspaceSession = privateSession;
      workspaceMode = "local";
      // Rotate only the Agent cookie. PM account auth and operation recovery journals remain intact.
      await privateSession.cookies.remove(started.origin, "agent_v4_access");
      await checkServer(privateSession, started.origin, started.token);
      if (quitting) throw new Error("Connection cancelled while quitting.");
      await createWorkspace(`${started.origin}/pm`, privateSession, "local");
      if (quitting) return snapshot();
      publish({ status: "connected", setupSuggested: false, message: "Local workspace ready. Sign in with your PM account. The product switch opens Agent; closing this window keeps local tasks running.", address: started.origin, runtime: started.runtime });
    } else {
      const origin = new URL(next.remoteUrl).origin;
      const remoteSession = session.fromPartition(workspacePartition("remote", origin));
      constrainSession(remoteSession, origin);
      workspaceSession = remoteSession;
      workspaceMode = "remote";
      const access = await checkServer(remoteSession, origin);
      if (quitting) throw new Error("Connection cancelled while quitting.");
      await createWorkspace(next.remoteUrl, remoteSession, "remote");
      if (quitting) return snapshot();
      publish({ status: "connected", message: access.authorized
        ? "Remote workspace connected. Sign in with that Server’s PM account; executions run remotely."
        : "Remote Server reached. Sign in with that Server’s PM account. Agent may also require its access token; no local token is shared.", address: origin, runtime: "" });
    }
  } catch (cause) {
    const details = localServer?.diagnostic() || "";
    let stopError = "";
    try { await stopConnection(); } catch (failure) { stopError = `\nShutdown also needs attention: ${safeDesktopMessage(failure, transientSecrets)}`; }
    if (!quitting) {
      publish({ status: "error", message: "Workspace connection did not complete. Saved data has not been reset.", error: `${safeDesktopMessage(cause, transientSecrets)}${stopError}`, details });
      showConnection();
    }
  } finally {
    if (setup) setup.password = "";
    transientSecrets = [];
    changingConnection = false;
    publish({});
  }
  return snapshot();
}

async function reopenWorkspace() {
  if (changingConnection || maintenancePromise || quitting) return;
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    if (workspaceWindow.isMinimized()) workspaceWindow.restore();
    workspaceWindow.show();
    workspaceWindow.focus();
  } else if (state.status === "connected" && workspaceSession && state.address) {
    try { await createWorkspace(workspaceUrl || `${state.address}/pm`, workspaceSession, workspaceMode); }
    catch (cause) { publish({ error: safeDesktopMessage(cause) }); showConnection(); }
  } else showConnection();
  if (workspaceWindow && !workspaceWindow.isDestroyed()) publish({
    error: "",
    message: workspaceMode === "local"
      ? "Workspace window open. Local services and scheduled tasks are running."
      : "Workspace window open. Remote tasks remain managed by the remote Server.",
  });
}

function finishQuit() {
  if (quitPromise) return quitPromise;
  quitting = true;
  publish({ status: maintenancePromise ? "maintenance" : "stopping", message: maintenancePromise ? "Waiting for the current backup or restore to finish safely…" : "Stopping local services and PostgreSQL…" });
  quitPromise = (async () => {
    try {
      if (maintenancePromise) await maintenancePromise;
      await stopConnection();
      if (localRunning()) throw new Error("Owned local processes are still running. Retry Quit; do not manually remove workspace data.");
      if (connectionWindow && !connectionWindow.isDestroyed()) rememberWindow("connection", connectionWindow);
      await windowStateWrite;
      allowQuit = true;
      app.quit();
    } catch (cause) {
      quitting = false;
      publish({ status: "error", message: "The app is still open because shutdown did not complete.", error: safeDesktopMessage(cause) });
      showConnection();
    } finally { if (!allowQuit) quitPromise = null; }
  })();
  return quitPromise;
}

async function requestQuit() {
  if (quitting || quitPrompt) return;
  if (maintenancePromise) {
    publish({ error: "Wait for backup or restore to finish before quitting. Closing the app early could leave an incomplete backup." });
    showConnection();
    return;
  }
  quitPrompt = true;
  publish({});
  try {
    if (!(await confirmLocalStop("Quit PM Agent v4 and stop local background tasks?"))) return;
    await finishQuit();
  } catch (cause) {
    publish({ error: `Could not confirm shutdown: ${safeDesktopMessage(cause)}` });
    showConnection();
  } finally {
    quitPrompt = false;
    publish({});
  }
}

function trustedConnection(event) {
  return Boolean(connectionWindow && !connectionWindow.isDestroyed() &&
    trustedConnectionFrame(event, connectionWindow.webContents, connectionUrl));
}

async function maintenance(action) {
  if (changingConnection || maintenancePromise || quitting || quitPrompt || localRunning() || workspaceSession || workspaceWindow)
    throw new Error("Disconnect and stop all local services before backup or restore.");
  changingConnection = true; // Reserve the desktop while native dialogs are open too.
  const operation = (async () => {
    try {
      const restoring = action === "restore";
      const confirmation = await dialog.showMessageBox(connectionWindow, {
        type: "warning", title: restoring ? "Restore to a new workspace?" : "Back up private workspace data?",
        message: restoring ? "Restore only into a NEW, EMPTY workspace data directory." : "This backup includes private data, saved credentials and conversations.",
        detail: restoring
          ? "Existing workspaces are never overwritten. Select the backup folder, then a new or empty destination. The restored workspace stays disconnected until you explicitly connect."
          : `The backup includes PM, registered project storage, managed Agent state, credentials and conversations. Global/external CLI credential homes are excluded. Keep it somewhere private; it is not encrypted. Saved workspace: ${configuration.dataDir}`,
        buttons: ["Cancel", restoring ? "Choose backup and empty destination" : "Choose backup destination"], defaultId: 0, cancelId: 0,
      });
      if (confirmation.response !== 1 || quitting) return;
      let options;
      if (restoring) {
        const source = await dialog.showOpenDialog(connectionWindow, { title: "Choose the complete desktop backup folder", properties: ["openDirectory"] });
        if (source.canceled || quitting) return;
        const target = await dialog.showOpenDialog(connectionWindow, { title: "Choose a NEW or EMPTY workspace data folder — never an existing workspace", properties: ["openDirectory", "createDirectory"] });
        if (target.canceled || quitting) return;
        options = { source: source.filePaths[0], dataDir: target.filePaths[0] };
      } else {
        const target = await dialog.showOpenDialog(connectionWindow, { title: "Choose a private backup destination outside the workspace data folder", properties: ["openDirectory", "createDirectory"] });
        if (target.canceled || quitting) return;
        options = { dataDir: configuration.dataDir, destination: join(target.filePaths[0], `PM-Agent-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`) };
      }
      publish({ status: "maintenance", message: restoring ? "Restoring into a new isolated workspace…" : "Creating the full workspace backup…", error: "", details: "" });
      const onProgress = message => publish({ message: typeof message === "string" ? message : message?.message || "Maintaining workspace data…" });
      const result = await (restoring ? restoreDesktop : backupDesktop)({ serverRoot, runtimeRoot, ...options, onProgress });
      if (restoring) await saveConfiguration({ ...configuration, mode: "local", dataDir: result.dataDir, projectRoot: result.projectRoot });
      publish({ status: "idle", setupSuggested: false, message: restoring ? "Restore complete. Connect Local to sign in to the restored workspace; no existing workspace was overwritten." : "Backup complete. Keep the private backup folder safe.", details: restoring ? result.dataDir : result.directory, error: "", address: "", runtime: "" });
    } catch (cause) {
      publish({ status: "error", message: "Maintenance did not complete. Existing workspace data has not been replaced.", error: safeDesktopMessage(cause) });
    }
  })();
  maintenancePromise = operation;
  publish({});
  try { await operation; }
  finally {
    maintenancePromise = null;
    changingConnection = false;
    publish({});
  }
  return snapshot();
}

async function directory(field) {
  if (!["dataDir", "projectRoot"].includes(field)) throw new Error("Invalid directory selection.");
  if (changingConnection || maintenancePromise || quitting) throw new Error("Wait for the current desktop operation.");
  const result = await dialog.showOpenDialog(connectionWindow, {
    title: field === "dataDir" ? "Choose a new empty managed workspace folder, or an existing desktop-managed workspace" : "Choose an explicit local project root",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function reveal(field) {
  if (!["dataDir", "projectRoot"].includes(field)) throw new Error("Invalid workspace folder.");
  // No renderer-provided path is ever sent to the shell. Reveal only saved, host-validated directories.
  const value = absolutePath(configuration[field], "Saved workspace folder");
  shell.showItemInFolder(value);
  return snapshot();
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Workspace", submenu: [
      { label: "Open Workspace", accelerator: "CmdOrCtrl+Shift+O", click: () => void reopenWorkspace() },
      { label: "Connection Settings…", accelerator: "CmdOrCtrl+,", click: showConnection },
      { type: "separator" },
      { label: "Quit PM Agent v4…", accelerator: "CmdOrCtrl+Q", click: () => void requestQuit() },
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
  ]));
}

async function desktopAction(event, input) {
  if (!trustedConnection(event)) throw new Error("Desktop controls are available only in the trusted top-level connection window.");
  if (!input || typeof input !== "object") throw new Error("Invalid desktop action.");
  switch (input.action) {
    case "state": return snapshot();
    case "connect": return connect(input.configuration);
    case "open": await reopenWorkspace(); return snapshot();
    case "disconnect":
      if (changingConnection || maintenancePromise || quitting) throw new Error("Wait for the current desktop operation, or Quit to stop startup.");
      changingConnection = true;
      try {
        if (await confirmLocalStop("Disconnect and stop local services?")) {
          publish({ status: "stopping", message: "Stopping local services and PostgreSQL…", error: "" });
          await stopConnection();
          publish({ status: "idle", message: "Disconnected. Saved data and pending-command journals are kept; local schedules are stopped.", address: "", runtime: "", error: "", details: "" });
        }
      } catch (cause) { publish({ status: "error", error: safeDesktopMessage(cause), message: "Shutdown did not complete. Retry Disconnect or Quit." }); }
      finally { changingConnection = false; publish({}); }
      return snapshot();
    case "directory": return directory(input.field);
    case "reveal": return reveal(input.field);
    case "node": {
      if (app.isPackaged || changingConnection || maintenancePromise || quitting) throw new Error("Packaged workspaces use only the bundled Node runtime.");
      const result = await dialog.showOpenDialog(connectionWindow, { title: "Choose an explicit development Node 24 executable", properties: ["openFile"] });
      return result.canceled ? null : result.filePaths[0];
    }
    case "backup": case "restore": return maintenance(input.action);
    case "quit": await requestQuit(); return snapshot();
    default: throw new Error("Unknown desktop action.");
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    if (!configuration || !app.isReady()) return;
    showConnection();
    try {
      const next = readLaunchArguments(argv);
      if (next.mode) void connect({ ...configuration, ...next }).catch(cause => publish({ error: safeDesktopMessage(cause) }));
    } catch (cause) { publish({ error: safeDesktopMessage(cause) }); }
  });
  app.on("activate", () => { if (app.isReady() && configuration) void reopenWorkspace(); });
  app.on("window-all-closed", () => { if (!quitting && app.isReady() && configuration) showConnection(); });
  app.on("before-quit", event => { if (!allowQuit) { event.preventDefault(); void finishQuit(); } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void finishQuit());
  void app.whenReady().then(async () => {
    settingsFile = join(app.getPath("userData"), "connection.json");
    windowStateFile = join(app.getPath("userData"), "window-state.json");
    await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
    let saved = {};
    let configError = "";
    try {
      saved = JSON.parse(await readFile(settingsFile, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid saved connection settings.");
      if (saved.version !== 2) {
        saved = { mode: saved.mode, remoteUrl: saved.remoteUrl };
        configError = "Older connection settings were not adopted as a managed workspace. Choose a new empty data folder, or explicitly select an existing desktop-managed workspace. Existing repository Agent data has not been moved or changed.";
      }
    } catch (cause) {
      saved = {};
      if (cause.code !== "ENOENT") configError = "Saved connection settings could not be read. Choose the managed workspace folder explicitly; no data has been reset.";
    }
    try { windowStates = JSON.parse(await readFile(windowStateFile, "utf8")); if (!windowStates || typeof windowStates !== "object" || Array.isArray(windowStates)) windowStates = {}; }
    catch { windowStates = {}; }
    const dataDir = typeof saved.dataDir === "string" && saved.dataDir ? saved.dataDir : join(app.getPath("userData"), "workspace");
    let savedRemote = "";
    try { if (saved.remoteUrl) savedRemote = remoteAddress(saved.remoteUrl); } catch { configError = "The saved remote URL is invalid. Enter a credential-free workspace origin."; }
    configuration = publicConfiguration({
      mode: saved.mode === "remote" ? "remote" : "local", remoteUrl: savedRemote,
      dataDir, projectRoot: typeof saved.projectRoot === "string" && saved.projectRoot ? saved.projectRoot : join(dataDir, "projects"),
      ...(!app.isPackaged && typeof saved.nodePath === "string" && saved.nodePath !== "node" ? { nodePath: saved.nodePath } : {}),
    }, !app.isPackaged);
    state.setupSuggested = saved.version !== 2;
    let launch = {};
    try {
      launch = readLaunchArguments(process.argv.slice(1));
      if (app.isPackaged && launch.nodePath) throw new Error("Packaged local mode uses the bundled Node runtime; --node is development-only.");
      configuration = { ...configuration, ...launch };
      if (launch.dataDir && !launch.projectRoot) configuration.projectRoot = join(launch.dataDir, "projects");
    } catch (cause) { configError = safeDesktopMessage(cause); }
    installMenu();
    ipcMain.handle("desktop:action", desktopAction);
    showConnection();
    if (configError) publish({ status: "error", error: configError });
    else if (launch.mode) await connect(configuration);
  }).catch(cause => {
    dialog.showErrorBox("Desktop startup failed", safeDesktopMessage(cause));
    void finishQuit();
  });
}

import * as electron from "electron";
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LocalServer } from "./local-server.mjs";
import { readSetupStatus } from "./first-run.mjs";
import { PreviewManager } from "./preview/manager.mjs";
import { isAllowedPreviewUrl } from "./preview/preview-policy.mjs";
import { backupDesktop, restoreDesktop } from "./maintenance.mjs";
import { captureWindowState, restoredWindowBounds } from "./window-state.mjs";
import { protectWorkspaceClose } from "./window-close.mjs";
import { readInstallStamp } from "./install-stamp.mjs";
import { loadLifecycleRequest, readLifecycleArguments, runLifecycleRequest } from "./lifecycle-cli.mjs";
import { ensurePrivateDirectory, securePrivateFile, writePrivateJson } from "./private-state.mjs";
import {
  macosWindowButtonPosition, normalizeTitleBarTheme, titleBarOverlay, windowTitleBarOptions,
} from "./window-chrome.mjs";
import {
  absolutePath, publicConfiguration, readLaunchArguments, remoteAddress,
  safeDesktopMessage, sameService, serviceRequestAllowed, trustedConnectionFrame, trustedWorkspaceFrame, workspacePartition,
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
const installRoot = app.isPackaged ? (process.platform === "darwin" ? resolve(process.resourcesPath, "../..") : dirname(app.getPath("exe"))) : null;
let installStamp;
let lifecycleContext;
let lifecycleError;
try {
  if (app.isPackaged) installStamp = await readInstallStamp(process.resourcesPath, { version: app.getVersion() });
  const arguments_ = readLifecycleArguments(process.argv.slice(1));
  if (arguments_) {
    lifecycleContext = await loadLifecycleRequest(arguments_, { packaged: app.isPackaged, installRoot, stamp: installStamp });
    // Single-instance routing must be bound to this private userData first.
    app.setPath("userData", lifecycleContext.controllerUserDataDir);
  }
} catch (cause) { lifecycleError = cause; }
let connectionWindow;
let workspaceWindow;
let workspaceClose;
let localServer;
let lifecycleConnection;
let lifecyclePromise;
let lifecycleStateFrozen = false;
let workspaceSession;
let workspaceMode;
let workspaceUrl;
let previewManager;
let allowQuit = false;
let quitting = false;
let quitPrompt = false;
let quitPromise;
let stopPromise;
let maintenancePromise;
let changingConnection = false;
let firstRunTimer = null;
let externalPrompt = false;
let configuration;
let workspaceDirectoryPending = false;
let settingsFile;
let windowStateFile;
let windowStates = {};
let windowStateWrite = Promise.resolve();
let transientSecrets = [];
const state = {
  status: "idle", message: "Choose where your workspace runs.", error: "", details: "", address: "", runtime: "",
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
    installIdentity: installStamp ? { version: installStamp.version, distribution: installStamp.distribution, ownership: installStamp.ownership.installation, updateMechanism: installStamp.updateMechanism } : null,
    workspaceOpen: Boolean(workspaceWindow && !workspaceWindow.isDestroyed()),
    firstRunPending: Boolean(localServer?.setupPending),
    maintenanceAllowed: !changingConnection && !maintenancePromise && !lifecyclePromise && !quitting && !quitPrompt && !localRunning() && !workspaceSession,
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
  if (lifecycleStateFrozen) return;
  const saved = captureWindowState(window);
  if (!saved || !windowStateFile) return;
  windowStates[kind] = saved;
  const value = { ...windowStates };
  windowStateWrite = windowStateWrite.catch(() => {}).then(() => writePrivateJson(windowStateFile, value)).catch(() => {});
}

function watchWindow(kind, window) {
  let timer;
  const remember = () => {
    clearTimeout(timer);
    timer = setTimeout(() => rememberWindow(kind, window), 300);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) window.on(event, remember);
  window.on("close", () => { clearTimeout(timer); if (!allowQuit) rememberWindow(kind, window); });
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

function applyTitleBarTheme(window, theme) {
  if (!window || window.isDestroyed() || process.platform === "darwin") return;
  const resolved = normalizeTitleBarTheme(theme);
  if (resolved) window.setTitleBarOverlay(titleBarOverlay(resolved));
}

function syncMacosWindowButtons(window) {
  if (process.platform !== "darwin" || !window || window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition(macosWindowButtonPosition(window.webContents.getZoomFactor()));
}

function watchTitleBar(window) {
  // Keep the application menu for accelerators, but never reserve a native
  // menu row inside the frameless window. Alt still follows Electron behavior.
  if (process.platform !== "darwin") window.setMenuBarVisibility(false);
  if (process.platform !== "darwin") return;
  syncMacosWindowButtons(window);
  window.webContents.on("did-finish-load", () => syncMacosWindowButtons(window));
  window.webContents.on("zoom-changed", () => syncMacosWindowButtons(window));
  window.on("leave-full-screen", () => syncMacosWindowButtons(window));
}

async function setTitleBarTheme(event, value) {
  const theme = normalizeTitleBarTheme(value);
  if (!theme) throw new Error("Invalid title bar theme.");
  const workspace = workspaceWindow;
  if (workspace && !workspace.isDestroyed() && trustedWorkspaceFrame(event, workspace.webContents, workspaceUrl)) {
    applyTitleBarTheme(workspace, theme);
    return;
  }
  const connection = connectionWindow;
  if (connection && !connection.isDestroyed() && trustedConnectionFrame(event, connection.webContents, connectionUrl)) {
    applyTitleBarTheme(connection, theme);
    return;
  }
  throw new Error("Title bar controls are available only in a trusted desktop window.");
}

function showConnection() {
  if (connectionWindow && !connectionWindow.isDestroyed()) {
    if (connectionWindow.isMinimized()) connectionWindow.restore();
    connectionWindow.show();
    connectionWindow.focus();
    return connectionWindow;
  }
  connectionWindow = new BrowserWindow({
    ...restoredWindowBounds(windowStates.connection, { width: 1080, height: 800, minWidth: 620, minHeight: 660 }, screen.getAllDisplays()),
    title: "工作区连接 — Dovspace", backgroundColor: "#fafaf9", autoHideMenuBar: true,
    ...windowTitleBarOptions(process.platform, nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    webPreferences: securePreferences("desktop-connection", join(here, "preload.cjs")),
  });
  const window = connectionWindow;
  watchTitleBar(window);
  watchWindow("connection", window);
  lockPermissions(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== connectionUrl) event.preventDefault(); });
  window.webContents.on("will-frame-navigate", (event) => { if (!event.isMainFrame || event.url !== connectionUrl) event.preventDefault(); });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (workspaceWindow && !workspaceWindow.isDestroyed()) {
      window.hide();
      if (workspaceWindow.isMinimized()) workspaceWindow.restore();
      workspaceWindow.show();
      workspaceWindow.focus();
    } else void requestQuit();
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
    title: "PM Agent v4", backgroundColor: "#fafaf9", show: false, autoHideMenuBar: true,
    ...windowTitleBarOptions(process.platform, nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    webPreferences: {
      ...securePreferences(undefined, join(here, "preload.workspace.cjs")),
      session: targetSession,
      webviewTag: mode === "local",
      additionalArguments: mode === "local" ? ["--pm-native-preview"] : [],
    },
  });
  watchTitleBar(window);
  workspaceWindow = window;
  workspaceClose = protectWorkspaceClose(window, {
    dialog,
    onError: (cause) => {
      publish({ error: `Could not confirm leaving the workspace: ${safeDesktopMessage(cause)}` });
      showConnection();
    },
  });
  workspaceSession = targetSession;
  workspaceMode = mode;
  workspaceUrl = url;
  previewManager?.dispose();
  if (mode === "local") previewManager?.setWorkspaceOrigin(origin);
  watchWindow("workspace", window);
  window.webContents.setWindowOpenHandler(({ url: destination }) => { void externalLink(destination); return { action: "deny" }; });
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (mode !== "local" || !previewManager?.validateAttach(params)) { event.preventDefault(); return; }
    // The guest preload is the picker overlay. Force every security-relevant
    // preference here; a renderer must not be able to weaken the guest.
    webPreferences.preload = previewManager.guestPreloadPath;
    webPreferences.sandbox = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = false;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.webviewTag = false;
    webPreferences.additionalArguments = [];
    webPreferences.navigateOnDragDrop = false;
    webPreferences.safeDialogs = true;
    webPreferences.disableHtmlFullscreenWindowResize = true;
  });
  window.webContents.on("will-navigate", (event, destination) => {
    if (!sameService(destination, origin)) { event.preventDefault(); void externalLink(destination); }
  });
  window.webContents.on("will-redirect", (event, destination) => { if (!sameService(destination, origin)) event.preventDefault(); });
  window.webContents.on("will-frame-navigate", (event) => { if (!sameService(event.url, origin)) event.preventDefault(); });
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
    previewManager?.dispose();
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
  if (previous && !previous.isDestroyed()) await workspaceClose();
  previewManager?.dispose();
  const previousSession = workspaceSession;
  if (previousSession) {
    try {
      await previousSession.closeAllConnections();
      await previousSession.flushStorageData();
    } catch (cause) {
      throw new Error(`Browser storage could not be flushed: ${safeDesktopMessage(cause)} Keep the app open and retry Disconnect or Quit.`, { cause });
    }
    previousSession.webRequest.onBeforeRequest(null);
    // Never clear IndexedDB/localStorage: pending/unknown command journals must survive disconnect.
  }
  workspaceSession = null;
  workspaceMode = null;
  workspaceUrl = null;
}

async function stopConnection() {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    // A cancelled draft guard or failed storage flush must leave services running.
    stopFirstRunWatch();
    await closeWorkspace();
    const server = localServer;
    if (server?.setupPending) {
      try { await server.finalizeSetup(); }
      catch { /* Setup may still be incomplete; backup remains refused until ready. */ }
    }
    await server?.stop();
    if (localServer === server) { localServer = null; lifecycleConnection = null; }
  })();
  try { await stopPromise; } finally { stopPromise = null; }
}

async function confirmLocalStop(message) {
  if (!localRunning() && !(changingConnection && localServer)) return true;
  const focused = BrowserWindow.getFocusedWindow();
  const parent = [connectionWindow, workspaceWindow].find(window => window && !window.isDestroyed() && window === focused)
    || [connectionWindow, workspaceWindow].find(window => window && !window.isDestroyed());
  const result = await dialog.showMessageBox(...(parent ? [parent] : []), {
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
  await writePrivateJson(settingsFile, { version: 2, ...safe });
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

function stopFirstRunWatch() {
  clearInterval(firstRunTimer);
  firstRunTimer = null;
}

function watchFirstRun(server, origin) {
  stopFirstRunWatch();
  let polling = false;
  firstRunTimer = setInterval(async () => {
    if (polling || localServer !== server || !server.setupPending || quitting) return;
    polling = true;
    try {
      const status = await readSetupStatus(origin);
      if (status.initialized) {
        const result = await server.finalizeSetup();
        if (result?.phase === "ready") {
          stopFirstRunWatch();
          publish({ message: "First-run setup is complete. The local workspace is ready." });
        }
      }
    } catch {
      // Keep retrying while this workspace is connected; a restart also finalizes
      // a completed setup before services start. Never resubmit account data.
    } finally { polling = false; }
  }, 1_500);
  firstRunTimer.unref?.();
}

async function connect(input) {
  if (quitting || quitPrompt || changingConnection || maintenancePromise || lifecyclePromise) throw new Error("Another desktop operation is in progress.");
  const next = normalizeConfiguration(input);
  changingConnection = true;
  let previousStopped = false;
  try {
    if (!(await confirmLocalStop("Changing the connection stops current local services.")) || quitting) return snapshot();
    publish({ status: "connecting", message: next.mode === "local" ? "Preparing the managed local workspace…" : "Checking the remote Server…", error: "", details: "", address: "", runtime: "" });
    await stopConnection();
    previousStopped = true;
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
          void closeWorkspace().catch(cause => publish({ error: `${message}\nWorkspace cleanup did not complete: ${safeDesktopMessage(cause)}` })).finally(() => publish({}));
          showConnection();
        },
      });
      localServer = server;
      const started = await server.start({ ...next });
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
      const firstRun = started.phase === "pending";
      if (firstRun) watchFirstRun(server, started.origin);
      publish({ status: "connected", message: firstRun
        ? "Local workspace ready. Complete first-run account and workspace setup in the workspace page; the desktop supplies its one-time token."
        : "Local workspace ready. Sign in with your PM account. The product switch opens Agent; closing this window keeps local tasks running.", address: started.origin, runtime: started.runtime });
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
    stopFirstRunWatch();
    const details = localServer?.diagnostic() || "";
    let stopError = "";
    // Do not repeat a rejected close of the previous workspace during rollback.
    if (previousStopped) {
      try { await stopConnection(); } catch (failure) { stopError = `\nShutdown also needs attention: ${safeDesktopMessage(failure, transientSecrets)}`; }
    }
    if (!quitting) {
      publish({ status: "error", message: "Workspace connection did not complete. Saved data has not been reset.", error: `${safeDesktopMessage(cause, transientSecrets)}${stopError}`, details });
      showConnection();
    }
  } finally {
    transientSecrets = [];
    changingConnection = false;
    publish({});
  }
  return snapshot();
}

async function reopenWorkspace() {
  if (changingConnection || maintenancePromise || lifecyclePromise || quitting) return;
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
      if (lifecyclePromise) await lifecyclePromise;
      await stopConnection();
      previewManager?.destroy();
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
  if (maintenancePromise || lifecyclePromise) {
    publish({ error: "Wait for backup, restore or the installed lifecycle operation to finish safely before quitting." });
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

function trustedWorkspace(event) {
  return Boolean(workspaceWindow && !workspaceWindow.isDestroyed() &&
    trustedWorkspaceFrame(event, workspaceWindow.webContents, workspaceUrl));
}

async function firstRunToken(event) {
  if (workspaceMode !== "local" || !trustedWorkspace(event))
    throw new Error("First-run setup is available only in the trusted local workspace.");
  const pathname = new URL(event.senderFrame.url).pathname;
  if (pathname !== "/pm" && pathname !== "/pm/")
    throw new Error("First-run setup is available only on the workspace setup page.");
  if (!localServer?.setupPending || !localServer.setupToken)
    throw new Error("First-run setup is not pending.");
  return localServer.setupToken;
}

async function chooseWorkspaceDirectory(event) {
  if (workspaceMode !== "local" || !trustedWorkspace(event)) throw new Error("Folder selection is available only in the trusted local workspace.");
  if (workspaceDirectoryPending || changingConnection || maintenancePromise || lifecyclePromise || quitting) throw new Error("Wait for the current desktop operation.");
  const window = workspaceWindow;
  workspaceDirectoryPending = true;
  try {
    const result = await dialog.showOpenDialog(window, {
      title: "Choose an existing Agent workspace folder",
      defaultPath: configuration.projectRoot,
      properties: ["openDirectory"],
      dontAddToRecent: true,
    });
    if (workspaceWindow !== window || workspaceMode !== "local" || !trustedWorkspace(event) || changingConnection || lifecyclePromise || quitting) throw new Error("The local workspace changed while choosing a folder.");
    // The Agent must still canonicalize and validate the chosen path against its allowed roots.
    return result.canceled || !result.filePaths[0] ? null : absolutePath(result.filePaths[0], "Agent workspace folder");
  } finally {
    workspaceDirectoryPending = false;
  }
}

async function previewAction(event, input) {
  if (!trustedWorkspace(event)) throw new Error("Preview controls are available only in the trusted workspace window.");
  if (workspaceMode !== "local") throw new Error("Native preview is available only for the local workspace.");
  if (lifecyclePromise) throw new Error("Wait for the installed lifecycle operation before opening previews.");
  if (!previewManager) throw new Error("Preview is unavailable.");
  if (!input || typeof input !== "object" || typeof input.action !== "string") throw new Error("Invalid preview action.");
  switch (input.action) {
    case "state": return previewManager.getState(input.tabId);
    case "create-tab": return previewManager.createTab(input.tabId, input.options);
    case "close-tab": previewManager.closeTab(input.tabId); return { closed: true };
    case "register-webview": return previewManager.registerWebview(input.tabId, input.webContentsId);
    case "navigate": return previewManager.navigate(input.tabId, input.url);
    case "back": return previewManager.back(input.tabId);
    case "forward": return previewManager.forward(input.tabId);
    case "reload": return previewManager.reload(input.tabId);
    case "stop": return previewManager.stop(input.tabId);
    case "capture": return previewManager.capture(input.tabId);
    case "pick": return previewManager.pick(input.tabId);
    case "cancel-pick": return previewManager.cancelPick(input.tabId);
    case "pip-open": return previewManager.openPiP(input.tabId);
    case "pip-close": if (previewManager.isPiPOpen(input.tabId)) previewManager.closePiP(); return { open: false };
    case "devtools": await previewManager.openDevTools(input.tabId); return { open: true };
    case "open-external": {
      if (!isAllowedPreviewUrl(input.url)) throw new Error("Only http(s) preview links can be opened externally.");
      await externalLink(input.url);
      return { opened: true };
    }
    default: throw new Error("Unknown preview action.");
  }
}

async function maintenance(action, input) {
  let password = input?.password;
  let trustedSourceAcknowledged = input?.trustedSourceAcknowledged === true;
  if (input) { input.password = ""; input.trustedSourceAcknowledged = false; }
  if (changingConnection || maintenancePromise || quitting || quitPrompt || localRunning() || workspaceSession || workspaceWindow)
    throw new Error("Disconnect and stop all local services before backup or restore.");
  const restoring = action === "restore";
  if (typeof password !== "string" || password.length < (restoring ? (input.allowLegacyUnencrypted === true ? 0 : 1) : 12) || password.length > 1024 || Buffer.byteLength(password, "utf8") > 4096) throw new Error(restoring ? "Enter the backup password (at most 1024 characters)." : "Use a backup password between 12 and 1024 characters.");
  if (input.allowLegacyUnencrypted !== undefined && typeof input.allowLegacyUnencrypted !== "boolean") throw new Error("Invalid legacy restore confirmation.");
  if (restoring && !trustedSourceAcknowledged) throw new Error("Confirm the backup's trusted source for this restore operation; a valid password does not establish trusted authorship.");
  transientSecrets = [password];
  changingConnection = true; // Reserve the desktop while native dialogs are open too.
  const operation = (async () => {
    try {
      const allowLegacyUnencrypted = restoring && input.allowLegacyUnencrypted === true;
      const confirmation = await dialog.showMessageBox(connectionWindow, {
        type: "warning", title: restoring ? "Restore trusted database SQL to a new workspace?" : "Create an encrypted private backup?",
        message: restoring ? "Restore executes the supplied PostgreSQL SQL with the local application/server account's privileges. Only restore a backup from a source you trust." : "This encrypted backup includes private data, saved credentials and conversations.",
        detail: restoring
          ? `Encryption establishes key possession and detects alteration, not trusted authorship. Supplied SQL can have effects beyond the new destination. This confirmation applies only to this operation. Restore is limited to a NEW, EMPTY directory on the same operating system; existing workspaces are never overwritten.${allowLegacyUnencrypted ? " You also explicitly allowed an old UNENCRYPTED backup; keep its source private." : " Old unencrypted backups are rejected unless explicitly allowed."}`
          : `Password-derived encryption protects private PM, registered project storage, managed Agent state, credentials and conversations, and detects alteration. It does not identify the archive's author. Global/external CLI credential homes are excluded. Keep the password separately; it cannot be recovered. Saved workspace: ${configuration.dataDir}`,
        buttons: ["Cancel", restoring ? "I trust this source — choose backup and empty destination" : "Choose backup destination"], defaultId: 0, cancelId: 0,
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
      const result = await (restoring ? restoreDesktop : backupDesktop)({ serverRoot, runtimeRoot, ...options, password, ...(restoring ? { allowLegacyUnencrypted, trustedSourceAcknowledged: true } : {}), onProgress });
      if (restoring) await saveConfiguration({ ...configuration, mode: "local", dataDir: result.dataDir, projectRoot: result.projectRoot });
      publish({ status: "idle", message: restoring ? "Restore complete. Connect Local to sign in to the restored workspace; no existing workspace was overwritten." : "Encrypted backup complete. Keep the backup and its password safe and separate.", details: restoring ? result.dataDir : result.directory, error: "", address: "", runtime: "" });
    } catch (cause) {
      publish({ status: "error", message: "Maintenance did not complete. Existing workspace data has not been replaced.", error: safeDesktopMessage(cause, transientSecrets) });
    }
  })();
  maintenancePromise = operation;
  publish({});
  try { await operation; }
  finally {
    password = "";
    trustedSourceAcknowledged = false;
    if (input) input.password = "";
    transientSecrets = [];
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
    { label: "工作区", submenu: [
      { label: "打开工作区", accelerator: "CmdOrCtrl+Shift+O", click: () => void reopenWorkspace() },
      { label: "连接设置…", accelerator: "CmdOrCtrl+,", click: showConnection },
      { type: "separator" },
      { label: "退出 Dovspace…", accelerator: "CmdOrCtrl+Q", click: () => void requestQuit() },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
  ]));
}

async function desktopAction(event, input) {
  if (!trustedConnection(event)) throw new Error("Desktop controls are available only in the trusted top-level connection window.");
  if (!input || typeof input !== "object") throw new Error("Invalid desktop action.");
  if (lifecyclePromise && input.action !== "state") throw new Error("Wait for the installed lifecycle operation to finish safely.");
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
    case "backup": case "restore": return maintenance(input.action, input);
    case "quit": await requestQuit(); return snapshot();
    default: throw new Error("Unknown desktop action.");
  }
}

async function dispatchLifecycle(context) {
  const rejection = lifecyclePromise ? "Another packaged lifecycle operation is in progress."
    : maintenancePromise ? "Wait for the encrypted backup or restore to finish before maintenance."
    : quitting || quitPrompt ? "Wait for the current quit confirmation or shutdown to finish."
    : changingConnection && !localServer?.startPromise ? "Wait for the current connection change or native dialog to finish."
    : context.controllerUserDataDir !== app.getPath("userData") ? "Lifecycle requests cannot cross application user-data instances." : "";
  if (rejection) {
    if (context.request.setup) context.request.setup.password = "";
    await writePrivateJson(context.responseFile, { formatVersion: 1, requestId: context.request.requestId, operation: context.operation, ok: false, installStamp: context.stamp, error: rejection }, { exclusive: true });
    return { success: false, keepAlive: true };
  }
  const previouslyQuitting = quitting;
  if (["stop", "preinstall", "uninstall"].includes(context.operation)) quitting = true;
  const pending = runLifecycleRequest(context, {
    serverRoot, runtimeRoot,
    getServer: () => localServer,
    setServer: server => { localServer = server; },
    getConnection: () => lifecycleConnection,
    setConnection: connection => { lifecycleConnection = connection; },
    stop: async () => {
      await stopConnection();
      const deadline = Date.now() + 5000;
      while (changingConnection && Date.now() < deadline) await delay(10);
      if (changingConnection) throw new Error("The current connection change has not settled; installation cleanup is refused.");
      if (connectionWindow && !connectionWindow.isDestroyed()) rememberWindow("connection", connectionWindow);
      await windowStateWrite;
      lifecycleStateFrozen = true;
    },
    quit: async () => {
      previewManager?.destroy();
      allowQuit = true;
      quitting = true;
      app.quit();
    },
    onUnexpectedExit: () => { if (!quitting) publish({ status: "error", error: "An installed lifecycle service exited unexpectedly." }); },
  });
  lifecyclePromise = pending;
  try { return await pending; }
  finally {
    lifecyclePromise = null;
    if (!allowQuit) {
      lifecycleStateFrozen = false;
      if (!quitPromise) quitting = previouslyQuitting;
    }
  }
}

if (lifecycleError) {
  dialog.showErrorBox("Desktop installation identity rejected", safeDesktopMessage(lifecycleError));
  app.quit();
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    void (async () => {
      const arguments_ = readLifecycleArguments(argv);
      if (arguments_) {
        const context = await loadLifecycleRequest(arguments_, { packaged: app.isPackaged, installRoot, stamp: installStamp });
        await app.whenReady();
        await dispatchLifecycle(context);
        return;
      }
      if (!configuration || !app.isReady() || lifecycleContext) return;
      showConnection();
      const next = readLaunchArguments(argv);
      if (next.mode) await connect({ ...configuration, ...next });
    })().catch(cause => { if (!lifecycleContext) publish({ error: safeDesktopMessage(cause) }); });
  });
  app.on("activate", () => { if (!lifecycleContext && app.isReady() && configuration) void reopenWorkspace(); });
  app.on("window-all-closed", () => { if (!lifecycleContext && !quitting && app.isReady() && configuration) showConnection(); });
  app.on("before-quit", event => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void finishQuit());
  void app.whenReady().then(async () => {
    settingsFile = join(app.getPath("userData"), "connection.json");
    windowStateFile = join(app.getPath("userData"), "window-state.json");
    await ensurePrivateDirectory(app.getPath("userData"));
    if (lifecycleContext) {
      configuration = { mode: "local", dataDir: lifecycleContext.request.dataDir, projectRoot: lifecycleContext.request.projectRoot };
      const outcome = await dispatchLifecycle(lifecycleContext);
      if (!outcome.keepAlive && !allowQuit) { allowQuit = true; app.exit(outcome.success ? 0 : 1); }
      return;
    }
    // Upgrade only these known, same-owner GUI metadata files to private ACLs;
    // never tighten/adopt an arbitrary renderer- or command-selected path.
    for (const path of [settingsFile, windowStateFile]) {
      try { await securePrivateFile(path); }
      catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
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
    let launch = {};
    try {
      launch = readLaunchArguments(process.argv.slice(1));
      if (app.isPackaged && launch.nodePath) throw new Error("Packaged local mode uses the bundled Node runtime; --node is development-only.");
      configuration = { ...configuration, ...launch };
      if (launch.dataDir && !launch.projectRoot) configuration.projectRoot = join(launch.dataDir, "projects");
    } catch (cause) { configError = safeDesktopMessage(cause); }
    installMenu();
    previewManager = new PreviewManager({
      electron,
      guestPreloadPath: join(here, "preview-pick-preload.cjs"),
      pipPreloadPath: join(here, "preview-pip-preload.cjs"),
      getWindow: () => workspaceWindow,
      onOpenLink: ({ tabId, url }) => {
        if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.webContents.send("desktop:preview-open-link", { tabId, url });
      },
    });
    ipcMain.handle("desktop:preview", previewAction);
    ipcMain.handle("desktop:choose-workspace-directory", chooseWorkspaceDirectory);
    ipcMain.handle("desktop:first-run-token", firstRunToken);
    ipcMain.handle("desktop:action", desktopAction);
    ipcMain.handle("desktop:titlebar-theme", setTitleBarTheme);
    nativeTheme.on("updated", () => {
      applyTitleBarTheme(connectionWindow, nativeTheme.shouldUseDarkColors ? "dark" : "light");
    });
    showConnection();
    if (configError) publish({ status: "error", error: configError });
    else if (launch.mode) await connect(configuration);
  }).catch(cause => {
    dialog.showErrorBox("Desktop startup failed", safeDesktopMessage(cause));
    void finishQuit();
  });
}

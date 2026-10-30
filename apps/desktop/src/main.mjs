import { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalServer } from "./local-server.mjs";
import {
  absolutePath,
  readLaunchArguments,
  remoteAddress,
  sameService,
  serviceRequestAllowed,
} from "./policy.mjs";

app.setName("PM Agent v4");
app.setAppUserModelId("com.projectmanagementagent.v4");
app.setPath("userData", join(app.getPath("appData"), "PM Agent v4"));
const here = dirname(fileURLToPath(import.meta.url));
const connectionUrl = pathToFileURL(join(here, "connection.html")).href;
const repository = resolve(here, "../../..");
let connectionWindow;
let workspaceWindow;
let localServer;
let workspaceSession;
let workspaceMode;
let allowQuit = false;
let quitting = false;
let quitPromise;
let changingConnection = false;
let externalPrompt = false;
let configuration;
let settingsFile;
let state = {
  status: "idle",
  message: "Choose where your workspace runs.",
  error: "",
  details: "",
  address: "",
  runtime: "",
};

function snapshot() {
  return {
    ...state,
    configuration,
    localRunning: Boolean(localServer?.child),
    workspaceOpen: Boolean(workspaceWindow && !workspaceWindow.isDestroyed()),
  };
}

function publish(patch) {
  Object.assign(state, patch);
  if (connectionWindow && !connectionWindow.isDestroyed())
    connectionWindow.webContents.send("desktop:state", snapshot());
}

function securePreferences(partition, preload) {
  return {
    partition,
    ...(preload ? { preload } : {}),
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
  };
}

function lockPermissions(targetSession) {
  targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDevicePermissionHandler(() => false);
  targetSession.on("will-download", (_event, item) =>
    item.setSaveDialogOptions({ title: "Save workspace download" }),
  );
}

function showConnection() {
  if (connectionWindow && !connectionWindow.isDestroyed()) {
    connectionWindow.show();
    connectionWindow.focus();
    return connectionWindow;
  }
  connectionWindow = new BrowserWindow({
    width: 760,
    height: 800,
    minWidth: 620,
    minHeight: 660,
    title: "Workspace connection — Agent Workspace",
    backgroundColor: "#fafaf9",
    autoHideMenuBar: false,
    webPreferences: securePreferences("desktop-connection", join(here, "preload.cjs")),
  });
  lockPermissions(connectionWindow.webContents.session);
  connectionWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  connectionWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== connectionUrl) event.preventDefault();
  });
  connectionWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  connectionWindow.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (workspaceWindow && !workspaceWindow.isDestroyed()) connectionWindow.hide();
    else void requestQuit();
  });
  void connectionWindow.loadURL(connectionUrl);
  return connectionWindow;
}

async function externalLink(value) {
  if (externalPrompt || quitting) return;
  let url;
  try {
    url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
  } catch {
    return;
  }
  externalPrompt = true;
  try {
    const result = await dialog.showMessageBox({
      type: "question",
      title: "Open your browser?",
      message: `Open ${url.hostname} outside Agent Workspace?`,
      detail:
        "The system browser has a separate login session. No desktop local access token is passed to it.",
      buttons: ["Cancel", "Open in browser"],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) await shell.openExternal(url.href);
  } catch (cause) {
    publish({ error: `Could not open your browser: ${cause.message}` });
    showConnection();
  } finally {
    externalPrompt = false;
  }
}

function constrainSession(targetSession, origin) {
  lockPermissions(targetSession);
  targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: !serviceRequestAllowed(details.url, origin) });
  });
}

async function createWorkspace(url, targetSession, mode) {
  const origin = new URL(url).origin;
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 900,
    minHeight: 640,
    title: "Agent Workspace",
    backgroundColor: "#fafaf9",
    webPreferences: { ...securePreferences(), session: targetSession },
  });
  workspaceWindow = window;
  workspaceSession = targetSession;
  workspaceMode = mode;
  window.webContents.setWindowOpenHandler(({ url: destination }) => {
    void externalLink(destination);
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, destination) => {
    if (!sameService(destination, origin)) {
      event.preventDefault();
      void externalLink(destination);
    }
  });
  window.webContents.on("will-redirect", (event, destination) => {
    if (!sameService(destination, origin)) event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, code, description, destination, mainFrame) => {
    if (mainFrame && code !== -3 && workspaceWindow === window && state.status !== "connecting") {
      publish({
        status: "error",
        error: `Workspace connection failed (${description}, ${code}). Check the server URL, certificate and network, then reconnect.`,
        details: destination,
      });
      showConnection();
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (workspaceWindow !== window || quitting) return;
    publish({
      status: "error",
      error: `The workspace renderer stopped (${details.reason}). Use Open workspace to reopen it; local Server tasks are not cancelled.`,
    });
    showConnection();
  });
  window.on("closed", () => {
    if (workspaceWindow !== window) return;
    workspaceWindow = null;
    if (!quitting) {
      publish({
        message:
          mode === "local"
            ? "Workspace window closed. The local Server and scheduled tasks are still running. Open it again, or Quit to stop them."
            : "Workspace window closed. Remote tasks belong to the remote Server; quitting this app does not stop that Server.",
      });
      showConnection();
    }
  });
  try {
    await window.loadURL(url);
  } catch (cause) {
    if (!window.isDestroyed()) window.destroy();
    throw new Error(
      `Cannot load the workspace: ${cause.message}. Check the connection and reconnect.`,
    );
  }
  if (connectionWindow && !connectionWindow.isDestroyed()) connectionWindow.hide();
}

async function closeWorkspace() {
  const previous = workspaceWindow;
  workspaceWindow = null;
  if (previous && !previous.isDestroyed()) previous.destroy();
  const previousSession = workspaceSession;
  const previousMode = workspaceMode;
  workspaceSession = null;
  workspaceMode = null;
  if (previousSession) {
    previousSession.webRequest.onBeforeRequest(null);
    await previousSession.closeAllConnections();
    if (previousMode === "local") await previousSession.clearStorageData();
  }
}

async function stopConnection() {
  await closeWorkspace();
  await localServer?.stop();
  localServer = null;
}

async function confirmLocalStop(message) {
  if (!localServer?.child) return true;
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "Stop the local Server?",
    message,
    detail:
      "Active local executions will be interrupted. Schedules and folder watches do not run while the app is quit or disconnected. Saved workspace data is kept. Close only the workspace window to keep tasks running.",
    buttons: ["Keep running", "Stop local Server"],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}

async function checkServer(targetSession, origin, token) {
  const response = await targetSession.fetch(`${origin}/agent/api/access`, {
    method: token ? "POST" : "GET",
    credentials: "include",
    ...(token
      ? {
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({ token }),
        }
      : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Server access check returned HTTP ${response.status}. Use the direct workspace Server origin (redirects are not followed).`,
    );
  const result = await response.json().catch(() => null);
  if (
    !result ||
    typeof result.authorized !== "boolean" ||
    (!token && typeof result.configured !== "boolean")
  ) {
    throw new Error(
      "The address is not a compatible Agent Server: /agent/api/access did not return the expected access status.",
    );
  }
  if (token && result.authorized !== true)
    throw new Error("The local Server rejected the private desktop session.");
  if (token) {
    const verified = await checkServer(targetSession, origin);
    if (!verified.authorized)
      throw new Error("The local Server did not establish its private HttpOnly session cookie.");
  }
  return result;
}

async function saveConfiguration(next) {
  await writeFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  configuration = next;
}

async function connect(input) {
  if (quitting || changingConnection)
    throw new Error("A connection change is already in progress.");
  if (!input || !["local", "remote"].includes(input.mode))
    throw new Error("Select Local or Remote.");
  const next = {
    mode: input.mode,
    remoteUrl: input.mode === "remote" ? remoteAddress(input.remoteUrl) : configuration.remoteUrl,
    dataDir:
      input.mode === "local"
        ? absolutePath(input.dataDir, "Data directory")
        : configuration.dataDir,
    projectRoot:
      input.mode === "local"
        ? absolutePath(input.projectRoot, "Project root")
        : configuration.projectRoot,
    nodePath:
      input.mode === "remote"
        ? configuration.nodePath
        : input.nodePath === "node"
          ? "node"
          : absolutePath(input.nodePath, "Node executable"),
  };
  changingConnection = true;
  try {
    if (!(await confirmLocalStop("Changing the connection stops the current local Server.")))
      return snapshot();
    if (quitting) return snapshot();
    publish({
      status: "connecting",
      message:
        next.mode === "local"
          ? "Starting local Server and authenticating the private window…"
          : "Checking the remote Server…",
      error: "",
      details: "",
      address: "",
      runtime: "",
    });
    await stopConnection();
    await saveConfiguration(next);
    if (quitting) throw new Error("Connection cancelled while quitting.");
    if (next.mode === "local") {
      localServer = new LocalServer({
        serverRoot: app.isPackaged ? join(process.resourcesPath, "workspace-runtime") : repository,
        webRoot: app.isPackaged
          ? join(process.resourcesPath, "workspace-runtime", "apps", "web", "dist")
          : join(repository, "apps", "web", "dist"),
        configRoot: app.isPackaged ? join(app.getPath("home"), ".pmv4") : repository,
        onExit: (message, details) => {
          publish({ status: "error", error: message, details });
          showConnection();
        },
      });
      const started = await localServer.start(next);
      if (quitting) throw new Error("Connection cancelled while quitting.");
      // A fresh nonpersistent partition is never reused by a remote page, even if its port matches.
      const privateSession = session.fromPartition(`local-workspace-${randomUUID()}`);
      constrainSession(privateSession, started.origin);
      workspaceSession = privateSession;
      workspaceMode = "local";
      await checkServer(privateSession, started.origin, started.token);
      if (quitting) throw new Error("Connection cancelled while quitting.");
      await createWorkspace(`${started.origin}/agent/workspace`, privateSession, "local");
      publish({
        status: "connected",
        message:
          "Local workspace connected. Closing its window keeps the Server running; Quit stops it.",
        address: started.origin,
        runtime: started.runtime,
      });
    } else {
      const origin = new URL(next.remoteUrl).origin;
      const key = createHash("sha256").update(origin).digest("hex");
      const remoteSession = session.fromPartition(`persist:remote-workspace-${key}`);
      constrainSession(remoteSession, origin);
      workspaceSession = remoteSession;
      workspaceMode = "remote";
      const access = await checkServer(remoteSession, origin);
      if (quitting) throw new Error("Connection cancelled while quitting.");
      await createWorkspace(next.remoteUrl, remoteSession, "remote");
      publish({
        status: "connected",
        message: access.authorized
          ? "Remote workspace connected. Executions run on the remote Server."
          : "Remote Server reached. Enter that Server’s access token in the workspace login page; no local token is shared.",
        address: origin,
        runtime: "",
      });
    }
  } catch (cause) {
    const details = localServer?.diagnostic() || "";
    await stopConnection();
    publish({
      status: "error",
      message: "Workspace connection did not complete.",
      error: cause.message,
      details,
    });
    if (!quitting) showConnection();
  } finally {
    changingConnection = false;
  }
  return snapshot();
}

async function reopenWorkspace() {
  if (state.status === "connecting" || quitting) return;
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.show();
    workspaceWindow.focus();
  } else if (state.status === "connected" && workspaceSession && state.address) {
    await createWorkspace(`${state.address}/agent/workspace`, workspaceSession, workspaceMode).catch(
      (cause) => {
        publish({ status: "error", error: cause.message });
        showConnection();
      },
    );
  } else showConnection();
}

function finishQuit() {
  if (quitPromise) return quitPromise;
  quitting = true;
  publish({ status: "stopping", message: "Stopping local Server and its workers…" });
  quitPromise = stopConnection().finally(() => {
    allowQuit = true;
    app.quit();
  });
  return quitPromise;
}

async function requestQuit() {
  if (quitting) return;
  quitting = true;
  if (!(await confirmLocalStop("Quit Agent Workspace and stop local background tasks?"))) {
    if (!quitPromise) quitting = false;
    return;
  }
  await finishQuit();
}

function trustedConnection(event) {
  return (
    connectionWindow &&
    !connectionWindow.isDestroyed() &&
    event.sender === connectionWindow.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === connectionUrl
  );
}

function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Workspace",
        submenu: [
          {
            label: "Open Workspace",
            accelerator: "CmdOrCtrl+Shift+O",
            click: () => void reopenWorkspace(),
          },
          { label: "Connection Settings…", accelerator: "CmdOrCtrl+,", click: showConnection },
          { type: "separator" },
          {
            label: "Quit Agent Workspace…",
            accelerator: "CmdOrCtrl+Q",
            click: () => void requestQuit(),
          },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    showConnection();
    try {
      const next = readLaunchArguments(argv);
      if (next.mode)
        void connect({ ...configuration, ...next }).catch((cause) =>
          publish({ error: cause.message }),
        );
    } catch (cause) {
      publish({ error: cause.message });
    }
  });
  app.on("activate", () => void reopenWorkspace());
  app.on("window-all-closed", () => {
    if (!quitting) showConnection();
  });
  app.on("before-quit", (event) => {
    if (!allowQuit) {
      event.preventDefault();
      // Explicit UI actions confirm before calling app.quit; native OS quit must not wait on a dialog.
      void finishQuit();
    }
  });
  // OS termination skips interactive confirmation but still awaits graceful Server shutdown.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void finishQuit());
  void app
    .whenReady()
    .then(async () => {
      settingsFile = join(app.getPath("userData"), "connection.json");
      await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
      const defaultProject = app.isPackaged
        ? join(app.getPath("userData"), "projects")
        : join(repository, ".local", "projects");
      if (app.isPackaged) await mkdir(defaultProject, { recursive: true });
      let saved = {};
      let configError = "";
      try {
        saved = JSON.parse(await readFile(settingsFile, "utf8"));
        if (!saved || typeof saved !== "object" || Array.isArray(saved))
          throw new Error("Invalid saved connection settings.");
      } catch (cause) {
        if (cause.code !== "ENOENT")
          configError = `Could not read saved connection settings: ${cause.message}`;
      }
      configuration = {
        mode: saved.mode === "local" ? "local" : "remote",
        remoteUrl: typeof saved.remoteUrl === "string" ? saved.remoteUrl : "http://127.0.0.1:3224/agent/workspace",
        dataDir:
          process.env.AGENT_WORKSPACE_DATA_DIR ||
          saved.dataDir ||
          (app.isPackaged ? join(app.getPath("userData"), "agent-data") : join(repository, ".local", "agent-data")),
        projectRoot:
          process.env.AGENT_WORKSPACE_PROJECT_ROOT || saved.projectRoot || defaultProject,
        nodePath: process.env.AGENT_WORKSPACE_NODE || saved.nodePath || "node",
      };
      let launch = {};
      try {
        launch = readLaunchArguments(process.argv.slice(1));
      } catch (cause) {
        configError = cause.message;
      }
      configuration = { ...configuration, ...launch };
      installMenu();
      ipcMain.handle("desktop:action", async (event, input) => {
        if (!trustedConnection(event))
          throw new Error("Desktop controls are available only in the trusted connection window.");
        if (!input || typeof input !== "object") throw new Error("Invalid desktop action.");
        switch (input.action) {
          case "state":
            return snapshot();
          case "connect":
            return connect(input.configuration);
          case "open":
            await reopenWorkspace();
            return snapshot();
          case "disconnect":
            if (state.status === "connecting")
              throw new Error("Wait for startup to complete before disconnecting.");
            if (await confirmLocalStop("Disconnect and stop the local Server?")) {
              await stopConnection();
              publish({
                status: "idle",
                message: "Disconnected. Saved data is kept; local schedules are stopped.",
                address: "",
                runtime: "",
                error: "",
                details: "",
              });
            }
            return snapshot();
          case "directory": {
            if (!["dataDir", "projectRoot"].includes(input.field))
              throw new Error("Invalid directory selection.");
            const result = await dialog.showOpenDialog(connectionWindow, {
              title:
                input.field === "dataDir"
                  ? "Choose existing workspace data directory"
                  : "Choose project root",
              properties: ["openDirectory", "createDirectory"],
            });
            return result.canceled ? null : result.filePaths[0];
          }
          case "node": {
            const result = await dialog.showOpenDialog(connectionWindow, {
              title: "Choose Node 24 LTS executable",
              properties: ["openFile"],
            });
            return result.canceled ? null : result.filePaths[0];
          }
          case "quit":
            await requestQuit();
            return snapshot();
          default:
            throw new Error("Unknown desktop action.");
        }
      });
      showConnection();
      if (configError) publish({ status: "error", error: configError });
      else if (launch.mode) await connect(configuration);
    })
    .catch((cause) => {
      dialog.showErrorBox("Desktop startup failed", cause.message);
      allowQuit = true;
      app.quit();
    });
}

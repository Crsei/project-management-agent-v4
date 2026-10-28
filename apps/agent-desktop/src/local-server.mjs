import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { absolutePath } from "./policy.mjs";

const execute = promisify(execFile);
const STARTUP_DEADLINE = 45_000;
const SHUTDOWN_DEADLINE = 18_000;

function runtimeEnvironment() {
  const environment = { ...process.env };
  // The server is an ordinary Node process, not an Electron subprocess.
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "AGENT_WORKSPACE_ACCESS_TOKEN",
  ])
    delete environment[key];
  return environment;
}

export class LocalServer {
  constructor({ serverRoot, webRoot, envFile, onExit }) {
    this.serverRoot = serverRoot;
    this.webRoot = webRoot;
    this.envFile = envFile;
    this.onExit = onExit;
    this.child = null;
    this.logs = "";
    this.stopping = false;
    this.stopPromise = null;
    this.token = "";
  }

  diagnostic() {
    return this.logs;
  }

  async start(configuration) {
    if (this.child) throw new Error("A local server is already running.");
    this.stopping = false;
    this.stopPromise = null;
    const projectRoot = absolutePath(configuration.projectRoot, "Project root");
    const dataDir = absolutePath(configuration.dataDir, "Data directory");
    const node =
      configuration.nodePath === "node"
        ? "node"
        : absolutePath(configuration.nodePath, "Node executable");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (!(await stat(projectRoot).catch(() => null))?.isDirectory()) {
      throw new Error(
        `Project folder does not exist: ${projectRoot}. Select an existing project folder.`,
      );
    }
    const entry = join(this.serverRoot, "dist", "index.mjs");
    for (const file of [
      entry,
      join(this.serverRoot, "dist", "agents", "claude-history-worker.mjs"),
      join(this.webRoot, "index.html"),
      join(this.webRoot, "ui-lab.json"),
    ]) {
      await access(file, constants.R_OK).catch(() => {
        throw new Error(
          `Missing application asset: ${file}. Build contracts, Server and Web, or reinstall the complete desktop package.`,
        );
      });
    }
    const probe = `
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major !== 24) throw new Error('Node 24 LTS is required; found '+process.version);
      require('node:sqlite');
      require('@lydell/node-pty');
      const fs = require('node:fs');
      const path = require('node:path');
      const {createRequire} = require('node:module');
      const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
      const nativePackage = '@anthropic-ai/claude-agent-sdk-'+process.platform+'-'+process.arch;
      const sdkRequire = createRequire(sdkEntry);
      const nativeRoot = path.dirname(sdkRequire.resolve(nativePackage+'/package.json'));
      fs.accessSync(path.join(nativeRoot, process.platform === 'win32' ? 'claude.exe' : 'claude'), process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
      console.log(JSON.stringify({version:process.version, executable:process.execPath}));
    `;
    let runtime;
    try {
      const result = await execute(node, ["-e", probe], {
        cwd: this.serverRoot,
        env: runtimeEnvironment(),
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      });
      runtime = JSON.parse(result.stdout.trim());
    } catch (cause) {
      const details = cause.stderr?.trim() || cause.message;
      throw new Error(
        `Cannot use Node runtime “${node}”. Install Node 24 LTS and select its executable. The Server needs node:sqlite, the platform-native @lydell/node-pty dependency and the Claude SDK. ${details}`,
      );
    }
    if (this.stopping) throw new Error("Local startup was cancelled.");
    this.token = randomBytes(48).toString("base64url");
    this.logs = "";
    const privateToken = this.token;
    const args = this.envFile ? [`--env-file-if-exists=${this.envFile}`, entry] : [entry];
    const child = spawn(runtime.executable, args, {
      cwd: projectRoot,
      env: {
        ...runtimeEnvironment(),
        HOST: "127.0.0.1",
        PORT: "0",
        AGENT_WORKSPACE_API_ONLY: "0",
        AGENT_WORKSPACE_WEB_DIST: this.webRoot,
        AGENT_WORKSPACE_DATA_DIR: dataDir,
        AGENT_WORKSPACE_PROJECT_ROOT: projectRoot,
        AGENT_WORKSPACE_ACCESS_TOKEN: this.token,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      let pending = "";
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(new Error(`${message}\n${this.diagnostic()}`.trim()));
      };
      const deadline = setTimeout(() => {
        fail(
          "The local Server did not report readiness within 45 seconds. Check Node, database ownership and application assets.",
        );
        void this.stop();
      }, STARTUP_DEADLINE);
      const record = (chunk) => {
        const text = chunk.toString();
        this.logs = (this.logs + text)
          .replaceAll(privateToken, "[local credential redacted]")
          .slice(-16_384);
        return text;
      };
      child.stderr.on("data", record);
      child.stdout.on("data", (chunk) => {
        pending += record(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop().slice(-8192);
        for (const line of lines) {
          const match = /^agent-workspace listening on http:\/\/127\.0\.0\.1:(\d+)$/.exec(line);
          const port = match ? Number(match[1]) : 0;
          if (!settled && port > 0 && port <= 65535) {
            settled = true;
            ready = true;
            clearTimeout(deadline);
            resolve({
              origin: `http://127.0.0.1:${port}`,
              token: this.token,
              runtime: runtime.version,
            });
          }
        }
      });
      child.once("error", (cause) => {
        this.child = null;
        this.token = "";
        fail(`Cannot start the local Server: ${cause.message}`);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(deadline);
        this.child = null;
        this.token = "";
        // The Server has already awaited its workers on a normal exit. Reap any remaining descendants.
        this.terminateTree(child.pid, true);
        if (!ready)
          fail(
            `The local Server exited before readiness (${signal || code}). Stop other processes using the data directory, then reconnect.`,
          );
        else if (!this.stopping)
          this.onExit(
            `The local Server stopped unexpectedly (${signal || code}). Reconnect to restart it.`,
            this.diagnostic(),
          );
      });
    });
  }

  terminateTree(pid, force = false) {
    if (!pid) return;
    if (process.platform === "win32") {
      const killer = spawn(
        join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => {});
    } else {
      try {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      } catch (cause) {
        if (cause.code !== "ESRCH")
          this.logs += `\nCould not signal server process group: ${cause.message}`;
      }
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopPromise = new Promise((resolve) => {
      const deadline = setTimeout(() => this.terminateTree(child.pid, true), SHUTDOWN_DEADLINE);
      child.once("exit", () => {
        clearTimeout(deadline);
        resolve();
      });
      // The dedicated parent IPC channel is never exposed to a BrowserWindow.
      if (child.connected) {
        child.send({ type: "agent-workspace:shutdown" }, (error) => {
          if (error && child.exitCode === null) {
            if (process.platform !== "win32") child.kill("SIGTERM");
            else this.terminateTree(child.pid, true);
          }
        });
      } else if (process.platform !== "win32") child.kill("SIGTERM");
      else this.terminateTree(child.pid, true);
    });
    return this.stopPromise;
  }
}

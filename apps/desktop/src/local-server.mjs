import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify, parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { absolutePath } from "./policy.mjs";

const execute = promisify(execFile);
const STARTUP_DEADLINE = 60_000;
const SHUTDOWN_DEADLINE = 18_000;
const ports = { public: 3224, pm: 4194, agent: 4325 };

function commonEnvironment() {
  return Object.fromEntries([
    "PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "TZ", "LANG", "LC_ALL",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CHOKIDAR_USEPOLLING",
  ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function readEnvironment(directory, name, required = false) {
  const file = join(directory, name);
  try { return parseEnv(await readFile(file, "utf8")); }
  catch (error) {
    if (!required && error.code === "ENOENT") return {};
    throw new Error(`Cannot read ${file}: ${error.message}. Configure the v4 local services before connecting.`);
  }
}

async function assertFree(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } catch (error) {
    throw new Error(`Local port ${port} is unavailable: ${error.message}. Stop the conflicting service; desktop never takes ownership of it.`);
  }
}

export class LocalServer {
  constructor({ serverRoot, webRoot, configRoot, onExit }) {
    this.serverRoot = serverRoot;
    this.webRoot = webRoot;
    this.configRoot = configRoot;
    this.onExit = onExit;
    this.children = new Map();
    this.logs = "";
    this.secrets = [];
    this.stopping = false;
    this.stopPromise = null;
    this.ready = false;
    this.failure = "";
    this.token = "";
  }

  get child() { return this.children.values().next().value || null; }
  diagnostic() { return this.logs; }

  record(role, chunk) {
    let text = chunk.toString();
    for (const secret of this.secrets) text = text.replaceAll(secret, "[credential redacted]");
    this.logs = (this.logs + `[${role}] ${text}`).slice(-32_768);
  }

  async start(configuration) {
    if (this.child) throw new Error("Local services are already running.");
    this.stopping = false;
    this.stopPromise = null;
    this.failure = "";
    this.ready = false;
    this.logs = "";
    const projectRoot = absolutePath(configuration.projectRoot, "Project root");
    const dataDir = absolutePath(configuration.dataDir, "Data directory");
    const node = configuration.nodePath === "node" ? "node" : absolutePath(configuration.nodePath, "Node executable");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (!(await stat(projectRoot).catch(() => null))?.isDirectory())
      throw new Error(`Project folder does not exist: ${projectRoot}. Select an existing project folder.`);
    const entries = {
      pm: join(this.serverRoot, "apps/server/pm/src/main.ts"),
      worker: join(this.serverRoot, "apps/server/worker/src/main.ts"),
      agent: join(this.serverRoot, "apps/server/agent/dist/index.mjs"),
      gateway: join(this.serverRoot, "apps/server/gateway.ts"),
    };
    for (const file of [...Object.values(entries), join(this.webRoot, "index.html")]) {
      await access(file).catch(() => { throw new Error(`Missing application asset: ${file}. Build the v4 Agent and unified Web, or reinstall the complete desktop package.`); });
    }
    const pm = await readEnvironment(this.configRoot, ".env", true);
    const worker = await readEnvironment(this.configRoot, ".env.worker", true);
    const agent = await readEnvironment(this.configRoot, ".env.agent");
    if (!pm.DATABASE_URL || !worker.DATABASE_URL)
      throw new Error(`DATABASE_URL is required in both ${join(this.configRoot, ".env")} and ${join(this.configRoot, ".env.worker")}. Start and migrate your own PostgreSQL database; PostgreSQL is not bundled.`);
    if (Object.keys(worker).some((key) => /^(?:AWS_|S3_|SOURCE_S3_|TARGET_S3_)/.test(key)))
      throw new Error("The Worker environment must not contain blob or cloud credentials; use a separate .env.worker.");
    this.secrets = [pm.DATABASE_URL, worker.DATABASE_URL, ...[process.env, pm, worker, agent].flatMap((environment) =>
      Object.entries(environment).filter(([key, value]) => /(?:KEY|TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|COOKIE)/i.test(key) && typeof value === "string" && value.length >= 4).map(([, value]) => value))];
    for (const value of [pm.DATABASE_URL, worker.DATABASE_URL]) {
      try { const password = new URL(value).password; if (password) this.secrets.push(password, decodeURIComponent(password)); } catch { /* The server reports invalid URLs. */ }
    }
    let runtime;
    try {
      const result = await execute(node, ["-e", "if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Node 24 is required; found '+process.version); require('node:sqlite'); console.log(JSON.stringify({version:process.version,executable:process.execPath}))"], {
        cwd: this.serverRoot, env: commonEnvironment(), timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024,
      });
      runtime = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new Error(`Cannot use Node runtime “${node}”. Install Node 24 LTS and select its executable. ${error.stderr?.trim() || error.message}`);
    }
    for (const port of Object.values(ports)) await assertFree(port);
    if (this.stopping) throw new Error("Local startup was cancelled.");
    this.token = randomBytes(48).toString("base64url");
    this.secrets.push(this.token);
    const origin = `http://127.0.0.1:${ports.public}`;
    const pmUrl = `http://127.0.0.1:${ports.pm}`;
    const agentUrl = `http://127.0.0.1:${ports.agent}`;
    const common = commonEnvironment();
    const environments = {
      pm: { ...common, ...pm, HOST: "127.0.0.1", PORT: String(ports.pm), PUBLIC_ORIGIN: origin },
      worker: { ...common, ...worker },
      agent: { ...process.env, ...agent, HOST: "127.0.0.1", PORT: String(ports.agent), PM_API_URL: pmUrl, AGENT_WORKSPACE_API_ONLY: "1", AGENT_WORKSPACE_DATA_DIR: dataDir, AGENT_WORKSPACE_PROJECT_ROOT: projectRoot, AGENT_WORKSPACE_ACCESS_TOKEN: this.token },
      gateway: { ...common, PUBLIC_HOST: "127.0.0.1", PUBLIC_PORT: String(ports.public), PM_URL: pmUrl, AGENT_URL: agentUrl, WEB_DIST: this.webRoot },
    };
    const output = { worker: "", pm: "", agent: "", gateway: "" };
    const started = new Set();
    const markers = {
      worker: '"event":"worker_started"',
      pm: `Server listening at ${pmUrl}`,
      agent: `agent-workspace listening on ${agentUrl}`,
      gateway: `public gateway listening on ${origin}`,
    };
    try {
      for (const role of ["worker", "pm", "agent", "gateway"]) {
        if (this.stopping) throw new Error("Local startup was cancelled.");
        const child = spawn(runtime.executable, ["--conditions=development", entries[role]], {
          cwd: this.configRoot, env: environments[role], stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32", windowsHide: true,
        });
        this.children.set(role, child);
        child.stdout.on("data", (chunk) => {
          if (!started.has(role)) {
            output[role] = (output[role] + chunk.toString()).slice(-8192);
            if (output[role].includes(markers[role])) started.add(role);
          }
          this.record(role, chunk);
        });
        child.stderr.on("data", (chunk) => this.record(role, chunk));
        child.once("error", (error) => { this.failure ||= `${role} could not start: ${error.message}`; });
        child.once("exit", (code, signal) => {
          this.children.delete(role);
          if (!this.stopping) this.terminateTree(child.pid, true);
          if (!this.stopping) {
            this.failure ||= `${role} exited unexpectedly (${signal || code}).`;
            if (this.ready) { this.ready = false; this.onExit(this.failure, this.diagnostic()); void this.stop(); }
          }
        });
      }
      const end = Date.now() + STARTUP_DEADLINE;
      let last = "";
      while (Date.now() < end) {
        if (this.stopping) throw new Error("Local startup was cancelled.");
        if (this.failure) throw new Error(this.failure);
        try {
          const checks = await Promise.all([
            fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1500), redirect: "error" }),
            fetch(`${origin}/agent/api/access`, { signal: AbortSignal.timeout(1500), redirect: "error" }),
            fetch(`${origin}/pm`, { signal: AbortSignal.timeout(1500), redirect: "error" }),
            fetch(`${origin}/agent/workspace`, { signal: AbortSignal.timeout(1500), redirect: "error" }),
          ]);
          const health = await checks[0].json().catch(() => null);
          const access = await checks[1].json().catch(() => null);
          if (checks.every((response) => response.ok) && health?.status === "ready" && typeof access?.authorized === "boolean" && checks[2].headers.get("content-type")?.includes("text/html") && checks[3].headers.get("content-type")?.includes("text/html") && started.size === 4 && this.children.size === 4 && !this.failure) {
            this.ready = true;
            return { origin, token: this.token, runtime: runtime.version };
          }
          last = `Readiness: PM HTTP ${checks[0].status} ${JSON.stringify(health)}, Agent HTTP ${checks[1].status}, Web HTTP ${checks[2].status}/${checks[3].status}.`;
        } catch (error) { last = `Waiting for local services: ${error.message}`; }
        await delay(500);
      }
      throw new Error(`Local services did not become ready within 60 seconds. Verify PostgreSQL is running and migrated, storage is configured, and the Worker can access the database. ${last}`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  terminateTree(pid, force = false) {
    if (!pid) return;
    if (process.platform === "win32") {
      const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {});
    } else {
      try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") this.logs += `\nCould not signal owned process group: ${error.message}`; }
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.ready = false;
    const children = [...this.children.values()];
    this.stopPromise = Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) { resolve(); return; }
      const deadline = setTimeout(() => this.terminateTree(child.pid, true), SHUTDOWN_DEADLINE);
      child.once("exit", () => { clearTimeout(deadline); resolve(); });
      this.terminateTree(child.pid);
    }))).then(() => { this.token = ""; });
    return this.stopPromise;
  }
}

import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { absolutePath } from "./policy.mjs";
import { ManagedPostgres } from "./managed-postgres.mjs";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "./private-state.mjs";
import { ownsLiveProcess, serviceEntry, spawnOwned, stopOwned } from "./local-process.mjs";

const STARTUP_DEADLINE = 90_000;
const BOOTSTRAP_DEADLINE = 120_000;
const SHUTDOWN_DEADLINE = 120_000;
const RESERVED_DEVELOPMENT_PORTS = new Set([3000, 3223, 3224, 4193, 4194, 4324, 4325, 5432]);
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const SERVICE_ROLES = ["worker", "pm", "agent", "gateway"];
const STOP_ORDER = ["gateway", "worker", "agent", "pm", "bootstrap", "runtime"];

function systemEnvironment() {
  // Never inherit NODE_OPTIONS, DATABASE_URL, provider tokens, cloud identity or
  // a shell's application configuration. Agent CLI homes are explicit below.
  return Object.fromEntries([
    "PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "TZ", "LANG", "LC_ALL",
  ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function cancellation() { return new Error("Local startup was cancelled."); }
function validPort(port) { return Number.isInteger(port) && port >= 1024 && port <= 65535 && !RESERVED_DEVELOPMENT_PORTS.has(port); }

async function reservePort(preferred = 0) {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: preferred, exclusive: true }, done);
    });
    const port = server.address().port;
    if (!validPort(port)) { await closeReservation(server); return reservePort(); }
    return { port, server };
  } catch (error) {
    await closeReservation(server);
    throw error;
  }
}

function closeReservation(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
}

function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

function validateServicePorts(metadata) {
  if (!metadata || metadata.version !== 1 || metadata.instanceId !== null && (typeof metadata.instanceId !== "string" || !UUID.test(metadata.instanceId)) || ![metadata.public, metadata.pm, metadata.agent].every(validPort) || new Set([metadata.public, metadata.pm, metadata.agent]).size !== 3 || typeof metadata.serviceSecret !== "string" || !/^[\w-]{64}$/.test(metadata.serviceSecret)) {
    throw new Error("Managed service port metadata is invalid. Restore the complete desktop instance; its public origin will not be changed silently.");
  }
  return metadata;
}

async function acquireServicePorts(dataDir, reservations, assertActive = () => {}) {
  const file = join(dataDir, "service-ports.json");
  let metadata = await readPrivateJson(file, 4096);
  const fresh = metadata === null;
  if (fresh && (await readdir(dataDir)).length) throw new Error("Managed service port metadata is missing. Select a new empty desktop data directory or restore the complete instance; its public origin will not be changed silently.");
  if (!fresh) validateServicePorts(metadata);
  assertActive();
  const selected = {};
  try {
    for (const role of ["public", "pm", "agent"]) {
      assertActive();
      let reservation;
      try { reservation = await reservePort(metadata?.[role] || 0); }
      catch (error) {
        if (role === "public") throw new Error(metadata ? `Saved desktop public port ${metadata.public} is unavailable. Desktop never stops or takes ownership of a conflicting service.` : "Cannot reserve a loopback port for the desktop public origin.");
        if (error.code !== "EADDRINUSE") throw error;
        reservation = await reservePort();
      }
      reservations.set(role, reservation.server);
      selected[role] = reservation.port;
      assertActive();
    }
    metadata = { version: 1, instanceId: metadata?.instanceId ?? null, ...selected, serviceSecret: metadata?.serviceSecret ?? randomBytes(48).toString("base64url") };
    await writePrivateJson(file, metadata, { exclusive: fresh });
    assertActive();
    return metadata;
  } catch (error) {
    await Promise.all([...reservations.values()].map(closeReservation));
    reservations.clear();
    throw error;
  }
}

// Restore must allocate a new public origin before claiming its new database,
// not copy another instance's browser origin or private service identity.
export async function prepareServicePorts(input) {
  const dataDir = absolutePath(input, "Data directory");
  const createdDataDirectory = await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if ((await readdir(dataDir)).length) throw new Error("Preparing desktop service ports requires an empty target directory.");
  await ensurePrivateDirectory(dataDir, { newlyCreated: createdDataDirectory !== undefined });
  const reservations = new Map();
  try {
    const ports = await acquireServicePorts(dataDir, reservations);
    return { origin: `http://127.0.0.1:${ports.public}` };
  } finally { await Promise.all([...reservations.values()].map(closeReservation)); }
}

export async function bindServicePorts(input, instanceId) {
  if (typeof instanceId !== "string" || !UUID.test(instanceId)) throw new Error("Invalid managed database instance identity.");
  const file = join(absolutePath(input, "Data directory"), "service-ports.json");
  const ports = validateServicePorts(await readPrivateJson(file, 4096));
  if (ports.instanceId !== null && ports.instanceId !== instanceId) throw new Error("Desktop service ports belong to a different managed database instance. Restore the complete instance.");
  if (ports.instanceId === null) await writePrivateJson(file, { ...ports, instanceId });
}

export class LocalServer {
  constructor({ serverRoot, webRoot, runtimeRoot, onExit, onProgress }, { postgresFactory = (options) => new ManagedPostgres(options) } = {}) {
    this.serverRoot = resolve(serverRoot);
    this.webRoot = resolve(webRoot);
    this.runtimeRoot = runtimeRoot ? absolutePath(runtimeRoot, "Runtime directory") : join(this.serverRoot, "apps/desktop/.runtime/desktop-runtime");
    this.onExit = onExit;
    this.onProgress = onProgress;
    this.postgresFactory = postgresFactory;
    this.children = new Map();
    this.reservations = new Map();
    this.postgres = null;
    this.logs = "";
    this.secrets = [];
    this.redactionBuffers = new Map();
    this.stopping = false;
    this.stopPromise = null;
    this.startPromise = null;
    this.cleanupPromise = null;
    this.controller = null;
    this.ready = false;
    this.failure = "";
    this.token = "";
    this.workerStarted = false;
  }

  get child() { return [...this.children.values()].find(ownsLiveProcess) || null; }
  get processCount() {
    return [...this.children.values()].filter(ownsLiveProcess).length + (this.postgres?.ownedProcessCount ?? (this.postgres?.running ? 1 : 0));
  }
  get running() { return Boolean(this.startPromise || this.processCount || this.postgres?.running); }
  diagnostic() { return this.logs; }

  redact(value) {
    let text = String(value);
    for (const secret of this.secrets) if (secret) text = text.replaceAll(secret, "[credential redacted]");
    return text;
  }

  record(role, chunk, flush = false) {
    const raw = (this.redactionBuffers.get(role) || "") + chunk.toString();
    const overlap = Math.max(1, ...this.secrets.map((secret) => secret.length)) - 1;
    let boundary = flush ? raw.length : Math.max(0, raw.length - overlap);
    // Do not cut a known credential across the emitted prefix and retained tail.
    for (const secret of this.secrets) {
      if (!secret) continue;
      let at = raw.indexOf(secret);
      while (at !== -1 && at < boundary) {
        if (at + secret.length > boundary) boundary = at;
        at = raw.indexOf(secret, at + 1);
      }
    }
    const text = this.redact(raw.slice(0, boundary));
    this.redactionBuffers.set(role, raw.slice(boundary));
    if (text) this.logs = (this.logs + `[${role}] ${text}`).slice(-32_768);
  }

  progress(message) { this.onProgress?.(message); }
  assertActive() {
    if (this.stopping || this.controller?.signal.aborted) throw this.failure ? new Error(this.failure) : cancellation();
  }

  start(configuration) {
    if (this.running || this.stopPromise && this.stopping) return Promise.reject(new Error("Local services are already running or stopping."));
    this.stopping = false;
    this.stopPromise = null;
    this.failure = "";
    this.ready = false;
    this.logs = "";
    this.workerStarted = false;
    this.redactionBuffers.clear();
    this.secrets = typeof configuration.setup?.password === "string" && configuration.setup.password ? [configuration.setup.password] : [];
    this.controller = new AbortController();
    const pending = this.startManaged(configuration);
    this.startPromise = pending;
    void pending.finally(() => { if (this.startPromise === pending) this.startPromise = null; }).catch(() => {});
    return pending;
  }

  async reserveServicePorts(dataDir) {
    const metadata = await acquireServicePorts(dataDir, this.reservations, () => this.assertActive());
    this.secrets.push(metadata.serviceSecret);
    return metadata;
  }

  async startManaged(configuration) {
    try {
      const dataDir = absolutePath(configuration.dataDir, "Data directory");
      const projectRoot = configuration.projectRoot ? absolutePath(configuration.projectRoot, "Project root") : join(dataDir, "projects");
      if (relative(join(dataDir, "projects"), projectRoot) !== "" && !(await stat(projectRoot).catch(() => null))?.isDirectory()) throw new Error(`Project folder does not exist: ${projectRoot}. Select an existing project folder.`);
      const node = configuration.nodePath ? absolutePath(configuration.nodePath, "Node executable") : join(this.runtimeRoot, "node", ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]));
      const entries = {
        bootstrap: join(this.serverRoot, "apps/desktop/src/backend/bootstrap.ts"),
        pm: join(this.serverRoot, "apps/server/pm/src/main.ts"),
        worker: join(this.serverRoot, "apps/server/worker/src/main.ts"),
        agent: join(this.serverRoot, "apps/server/agent/dist/index.mjs"),
        gateway: join(this.serverRoot, "apps/server/gateway.ts"),
      };
      const ccSwitchEntry = join(this.serverRoot, "apps/server/agent/dist/cc-switch/host/main.mjs");
      await access(ccSwitchEntry).catch(() => { throw new Error("Bundled configuration service is missing. Rebuild or reinstall the application."); });
      for (const file of [...Object.values(entries), join(this.webRoot, "index.html")]) {
        await access(file).catch(() => { throw new Error(`Missing application asset: ${file}. Build the complete desktop runtime or reinstall the application.`); });
        this.assertActive();
      }
      await access(node).catch(() => { throw new Error("Bundled Node runtime is missing. Prepare the desktop runtime in development or reinstall the application."); });
      const createdDataDirectory = await mkdir(dataDir, { recursive: true, mode: 0o700 });
      this.assertActive();
      // Refuse unknown data before changing its permissions or writing metadata.
      const existing = await readdir(dataDir);
      if (existing.length && !existing.includes("service-ports.json")) throw new Error("Managed service port metadata is missing. Select a new empty desktop data directory or restore the complete instance.");
      await ensurePrivateDirectory(dataDir, { newlyCreated: createdDataDirectory !== undefined });
      this.assertActive();
      const ports = await this.reserveServicePorts(dataDir);
      this.progress("Checking bundled Node runtime…");
      let runtime;
      try {
        const output = await this.runNode("runtime", node, ["--eval", "if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Node 24 is required'); require('node:sqlite'); console.log(JSON.stringify({version:process.version,executable:process.execPath}))"], { cwd: dataDir, env: systemEnvironment() }, 15_000);
        runtime = JSON.parse(output.trim());
        if (!runtime.version.startsWith("v24.") || typeof runtime.executable !== "string") throw new Error("Invalid runtime identity");
      } catch (error) {
        this.assertActive();
        throw new Error(`Cannot use the bundled Node 24 runtime. Reinstall or prepare the matching desktop runtime. ${this.redact(error.message)}`);
      }
      this.assertActive();
      this.progress("Starting managed PostgreSQL…");
      this.postgres = this.postgresFactory({
        dataDir, binariesDir: join(this.runtimeRoot, "postgres"),
        onExit: () => this.unexpectedExit("postgres"),
        onProgress: (message) => this.progress(message),
      });
      const database = await this.postgres.start();
      if (typeof database.databaseUrl !== "string" || !database.databaseUrl) throw new Error("Managed PostgreSQL returned an invalid connection identity.");
      this.secrets.push(database.databaseUrl);
      try {
        const password = new URL(database.databaseUrl).password;
        if (password) this.secrets.push(password, decodeURIComponent(password));
      } catch { throw new Error("Managed PostgreSQL returned an invalid connection identity."); }
      this.assertActive();
      await bindServicePorts(dataDir, database.instanceId);
      this.assertActive();
      for (const directory of [join(dataDir, "projects"), join(dataDir, "agent-data"), join(dataDir, "chat-spaces"), join(dataDir, "runtime-home")]) {
        await ensurePrivateDirectory(directory);
        this.assertActive();
      }
      const origin = `http://127.0.0.1:${ports.public}`;
      const pmUrl = `http://127.0.0.1:${ports.pm}`;
      const agentUrl = `http://127.0.0.1:${ports.agent}`;
      this.token = randomBytes(48).toString("base64url");
      this.secrets.push(this.token);
      const common = {
        ...systemEnvironment(), NODE_ENV: "production", PM_DESKTOP_MANAGED: "1",
        PATH: [dirname(runtime.executable), process.env.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
        HOME: join(dataDir, "runtime-home"), USERPROFILE: join(dataDir, "runtime-home"),
      };
      const storage = {
        LOCAL_PROJECT_CONFIG: join(dataDir, "local-projects.json"), LOCAL_PROJECTS_ENABLED: "true",
        LOCAL_DATA_ROOT: dataDir, LOCAL_PROJECT_ALLOWED_ROOTS: JSON.stringify([...new Set([join(dataDir, "projects"), projectRoot])]),
        LOCAL_PROJECT_DEFAULT_PARENT: projectRoot, LOCAL_BACKUP_ROOT: join(dataDir, "backups"),
        CORE_WORKSPACE_ROOT: join(dataDir, "pm-workspaces"), PM_CHAT_SPACE_ROOT: join(dataDir, "chat-spaces"),
      };
      const service = { PM_API_URL: pmUrl, PM_AUTOMATION_SERVICE_SECRET: ports.serviceSecret, PM_AUTOMATION_AGENT_URL: agentUrl, PM_MCP_AGENT_URL: agentUrl };
      this.progress("Preparing local workspace storage and accounts…");
      const initialized = JSON.parse((await this.runNode("bootstrap", runtime.executable, ["--conditions=development", entries.bootstrap], {
        cwd: dataDir, env: { ...common, ...storage, BLOB_PROVIDER: "local", BLOB_ROOT: join(dataDir, "blobs") },
      }, BOOTSTRAP_DEADLINE, { databaseUrl: database.databaseUrl, dataDir, projectRoot, ...(configuration.setup ? { setup: configuration.setup } : {}) })).trim());
      if (typeof initialized.userId !== "string" || !UUID.test(initialized.userId) || typeof initialized.workspaceId !== "string" || !UUID.test(initialized.workspaceId) || typeof initialized.initialized !== "boolean" || initialized.instanceId && initialized.instanceId !== database.instanceId) throw new Error("Managed database bootstrap returned an invalid account/workspace identity.");
      this.assertActive();
      const environments = {
        worker: { ...common, ...storage, ...service, DATABASE_URL: database.databaseUrl, PUBLIC_ORIGIN: origin },
        pm: { ...common, ...storage, ...service, DATABASE_URL: database.databaseUrl, HOST: "127.0.0.1", PORT: String(ports.pm), PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", BLOB_PROVIDER: "local", BLOB_ROOT: join(dataDir, "blobs") },
        agent: {
          ...common, ...service,
          ...Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
          HOST: "127.0.0.1", PORT: String(ports.agent),
          AGENT_WORKSPACE_API_ONLY: "1", AGENT_WORKSPACE_DATA_DIR: join(dataDir, "agent-data"),
          CC_SWITCH_HOST_ENTRY: ccSwitchEntry,
          AGENT_WORKSPACE_PROJECT_ROOT: projectRoot, AGENT_WORKSPACE_WEB_DIST: this.webRoot, AGENT_WORKSPACE_ACCESS_TOKEN: this.token,
          PM_CHAT_SPACE_ROOT: join(dataDir, "chat-spaces"),
        },
        gateway: { ...common, PUBLIC_HOST: "127.0.0.1", PUBLIC_PORT: String(ports.public), PM_URL: pmUrl, AGENT_URL: agentUrl, WEB_DIST: this.webRoot },
      };
      this.progress("Starting local workspace services…");
      for (const role of SERVICE_ROLES) {
        this.assertActive();
        const reservationRole = role === "gateway" ? "public" : role;
        await closeReservation(this.reservations.get(reservationRole));
        this.reservations.delete(reservationRole);
        this.assertActive();
        this.track(role, spawnOwned(runtime.executable, ["--conditions=development", "--input-type=module", "--eval", serviceEntry, entries[role]], { cwd: dataDir, env: environments[role] }), true);
      }
      this.progress("Waiting for database, storage, worker, Agent and Web readiness…");
      await this.waitForReadiness({ origin, pmUrl, agentUrl });
      this.assertActive();
      this.ready = true;
      this.progress("Local workspace is ready.");
      return { origin, token: this.token, runtime: runtime.version, instanceId: database.instanceId };
    } catch (error) {
      const message = this.redact(error.message || error);
      let cleanupError;
      try { await this.cleanup(); } catch (failure) { cleanupError = failure; }
      throw new Error(cleanupError ? `${message} Cleanup also failed: ${this.redact(cleanupError.message)}` : message);
    }
  }

  track(role, child, service = false) {
    this.children.set(role, child);
    let workerOutput = "";
    child.stdout.on("data", (chunk) => {
      this.record(role, chunk);
      if (role !== "worker" || this.workerStarted) return;
      workerOutput += chunk.toString();
      let boundary;
      while ((boundary = workerOutput.indexOf("\n")) !== -1) {
        const line = workerOutput.slice(0, boundary); workerOutput = workerOutput.slice(boundary + 1);
        try { if (JSON.parse(line).event === "worker_started") this.workerStarted = true; } catch { /* Non-event output is diagnostic only. */ }
      }
      workerOutput = workerOutput.slice(-8192);
    });
    child.stderr.on("data", (chunk) => this.record(role, chunk));
    child.once("error", () => { if (service) this.unexpectedExit(role); });
    child.once("exit", () => { if (service) this.unexpectedExit(role); });
    child.once("close", () => this.record(role, "", true));
    return child;
  }

  unexpectedExit(role) {
    if (this.stopping || this.cleanupPromise) return;
    this.failure ||= `${role} exited unexpectedly. See the local service diagnostics.`;
    this.controller?.abort();
    if (this.ready) {
      this.ready = false;
      const notify = () => this.onExit?.(this.failure, this.diagnostic());
      void this.stop().then(notify, (error) => {
        this.record("shutdown", this.redact(error.message), true);
        this.failure += " Owned shutdown failed; disconnect again before quitting.";
        notify();
      }).catch(() => {});
    }
  }

  async runNode(role, node, args, options, timeout, input) {
    this.assertActive();
    const child = this.track(role, spawnOwned(node, args, options));
    let output = "";
    const result = new Promise((done, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.length > 262_144) reject(new Error(`${role} output exceeded its limit.`));
      });
      child.once("error", () => reject(new Error(`${role} helper could not start.`)));
      child.once("close", (code, signal) => code === 0 ? done(output) : reject(new Error(`${role} helper failed (${signal || code}). See the local service diagnostics.`)));
    });
    const signal = this.controller.signal;
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(cancellation());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    if (input !== undefined) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
    try { return await bounded(Promise.race([result, aborted]), timeout, `${role} helper did not complete within ${Math.round(timeout / 1000)} seconds.`); }
    finally {
      signal.removeEventListener("abort", abort);
      await stopOwned(child, { force: true });
      if (!ownsLiveProcess(child)) this.children.delete(role);
    }
  }

  async waitForReadiness({ origin, pmUrl, agentUrl }) {
    const deadline = Date.now() + STARTUP_DEADLINE;
    let last = "Waiting for service listeners.";
    while (Date.now() < deadline) {
      this.assertActive();
      try {
        const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(1500)]);
        const requests = [
          [`${pmUrl}/health/ready`], [`${origin}/health/ready`],
          [`${agentUrl}/api/access`, true], [`${origin}/agent/api/access`, true],
          [`${agentUrl}/api/access`], [`${origin}/pm`], [`${origin}/agent/workspace`],
        ];
        const responses = await Promise.all(requests.map(async ([url, authenticated]) => {
          const response = await fetch(url, { signal, redirect: "error", headers: authenticated ? { authorization: `Bearer ${this.token}` } : {} });
          const text = await response.text();
          let value; try { value = JSON.parse(text); } catch { /* Web responses are HTML. */ }
          return { ok: response.ok, status: response.status, type: response.headers.get("content-type"), value };
        }));
        const healthReady = (response) => response.value?.status === "ready" && ["database", "storage", "worker", "core"].every((key) => response.value.checks?.[key] === true) && response.value.checks.quarantinedEvents === 0;
        const agentReady = (response) => response.value?.authorized === true && response.value?.configured === true;
        if (responses.every((response) => response.ok) && healthReady(responses[0]) && healthReady(responses[1]) && agentReady(responses[2]) && agentReady(responses[3]) && responses[4].value?.authorized === false && responses[4].value?.configured === true && responses[5].type?.includes("text/html") && responses[6].type?.includes("text/html") && this.workerStarted && SERVICE_ROLES.every((role) => ownsLiveProcess(this.children.get(role))) && this.postgres?.running && !this.failure) return;
        last = `HTTP readiness statuses: ${responses.map((response) => response.status).join("/")}; worker startup ${this.workerStarted ? "confirmed" : "pending"}.`;
      } catch (error) {
        this.assertActive();
        last = `Waiting for local service listeners: ${this.redact(error.message)}`;
      }
      await delay(250, undefined, { signal: this.controller.signal }).catch(() => {});
    }
    throw new Error(`Local services did not become ready within ${STARTUP_DEADLINE / 1000} seconds. ${last}`);
  }

  async releaseReservations() {
    const reservations = [...this.reservations.values()];
    this.reservations.clear();
    await Promise.all(reservations.map(closeReservation));
  }

  cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    const pending = (async () => {
      this.ready = false;
      const errors = [];
      try { await this.releaseReservations(); }
      catch (error) { errors.push(`Port reservations: ${error.message}`); }
      for (const role of [...STOP_ORDER, ...this.children.keys()].filter((role, index, roles) => roles.indexOf(role) === index)) {
        const child = this.children.get(role);
        if (!child) continue;
        try { await stopOwned(child, { force: !SERVICE_ROLES.includes(role) }); }
        catch (error) { errors.push(`${role}: ${error.message}`); }
        if (!ownsLiveProcess(child)) this.children.delete(role);
      }
      // Database is always last: Worker and PM can finish their transactions.
      if (this.postgres && !this.child) {
        try { await bounded(this.postgres.stop(), 75_000, "Managed PostgreSQL is still shutting down; the instance remains owned. Retry Stop."); }
        catch (error) { errors.push(error.message); }
        if (!this.postgres.running && !this.postgres.ownedProcessCount) this.postgres = null;
      }
      else if (this.postgres) errors.push("Managed PostgreSQL remains running until every owned application process has exited.");
      this.token = "";
      if (errors.length) throw new Error(this.redact(errors.join(" ")));
      if (this.processCount || this.postgres?.running) throw new Error("Owned local processes are still running; desktop has not disconnected safely.");
      this.secrets = [];
      this.redactionBuffers.clear();
    })();
    this.cleanupPromise = pending;
    void pending.finally(() => { if (this.cleanupPromise === pending) this.cleanupPromise = null; }).catch(() => {});
    return pending;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.ready = false;
    this.controller?.abort();
    const starting = this.startPromise;
    const pending = bounded((async () => {
      // Cleanup reaches a PG-only startup immediately, and otherwise keeps the
      // database alive until every application role has finished.
      await this.cleanup();
      if (starting) await starting.catch(() => {});
      await this.cleanup();
      this.stopping = false;
    })(), SHUTDOWN_DEADLINE, "Local shutdown exceeded its deadline; owned processes may still be running.");
    this.stopPromise = pending;
    void pending.catch(() => { if (this.stopPromise === pending) this.stopPromise = null; });
    return pending;
  }
}

// Real integration entry point: parent supplies its PM login/workspace exercise;
// teardown is guaranteed even if an assertion or startup fails. No fake backend.
export async function withLocalServer(options, configuration, exercise) {
  const server = new LocalServer(options);
  try { return await exercise(await server.start(configuration), server); }
  finally { await server.stop(); }
}

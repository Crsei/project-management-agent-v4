import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, delimiter } from "node:path";
import { Client } from "pg";
import { assertPrivatePath, ensurePrivateDirectory, readPrivateJson, securePrivateFile, writePrivateJson } from "./private-state.mjs";
import { assertOwnedProcess, assertProcessIdentity, readProcessIdentity, rememberOwnedProcess, sameProcessIdentity } from "./process-identity.mjs";
export { ensurePrivateDirectory } from "./private-state.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const shutdownSeconds = 60;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
const samePath = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = resolve(left), b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};

export function validateManagedPostgresState(value) {
  const keys = ["formatVersion", "postgresMajor", "instanceId", "username", "password", "port", "phase"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.formatVersion !== 1 || value.postgresMajor !== 16 || typeof value.instanceId !== "string" || !uuid.test(value.instanceId) || typeof value.password !== "string" || !/^[a-f0-9]{64}$/.test(value.password) || value.username !== "desktop" || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !["initializing", "ready"].includes(value.phase)) throw new Error("Invalid managed PostgreSQL metadata or unsupported major version");
  return value;
}
export async function readManagedPostgresState(dataDir) {
  const state = await readPrivateJson(join(dataDir, "managed-postgres.json"));
  if (!state) throw new Error("Managed PostgreSQL ownership metadata is missing");
  return validateManagedPostgresState(state);
}

async function unusedPort(excluded = []) {
  for (;;) {
    const server = createServer();
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const port = server.address().port;
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    if (!excluded.includes(port)) return port;
  }
}
async function assertPortFree(port) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", () => reject(new Error("Managed PostgreSQL port is already in use; refusing another server")));
    server.listen(port, "127.0.0.1", done);
  });
  await new Promise(done => server.close(done));
}

/** Owns one private PG16 cluster. Never connects to repository or system credentials. */
export class ManagedPostgres {
  /**
   * @param {{ dataDir: string, binariesDir: string,
   * onExit?: (event: { role: "postgres", code: number | null, signal: NodeJS.Signals | null }) => void,
   * onProgress?: (event: { role: "postgres", message: string }) => void }} options
   */
  constructor({ dataDir, binariesDir, onExit, onProgress }) {
    this.dataDir = resolve(dataDir);
    this.binariesDir = resolve(binariesDir);
    this.clusterDir = join(this.dataDir, "postgres");
    this.onExit = onExit;
    this.onProgress = onProgress;
    this.child = null;
    this.children = new Set();
    this.windowsPid = null;
    this.serverIdentity = null;
    this.windowsMonitor = null;
    this.windowsLaunchPending = false;
    this.ready = false;
    this.cancelled = false;
    this.starting = null;
    this.stopping = null;
    this.lock = null;
    this.state = null;
  }
  get running() { return this.ownedProcessCount > 0; }
  get ownedProcessCount() { return this.children.size + (this.windowsPid !== null || this.windowsLaunchPending ? 1 : 0); }
  binary(name) { return join(this.binariesDir, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`); }
  environment() {
    // Do not honor a shell's PG*, dynamic-loader injection or user pgpass settings.
    const env = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "TZ"]) if (process.env[key]) env[key] = process.env[key];
    env.PATH = [join(this.binariesDir, "bin"), process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin"].join(delimiter);
    env.HOME = this.dataDir;
    env.USERPROFILE = this.dataDir;
    if (process.platform === "linux") env.LD_LIBRARY_PATH = join(this.binariesDir, "lib");
    if (process.platform === "darwin") env.DYLD_LIBRARY_PATH = join(this.binariesDir, "lib");
    return env;
  }
  checkCancelled() { if (this.cancelled) throw new Error("Managed PostgreSQL startup cancelled"); }
  progress(message) { this.onProgress?.({ role: "postgres", message }); }
  async command(name, args, { timeout = 30_000, cancelable = true, captureOutput = false } = {}) {
    if (cancelable) this.checkCancelled();
    const child = rememberOwnedProcess(spawn(this.binary(name), args, { cwd: this.dataDir, env: this.environment(), windowsHide: true, stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore" }));
    this.children.add(child);
    return new Promise((done, reject) => {
      let output = "";
      if (captureOutput) {
        const capture = bytes => { if (output.length < 16_384) output += bytes.toString("utf8").slice(0, 16_384 - output.length); };
        child.stdout.on("data", capture); child.stderr.on("data", capture);
      }
      const timer = setTimeout(() => reject(new Error(`Managed PostgreSQL ${name} timed out. Its process remains owned; no force kill was attempted.`)), timeout);
      child.once("error", () => { clearTimeout(timer); this.children.delete(child); reject(new Error(`Managed PostgreSQL ${name} could not start`)); });
      child.once("close", code => {
        clearTimeout(timer); this.children.delete(child);
        if (code === 0) done(output);
        else reject(new Error(`Managed PostgreSQL ${name} failed${code === null ? " or timed out" : ` (exit ${code})`}`));
      });
    });
  }
  async acquireLock() {
    const path = join(this.dataDir, ".postgres-owner.json");
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await writePrivateJson(path, { formatVersion: 2, pid: process.pid, identity: readProcessIdentity(process.pid), token }, { exclusive: true }); this.lock = { path, token }; return; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await readPrivateJson(path);
        if (![1, 2].includes(owner?.formatVersion) || !Number.isInteger(owner.pid) || owner.pid < 1 || !uuid.test(owner.token ?? "")) throw new Error("Invalid managed PostgreSQL process ownership");
        if (owner.formatVersion === 2) {
          if (assertProcessIdentity(owner.identity)) throw new Error("Managed PostgreSQL is controlled by another running process");
        } else if (alive(owner.pid)) throw new Error("Managed PostgreSQL has legacy ownership held by a running or reused PID; close it normally before continuing");
        await unlink(path);
      }
    }
    throw new Error("Managed PostgreSQL ownership changed concurrently");
  }
  async releaseLock() {
    if (!this.lock) return;
    const lock = this.lock;
    const owner = await readPrivateJson(lock.path);
    if (owner?.token !== lock.token || owner.pid !== process.pid) throw new Error("Managed PostgreSQL controller ownership changed; retaining the lock for inspection.");
    await unlink(lock.path);
    this.lock = null;
    this.serverIdentity = null;
  }
  async prepareState() {
    let entries;
    try {
      const stat = await lstat(this.dataDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe managed PostgreSQL root");
      entries = await readdir(this.dataDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await ensurePrivateDirectory(this.dataDir); entries = [];
    }
    const hasState = entries.includes("managed-postgres.json");
    const ports = entries.includes("service-ports.json") ? await readPrivateJson(join(this.dataDir, "service-ports.json"), 4096) : null;
    if (entries.includes("service-ports.json") && !ports) throw new Error("Invalid managed desktop service ports");
    const reservedPorts = ports ? [ports.public, ports.pm, ports.agent] : [];
    if (ports && (Object.keys(ports).length !== 6 || ports.version !== 1 || (ports.instanceId !== null && (typeof ports.instanceId !== "string" || !uuid.test(ports.instanceId))) || typeof ports.serviceSecret !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(ports.serviceSecret) || reservedPorts.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(reservedPorts).size !== 3)) throw new Error("Invalid managed desktop service ports");
    if (!hasState) {
      if (entries.some(name => name !== "service-ports.json")) throw new Error("Refusing a nonempty directory without managed PostgreSQL ownership");
      if (ports && ports.instanceId !== null) throw new Error("Initial desktop ports do not belong to a new managed instance");
    }
    await ensurePrivateDirectory(this.dataDir);
    if (hasState) this.state = await readManagedPostgresState(this.dataDir);
    else {
      this.state = { formatVersion: 1, postgresMajor: 16, instanceId: randomUUID(), username: "desktop", password: randomBytes(32).toString("hex"), port: await unusedPort(reservedPorts), phase: "initializing" };
      await writePrivateJson(join(this.dataDir, "managed-postgres.json"), this.state, { exclusive: true });
    }
    await this.acquireLock();
    // Re-read after the process lock so no state written by a concurrent owner is used.
    this.state = await readManagedPostgresState(this.dataDir);
    if (ports && ((ports.instanceId !== null && ports.instanceId !== this.state.instanceId) || reservedPorts.includes(this.state.port))) throw new Error("Managed PostgreSQL conflicts with the saved desktop instance or service ports");
  }
  async clusterComplete(directory) {
    let stat;
    try { stat = await lstat(directory); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe managed PostgreSQL cluster directory");
    await assertPrivatePath(directory, true);
    const owner = await readPrivateJson(join(directory, ".desktop-instance.json"));
    if (!owner) return false;
    if (owner.formatVersion !== 1 || owner.instanceId !== this.state.instanceId || owner.postgresMajor !== 16) throw new Error("Managed PostgreSQL cluster ownership mismatch");
    const versionFile = join(directory, "PG_VERSION");
    const versionStat = await lstat(versionFile);
    if (!versionStat.isFile() || versionStat.isSymbolicLink() || versionStat.size > 16 || (await readFile(versionFile, "utf8")).trim() !== "16") throw new Error("PostgreSQL major version mismatch; automatic upgrades are forbidden");
    return true;
  }
  async initialize() {
    const stage = join(this.dataDir, `postgres-init-${this.state.instanceId}`);
    if (this.state.phase === "ready") {
      if (!(await this.clusterComplete(this.clusterDir))) throw new Error("Managed PostgreSQL cluster is missing or corrupt; refusing to recreate it");
      return;
    }
    let clusterExists = false;
    try { await lstat(this.clusterDir); clusterExists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (clusterExists) {
      if (!(await this.clusterComplete(this.clusterDir))) throw new Error("Unowned PostgreSQL cluster; refusing recovery");
    } else {
      let stageExists = false;
      try { await lstat(stage); stageExists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stageExists && !(await this.clusterComplete(stage))) {
        // Preserve an interrupted initdb verbatim; never recursively remove an unknown file.
        const stat = await lstat(stage);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe interrupted PostgreSQL initialization");
        try { await lstat(join(stage, "postmaster.pid")); throw new Error("An unowned PostgreSQL process state occupies the initialization directory"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await rename(stage, join(this.dataDir, `postgres-interrupted-${randomUUID()}`));
        stageExists = false;
      }
      if (!stageExists) {
        await ensurePrivateDirectory(stage);
        const passwordFile = join(this.dataDir, `.initdb-password-${this.state.instanceId}`);
        let password;
        let passwordOwned = false;
        try {
          // Only a file tied to this already-owned interrupted initialization may be reused.
          try { await assertPrivatePath(passwordFile); await unlink(passwordFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
          password = await open(passwordFile, "wx", 0o600);
          passwordOwned = true;
          await securePrivateFile(passwordFile, { newlyCreated: true });
          await password.writeFile(`${this.state.password}\n`); await password.sync(); await password.close(); password = null;
          this.progress("Initializing private PostgreSQL 16 database");
          await this.command("initdb", ["-D", stage, "--username=desktop", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", "--no-instructions"], { timeout: 120_000 });
          this.checkCancelled();
          await writePrivateJson(join(stage, ".desktop-instance.json"), { formatVersion: 1, postgresMajor: 16, instanceId: this.state.instanceId }, { exclusive: true });
        } finally { await password?.close().catch(() => undefined); if (passwordOwned) await unlink(passwordFile).catch(() => undefined); }
      }
      this.checkCancelled();
      await rename(stage, this.clusterDir);
    }
    this.state = { ...this.state, phase: "ready" };
    await writePrivateJson(join(this.dataDir, "managed-postgres.json"), this.state);
  }
  databaseUrl() {
    const url = new URL(`postgresql://127.0.0.1:${this.state.port}/postgres`);
    url.username = this.state.username; url.password = this.state.password;
    return url.toString();
  }
  createClient() {
    return new Client({ connectionString: this.databaseUrl(), ssl: false, options: "", connectionTimeoutMillis: 1_000, query_timeout: 1_000, application_name: "pm-desktop-owner" });
  }
  async identify(existingClient = null) {
    const client = existingClient ?? this.createClient();
    if (!existingClient) client.on("error", () => undefined);
    try {
      if (!existingClient) await client.connect();
      const result = await client.query("SELECT current_setting('data_directory') AS directory,current_setting('server_version_num') AS version");
      const row = result.rows[0];
      if (!samePath(row.directory, this.clusterDir) || Math.floor(Number(row.version) / 10_000) !== 16) throw new Error("Managed PostgreSQL server identity mismatch");
    } finally { if (!existingClient) await client.end().catch(() => undefined); }
  }
  async recordServerIdentity(pid) {
    const identity = readProcessIdentity(pid);
    if (!identity || !samePath(identity.executable, this.binary("postgres"))) throw new Error("Managed PostgreSQL executable identity mismatch");
    this.serverIdentity = identity;
    await writePrivateJson(join(this.dataDir, ".postgres-process.json"), { formatVersion: 1, instanceId: this.state.instanceId, clusterDir: this.clusterDir, identity });
  }
  async verifyServerIdentity(pid) {
    const record = await readPrivateJson(join(this.dataDir, ".postgres-process.json"));
    if (record?.formatVersion !== 1 || record.instanceId !== this.state.instanceId || !samePath(record.clusterDir, this.clusterDir) || record.identity?.pid !== pid || !samePath(record.identity.executable, this.binary("postgres"))) throw new Error("Managed PostgreSQL process creation ownership is missing or changed");
    if (this.serverIdentity && !sameProcessIdentity(this.serverIdentity, record.identity)) throw new Error("Managed PostgreSQL process ownership record changed");
    const current = assertProcessIdentity(record.identity);
    this.serverIdentity = record.identity;
    return current;
  }
  async recoverOwnedServer({ cancelable = true } = {}) {
    const pidFile = join(this.clusterDir, "postmaster.pid");
    let bytes;
    try {
      const stat = await lstat(pidFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Unsafe PostgreSQL process state");
      bytes = await readFile(pidFile, "utf8");
    } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const lines = bytes.split(/\r?\n/);
    const pid = Number(lines[0]);
    if (!Number.isInteger(pid) || pid < 1 || !samePath(lines[1], this.clusterDir) || Number(lines[3]) !== this.state.port) throw new Error("PostgreSQL process ownership mismatch");
    if (!alive(pid)) return; // PostgreSQL itself safely handles its stale pid file.
    if (!(await this.verifyServerIdentity(pid))) return;
    // A dead controller can leave its private server alive. Authenticate before touching it.
    let identified = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && alive(pid)) {
      if (cancelable) this.checkCancelled();
      try { await this.identify(); identified = true; break; }
      catch { await delay(100); }
    }
    if (!identified) throw new Error("An active foreign or unverifiable PostgreSQL server occupies this cluster");
    if (!(await this.verifyServerIdentity(pid))) return;
    await this.command("pg_ctl", ["stop", "-D", this.clusterDir, "-m", "fast", "-w", "-t", String(shutdownSeconds)], { timeout: (shutdownSeconds + 5) * 1000, cancelable });
  }
  async readWindowsPid() {
    const file = join(this.clusterDir, "postmaster.pid");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Unsafe PostgreSQL process state");
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const pid = Number(lines[0]);
    if (!Number.isInteger(pid) || pid < 1 || !samePath(lines[1], this.clusterDir) || Number(lines[3]) !== this.state.port) throw new Error("PostgreSQL process ownership mismatch");
    return pid;
  }
  async closeWindowsMonitor() {
    const client = this.windowsMonitor;
    this.windowsMonitor = null;
    await client?.end().catch(() => undefined);
  }
  async startWindows(serverOptions) {
    // pg_ctl uses PostgreSQL's restricted-token launcher on Windows. Direct
    // postgres.exe rejects an elevated desktop/runner token; never run it as admin.
    this.windowsLaunchPending = true;
    await this.command("pg_ctl", ["start", "-D", this.clusterDir, "-o", serverOptions.join(" "), "-l", "NUL", "-w", "-t", "30"], { timeout: 35_000 });
    this.windowsPid = await this.readWindowsPid();
    await this.recordServerIdentity(this.windowsPid);
    this.windowsLaunchPending = false;
    this.checkCancelled();
    const client = this.createClient();
    this.windowsMonitor = client;
    let failure = null;
    const disconnected = () => {
      if (this.windowsMonitor !== client) return;
      failure = new Error("Managed PostgreSQL ownership connection closed");
      const unexpected = this.ready && !this.cancelled;
      this.ready = false;
      if (this.windowsPid !== null && !alive(this.windowsPid)) this.windowsPid = null;
      if (unexpected) this.onExit?.({ role: "postgres", code: null, signal: null });
    };
    client.on("error", disconnected);
    client.on("end", disconnected);
    await client.connect();
    await this.identify(client);
    this.checkCancelled();
    if (failure) throw failure;
    this.ready = true;
    return { databaseUrl: this.databaseUrl(), port: this.state.port, instanceId: this.state.instanceId };
  }
  async stopWindowsOwnedProcess() {
    if (this.windowsLaunchPending) {
      // Let an in-flight pg_ctl start settle, then reconcile any uncertain launch
      // using the private pid file and authenticated database identity.
      if ([...this.children].some(child => child.spawnargs?.[0] === this.binary("pg_ctl") && child.spawnargs?.[1] === "start")) return;
      await this.recoverOwnedServer({ cancelable: false });
      this.windowsLaunchPending = false;
    }
    const pid = this.windowsPid;
    if (pid !== null && await this.verifyServerIdentity(pid)) {
      if (await this.readWindowsPid() !== pid) throw new Error("PostgreSQL shutdown ownership changed");
      await this.identify();
      if (!(await this.verifyServerIdentity(pid))) throw new Error("PostgreSQL identity changed during shutdown");
      try {
        await this.command("pg_ctl", ["stop", "-D", this.clusterDir, "-m", "fast", "-w", "-t", String(shutdownSeconds)], { timeout: (shutdownSeconds + 5) * 1000, cancelable: false });
      } catch {
        if (alive(pid)) throw new Error("Managed PostgreSQL is still shutting down. Ownership and data are retained; retry Stop instead of removing the instance.");
      }
      const deadline = Date.now() + 5_000;
      while (alive(pid) && Date.now() < deadline) await delay(50);
      if (alive(pid)) throw new Error("Managed PostgreSQL is still shutting down. Ownership and data are retained; retry Stop instead of removing the instance.");
    }
    this.windowsPid = null;
    await this.closeWindowsMonitor();
  }
  async start() {
    if (this.ready) return { databaseUrl: this.databaseUrl(), port: this.state.port, instanceId: this.state.instanceId };
    if (this.starting) return this.starting;
    if (this.stopping) await this.stopping;
    this.cancelled = false;
    this.starting = this.startInternal();
    try { return await this.starting; }
    finally { this.starting = null; }
  }
  async startInternal() {
    try {
      await this.prepareState(); this.checkCancelled();
      const version = await this.command("postgres", ["--version"], { captureOutput: true });
      if (!/\(PostgreSQL\) 16\./.test(version)) throw new Error("Managed desktop requires PostgreSQL 16 binaries; automatic upgrades are forbidden");
      await this.initialize(); this.checkCancelled();
      await this.recoverOwnedServer(); await assertPortFree(this.state.port); this.checkCancelled();
      this.progress("Starting private PostgreSQL 16 database");
      const serverOptions = ["-h", "127.0.0.1", "-p", String(this.state.port), "-c", "unix_socket_directories=", "-c", "password_encryption=scram-sha-256", "-c", "logging_collector=off", "-c", "log_statement=none", "-c", "log_min_error_statement=panic", "-c", "log_connections=off", "-c", "log_disconnections=off"];
      if (process.platform === "win32") return await this.startWindows(serverOptions);
      const child = rememberOwnedProcess(spawn(this.binary("postgres"), ["-D", this.clusterDir, ...serverOptions], { cwd: this.dataDir, env: this.environment(), windowsHide: true, stdio: "ignore" }));
      this.child = child; this.children.add(child);
      let failure = null;
      child.once("error", () => { failure = new Error("Managed PostgreSQL process could not start"); this.children.delete(child); if (this.child === child) this.child = null; });
      child.once("exit", (code, signal) => {
        this.children.delete(child);
        const unexpected = this.ready && !this.cancelled;
        this.ready = false;
        if (this.child === child) this.child = null;
        failure = new Error("Managed PostgreSQL exited before readiness");
        if (unexpected) this.onExit?.({ role: "postgres", code, signal });
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        this.checkCancelled(); if (failure) throw failure;
        try {
          await this.identify();
          assertOwnedProcess(child);
          await this.recordServerIdentity(child.pid);
          if (failure || child.exitCode !== null) throw failure ?? new Error("Managed PostgreSQL exited during readiness");
          this.checkCancelled(); this.ready = true;
          return { databaseUrl: this.databaseUrl(), port: this.state.port, instanceId: this.state.instanceId };
        } catch (error) { if (failure || this.cancelled) throw error; }
        await delay(100);
      }
      throw new Error("Managed PostgreSQL did not become ready within 30 seconds");
    } catch (error) {
      this.ready = false;
      try { await this.stopOwnedProcess(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Managed PostgreSQL startup failed and owned shutdown is not confirmed"); }
      await this.releaseLock();
      throw error;
    }
  }
  async stopOwnedProcess() {
    if (process.platform === "win32") return this.stopWindowsOwnedProcess();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // pg_ctl addresses only our marker-verified cluster, never a shared service or arbitrary PID.
    let stopped = false;
    let ownedPid = false;
    let ownershipError = null;
    const pidDeadline = Date.now() + 1_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < pidDeadline) {
      try {
        const pidFile = join(this.clusterDir, "postmaster.pid");
        const stat = await lstat(pidFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Unsafe PostgreSQL shutdown ownership");
        const lines = (await readFile(pidFile, "utf8")).split(/\r?\n/);
        if (Number(lines[0]) !== child.pid || !samePath(lines[1], this.clusterDir) || Number(lines[3]) !== this.state.port) throw new Error("PostgreSQL shutdown ownership changed");
        assertOwnedProcess(child);
        if (this.serverIdentity && !(await this.verifyServerIdentity(child.pid))) return;
        ownedPid = true;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") { ownershipError = error; break; }
        await delay(50);
      }
    }
    if (ownershipError) throw ownershipError;
    if (ownedPid && child.exitCode === null && child.signalCode === null) {
      try { await this.command("pg_ctl", ["stop", "-D", this.clusterDir, "-m", "fast", "-w", "-t", String(shutdownSeconds)], { timeout: (shutdownSeconds + 5) * 1000, cancelable: false }); stopped = true; }
      catch { /* A slow checkpoint must not turn a normal quit into a database crash. */ }
    }
    if (!stopped && !ownedPid && child.exitCode === null && child.signalCode === null && assertOwnedProcess(child)) child.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error("Managed PostgreSQL is still shutting down. Ownership and data are retained; retry Stop instead of removing the instance.");
    }
  }
  async stop() {
    this.cancelled = true; this.ready = false;
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      // Never terminate a pg_ctl checkpoint helper or use Windows TerminateProcess.
      for (const child of this.children) {
        if (child === this.child || child.spawnargs?.[0]?.endsWith(process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl")) continue;
        if (process.platform !== "win32" && child.exitCode === null && child.signalCode === null && assertOwnedProcess(child)) child.kill("SIGTERM");
      }
      await this.stopOwnedProcess();
      if (this.starting) await this.starting.catch(() => undefined);
      await this.stopOwnedProcess();
      const deadline = Date.now() + 5_000;
      while (this.children.size && Date.now() < deadline) await delay(50);
      if (this.children.size) throw new Error("Managed PostgreSQL helper shutdown timed out. Ownership is retained; no process was force-killed.");
      await this.releaseLock();
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}

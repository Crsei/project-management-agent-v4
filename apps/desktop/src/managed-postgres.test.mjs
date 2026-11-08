import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { Client } from "pg";
import { ManagedPostgres, validateManagedPostgresState } from "./managed-postgres.mjs";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "./private-state.mjs";
import { readProcessIdentity, sameProcessIdentity } from "./process-identity.mjs";

const binariesDir = process.env.PM_DESKTOP_TEST_POSTGRES_ROOT;
const sampleState = () => ({ formatVersion: 1, postgresMajor: 16, instanceId: randomUUID(), username: "desktop", password: randomBytes(32).toString("hex"), port: 25432, phase: "ready" });
async function isolated(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-managed-pg-")));
  const dataDir = join(root, "instance");
  const processes = [];
  t.after(async () => {
    for (const pg of processes) await pg.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, processes };
}

test("managed metadata rejects corrupt credentials, ownership, ports and major upgrades", () => {
  assert.equal(validateManagedPostgresState(sampleState()).postgresMajor, 16);
  for (const change of [{ postgresMajor: 17 }, { instanceId: "foreign" }, { password: "weak" }, { port: 543.2 }, { phase: "unknown" }, { instanceId: [randomUUID()] }, { password: ["a".repeat(64)] }, { unrecognized: true }]) {
    assert.throws(() => validateManagedPostgresState({ ...sampleState(), ...change }));
  }
});

test("command waits for buffered output to drain after process exit", { timeout: 10_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  await mkdir(dataDir);
  const pg = new ManagedPostgres({ dataDir, binariesDir: dataDir });
  processes.push(pg);
  pg.binary = () => process.execPath;
  const result = pg.command("version-probe", ["-e", "process.stdout.end('complete command output');"], { captureOutput: true });
  let settled = false;
  result.then(() => { settled = true; }, () => { settled = true; });
  const child = pg.children.values().next().value;
  // Readable mode holds real output in Node's buffer until the test consumes it.
  // Unlike descendant pipe inheritance, this boundary is portable to Windows.
  const holdOutput = () => {};
  child.stdout.on("readable", holdOutput);
  const closed = once(child, "close");
  try {
    await once(child, "exit");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "process exit must not truncate still-open command output");
  } finally {
    child.stdout.removeListener("readable", holdOutput);
    child.stdout.resume();
    await closed;
  }
  assert.equal(await result, "complete command output");
  assert.equal(pg.ownedProcessCount, 0);
});

test("command timeout does not kill the helper or discard its ownership", { timeout: 15_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  await mkdir(dataDir);
  const pg = new ManagedPostgres({ dataDir, binariesDir: dataDir });
  processes.push(pg);
  pg.binary = () => process.execPath;
  const pending = pg.command("slow-owned-helper", ["-e", "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('release-helper'))clearInterval(timer)},25);"], { timeout: 10 });
  const child = pg.children.values().next().value;
  const closed = once(child, "close");
  try {
    await assert.rejects(pending, /timed out.*remains owned.*no force kill/);
    assert.equal(pg.children.has(child), true);
    assert.equal(child.exitCode, null);
  } finally {
    await writeFile(join(dataDir, "release-helper"), "yes");
    await closed;
  }
  assert.equal(pg.ownedProcessCount, 0);
});

test("a reused controller PID and PostgreSQL creation identity refuse without signalling", async t => {
  const { dataDir, processes } = await isolated(t);
  await ensurePrivateDirectory(dataDir);
  const identity = readProcessIdentity(process.pid);
  const reused = { ...identity, creationTime: `${identity.creationTime}-reused` };
  const pg = new ManagedPostgres({ dataDir, binariesDir: dataDir });
  processes.push(pg);
  const owner = { formatVersion: 2, pid: process.pid, identity: reused, token: randomUUID() };
  await writePrivateJson(join(dataDir, ".postgres-owner.json"), owner);
  await assert.rejects(pg.acquireLock(), /reused|identity changed/);
  assert.deepEqual(await readPrivateJson(join(dataDir, ".postgres-owner.json")), owner);
  pg.state = sampleState();
  pg.binary = () => identity.executable;
  await ensurePrivateDirectory(pg.clusterDir);
  await writePrivateJson(join(dataDir, ".postgres-process.json"), { formatVersion: 1, instanceId: pg.state.instanceId, clusterDir: pg.clusterDir, identity: reused });
  await writeFile(join(pg.clusterDir, "postmaster.pid"), `${process.pid}\n${pg.clusterDir}\n0\n${pg.state.port}\n`, { mode: 0o600 });
  let identified = false;
  pg.identify = async () => { identified = true; };
  await assert.rejects(pg.recoverOwnedServer(), /reused|identity changed/);
  assert.equal(identified, false);
  assert.equal(sameProcessIdentity(readProcessIdentity(process.pid), identity), true);
});

test("unowned nonempty roots are preserved and never initialized", async t => {
  const { dataDir, processes } = await isolated(t);
  await mkdir(dataDir);
  await writeFile(join(dataDir, "important.txt"), "preserve");
  const pg = new ManagedPostgres({ dataDir, binariesDir: join(dataDir, "missing") });
  processes.push(pg);
  await assert.rejects(pg.start(), /nonempty directory without.*ownership/);
  assert.equal(await readFile(join(dataDir, "important.txt"), "utf8"), "preserve");
  assert.equal(pg.ownedProcessCount, 0);
  await pg.stop();
});

test("owned corrupt metadata never falls back to a new cluster", async t => {
  const { dataDir, processes } = await isolated(t);
  await ensurePrivateDirectory(dataDir);
  await writePrivateJson(join(dataDir, "managed-postgres.json"), { ...sampleState(), postgresMajor: 15 });
  const pg = new ManagedPostgres({ dataDir, binariesDir: join(dataDir, "missing") });
  processes.push(pg);
  await assert.rejects(pg.start(), /unsupported major/);
  assert.equal((await readPrivateJson(join(dataDir, "managed-postgres.json"))).postgresMajor, 15);
  await pg.stop();
});

test("real PG16 initializes, authenticates, restarts and preserves data", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  const pg = new ManagedPostgres({ dataDir, binariesDir });
  processes.push(pg);
  const first = await pg.start();
  assert.match(first.databaseUrl, /^postgresql:\/\//);
  assert.equal(pg.running, true);
  const client = new Client({ connectionString: first.databaseUrl });
  await client.connect();
  await client.query("CREATE TABLE desktop_restart_probe (id integer PRIMARY KEY, value text NOT NULL)");
  await client.query("INSERT INTO desktop_restart_probe VALUES (1,'preserved')");
  await client.end();
  await pg.stop();
  assert.equal(pg.ownedProcessCount, 0);
  const second = await pg.start();
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(second.port, first.port);
  assert.equal(second.databaseUrl, first.databaseUrl);
  const reconnected = new Client({ connectionString: second.databaseUrl });
  await reconnected.connect();
  assert.equal((await reconnected.query("SELECT value FROM desktop_restart_probe WHERE id=1")).rows[0].value, "preserved");
  await reconnected.end();
});

test("failed stop control retains the owned database and committed data instead of crashing PostgreSQL", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  const pg = new ManagedPostgres({ dataDir, binariesDir });
  processes.push(pg);
  const started = await pg.start();
  const client = new Client({ connectionString: started.databaseUrl });
  await client.connect();
  try {
    await client.query("CREATE TABLE shutdown_probe (value text NOT NULL)");
    await client.query("INSERT INTO shutdown_probe VALUES ('committed')");
  } finally { await client.end(); }
  const command = pg.command;
  pg.command = async function (name, args, options) {
    if (name === "pg_ctl" && args[0] === "stop") throw new Error("Control helper unavailable");
    return command.call(this, name, args, options);
  };
  try {
    await assert.rejects(pg.stop(), /still shutting down/);
    assert.equal(pg.running, true);
    const survivor = new Client({ connectionString: started.databaseUrl });
    await survivor.connect();
    try { assert.deepEqual((await survivor.query("SELECT value FROM shutdown_probe")).rows, [{ value: "committed" }]); }
    finally { await survivor.end(); }
  } finally { pg.command = command; }
  await pg.stop();
  assert.equal(pg.running, false);
});

test("real PG16 tampered creation ownership refuses shutdown and a restored record permits normal retry", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  const pg = new ManagedPostgres({ dataDir, binariesDir });
  processes.push(pg);
  await pg.start();
  const path = join(dataDir, ".postgres-process.json");
  const original = await readPrivateJson(path);
  await writePrivateJson(path, { ...original, identity: { ...original.identity, creationTime: `${original.identity.creationTime}-reused` } });
  await assert.rejects(pg.stop(), /ownership record changed|reused|identity changed/);
  assert.equal(pg.running, true);
  assert.ok(await readPrivateJson(join(dataDir, ".postgres-owner.json")));
  await writePrivateJson(path, original);
  await pg.stop();
  assert.equal(pg.running, false);
});

test("real PG16 refuses a saved port collision rather than using another server", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  const pg = new ManagedPostgres({ dataDir, binariesDir });
  processes.push(pg);
  const first = await pg.start();
  await pg.stop();
  const blocker = createServer(socket => socket.destroy());
  blocker.listen(first.port, "127.0.0.1");
  await once(blocker, "listening");
  try { await assert.rejects(pg.start(), /port is already in use/); }
  finally { await new Promise(done => blocker.close(done)); }
  assert.equal((await readPrivateJson(join(dataDir, "managed-postgres.json"))).port, first.port);
});

test("real PG16 unexpected exit after readiness is reported without credentials", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  let report;
  const exited = new Promise(done => { report = done; });
  const pg = new ManagedPostgres({ dataDir, binariesDir, onExit: report });
  processes.push(pg);
  const started = await pg.start();
  const pid = Number((await readFile(join(dataDir, "postgres", "postmaster.pid"), "utf8")).split(/\r?\n/)[0]);
  process.kill(pid, "SIGKILL");
  const event = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("PostgreSQL exit not reported")), 10_000); timer.unref(); })]);
  assert.equal(event.role, "postgres");
  assert.equal(pg.ready, false);
  assert.equal(JSON.stringify(event).includes(new URL(started.databaseUrl).password), false);
});

test("real PG16 missing/corrupt owned cluster and major mismatch never recreate data", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  const pg = new ManagedPostgres({ dataDir, binariesDir });
  processes.push(pg);
  await pg.start(); await pg.stop();
  const version = join(dataDir, "postgres", "PG_VERSION");
  await writeFile(version, "17\n");
  await assert.rejects(pg.start(), /major version mismatch/);
  assert.equal(await readFile(version, "utf8"), "17\n");
  await writeFile(version, "16\n");
  await unlink(join(dataDir, "postgres", ".desktop-instance.json"));
  await assert.rejects(pg.start(), /missing or corrupt/);
});

test("real initdb can be canceled without a later ready server", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const { dataDir, processes } = await isolated(t);
  let initializing;
  const startedInit = new Promise(done => { initializing = done; });
  const pg = new ManagedPostgres({ dataDir, binariesDir, onProgress: event => { if (event.message.startsWith("Initializing")) initializing(); } });
  processes.push(pg);
  const starting = pg.start();
  const rejection = assert.rejects(starting, /cancelled|initdb failed/);
  await startedInit;
  await pg.stop(); await rejection;
  assert.equal(pg.ready, false);
  assert.equal(pg.ownedProcessCount, 0);
  await pg.start();
  assert.equal(pg.ready, true);
});

test("real PG16 recovers an owned server after its controller crashes", { skip: !binariesDir, timeout: 180_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-managed-pg-controller-")));
  const dataDir = join(root, "instance");
  const source = `
    import { ManagedPostgres } from ${JSON.stringify(new URL("./managed-postgres.mjs", import.meta.url).href)};
    const pg = new ManagedPostgres({ dataDir: process.argv[1], binariesDir: process.argv[2] });
    const started = await pg.start();
    process.send({ instanceId: started.instanceId, port: started.port });
    setInterval(() => {}, 1000);
  `;
  const controller = spawn(process.execPath, ["--input-type=module", "--eval", source, dataDir, binariesDir], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  const pg = new ManagedPostgres({ dataDir, binariesDir });
  t.after(async () => {
    if (controller.exitCode === null && controller.signalCode === null) {
      const exited = once(controller, "exit");
      controller.kill("SIGKILL"); await exited;
    }
    // Recovery is also used for cleanup if an assertion interrupted the handover.
    if (!pg.ready) await pg.start();
    await pg.stop();
    await rm(root, { recursive: true, force: true });
  });
  const [original] = await Promise.race([
    once(controller, "message"),
    once(controller, "exit").then(() => { throw new Error("PostgreSQL controller exited before readiness"); }),
  ]);
  const exited = once(controller, "exit");
  controller.kill("SIGKILL"); await exited;
  const recovered = await pg.start();
  assert.equal(recovered.instanceId, original.instanceId);
  assert.equal(recovered.port, original.port);
  assert.equal(pg.ready, true);
});

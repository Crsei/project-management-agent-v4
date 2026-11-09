import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { bindServicePorts, LocalServer, prepareServicePorts } from "./local-server.mjs";

const instanceId = "11111111-2222-4333-8444-555555555555";
const userId = "22222222-2222-4333-8444-555555555555";
const workspaceId = "33333333-2222-4333-8444-555555555555";
const setup = { email: "desktop-fixture@example.invalid", password: "fixture-only-password-4738", name: "Desktop fixture", workspaceName: "Fixture workspace" };
const node24 = Number(process.versions.node.split(".")[0]) === 24;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate, message) {
  // Includes private ACL preparation and native Windows supervisor startup,
  // not just HTTP listener time. Keep the wait bounded on every platform.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(message);
}

async function fixture(t, behavior = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-v4-desktop-")));
  let server;
  t.after(async () => {
    // A failed cancellation assertion must not strand a blocking fixture.
    // The test itself never opens this escape hatch before asserting teardown.
    await writeFile(join(root, "release-bootstrap"), "yes");
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });
  const dataDir = join(root, "instance");
  const projectRoot = join(root, "selected-projects");
  await mkdir(projectRoot);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const bootstrap = `
import { appendFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
let text=''; for await (const chunk of process.stdin) text+=chunk;
const input=JSON.parse(text);
await writeFile(join(input.dataDir,'bootstrap-received.json'),JSON.stringify({ database:input.databaseUrl.startsWith('postgresql:'),projectRoot:input.projectRoot,setup:!!input.setup,keys:Object.keys(process.env) }));
if (${Boolean(behavior.blockBootstrap)}) {
  const source="const fs=require('node:fs'),http=require('node:http');const server=http.createServer((q,s)=>s.end('bootstrap-descendant'));const stop=()=>{clearInterval(timer);server.close(()=>process.exit(0))};const timer=setInterval(()=>{if(fs.existsSync('../release-bootstrap'))stop()},25);process.on('SIGTERM',stop);server.listen(0,'127.0.0.1',()=>console.log(server.address().port));";
  const nested=spawn(process.execPath,['--eval',source],{stdio:['ignore','pipe','inherit']});
  const port=await new Promise((done,reject)=>{nested.once('error',reject);nested.once('exit',()=>reject(new Error('Bootstrap descendant exited before readiness')));nested.stdout.once('data',chunk=>done(chunk.toString().trim()))});
  await writeFile(join(input.dataDir,'bootstrap-descendant-port'),port);
  await appendFile(join(input.dataDir,'events'),'bootstrap-started\\n');
  await new Promise(done=>{const timer=setInterval(()=>{if(existsSync('../release-bootstrap')){clearInterval(timer);done()}},25)});
} else await appendFile(join(input.dataDir,'events'),'bootstrap-started\\n');
if (input.setup) {
  const secret=input.setup.password;
  process.stderr.write('fixture secret '+secret.slice(0,7));
  await new Promise(done=>setTimeout(done,30));
  process.stderr.write(secret.slice(7)+'\\n');
}
console.log(JSON.stringify({instanceId:${JSON.stringify(instanceId)},userId:${JSON.stringify(userId)},workspaceId:${JSON.stringify(workspaceId)},initialized:true}));
`;
  const service = (role) => `
import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const role=${JSON.stringify(role)};
const digest=value=>value?createHash('sha256').update(value).digest('hex'):null;
const env=process.env;
const snapshot={ keys:Object.keys(env),cwd:process.cwd(),dataRoot:env.LOCAL_DATA_ROOT,coreRoot:env.CORE_WORKSPACE_ROOT,blobRoot:env.BLOB_ROOT,chatRoot:env.PM_CHAT_SPACE_ROOT,projectRoot:env.AGENT_WORKSPACE_PROJECT_ROOT,agentDataRoot:env.AGENT_WORKSPACE_DATA_DIR,ccSwitchEntry:env.CC_SWITCH_HOST_ENTRY,defaultParent:env.LOCAL_PROJECT_DEFAULT_PARENT,allowedRoots:env.LOCAL_PROJECT_ALLOWED_ROOTS?JSON.parse(env.LOCAL_PROJECT_ALLOWED_ROOTS):null,agentAllowedRoots:env.AGENT_WORKSPACE_ALLOWED_ROOTS?JSON.parse(env.AGENT_WORKSPACE_ALLOWED_ROOTS):null,serviceSecret:digest(env.PM_AUTOMATION_SERVICE_SECRET),agentToken:digest(env.AGENT_WORKSPACE_ACCESS_TOKEN),managed:env.PM_DESKTOP_MANAGED };
await writeFile(join(process.cwd(),role+'-environment.json'),JSON.stringify(snapshot));
await appendFile(join(process.cwd(),'events'),role+'-started\\n');
if (role===${JSON.stringify(behavior.failRole || "")}) process.exit(7);
let server, timer;
if(role==='worker') {
 console.log(JSON.stringify({event:'worker_started',id:'fixture-worker'})); timer=setInterval(()=>{},1000);
} else {
 server=http.createServer((req,res)=>{
  if(role==='gateway') {
   if(req.url.startsWith('/health/')||req.url.startsWith('/agent/api/')) {
    const agent=req.url.startsWith('/agent/');
    const target=new URL(agent?env.AGENT_URL:env.PM_URL);
    const request=http.request(target,{path:agent?req.url.slice(6):req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)});
    request.on('error',()=>{res.writeHead(502).end()});req.pipe(request);return;
   }
   res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><div id="root">desktop fixture</div>');return;
  }
  res.setHeader('content-type','application/json');
  if(role==='pm') {
   res.statusCode=${behavior.unready ? 503 : 200};
   res.end(JSON.stringify({status:${JSON.stringify(behavior.unready ? "not_ready" : "ready")},checks:{database:true,storage:true,worker:${!behavior.unready},core:true,quarantinedEvents:0}}));return;
  }
  res.end(JSON.stringify({authorized:req.headers.authorization==='Bearer '+env.AGENT_WORKSPACE_ACCESS_TOKEN,configured:env.AGENT_WORKSPACE_ACCESS_TOKEN.length>=32}));
 });
 server.listen(Number(role==='gateway'?env.PUBLIC_PORT:env.PORT),'127.0.0.1');
}
let stopping=false;
process.on('SIGTERM',async()=>{
 if(stopping)return;stopping=true;
 await appendFile(join(process.cwd(),'events'),role+'-stopped\\n');
 if(timer)clearInterval(timer);
 if(server)server.close(()=>process.exit(0));else process.exit(0);
});
`;
  const files = {
    "apps/desktop/src/backend/bootstrap.ts": bootstrap,
    "apps/server/pm/src/main.ts": service("pm"),
    "apps/server/worker/src/main.ts": service("worker"),
    "apps/server/agent/dist/index.mjs": service("agent"),
    "apps/server/agent/dist/cc-switch/host/main.mjs": "test-only presence fixture; this suite does not start the sidecar",
    "apps/server/gateway.ts": service("gateway"),
    "apps/web/dist/index.html": "<!doctype html><div id=\"root\">fixture</div>",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  const managers = [];
  const postgresEntered = deferred();
  const postgresFactory = () => {
    const waiting = deferred();
    let stopped = false;
    const manager = {
      running: false, ownedProcessCount: 0,
      async start() {
        this.running = true; this.ownedProcessCount = 1;
        postgresEntered.resolve();
        if (behavior.blockPostgres) await waiting.promise;
        if (stopped) throw new Error("Managed PostgreSQL startup was cancelled.");
        await appendFile(join(dataDir, "events"), "postgres-started\n");
        return { databaseUrl: "postgresql://desktop:fixture-only-database-password@127.0.0.1:6543/fixture", port: 6543, instanceId };
      },
      async stop() {
        if (stopped) return;
        stopped = true; this.running = false; this.ownedProcessCount = 0;
        waiting.resolve();
        await appendFile(join(dataDir, "events"), "postgres-stopped\n");
      },
    };
    managers.push(manager);
    return manager;
  };
  const options = { serverRoot: root, webRoot: join(root, "apps/web/dist"), runtimeRoot: join(root, "runtime") };
  const configuration = { dataDir, projectRoot, nodePath: process.execPath, setup };
  server = new LocalServer(options, { postgresFactory });
  return { root, dataDir, projectRoot, server, managers, postgresEntered, options, postgresFactory, configuration };
}

async function listenExternal(t, port) {
  const server = createServer((_request, response) => response.end("existing-development-service"));
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  t.after(() => new Promise((done) => server.close(done)));
  return server.address().port;
}

async function snapshot(directory, role) { return JSON.parse(await readFile(join(directory, `${role}-environment.json`), "utf8")); }

test("restore port preparation creates private independent identities and binds only one database", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-restore-ports-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const prepared = await prepareServicePorts(target);
  assert.match(prepared.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(Object.keys(prepared), ["origin"]);
  const initial = JSON.parse(await readFile(join(target, "service-ports.json"), "utf8"));
  assert.equal(initial.instanceId, null);
  assert.equal(new Set([initial.public, initial.pm, initial.agent]).size, 3);
  await bindServicePorts(target, instanceId);
  await bindServicePorts(target, instanceId);
  const bound = JSON.parse(await readFile(join(target, "service-ports.json"), "utf8"));
  assert.equal(bound.instanceId, instanceId);
  assert.equal(bound.public, initial.public);
  assert.equal(bound.serviceSecret === initial.serviceSecret, true);
  await assert.rejects(bindServicePorts(target, userId), /different managed database instance/);
  await assert.rejects(prepareServicePorts(target), /empty target directory/);
  const other = join(root, "other");
  await prepareServicePorts(other);
  const independent = JSON.parse(await readFile(join(other, "service-ports.json"), "utf8"));
  assert.equal(independent.serviceSecret !== initial.serviceSecret, true);
});

test("missing application assets never launch PostgreSQL or claim readiness", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-v4-desktop-missing-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let claimed = false;
  const server = new LocalServer({ serverRoot: root, webRoot: join(root, "web") }, { postgresFactory: () => { claimed = true; throw new Error("not allowed"); } });
  await assert.rejects(server.start({ dataDir: join(root, "data"), projectRoot: root, nodePath: process.execPath }));
  assert.equal(claimed, false);
  assert.equal(server.child, null);
  assert.equal(server.running, false);
  assert.equal(server.ready, false);
  await server.stop();
});

test("default runtime is bundled and missing runtime never falls back to a user's Node", { skip: !node24 }, async (t) => {
  const { server, configuration, managers } = await fixture(t);
  const bundled = { ...configuration };
  delete bundled.nodePath;
  await assert.rejects(server.start(bundled), /Bundled Node runtime is missing/);
  assert.equal(managers.length, 0);
  assert.equal(server.running, false);
});

test("fresh default project storage is created without creating an arbitrary missing custom folder", { skip: !node24 }, async (t) => {
  const f = await fixture(t);
  const projectRoot = join(f.dataDir, "projects");
  await f.server.start({ ...f.configuration, projectRoot });
  assert.equal((await lstat(projectRoot)).isDirectory(), true);
  await f.server.stop();
  const count = f.managers.length;
  const missing = join(f.root, "missing-custom-projects");
  await assert.rejects(f.server.start({ ...f.configuration, projectRoot: missing }), /Project folder does not exist/);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  assert.equal(f.managers.length, count);
  assert.equal(f.server.processCount, 0);
});

test("managed startup isolates roles, authenticates readiness, and retains origin and identity across restart", { skip: !node24 }, async (t) => {
  const f = await fixture(t);
  const original = {};
  const poison = { DATABASE_URL: "postgresql://foreign:never-read@127.0.0.1/dev", AWS_ACCESS_KEY_ID: "fixture-ambient-credential", OPENAI_API_KEY: "fixture-provider-token", NODE_OPTIONS: "--require=nonexistent-desktop-fixture" };
  for (const [key, value] of Object.entries(poison)) { original[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await writeFile(join(f.root, ".env"), "DATABASE_URL=not-a-database\n");
  await writeFile(join(f.root, ".env.worker"), "AWS_SECRET_ACCESS_KEY=must-never-be-loaded\n");
  await writeFile(join(f.root, ".env.agent"), "AGENT_WORKSPACE_ACCESS_TOKEN=must-never-be-loaded\n");
  const first = await f.server.start(f.configuration);
  assert.match(first.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(first.instanceId, instanceId);
  assert.match(first.runtime, /^v24\./);
  assert.equal(f.server.ready, true);
  assert.equal(f.server.processCount, 5);
  const roles = await Promise.all(["worker", "pm", "agent", "gateway"].map((role) => snapshot(f.dataDir, role)));
  for (const env of roles) {
    assert.equal(env.cwd, f.dataDir);
    assert.equal(env.managed, "1");
    for (const key of Object.keys(poison)) if (key !== "DATABASE_URL") assert.equal(env.keys.includes(key), false);
  }
  const [worker, pm, agent, gateway] = roles;
  for (const env of [worker, pm]) {
    assert.equal(env.dataRoot, f.dataDir);
    assert.equal(env.coreRoot, join(f.dataDir, "pm-workspaces"));
    assert.equal(env.chatRoot, join(f.dataDir, "chat-spaces"));
    assert.deepEqual(env.allowedRoots, [join(f.dataDir, "projects"), f.projectRoot]);
    assert.equal(env.defaultParent, f.projectRoot);
    assert.equal(env.keys.includes("DATABASE_URL"), true);
  }
  assert.equal(pm.blobRoot, join(f.dataDir, "blobs"));
  assert.equal(worker.keys.includes("BLOB_ROOT"), false);
  assert.equal(agent.keys.includes("DATABASE_URL"), false);
  assert.equal(agent.keys.includes("BLOB_ROOT"), false);
  assert.equal(agent.agentDataRoot, join(f.dataDir, "agent-data"));
  assert.equal(agent.ccSwitchEntry, join(f.root, "apps/server/agent/dist/cc-switch/host/main.mjs"));
  for (const env of [worker, pm, gateway]) assert.equal(env.ccSwitchEntry, undefined);
  assert.equal(agent.projectRoot, f.projectRoot);
  assert.deepEqual(agent.agentAllowedRoots, [...new Set([homedir(), join(f.dataDir, "projects"), f.projectRoot])]);
  for (const env of [worker, pm, gateway]) assert.equal(env.agentAllowedRoots, null);
  assert.equal(agent.chatRoot, join(f.dataDir, "chat-spaces"));
  assert.equal(gateway.keys.includes("DATABASE_URL"), false);
  assert.equal(gateway.keys.includes("PM_AUTOMATION_SERVICE_SECRET"), false);
  assert.equal(worker.serviceSecret, pm.serviceSecret);
  assert.equal(pm.serviceSecret, agent.serviceSecret);
  assert.equal(worker.agentToken, null);
  assert.equal(gateway.agentToken, null);
  const received = JSON.parse(await readFile(join(f.dataDir, "bootstrap-received.json"), "utf8"));
  assert.equal(received.database, true);
  assert.equal(received.setup, true);
  assert.equal(received.keys.includes("DATABASE_URL"), false);
  assert.doesNotMatch(f.server.diagnostic(), new RegExp(setup.password));
  assert.match(f.server.diagnostic(), /credential redacted/);
  await f.server.stop();
  assert.equal(f.server.running, false);
  assert.equal(f.server.processCount, 0);
  assert.equal(f.server.child, null);
  const events = (await readFile(join(f.dataDir, "events"), "utf8")).trim().split("\n");
  const order = ["gateway-stopped", "worker-stopped", "agent-stopped", "pm-stopped", "postgres-stopped"].map((event) => events.indexOf(event));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(order.every((index) => index >= 0), true);
  const reconnect = { ...f.configuration };
  delete reconnect.setup;
  const second = await f.server.start(reconnect);
  assert.equal(second.origin, first.origin);
  assert.equal(second.instanceId, first.instanceId);
  assert.notEqual(second.token, first.token);
  assert.equal((await snapshot(f.dataDir, "agent")).serviceSecret, agent.serviceSecret);
  await f.server.stop();
});

test("a saved public port conflict never starts PostgreSQL or stops the existing service", { skip: !node24 }, async (t) => {
  const f = await fixture(t);
  const started = await f.server.start(f.configuration);
  await f.server.stop();
  await listenExternal(t, Number(new URL(started.origin).port));
  const claims = f.managers.length;
  await assert.rejects(f.server.start(f.configuration), /Saved desktop public port .*unavailable/);
  assert.equal(f.managers.length, claims);
  assert.equal(await (await fetch(started.origin)).text(), "existing-development-service");
  assert.equal(f.server.running, false);
});

test("busy private role ports move independently while the saved public origin stays stable", { skip: !node24 }, async (t) => {
  const f = await fixture(t);
  const first = await f.server.start(f.configuration);
  await f.server.stop();
  const previous = JSON.parse(await readFile(join(f.dataDir, "service-ports.json"), "utf8"));
  await listenExternal(t, previous.pm);
  await listenExternal(t, previous.agent);
  const restarted = await f.server.start(f.configuration);
  const current = JSON.parse(await readFile(join(f.dataDir, "service-ports.json"), "utf8"));
  assert.equal(restarted.origin, first.origin);
  assert.notEqual(current.pm, previous.pm);
  assert.notEqual(current.agent, previous.agent);
  assert.equal(new Set([current.public, current.pm, current.agent]).size, 3);
  assert.equal(current.serviceSecret, previous.serviceSecret);
  assert.equal(await (await fetch(`http://127.0.0.1:${previous.pm}`)).text(), "existing-development-service");
  assert.equal(await (await fetch(`http://127.0.0.1:${previous.agent}`)).text(), "existing-development-service");
});

test("missing or corrupt owned port state is not silently regenerated", { skip: !node24 }, async (t) => {
  const f = await fixture(t);
  await f.server.start(f.configuration);
  await f.server.stop();
  const portFile = join(f.dataDir, "service-ports.json");
  const previous = await readFile(portFile, "utf8");
  await writeFile(portFile, "broken-json", { mode: 0o600 });
  await assert.rejects(f.server.start(f.configuration), /Corrupt desktop private metadata/);
  await rm(portFile);
  await assert.rejects(f.server.start(f.configuration), /service port metadata is missing/);
  await writeFile(portFile, previous, { mode: 0o600 });
  assert.equal(f.managers.length, 1);
});

test("stop cancels a PG-only startup and running includes the owned database", { skip: !node24 }, async (t) => {
  const f = await fixture(t, { blockPostgres: true });
  const started = f.server.start(f.configuration);
  const rejection = assert.rejects(started, /cancelled/i);
  await f.postgresEntered.promise;
  assert.equal(f.server.child, null);
  assert.equal(f.server.running, true);
  assert.equal(f.server.processCount, 1);
  await f.server.stop();
  await rejection;
  assert.equal(f.server.running, false);
  assert.equal(f.server.processCount, 0);
  assert.equal(f.server.children.size, 0);
});

test("stop during bootstrap cannot spawn application services after disconnect", { skip: !node24 }, async (t) => {
  const f = await fixture(t, { blockBootstrap: true });
  const started = f.server.start(f.configuration);
  const rejection = assert.rejects(started, /cancelled/i);
  await until(async () => (await readFile(join(f.dataDir, "events"), "utf8").catch(() => "")).includes("bootstrap-started"), "bootstrap did not enter");
  const bootstrap = f.server.children.get("bootstrap");
  assert.ok(bootstrap);
  assert.equal(bootstrap.stdin.writableEnded, true);
  const origin = `http://127.0.0.1:${await readFile(join(f.dataDir, "bootstrap-descendant-port"), "utf8")}`;
  assert.equal(await (await fetch(origin, { signal: AbortSignal.timeout(2000) })).text(), "bootstrap-descendant");
  await f.server.stop();
  await rejection;
  await delay(100);
  assert.equal(f.server.running, false);
  assert.equal(f.server.processCount, 0);
  assert.equal(bootstrap.desktopClosed, true);
  assert.equal(f.server.children.size, 0);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
  assert.doesNotMatch(await readFile(join(f.dataDir, "events"), "utf8"), /(?:worker|pm|agent|gateway)-started/);
});

test("partial startup failure stops every owned process before PostgreSQL", { skip: !node24 }, async (t) => {
  const f = await fixture(t, { failRole: "agent" });
  await assert.rejects(f.server.start(f.configuration), /agent exited unexpectedly/);
  assert.equal(f.server.ready, false);
  assert.equal(f.server.running, false);
  assert.equal(f.server.processCount, 0);
  const events = (await readFile(join(f.dataDir, "events"), "utf8")).trim().split("\n");
  assert.equal(events.at(-1), "postgres-stopped");
});

test("live HTTP listeners without worker/database readiness are never declared ready", { skip: !node24 }, async (t) => {
  const f = await fixture(t, { unready: true });
  let settled = false;
  const started = f.server.start(f.configuration);
  void started.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(started, /cancelled/i);
  await until(async () => {
    if (f.server.children.size !== 4) return false;
    const ports = JSON.parse(await readFile(join(f.dataDir, "service-ports.json"), "utf8"));
    try {
      const response = await fetch(`http://127.0.0.1:${ports.public}/health/ready`, { signal: AbortSignal.timeout(500) });
      const body = await response.json();
      return response.status === 503 && body.status === "not_ready" && body.checks.database === true && body.checks.worker === false;
    } catch { return false; }
  }, "application listeners did not return the explicit unready response");
  assert.equal(settled, false);
  assert.equal(f.server.ready, false);
  await f.server.stop();
  await rejection;
  assert.equal(f.server.running, false);
});

test("an unexpected running role exit reports only after owned teardown", { skip: !node24 }, async (t) => {
  const f = await fixture(t);
  const reported = deferred();
  f.server.onExit = (message) => reported.resolve({ message, count: f.server.processCount, running: f.server.running });
  await f.server.start(f.configuration);
  const agent = f.server.children.get("agent");
  agent.kill("SIGKILL");
  const result = await reported.promise;
  assert.match(result.message, /agent exited unexpectedly/);
  assert.equal(result.count, 0);
  assert.equal(result.running, false);
});

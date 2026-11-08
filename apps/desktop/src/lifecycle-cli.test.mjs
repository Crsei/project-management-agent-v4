import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadLifecycleRequest, readLifecycleArguments, runLifecycleRequest, stopRecoveredInstance } from "./lifecycle-cli.mjs";
import { assertPrivatePath, ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "./private-state.mjs";
import { ownsLiveProcess, serviceEntry, spawnOwned, stopOwned } from "./local-process.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-lifecycle-cli-")));
  await ensurePrivateDirectory(root, { newlyCreated: true });
  const installRoot = join(root, "installation");
  const userDataDir = join(root, "user-data");
  await mkdir(installRoot);
  await ensurePrivateDirectory(userDataDir);
  const stamp = Object.freeze({ commit: "a".repeat(40), source: Object.freeze({ sha256: "b".repeat(64) }), ownership: Object.freeze({ installation: "self" }), compatibility: Object.freeze({ dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) }) });
  const request = { formatVersion: 1, requestId: randomUUID(), operation: "stop", expectedInstallRoot: installRoot, expectedStamp: { commit: stamp.commit, sourceSha256: stamp.source.sha256 }, userDataDir, dataDir: join(userDataDir, "workspace"), consent: { stopLocalServices: true } };
  const args = { operation: "stop", requestFile: join(root, "request.json"), responseFile: join(root, "response.json") };
  const writeRequest = async change => { Object.assign(request, change); await writePrivateJson(args.requestFile, request); };
  await writeRequest({});
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  return { root, installRoot, stamp, userDataDir, request, args, writeRequest, cleanups, environment: { packaged: true, installRoot, stamp } };
}

test("packaged lifecycle requires a private source-bound request, not flags or runtime substitution", async t => {
  const f = await fixture(t);
  const argv = ["installed.exe", "--desktop-lifecycle", "stop", "--request-file", f.args.requestFile, "--response-file", f.args.responseFile];
  assert.deepEqual(readLifecycleArguments(argv), f.args);
  assert.equal(readLifecycleArguments(["installed.exe"]), null);
  assert.throws(() => readLifecycleArguments([...argv, "--no-sandbox"]), /cannot enable/);
  assert.throws(() => readLifecycleArguments([...argv, "--desktop-lifecycle", "stop"]), /Invalid/);
  await assert.rejects(loadLifecycleRequest(f.args, { ...f.environment, packaged: false }), /installed packaged/);
  const loaded = await loadLifecycleRequest(f.args, f.environment);
  assert.equal(loaded.request.userDataDir, f.userDataDir);
  await f.writeRequest({ expectedStamp: { ...f.request.expectedStamp, sourceSha256: "c".repeat(64) } });
  await assert.rejects(loadLifecycleRequest(f.args, f.environment), /source identity/);
  assert.equal(await readFile(f.args.requestFile, "utf8").then(value => value.includes("c".repeat(64))), true);
  await f.writeRequest({ expectedStamp: { commit: f.stamp.commit, sourceSha256: f.stamp.source.sha256 }, consent: {} });
  await assert.rejects(loadLifecycleRequest(f.args, f.environment), /consent/);
});

test("request links, nonprivate files, existing responses and cross-instance data refuse before actions", async t => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadLifecycleRequest({ ...f.args, requestFile: join(alias, "request.json"), responseFile: join(alias, "response.json") }, f.environment), /redirected/);
  if (process.platform !== "win32") {
    await chmod(f.args.requestFile, 0o644);
    await assert.rejects(loadLifecycleRequest(f.args, f.environment), /private/);
    await chmod(f.args.requestFile, 0o600);
  }
  await writePrivateJson(f.args.responseFile, { existing: true });
  await assert.rejects(loadLifecycleRequest(f.args, f.environment), /already exists/);
  await rm(f.args.responseFile);
  await f.writeRequest({ operation: "start-health", fixtureId: randomUUID(), dataDir: join(f.root, "foreign-data") });
  await assert.rejects(loadLifecycleRequest({ ...f.args, operation: "start-health" }, f.environment), /isolated/);
});

test("recovery never adopts or signals a listener selected only by saved port", async t => {
  const f = await fixture(t);
  await ensurePrivateDirectory(f.request.dataDir);
  const listener = createServer(socket => socket.end("foreign-service"));
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise(done => listener.close(done)));
  const port = listener.address().port;
  await writePrivateJson(join(f.request.dataDir, "service-ports.json"), { public: port, pm: port, agent: port });
  await assert.rejects(stopRecoveredInstance({ dataDir: f.request.dataDir, runtimeRoot: f.root }), /without this controller's ownership/);
  assert.equal(listener.listening, true);
});

test("failed real owned shutdown writes failure, retains ownership and allows an authenticated normal retry", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const script = join(f.root, "service.mjs");
  await writeFile(script, `import {existsSync} from 'node:fs';const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{if(existsSync('allow-stop'))clearInterval(timer)});console.log('ready');`);
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const child = spawnOwned(process.execPath, ["--input-type=module", "--eval", serviceEntry, script], { cwd: f.root, env });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.resume();
  f.cleanups.push(async () => { await writeFile(join(f.root, "allow-stop"), "yes"); await stopOwned(child); });
  const deadline = Date.now() + 20_000;
  while (!stdout.includes("ready") && child.exitCode === null && Date.now() < deadline) await delay(25);
  assert.match(stdout, /ready/);
  let quit = false;
  const host = { runtimeRoot: f.root, getServer: () => ({ running: ownsLiveProcess(child), processCount: ownsLiveProcess(child) ? 1 : 0 }), stop: () => stopOwned(child, { graceMs: 50 }), quit: async () => { quit = true; } };
  await runLifecycleRequest(await loadLifecycleRequest(f.args, f.environment), host);
  const failed = await readPrivateJson(f.args.responseFile);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Ownership is retained/);
  assert.equal(ownsLiveProcess(child), true);
  assert.equal(quit, false);
  await writeFile(join(f.root, "allow-stop"), "yes");
  f.args.responseFile = join(f.root, "retry-response.json");
  await f.writeRequest({ requestId: randomUUID() });
  await runLifecycleRequest(await loadLifecycleRequest(f.args, f.environment), host);
  const recovered = await readPrivateJson(f.args.responseFile);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.result, { stopped: true, remainingProcesses: 0 });
  assert.equal(quit, true);
});

test("incompatible upgrade is refused before any stop, while identical compatibility permits normal preinstall", async t => {
  const f = await fixture(t);
  f.args.operation = "preinstall";
  await f.writeRequest({ operation: "preinstall", candidateCompatibility: { ...f.stamp.compatibility, migrationsSha256: "d".repeat(64) } });
  let stopped = 0, quit = false;
  const host = { runtimeRoot: f.root, getServer: () => null, stop: async () => { stopped++; }, quit: async () => { quit = true; } };
  await runLifecycleRequest(await loadLifecycleRequest(f.args, f.environment), host);
  assert.equal((await readPrivateJson(f.args.responseFile)).ok, false);
  assert.equal(stopped, 0);
  assert.equal(quit, false);
  f.args.responseFile = join(f.root, "compatible-response.json");
  await f.writeRequest({ requestId: randomUUID(), candidateCompatibility: f.stamp.compatibility });
  await runLifecycleRequest(await loadLifecycleRequest(f.args, f.environment), host);
  assert.equal((await readPrivateJson(f.args.responseFile)).ok, true);
  assert.equal(stopped, 1);
  assert.equal(quit, true);
});

test("a never-launched code-only installation preserves genuine absent target roots", async t => {
  const f = await fixture(t);
  await rm(f.userDataDir, { recursive: true });
  const context = await loadLifecycleRequest(f.args, f.environment);
  assert.equal(context.userDataAbsent, true);
  assert.notEqual(context.controllerUserDataDir, f.userDataDir);
  await assertPrivatePath(context.controllerUserDataDir, true);
  await assert.rejects(readFile(f.userDataDir), { code: "ENOENT" });
  await assert.rejects(readFile(f.request.dataDir), { code: "ENOENT" });
  f.args.operation = "uninstall";
  await f.writeRequest({ operation: "uninstall", mode: "full" });
  await assert.rejects(loadLifecycleRequest(f.args, f.environment), /no initialized.*Full\/data-only/);
});

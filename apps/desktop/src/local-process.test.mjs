import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ownsLiveProcess, serviceEntry, signalOwned, spawnOwned, stopOwned } from "./local-process.mjs";
import { assertOwnedProcess, assertProcessIdentity, ownedProcessIdentity, readProcessIdentity, rememberOwnedProcess, sameProcessIdentity } from "./process-identity.mjs";

function environment() {
  return Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function processFixture(t, source, args = []) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-owned-process-"));
  const entry = join(directory, "entry.mjs");
  await writeFile(entry, source);
  const child = spawnOwned(process.execPath, ["--input-type=module", "--eval", serviceEntry, entry, ...args], { cwd: directory, env: environment() });
  let output = "";
  let failure = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { failure += chunk.toString(); });
  child.on("error", (error) => { failure += error.message; });
  t.after(async () => {
    await writeFile(join(directory, "allow-stop"), "yes");
    await writeFile(join(directory, "release-import"), "yes");
    await stopOwned(child);
    await rm(directory, { recursive: true, force: true });
  });
  async function ready(marker) {
    const deadline = Date.now() + 20_000;
    while (!output.includes(marker) && Date.now() < deadline) {
      assert.equal(child.exitCode, null, failure || "Owned child exited before readiness");
      await delay(25);
    }
    assert.equal(output.includes(marker), true, failure || "Owned child did not become ready");
    return output;
  }
  return { child, directory, ready };
}

test("owned services receive graceful shutdown and the owning process is reaped", async (t) => {
  const f = await processFixture(t, `
import { writeFile } from 'node:fs/promises';
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',async()=>{await writeFile('graceful','yes');clearInterval(timer)});
console.log('owned-ready');
`);
  await f.ready("owned-ready");
  assert.equal(ownsLiveProcess(f.child), true);
  await stopOwned(f.child);
  assert.equal(await readFile(join(f.directory, "graceful"), "utf8"), "yes");
  assert.equal(ownsLiveProcess(f.child), false);
});

test("normal shutdown waits for cooperative owned descendants to release their listeners", async t => {
  const f = await processFixture(t, `
import {spawn} from 'node:child_process';
const source=${JSON.stringify("const http=require('node:http');const server=http.createServer((q,s)=>s.end('owned-descendant'));const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('message',value=>{if(value==='stop')stop()});server.listen(0,'127.0.0.1',()=>console.log('port:'+server.address().port));")};
const nested=spawn(process.execPath,['--eval',source],{stdio:['ignore','pipe','inherit','ipc']});
nested.stdout.pipe(process.stdout);
process.on('SIGTERM',()=>{if(nested.connected)nested.send('stop',()=>{})});
`);
  const output = await f.ready("port:");
  const origin = `http://127.0.0.1:${Number(/port:(\d+)/.exec(output)[1])}`;
  assert.equal(await (await fetch(origin)).text(), "owned-descendant");
  await stopOwned(f.child);
  assert.equal(ownsLiveProcess(f.child), false);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
});

test("shutdown timeout preserves a live owned process and a normal retry succeeds without force", async (t) => {
  const f = await processFixture(t, `
import {existsSync} from 'node:fs';
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',()=>{if(existsSync('allow-stop'))clearInterval(timer)});
console.log('owned-ready');
`);
  await f.ready("owned-ready");
  await assert.rejects(stopOwned(f.child, { graceMs: 50 }), /Ownership is retained.*No process was force-killed/);
  assert.equal(ownsLiveProcess(f.child), true);
  assert.equal(f.child.exitCode, null);
  await writeFile(join(f.directory, "allow-stop"), "yes");
  await stopOwned(f.child);
  assert.equal(ownsLiveProcess(f.child), false);
});

if (process.platform === "win32") test("Windows handle ownership stays authoritative after asynchronous birth capture", async t => {
  const f = await processFixture(t, `
import { writeFile } from 'node:fs/promises';
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',async()=>{await writeFile('graceful','yes');clearInterval(timer)});
console.log('owned-ready');
`);
  await f.ready("owned-ready");
  const deadline = Date.now() + 20_000;
  while (!ownedProcessIdentity(f.child)?.creationTime && Date.now() < deadline) await delay(25);
  assert.ok(ownedProcessIdentity(f.child)?.creationTime, "Native birth metadata was not captured");
  const systemRoot = process.env.SystemRoot;
  try {
    // A stop must not start another native inspector, whether its asynchronous
    // birth query has completed or the supervisor has already exited.
    process.env.SystemRoot = join(f.directory, "missing-native-inspector");
    assert.ok(assertOwnedProcess(f.child));
    await stopOwned(f.child);
    assert.equal(assertOwnedProcess(f.child), null);
    assert.equal(ownsLiveProcess(f.child), false);
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
  assert.equal(await readFile(join(f.directory, "graceful"), "utf8"), "yes");
});

if (process.platform === "win32") test("a stop received during service import waits for its graceful handler", async t => {
  const f = await processFixture(t, `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
process.stdin.on('data',chunk=>{if(chunk.includes('desktop-stop'))console.log('stop-received')});
console.log('import-waiting');
while(!existsSync('release-import'))await delay(25);
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',()=>{writeFileSync('graceful','yes');clearInterval(timer)});
`);
  await f.ready("import-waiting");
  const stopping = stopOwned(f.child);
  // Observe delivery before allowing the module to install its handler.
  const stopped = stopping.then(() => null, error => error);
  try { await f.ready("stop-received"); }
  finally { await writeFile(join(f.directory, "release-import"), "yes"); }
  assert.equal(await stopped, null);
  assert.equal(await readFile(join(f.directory, "graceful"), "utf8"), "yes");
  assert.equal(f.child.desktopClosed, true);
});

for (const early of [true, false]) test(`pipe shutdown reaches a top-level-await service ${early ? "before" : "after"} handler registration`, async t => {
  const f = await processFixture(t, `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
process.stdin.on('data',chunk=>{if(chunk.includes('desktop-stop'))console.log('stop-received')});
console.log('import-waiting');
if (${early}) while(!existsSync('release-import'))await delay(25);
let finish;
const stopped=new Promise(resolve=>{finish=()=>{writeFileSync('graceful','yes');clearInterval(timer);resolve()}});
const timer=setInterval(()=>{if(existsSync('allow-stop'))finish()},25);
process.on('SIGTERM',finish);
console.log('handler-ready');
// Like the real Worker, import only completes after the stop handler runs.
await stopped;
console.log('graceful-stopped');
`);
  await f.ready(early ? "import-waiting" : "handler-ready");
  f.child.stdin.write('{"type":"desktop-stop"}\n');
  try { await f.ready("stop-received"); }
  finally { await writeFile(join(f.directory, "release-import"), "yes"); }
  // Do not call stopOwned (which sends a POSIX signal) until pipe delivery
  // itself has proven it released the top-level await.
  await f.ready("graceful-stopped");
  assert.equal(await readFile(join(f.directory, "graceful"), "utf8"), "yes");
  await stopOwned(f.child);
  assert.equal(f.child.desktopClosed, true);
});

test("unexpected parent exit cannot orphan an owned descendant", async (t) => {
  const f = await processFixture(t, `
import { spawn } from 'node:child_process';
import {existsSync} from 'node:fs';
const source=${JSON.stringify("const http=require('node:http');const server=http.createServer((q,s)=>s.end('owned-descendant'));server.listen(0,'127.0.0.1',()=>console.log('port:'+server.address().port));")};
const nested=spawn(process.execPath,['--eval',source],{stdio:['ignore','pipe','inherit']});
nested.stdout.once('data',chunk=>{process.stdout.write(chunk);setInterval(()=>{if(existsSync('allow-parent-exit'))process.exit(9)},25)});
process.on('SIGTERM',()=>process.exit(0));
`);
  const output = await f.ready("port:");
  const closed = once(f.child, "exit");
  assert.equal(ownsLiveProcess(f.child), true);
  await writeFile(join(f.directory, "allow-parent-exit"), "yes");
  await closed;
  const origin = `http://127.0.0.1:${Number(/port:(\d+)/.exec(output)[1])}`;
  await stopOwned(f.child, { closeMs: 2000 });
  assert.equal(ownsLiveProcess(f.child), false);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
});

test("a PID, spoofed identity property or reused creation identity never grants process ownership", () => {
  const current = readProcessIdentity(process.pid);
  assert.ok(current);
  const unowned = { pid: process.pid, exitCode: null, signalCode: null, desktopIdentity: current, stdin: { write() { throw new Error("Unowned pipe was used"); } }, kill() { throw new Error("Unowned PID was signalled"); } };
  assert.throws(() => signalOwned(unowned), /unowned/);
  assert.throws(() => assertProcessIdentity({ ...current, creationTime: `${current.creationTime}-reused` }), /reused|identity changed/);
  assert.throws(() => assertProcessIdentity({ ...current, executable: `${current.executable}-foreign` }), /reused|identity changed/);
  assert.equal(sameProcessIdentity(readProcessIdentity(process.pid), current), true);
});

test("an exited leader with uncaptured creation identity retains unknown descendants and refuses cleanup", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-unknown-birth-"));
  // Windows/libuv contains non-detached children in its own kill-on-close job.
  // This deliberately independent descendant must survive its leader so the
  // refusal assertion exercises a live unknown tree on every platform.
  // Closing the listener is not process exit: retain a handle briefly after
  // close so cleanup must observe native termination, not a completion file.
  const descendant = "const fs=require('node:fs'),http=require('node:http');fs.writeFileSync('descendant-pid',String(process.pid));const server=http.createServer((q,s)=>s.end('identity-not-adopted'));const timer=setInterval(()=>{if(fs.existsSync('release-descendant')){clearInterval(timer);server.close(()=>setTimeout(()=>{},250))}},25);server.listen(0,'127.0.0.1',()=>fs.writeFileSync('descendant-port',String(server.address().port)));";
  const source = `const {spawn}=require('node:child_process'),fs=require('node:fs');spawn(process.execPath,['--eval',${JSON.stringify(descendant)}],{detached:process.platform==='win32',stdio:'ignore'});setInterval(()=>{if(fs.existsSync('release-parent'))process.exit(9)},25);`;
  const child = spawn(process.execPath, ["--eval", source], { cwd: directory, env: environment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();
  const closed = once(child, "close");
  t.after(async () => {
    await writeFile(join(directory, "release-parent"), "yes");
    await writeFile(join(directory, "release-descendant"), "yes");
    await Promise.race([closed, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("The explicit test-owned leader did not exit cooperatively."); })]);
    const pid = Number(await readFile(join(directory, "descendant-pid"), "utf8"));
    const deadline = Date.now() + 10_000;
    let exited = false;
    let inspectionError;
    while (Date.now() < deadline) {
      try {
        // Native inspection can straddle teardown (for example /proc's exe
        // disappears before stat reports a zombie). Unknown is not exited.
        if (readProcessIdentity(pid) === null) { exited = true; break; }
      } catch (error) { inspectionError = error; }
      await delay(25);
    }
    if (!exited) throw new Error("The independent descendant did not exit cooperatively; its directory is retained.", { cause: inspectionError });
    await rm(directory, { recursive: true, force: true });
  });
  let port = "";
  const deadline = Date.now() + 30_000;
  while (!port && child.exitCode === null && Date.now() < deadline) {
    port = await readFile(join(directory, "descendant-port"), "utf8").catch(() => "");
    if (!port) await delay(25);
  }
  assert.match(port, /^\d+$/);
  const origin = `http://127.0.0.1:${port}`;
  assert.equal(await (await fetch(origin, { signal: AbortSignal.timeout(2000) })).text(), "identity-not-adopted");
  const exited = once(child, "exit");
  await writeFile(join(directory, "release-parent"), "yes");
  await exited;
  rememberOwnedProcess(child); // Deliberately too late to prove native birth.
  assert.equal(ownsLiveProcess(child), true);
  assert.throws(() => signalOwned(child), /identity.*captured.*unknown.*retained/);
  await assert.rejects(stopOwned(child, { graceMs: 50 }), /identity.*captured.*unknown.*retained/);
  assert.equal(await (await fetch(origin, { signal: AbortSignal.timeout(2000) })).text(), "identity-not-adopted");
});

if (process.platform === "win32") test("a missing native inspection helper is not reported as an exited PID", () => {
  const systemRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = join(tmpdir(), `missing-desktop-system-${Date.now()}`);
    assert.throws(() => readProcessIdentity(process.pid), /Cannot verify native/);
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
});

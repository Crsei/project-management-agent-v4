import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ownsLiveProcess, serviceEntry, signalOwned, spawnOwned, stopOwned } from "./local-process.mjs";
import { assertProcessIdentity, readProcessIdentity, rememberOwnedProcess, sameProcessIdentity } from "./process-identity.mjs";

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
  t.after(async () => { await writeFile(join(directory, "allow-stop"), "yes"); await stopOwned(child); await rm(directory, { recursive: true, force: true }); });
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

test("an exited leader with uncaptured creation identity retains unknown descendants and refuses cleanup", { timeout: 40_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-unknown-birth-"));
  const descendant = "const fs=require('node:fs'),http=require('node:http');const server=http.createServer((q,s)=>s.end('identity-not-adopted'));const timer=setInterval(()=>{if(fs.existsSync('release-descendant')){clearInterval(timer);server.close()}},25);server.listen(0,'127.0.0.1',()=>console.log('port:'+server.address().port));";
  const source = `const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['--eval',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});child.stdout.pipe(process.stdout);setInterval(()=>{if(fs.existsSync('release-parent'))process.exit(9)},25);`;
  const child = spawn(process.execPath, ["--eval", source], { cwd: directory, env: environment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.resume();
  const closed = once(child, "close");
  t.after(async () => {
    await writeFile(join(directory, "release-parent"), "yes");
    await writeFile(join(directory, "release-descendant"), "yes");
    await Promise.race([closed, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("The explicit test-owned fixture did not exit cooperatively."); })]);
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15_000;
  while (!output.includes("port:") && child.exitCode === null && Date.now() < deadline) await delay(25);
  assert.match(output, /port:\d+/);
  const exited = once(child, "exit");
  await writeFile(join(directory, "release-parent"), "yes");
  await exited;
  rememberOwnedProcess(child); // Deliberately too late to prove native birth.
  assert.equal(ownsLiveProcess(child), true);
  assert.throws(() => signalOwned(child), /identity.*captured.*unknown.*retained/);
  await assert.rejects(stopOwned(child, { graceMs: 50 }), /identity.*captured.*unknown.*retained/);
  const origin = `http://127.0.0.1:${Number(/port:(\d+)/.exec(output)[1])}`;
  assert.equal(await (await fetch(origin)).text(), "identity-not-adopted");
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

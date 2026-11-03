import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ownsLiveProcess, serviceEntry, spawnOwned, stopOwned } from "./local-process.mjs";

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
  t.after(async () => { await stopOwned(child, { force: true }); await rm(directory, { recursive: true, force: true }); });
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

test("forced teardown closes descendant listeners, not just the root process", async (t) => {
  const f = await processFixture(t, `
import { spawn } from 'node:child_process';
const source=${JSON.stringify("const http=require('node:http');process.on('SIGTERM',()=>{});const server=http.createServer((q,s)=>s.end('owned-descendant'));server.listen(0,'127.0.0.1',()=>console.log('port:'+server.address().port));")};
const nested=spawn(process.execPath,['--eval',source],{stdio:['ignore','pipe','inherit']});
nested.stdout.pipe(process.stdout);
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`);
  const output = await f.ready("port:");
  const port = Number(/port:(\d+)/.exec(output)[1]);
  const origin = `http://127.0.0.1:${port}`;
  assert.equal(await (await fetch(origin)).text(), "owned-descendant");
  await stopOwned(f.child, { graceMs: 50, forceMs: 2000 });
  assert.equal(ownsLiveProcess(f.child), false);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
});

test("unexpected parent exit cannot orphan an owned descendant", async (t) => {
  const f = await processFixture(t, `
import { spawn } from 'node:child_process';
const source=${JSON.stringify("const http=require('node:http');const server=http.createServer((q,s)=>s.end('owned-descendant'));server.listen(0,'127.0.0.1',()=>console.log('port:'+server.address().port));")};
const nested=spawn(process.execPath,['--eval',source],{stdio:['ignore','pipe','inherit']});
nested.stdout.once('data',chunk=>{process.stdout.write(chunk);setTimeout(()=>process.exit(9),100)});
`);
  const output = await f.ready("port:");
  const closed = once(f.child, "exit");
  await closed;
  const origin = `http://127.0.0.1:${Number(/port:(\d+)/.exec(output)[1])}`;
  await stopOwned(f.child, { force: true, forceMs: 2000 });
  assert.equal(ownsLiveProcess(f.child), false);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
});

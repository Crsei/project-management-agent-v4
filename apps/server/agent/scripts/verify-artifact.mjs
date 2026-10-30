import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.argv[2] !== "--artifact" || !process.argv[3] || process.argv.length !== 4) throw new Error("Usage: node apps/server/agent/scripts/verify-artifact.mjs --artifact RELOCATED_ARTIFACT_ROOT");
const artifact = await realpath(path.resolve(process.argv[3]));
const manifest = JSON.parse(await readFile(path.join(artifact, "artifact-manifest.json"), "utf8"));
assert.equal(manifest.version, 1);
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
const contained = (value) => value === artifact || value.startsWith(artifact + path.sep);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const entry of manifest.files) {
  const target = path.resolve(artifact, entry.path);
  assert.ok(contained(target), entry.path);
  assert.equal(sha(await readFile(target)), entry.sha256, entry.path);
  assert.equal((await lstat(target)).mode & 0o777, entry.mode, entry.path);
}
for (const entry of manifest.links) {
  const target = path.resolve(artifact, entry.path);
  assert.ok(contained(target));
  const link = await readlink(target);
  assert.ok(!path.isAbsolute(link));
  assert.equal(link.split(path.sep).join("/"), entry.target);
  assert.ok(contained(await realpath(target)));
}
assert.equal(manifest.packages.filter((entry) => entry.name === "effect").length, 1);
const temporary = await mkdtemp(path.join(os.tmpdir(), "pm-agent-portable-"));
const home = path.join(temporary, "home");
await mkdir(home);
// Explicit empty native environment, never ambient Provider credentials or NODE_PATH.
const environment = {
  PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_CACHE_HOME: path.join(home, ".cache"), TMPDIR: temporary, TEMP: temporary, TMP: temporary,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  AGENT_WORKSPACE_DATA_DIR: path.join(temporary, "data"), AGENT_WORKSPACE_PROJECT_ROOT: temporary,
  AGENT_WORKSPACE_API_ONLY: "1", HOST: "127.0.0.1", PORT: "0",
};
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: temporary, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Portable helper deadline exceeded.")); }, 60_000);
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Portable helper failed (${code ?? signal}): ${stderr}`));
    });
  });
}
let server;
try {
  const sdkImports = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {pathToFileURL} from 'node:url';
    import {fork} from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    const root=process.argv[1], req=createRequire(path.join(root,'apps/server/agent/dist/index.mjs'));
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'artifact-manifest.json'),'utf8'));
    const expected=fs.realpathSync(path.join(root,manifest.effectSingleton));
    for(const record of manifest.packages){
      if(record.dependencies.effect){
        const local=createRequire(path.join(root,record.path,'package.json'));
        assert.equal(fs.realpathSync(path.dirname(local.resolve('effect/package.json'))),expected);
      }
    }
    for(const name of ['@anthropic-ai/claude-agent-sdk','@cursor/sdk','@muse-code/sdk']) await import(pathToFileURL(req.resolve(name)).href);
    req('@lydell/node-pty');
    const store=await req('@cursor/sdk/sqlite').SqliteLocalAgentStore.open({workspaceRef:process.cwd(),stateRoot:path.join(process.cwd(),'cursor-sdk-state')});
    await store.dispose();
    await import(pathToFileURL(path.join(root,'apps/server/agent/dist/pm-cli/pi-tools.mjs')).href);
    await new Promise((resolve,reject)=>{
      const worker=fork(path.join(root,'apps/server/agent/dist/cursor-sdk-worker.mjs'),[],{execArgv:[],cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe','ipc']});
      let replied=false, diagnostics='';
      const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(new Error('Portable Cursor worker deadline'));},30000);
      worker.stderr.on('data',bytes=>{diagnostics+=bytes;});
      worker.once('error',error=>{clearTimeout(timer);reject(error);});
      worker.on('message',message=>{
        if(message?.type==='result'&&message.id===1){replied=true;worker.disconnect();}
        else {worker.kill('SIGKILL');reject(new Error('Portable Cursor worker rejected close'));}
      });
      worker.once('exit',code=>{
        clearTimeout(timer);
        if(code===0&&replied)resolve();else reject(new Error('Portable Cursor worker exit '+code+': '+diagnostics));
      });
      worker.send({id:1,operation:'close'});
    });
    console.log('disk-sdk-imports-native-pty-and-effect-singleton-ok');
  `;
  assert.match(await run(["--input-type=module", "-e", sdkImports, artifact]), /disk-sdk-imports-native-pty-and-effect-singleton-ok/);
  const rtf = path.join(temporary, "document.rtf");
  await writeFile(rtf, "{\\rtf1\\ansi Portable document resource closure.}");
  assert.equal((await run([path.join(artifact, "apps/server/agent/dist/providers/t3code/document-text-worker.mjs"), "__document-text", rtf, ".rtf"])).trim(), "Portable document resource closure.");
  // Dispatch through the production root and load the standalone history worker, with a disposable native home only.
  assert.equal((await run([path.join(artifact, "apps/server/agent/dist/index.mjs"), "__claude-history", "getSessionMessages", "00000000-0000-4000-8000-000000000000", JSON.stringify({ dir: temporary })])).trim(), "[]");
  assert.equal((await run([path.join(artifact, "apps/server/agent/dist/claude-history-worker.mjs"), "getSessionMessages", "00000000-0000-4000-8000-000000000000", JSON.stringify({ dir: temporary })])).trim(), "[]");
  const entrypoint = path.resolve(artifact, manifest.entrypoint);
  assert.ok(contained(entrypoint));
  server = spawn(process.execPath, [entrypoint], { cwd: temporary, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Standalone startup deadline: ${stderr}`)), 60_000);
    server.stdout.on("data", (bytes) => {
      stdout += bytes;
      const match = /agent-workspace listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.stderr.on("data", (bytes) => { stderr += bytes; });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Standalone startup exit ${code}: ${stderr}`)); });
  });
  const response = await fetch(`${address}/api/access`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const access = await response.json();
  assert.equal(access.authorized, true);
  console.log(JSON.stringify({ artifactHashesAndInternalLinks: true, diskSdkImports: true, nativePtyLoad: true, oneEffectSingleton: true, documentWorker: true, productionClaudeHistoryDispatch: true, apiOnlyProductionHttp: true, target: `${process.platform}-${process.arch}` }));
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { server.kill("SIGKILL"); }, 15_000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
      server.kill("SIGTERM");
    });
  }
  await rm(temporary, { recursive: true, force: true });
}

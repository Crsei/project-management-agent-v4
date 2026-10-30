import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as Layer from "effect/Layer";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import { antigravityAdapter } from "./antigravity.ts";
import { createProviderInstance, getProviderSettings, providerContext, updateProviderSettings } from "../instances.ts";
import { beginProviderExecution } from "../auth.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../t3code/application.ts";
import { makePmProviderFamily } from "../t3code/registration.ts";
import { antigravityDriver, makeAntigravityDriverLayer, antigravityProtocolResolver,
  antigravityCapabilities, antigravityInstallationMethods } from "../t3code/families/antigravity.ts";
import { closeStore, deleteRecord, listRecords } from "../../durable/store.ts";
import { continuationKey, PM_CONTINUATIONS } from "../t3code/continuation.ts";
import * as ModelManifest from "../../../../../../vendor/t3code/apps/server/src/provider/ModelManifest.ts";

// Antigravity's pinned native handshake reports protocolVersion 2 with the v1 shape.
// Use that original wire schema, not an invented ACP-v2/native-version equivalence.
// This executable owns actual SQLite session/history state; its answers are computed.
const peerSource = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import * as Schema from ${JSON.stringify(import.meta.resolve("effect/Schema"))};
import * as Wire from ${JSON.stringify(new URL("../../../../../../vendor/t3code/packages/effect-acp/src/_generated/schema-v1.gen.ts", import.meta.url).href)};
const directory = join(process.env.GEMINI_HOME, 'antigravity-acp');
const conversations = join(directory, 'conversations');
const authorization = join(directory, 'fixture-authorization');
const trace = value => appendFileSync(join(process.env.HOME, 'trace.jsonl'), JSON.stringify({pid:process.pid,...value}) + '\n');
trace({event:'spawn', home:process.env.HOME, profile:process.env.GEMINI_HOME, temp:process.env.TMPDIR, cwd:process.cwd(), adc:Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS), key:process.env.GEMINI_API_KEY});
process.once('exit', code => trace({event:'exit', code}));
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => process.exit(0));
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const reply = (id,schema,result) => send({jsonrpc:'2.0',id,result:Schema.encodeSync(schema)(result)});
const error = (id,code,message) => send({jsonrpc:'2.0',id,error:Schema.encodeSync(Wire.Error)({code,message})});
const invalid = message => { throw new Error(message); };
const requestSchemas = {
 initialize:Wire.InitializeRequest, authenticate:Wire.AuthenticateRequest, logout:Wire.LogoutRequest,
 'session/new':Wire.NewSessionRequest, 'session/resume':Wire.ResumeSessionRequest,
 'session/set_config_option':Wire.SetSessionConfigOptionRequest, 'session/set_mode':Wire.SetSessionModeRequest,
 'session/prompt':Wire.PromptRequest, 'session/cancel':Wire.CancelNotification
};
let sessionId, activePrompt, authenticated=false, callbackServer;
const withSession = (id,use) => {
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? '')) invalid('Native session identity mismatch');
 const base=join(conversations,id);
 if(!existsSync(base+'.db') || !existsSync(base+'.meta')) invalid('Native session history is missing');
 const metadata=JSON.parse(readFileSync(base+'.meta','utf8'));
 const db=new DatabaseSync(base+'.db');
 try {
  const session=db.prepare('SELECT * FROM native_session').get();
  if(!session || session.id!==id) invalid('Native session identity mismatch');
  if(session.cwd!==metadata.cwd) invalid('Native session cwd mismatch');
  return use(db,session);
 } finally { db.close(); }
};
const config = session => [
 {id:'model',category:'model',type:'select',name:'Model',currentValue:session.model,
  options:[{group:'native',name:'Controlled account',options:[{value:'model-a',name:'Calculator A'},{value:'model-b',name:'Calculator B'}]}]},
 {id:'mode',category:'mode',type:'select',name:'Mode',currentValue:session.mode,
  options:[{value:'default',name:'Ask'},{value:'auto_edit',name:'Auto edit'},{value:'yolo',name:'Full access'}]}
];
const delta = (role,text,messageId) => send({jsonrpc:'2.0',method:'session/update',params:Schema.encodeSync(Wire.SessionNotification)({
 sessionId,update:{sessionUpdate:role+'_message_chunk',messageId,content:{type:'text',text}}
})});
const finish = (status,answer) => withSession(sessionId,(db) => {
 db.exec('BEGIN');
 try {
  db.prepare('UPDATE native_turn SET status=?,answer=? WHERE status=?').run(status,answer,'running');
  db.prepare('UPDATE native_session SET state=?').run('idle');
  db.exec('COMMIT');
 } catch(cause) { db.exec('ROLLBACK');throw cause; }
});
const input=createInterface({input:process.stdin});
input.once('close',()=>process.exit(0));
input.on('line',line=>{
 let id;
 try {
  const message=JSON.parse(line);id=message.id;
  const method=message.method;
  if(!requestSchemas[method]) return error(id,-32601,'Unknown native method');
  const params=Schema.decodeUnknownSync(requestSchemas[method])(message.params ?? {});
  trace({method,params});
  if(method==='initialize') return reply(id,Wire.InitializeResponse,{
   protocolVersion:2,agentInfo:{name:'antigravity-acp',version:'controlled-native-fixture'},
   agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}},auth:{logout:{}}},
   authMethods:[{id:'oauth-personal',name:'Controlled Google flow'},{id:'gemini-api-key',name:'Controlled key'}]
  });
  if(method==='authenticate') {
   if(params.methodId==='gemini-api-key') {
    if(process.env.GEMINI_API_KEY!=='fixture-key') return error(id,-32602,'Configured API key was rejected');
    authenticated=true;return reply(id,Wire.AuthenticateResponse,{});
   }
   if(params.methodId!=='oauth-personal') return error(id,-32602,'Unsupported native auth method');
   if(existsSync(authorization)) { authenticated=true;return reply(id,Wire.AuthenticateResponse,{}); }
   const state=randomUUID();const path='/';
   callbackServer=createServer((request,response)=>{
    const callback=new URL(request.url,'http://127.0.0.1');
    trace({event:'callback',path:request.url});
    if(callback.pathname!==path || callback.searchParams.get('state')!==state) {response.writeHead(400);response.end('foreign callback');return;}
    const approved=callback.searchParams.get('code')==='approved' && !callback.searchParams.has('error');
    if(approved) {writeFileSync(authorization,'controlled account authorized');authenticated=true;}
    response.end(approved ? 'accepted' : 'denied');callbackServer.close();
    if(approved) reply(id,Wire.AuthenticateResponse,{});else error(id,-32602,'access_denied');
   });
   callbackServer.listen(0,'127.0.0.1',()=>{
    const redirect='http://127.0.0.1:'+callbackServer.address().port+path;
    trace({event:'authorization',redirect,state});
    process.stdout.write('Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri='+encodeURIComponent(redirect)+'&state='+state+'\n');
   });return;
  }
  if(method==='logout') {
   authenticated=false;if(existsSync(authorization)) unlinkSync(authorization);
   writeFileSync(join(directory,'signed-out'),'yes');return reply(id,Wire.LogoutResponse,{});
  }
  if(!authenticated) return error(id,-32000,'Native authentication required');
  if(method==='session/new') {
   sessionId=randomUUID();mkdirSync(conversations,{recursive:true});
   const db=new DatabaseSync(join(conversations,sessionId+'.db'));
   try {
    db.exec('CREATE TABLE native_session (id TEXT PRIMARY KEY,cwd TEXT NOT NULL,model TEXT NOT NULL,mode TEXT NOT NULL,total INTEGER NOT NULL,state TEXT NOT NULL); CREATE TABLE native_turn (id TEXT PRIMARY KEY,prompt TEXT NOT NULL,answer TEXT,status TEXT NOT NULL)');
    db.prepare('INSERT INTO native_session VALUES (?,?,?,?,?,?)').run(sessionId,params.cwd,'model-a','default',0,'idle');
   } finally {db.close();}
   writeFileSync(join(conversations,sessionId+'.meta'),JSON.stringify({cwd:params.cwd}));
   trace({event:'native-session',sessionId,cwd:params.cwd});
   return withSession(sessionId,(_db,session)=>reply(id,Wire.NewSessionResponse,{sessionId,configOptions:config(session)}));
  }
  if(method==='session/resume') return withSession(params.sessionId,(db,session)=>{
   if(session.cwd!==params.cwd) invalid('Native session cwd mismatch');
   if(session.state!=='idle' || db.prepare('SELECT id FROM native_turn WHERE status=?').get('running')) invalid('Native session has unfinished work');
   sessionId=params.sessionId;
   trace({event:'native-resume',sessionId,cwd:session.cwd,state:session.state,total:session.total});
   return reply(id,Wire.ResumeSessionResponse,{configOptions:config(session)});
  });
  if(params.sessionId!==sessionId) invalid('Native active session identity mismatch');
  if(method==='session/set_config_option') return withSession(sessionId,(db,session)=>{
   if(params.configId==='model' && ['model-a','model-b'].includes(params.value)) {
    db.prepare('UPDATE native_session SET model=?').run(params.value);
   } else if(params.configId==='mode' && ['default','auto_edit','yolo'].includes(params.value)) {
    db.prepare('UPDATE native_session SET mode=?').run(params.value);
   } else invalid('Native configuration is unavailable');
   return reply(id,Wire.SetSessionConfigOptionResponse,{configOptions:config({...session,[params.configId]:params.value})});
  });
  if(method==='session/set_mode') return withSession(sessionId,(db)=>{
   if(!['default','auto_edit','yolo'].includes(params.modeId)) invalid('Native mode is unavailable');
   db.prepare('UPDATE native_session SET mode=?').run(params.modeId);
   return reply(id,Wire.SetSessionModeResponse,{});
  });
  if(method==='session/prompt') {
   const prompt=params.prompt.filter(p=>p.type==='text').map(p=>p.text).join('\n');
   // Accept one standalone calculator/control command alongside native host instructions.
   const commands=prompt.split(/\r?\n/).map(line=>line.trim()).filter(line=>/^(ADD -?\d+ -?\d+|ACCUMULATE -?\d+|fail|wait|crash)$/.test(line));
   if(commands.length!==1) return error(id,-32602,'Expected one controlled calculator command');
   const text=commands[0];
   const turnId=randomUUID();
   withSession(sessionId,(db,session)=>{
    if(session.state!=='idle') invalid('Native session has unfinished work');
    db.exec('BEGIN');
    try {
     db.prepare('INSERT INTO native_turn VALUES (?,?,?,?)').run(turnId,prompt,null,'running');
     db.prepare('UPDATE native_session SET state=?').run('running');db.exec('COMMIT');
    } catch(cause) {db.exec('ROLLBACK');throw cause;}
    trace({event:'native-prompt',sessionId,model:session.model,mode:session.mode,text});
   });
   if(text==='fail') {delta('agent','partial failure',turnId);finish('failed',null);return error(id,-32603,'Native terminal failure');}
   if(text==='wait') {activePrompt=id;delta('agent','partial',turnId);return;}
   if(text==='crash') {delta('agent','native connection closing',turnId);process.exit(17);}
   const add=/^ADD (-?\d+) (-?\d+)$/.exec(text);
   const accumulate=/^ACCUMULATE (-?\d+)$/.exec(text);
   if(!add && !accumulate) {finish('failed',null);return error(id,-32602,'Unsupported controlled calculator command');}
   const answer=withSession(sessionId,(db,session)=>{
    const total=add ? Number(add[1])+Number(add[2]) : session.total+Number(accumulate[1]);
    db.prepare('UPDATE native_session SET total=?').run(total);return 'Native total='+total;
   });
   delta('agent',answer,turnId);finish('completed',answer);
   return reply(id,Wire.PromptResponse,{stopReason:'end_turn'});
  }
  if(method==='session/cancel') {
   trace({event:'native-cancel',sessionId});
   if(activePrompt!==undefined) {finish('cancelled',null);reply(activePrompt,Wire.PromptResponse,{stopReason:'cancelled'});activePrompt=undefined;}
   return;
  }
 } catch(cause) {
  trace({event:'rejected',message:String(cause)});
  if(id!==undefined) error(id,-32602,String(cause));
 }
});
`;

async function fixture(authMethod = "gemini-api-key", apiKey = "fixture-key") {
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  const root = await mkdtemp(join(tmpdir(), "pm-antigravity-m4-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  const close = async () => {
    try { await stopPmProviderApplication(); }
    finally {
      closeStore();
      if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    const cwd = join(root, "project"); const home = join(root, "native-home"); const bin = join(root, "bin");
    await mkdir(cwd); await mkdir(home); await chmod(home, 0o755); await mkdir(bin);
    const executable = join(bin, "agy_acp_server.mjs");
    await writeFile(executable, `#!${process.execPath}\n${peerSource}`); await chmod(executable, 0o700);
    await writeFile(join(bin, "localharness_external"), "controlled native peer harness\n"); await chmod(join(bin, "localharness_external"), 0o700);
    const settings = getProviderSettings(); updateProviderSettings(settings.revision, 0);
    const stored = createProviderInstance({ instanceId: "antigravity-m4", driver: "antigravity",
      config: { authMethod, apiKey, binaryPath: executable },
      environment: [{ name: "HOME", value: home, sensitive: false }, { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/must-not-read.json", sensitive: false }] });
    await startPmProviderApplication({ families: new Map([[antigravityDriver.driverKind, makePmProviderFamily(antigravityDriver, (context, runtimeHost) => Layer.merge(makeAntigravityDriverLayer(context, runtimeHost), ModelManifest.layerTest))]]), capabilities: new Map([["antigravity", antigravityCapabilities]]),
    installations: new Map([["antigravity", antigravityInstallationMethods]]), protocols: new Map([["antigravity", antigravityProtocolResolver]]), });
    const context = providerContext(stored, cwd);
    return { context, root, close,
      trace: async (): Promise<Record<string, unknown>[]> => (await readFile(join(home, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>),
      nativeDatabase: <A>(sessionId: string, use: (db: DatabaseSync) => A): A => {
        const db = new DatabaseSync(join(context.stateDirectory, "antigravity-acp", "conversations", sessionId + ".db"));
        try { return use(db); } finally { db.close(); }
      },
    };
  } catch (error) { await close(); throw error; }
}

test("Antigravity public settings use the source schema without introducing new settings", () => {
  assert.equal(antigravityAdapter.validateConfig({}).authMethod, "oauth-personal");
  assert.throws(() => antigravityAdapter.validateConfig({ authMethod: "unsupported" }));
  assert.throws(() => antigravityAdapter.validateConfig({ binaryPath: "bad\0path" }));
  assert.throws(() => antigravityAdapter.validateConfig({ unknown: "value" }));
});

test("original native auth, model selection, direct and zero-prompt legacy resume preserve owned state", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const before = await antigravityAdapter.check(f.context);
    assert.equal(before.authentication, "unknown"); assert.equal(before.nativeSessionReady, false);
    await assert.rejects(readFile(join(f.context.homeDirectory, "trace.jsonl")), { code: "ENOENT" });
    await antigravityAdapter.authenticate(f.context, { methodId: "gemini-api-key", signal: new AbortController().signal,
      onUpdate: () => {}, readInput: async () => { throw new Error("Key auth cannot request browser input"); } });
    const status = await antigravityAdapter.check(f.context);
    assert.equal(status.authentication, "authenticated"); assert.equal(status.nativeSessionReady, true);
    assert.ok(status.models.some(model => model.id === "model-b"));
    assert.equal(status.canLogout, true);
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "conversations")), []);
    const first = await antigravityAdapter.run(f.context, { model: "model-b", prompt: "ADD 19 23" });
    assert.equal(first.text, "Native total=42"); assert.ok(first.nativeSession);
    assert.equal(listRecords<{ protocol: string }>(PM_CONTINUATIONS)[0]?.protocol, "acp-v1.ndjson-jsonrpc");
    const resumed = await antigravityAdapter.run(f.context, { model: "model-b", prompt: "ACCUMULATE 8", resume: first.nativeSession });
    assert.equal(resumed.text, "Native total=50");
    assert.equal(resumed.nativeSession?.sessionId, first.nativeSession.sessionId);
    const legacy: NativeSessionRef = { driver: "antigravity", providerInstanceId: f.context.instanceId,
      instanceRevision: f.context.revision, cwd: f.context.cwd, sessionId: first.nativeSession.sessionId, modelId: "model-b" };
    deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, legacy.sessionId));
    const countBefore = (await f.trace()).filter(entry => entry.method === "session/new").length;
    const adopted = await antigravityAdapter.run(f.context, { model: "model-b", prompt: "ACCUMULATE 7", resume: legacy });
    assert.equal(adopted.text, "Native total=57");
    assert.equal(adopted.nativeSession?.sessionId, legacy.sessionId);
    const trace = await f.trace();
    assert.equal(trace.filter(entry => entry.method === "session/new").length, countBefore);
    assert.equal(trace.filter(entry => entry.method === "session/prompt").length, 3);
    assert.ok(trace.some(entry => entry.method === "session/resume"));
    assert.equal(trace.some(entry => entry.method === "session/load"), false);
    assert.equal(trace.filter(entry => entry.event === "native-resume").length, 2);
    for (const resume of trace.filter(entry => entry.event === "native-resume")) {
      assert.equal(resume.sessionId, legacy.sessionId); assert.equal(resume.cwd, f.context.cwd); assert.equal(resume.state, "idle");
    }
    const prompts = trace.filter(entry => entry.event === "native-prompt");
    assert.deepEqual(prompts.map(entry => entry.text), ["ADD 19 23", "ACCUMULATE 8", "ACCUMULATE 7"]);
    assert.ok(prompts.every(entry => entry.model === "model-b" && entry.mode === "default"));
    f.nativeDatabase(legacy.sessionId, db => {
      const native = db.prepare("SELECT * FROM native_session").get()!;
      assert.equal(native.id, legacy.sessionId); assert.equal(native.cwd, f.context.cwd);
      assert.equal(native.total, 57); assert.equal(native.state, "idle");
      assert.deepEqual(db.prepare("SELECT status FROM native_turn ORDER BY rowid").all().map(row => row.status), ["completed", "completed", "completed"]);
    });
    const spawn = trace.find(entry => entry.event === "spawn")!;
    assert.equal(spawn.home, f.context.homeDirectory); assert.equal(spawn.profile, f.context.stateDirectory);
    assert.equal(spawn.adc, false); assert.equal(spawn.key, "fixture-key");
    assert.equal(spawn.cwd, (trace.find(entry => entry.event === "native-session"))?.cwd);
    assert.equal((await stat(f.context.homeDirectory)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
    await writeFile(join(f.context.stateDirectory, "antigravity-acp", "conversations", legacy.sessionId + ".meta"), JSON.stringify({ cwd: join(f.root, "foreign-project") }));
    deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, legacy.sessionId));
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-b", prompt: "ACCUMULATE 100", resume: legacy }));
    assert.equal((await f.trace()).filter(entry => entry.method === "session/prompt").length, 3);
    await antigravityAdapter.logout(f.context);
    assert.equal((await antigravityAdapter.check(f.context)).authentication, "unauthenticated");
    assert.equal(await readFile(join(f.context.stateDirectory, "antigravity-acp", "signed-out"), "utf8"), "yes");
  } finally { await f.close(); }
});

test("auth and maintenance cannot bypass an active original execution reservation", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const release = beginProviderExecution(f.context.instanceId);
    try {
      await assert.rejects(antigravityAdapter.authenticate(f.context, { signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => "" }), /busy/i);
      await assert.rejects(antigravityAdapter.prepare!(f.context), /busy/i);
      await assert.rejects(antigravityAdapter.removeInstallation!(f.context), /busy/i);
    } finally { release(); }
    for (const operation of [antigravityAdapter.prepare!, antigravityAdapter.update!, antigravityAdapter.removeInstallation!])
      await assert.rejects(operation(f.context), /custom Antigravity binary path/);
    assert.ok((await readFile(String(f.context.config.binaryPath), "utf8")).includes("session/prompt"));
  } finally { await f.close(); }
});

test("original native failure, cancellation and callback failure never resolve as successful Chat output", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-a", prompt: "fail" }));
    const failed = (await f.trace()).find(entry => entry.event === "native-prompt" && entry.text === "fail")!;
    f.nativeDatabase(String(failed.sessionId), db => {
      assert.equal(db.prepare("SELECT state FROM native_session").get()?.state, "idle");
      assert.equal(db.prepare("SELECT status FROM native_turn").get()?.status, "failed");
    });
    const controller = new AbortController();
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-a", prompt: "wait", signal: controller.signal, onText: () => controller.abort() }));
    assert.ok((await f.trace()).some(entry => entry.event === "native-cancel"));
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-a", prompt: "ADD 1 2", onText: () => { throw new Error("consumer callback failed"); } }), /consumer callback failed/);
    const beforeUnavailable = (await f.trace()).filter(entry => entry.method === "session/prompt").length;
    await assert.rejects(antigravityAdapter.run(f.context, { model: "unavailable-account-model", prompt: "ADD 1 2" }));
    const trace = await f.trace();
    assert.equal(trace.filter(entry => entry.method === "session/prompt").length, beforeUnavailable);
    const cancellation = trace.find(entry => entry.event === "native-cancel")!;
    assert.ok(cancellation);
    f.nativeDatabase(String(cancellation.sessionId), db => {
      assert.equal(db.prepare("SELECT state FROM native_session").get()?.state, "idle");
      assert.equal(db.prepare("SELECT status FROM native_turn").get()?.status, "cancelled");
    });
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
  } finally { await f.close(); }
});

test("original browser callback binds the native loopback destination and account flow", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const f = await fixture("oauth-personal");
  try {
    let callback: string | undefined;
    await antigravityAdapter.authenticate(f.context, { methodId: "oauth-personal", signal: new AbortController().signal,
      onUpdate: update => { if (update.interaction?.type === "browser") { const url = new URL(update.interaction.url);
        const redirect = new URL(url.searchParams.get("redirect_uri")!); redirect.searchParams.set("state", url.searchParams.get("state")!); redirect.searchParams.set("code", "approved"); callback = redirect.href; } },
      readInput: async () => { assert.ok(callback); return callback; },
    });
    assert.equal((await antigravityAdapter.check(f.context)).authentication, "authenticated");
    assert.ok(callback);
    const native = (await f.trace()).find(entry => entry.event === "authorization")!;
    const forwarded = new URL(callback);
    assert.equal(forwarded.origin + forwarded.pathname, native.redirect);
    assert.equal(forwarded.searchParams.get("state"), native.state);
    assert.deepEqual((await f.trace()).filter(entry => entry.event === "callback").map(entry => entry.path), [forwarded.pathname + forwarded.search]);
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "conversations")), []);
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
    await antigravityAdapter.logout(f.context);
    assert.equal((await antigravityAdapter.check(f.context)).authentication, "unauthenticated");
  } finally { await f.close(); }
});

test("original key authentication preserves external credential rejection without a session or prompt", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const f = await fixture("gemini-api-key", "rejected-fixture-key");
  try {
    const phases: string[] = [];
    await assert.rejects(antigravityAdapter.authenticate(f.context, {
      methodId: "gemini-api-key", signal: new AbortController().signal,
      onUpdate: update => { if (update.phase) phases.push(update.phase); },
      readInput: async () => { throw new Error("Rejected key auth cannot request browser input"); },
    }), /rejected the configured credentials/i);
    assert.equal(phases.includes("succeeded"), false);
    const trace = await f.trace();
    assert.ok(trace.some(entry => entry.method === "authenticate"));
    assert.equal(trace.some(entry => entry.method === "session/new" || entry.method === "session/prompt"), false);
    const status = await antigravityAdapter.check(f.context);
    assert.notEqual(status.authentication, "authenticated"); assert.equal(status.nativeSessionReady, false);
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
  } finally { await f.close(); }
});

test("legacy adoption rejects a different persisted native identity without a replacement or probe prompt", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const first = await antigravityAdapter.run(f.context, { model: "model-b", prompt: "ADD 2 3" });
    assert.ok(first.nativeSession);
    const legacy: NativeSessionRef = { driver: "antigravity", providerInstanceId: f.context.instanceId,
      instanceRevision: f.context.revision, cwd: f.context.cwd, sessionId: first.nativeSession.sessionId, modelId: "model-b" };
    f.nativeDatabase(legacy.sessionId, db => { db.prepare("UPDATE native_session SET id=?").run(randomUUID()); });
    deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, legacy.sessionId));
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-b", prompt: "ACCUMULATE 100", resume: legacy }));
    const trace = await f.trace();
    assert.equal(trace.filter(entry => entry.method === "session/new").length, 1);
    assert.equal(trace.filter(entry => entry.method === "session/prompt").length, 1);
    assert.equal(trace.filter(entry => entry.event === "native-resume").length, 0);
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
  } finally { await f.close(); }
});

test("legacy adoption refuses actual unfinished native work left by a crashed process without another prompt", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const first = await antigravityAdapter.run(f.context, { model: "model-b", prompt: "ADD 2 3" });
    assert.ok(first.nativeSession);
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-b", prompt: "crash", resume: first.nativeSession }));
    const legacy: NativeSessionRef = { driver: "antigravity", providerInstanceId: f.context.instanceId,
      instanceRevision: f.context.revision, cwd: f.context.cwd, sessionId: first.nativeSession.sessionId, modelId: "model-b" };
    f.nativeDatabase(legacy.sessionId, db => {
      assert.equal(db.prepare("SELECT state FROM native_session").get()?.state, "running");
      assert.equal(db.prepare("SELECT status FROM native_turn ORDER BY rowid DESC LIMIT 1").get()?.status, "running");
    });
    deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, legacy.sessionId));
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-b", prompt: "ACCUMULATE 100", resume: legacy }));
    const trace = await f.trace();
    assert.equal(trace.filter(entry => entry.method === "session/new").length, 1);
    assert.equal(trace.filter(entry => entry.method === "session/prompt").length, 2);
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
  } finally { await f.close(); }
});

for (const mismatch of ["state", "destination", "path"] as const) {
  test(`original browser callback rejects a foreign ${mismatch} before forwarding or authenticating`, { skip: process.platform === "win32", timeout: 60_000 }, async () => {
    const f = await fixture("oauth-personal");
    try {
      let callback: string | undefined;
      await assert.rejects(antigravityAdapter.authenticate(f.context, {
        methodId: "oauth-personal", signal: new AbortController().signal,
        onUpdate: update => {
          if (update.interaction?.type !== "browser") return;
          const authorization = new URL(update.interaction.url);
          const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("state", mismatch === "state" ? randomUUID() : authorization.searchParams.get("state")!);
          redirect.searchParams.set("code", "approved");
          if (mismatch === "destination") redirect.hostname = "127.0.0.2";
          if (mismatch === "path") redirect.pathname += "/foreign";
          callback = redirect.href;
        },
        readInput: async () => { assert.ok(callback); return callback; },
      }), /does not belong to the current sign-in/i);
      assert.equal((await f.trace()).some(entry => entry.event === "callback"), false);
      assert.notEqual((await antigravityAdapter.check(f.context)).authentication, "authenticated");
      assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
    } finally { await f.close(); }
  });
}

test("original browser denial is forwarded to the native account flow but never authenticates", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const f = await fixture("oauth-personal");
  try {
    let callback: string | undefined;
    const phases: string[] = [];
    await assert.rejects(antigravityAdapter.authenticate(f.context, {
      methodId: "oauth-personal", signal: new AbortController().signal,
      onUpdate: update => {
        if (update.phase) phases.push(update.phase);
        if (update.interaction?.type !== "browser") return;
        const authorization = new URL(update.interaction.url);
        const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("state", authorization.searchParams.get("state")!);
        redirect.searchParams.set("error", "access_denied"); callback = redirect.href;
      },
      readInput: async () => { assert.ok(callback); return callback; },
    }), /not approved/i);
    assert.equal(phases.includes("succeeded"), false);
    const trace = await f.trace();
    assert.equal(trace.filter(entry => entry.event === "callback").length, 1);
    assert.equal(trace.some(entry => entry.method === "session/new" || entry.method === "session/prompt"), false);
    assert.notEqual((await antigravityAdapter.check(f.context)).authentication, "authenticated");
    assert.deepEqual(await readdir(join(f.context.stateDirectory, "antigravity-acp", "tmp")), []);
  } finally { await f.close(); }
});

test("one controlled native account cannot complete another account's browser flow", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  let otherAccountState: string | undefined;
  const first = await fixture("oauth-personal");
  try {
    let callback: string | undefined;
    await antigravityAdapter.authenticate(first.context, {
      methodId: "oauth-personal", signal: new AbortController().signal,
      onUpdate: update => {
        if (update.interaction?.type !== "browser") return;
        const authorization = new URL(update.interaction.url);
        otherAccountState = authorization.searchParams.get("state")!;
        const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("state", otherAccountState); redirect.searchParams.set("code", "approved");
        callback = redirect.href;
      },
      readInput: async () => { assert.ok(callback); return callback; },
    });
  } finally { await first.close(); }
  assert.ok(otherAccountState);
  const second = await fixture("oauth-personal");
  try {
    let callback: string | undefined;
    await assert.rejects(antigravityAdapter.authenticate(second.context, {
      methodId: "oauth-personal", signal: new AbortController().signal,
      onUpdate: update => {
        if (update.interaction?.type !== "browser") return;
        const authorization = new URL(update.interaction.url);
        assert.notEqual(authorization.searchParams.get("state"), otherAccountState);
        const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("state", otherAccountState!); redirect.searchParams.set("code", "approved");
        callback = redirect.href;
      },
      readInput: async () => { assert.ok(callback); return callback; },
    }), /does not belong to the current sign-in/i);
    assert.equal((await second.trace()).some(entry => entry.event === "callback"), false);
    assert.notEqual((await antigravityAdapter.check(second.context)).authentication, "authenticated");
    assert.deepEqual(await readdir(join(second.context.stateDirectory, "antigravity-acp", "tmp")), []);
  } finally { await second.close(); }
});

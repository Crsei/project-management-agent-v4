import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { codexAdapter } from "./codex.ts";
import { codexEnvironment, tokenizeNativeArgs } from "./codex-config.ts";
import { createProviderInstance, providerContext } from "../instances.ts";
import { forkNativeSession } from "../native.ts";

const protocol = `import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2);
const log=value=>fs.appendFileSync(process.env.EVENT_LOG,JSON.stringify(value)+'\\n');
log({args,cwd:process.cwd(),home:process.env.CODEX_HOME});
if(args.includes('generate-ts')) {const out=args[args.indexOf('--out')+1];fs.mkdirSync(path.join(out,'v2'),{recursive:true});fs.writeFileSync(path.join(out,'v2','ThreadForkParams.ts'),'threadId: string; lastTurnId?: string');}
else {
const send=value=>console.log(JSON.stringify(value));const notify=(method,params)=>send({method,params});
const credential=path.join(process.env.CODEX_HOME,'auth.json');
let pendingThreadId='';let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){const msg=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);log({rpc:msg});const respond=result=>send({id:msg.id,result});
if(msg.id==='input-1'&&!msg.method){if(msg.error){notify('turn/completed',{threadId:pendingThreadId,turn:{id:'native-turn',status:'failed',error:{message:'User input cancelled'}}});}else {notify('item/completed',{threadId:pendingThreadId,turnId:'native-turn',item:{id:'assistant',type:'agentMessage',text:'native answer'}});notify('turn/completed',{threadId:pendingThreadId,turn:{id:'native-turn',status:'completed'}});}continue;}
if(msg.method==='initialize')respond({userAgent:'codex/controlled-protocol'});
else if(msg.method==='account/read')respond({account:fs.existsSync(credential)?{type:'apiKey'}:process.env.REQUIRE_AUTH?null:{type:'chatgpt',email:'fixture@example.invalid'},requiresOpenaiAuth:true});
else if(msg.method==='account/login/start'&&process.env.MODE==='auth-wait')respond({type:'chatgptDeviceCode',loginId:'waiting-login',userCode:'WAIT-TEST',verificationUrl:'https://auth.openai.com/codex/device'});
else if(msg.method==='account/login/start'){fs.writeFileSync(credential,'{"fixture":true}');if(msg.params.type==='apiKey')respond({type:'apiKey'});else {notify('account/login/completed',{loginId:'login-1',success:true});respond({type:'chatgptDeviceCode',loginId:'login-1',userCode:'FIXT-TEST',verificationUrl:'https://auth.openai.com/codex/device',authUrl:'https://auth.openai.com/authorize'});}}
else if(msg.method==='account/logout'){fs.rmSync(credential,{force:true});respond({});}
else if(msg.method==='model/list')respond(msg.params.cursor?{data:[{id:'row-2',model:'native-codex-2',displayName:'Native two'}],nextCursor:null}:{data:[{id:'row-1',model:'native-codex-1',displayName:'Native one'},{id:'hidden',model:'hidden-native',hidden:true}],nextCursor:'next'});
else if(msg.method==='thread/start'||msg.method==='thread/resume')respond({thread:{id:msg.params.threadId||'native-session'}});
else if(msg.method==='thread/fork')respond({thread:{id:'forked-native-session',forkedFromId:msg.params.threadId}});
else if(msg.method==='turn/interrupt'){respond({});}
else if(msg.method==='turn/start'){
 const threadId=msg.params.threadId;respond({turn:{id:'native-turn'}});notify('turn/started',{threadId,turn:{id:'native-turn'}});
 notify('item/agentMessage/delta',{threadId,turnId:'native-turn',itemId:'assistant',delta:'native '});
 if(process.env.MODE==='input'){pendingThreadId=threadId;send({id:'input-1',method:'item/tool/requestUserInput',params:{threadId,turnId:'native-turn',itemId:'question-tool',isBlocking:true,questions:[{id:'color',header:'Color',question:'Choose a color',options:[{label:'Blue',description:'Blue option'}]}]}});continue;}
 if(process.env.MODE==='cancel')continue;
 if(process.env.MODE==='eof'){process.stdout.write('',()=>process.exit(0));continue;}
 if(process.env.MODE==='failure'){notify('turn/completed',{threadId,turn:{id:'native-turn',status:'failed',error:{message:'Usage limit reached',code:'usage_limit_reached',resets_at:1900000000}}});continue;}
 if(process.env.MODE==='telemetry'){
  const first={inputTokens:100,cachedInputTokens:40,cacheWriteInputTokens:10,outputTokens:20,reasoningOutputTokens:5,totalTokens:120};
  const next={inputTokens:150,cachedInputTokens:60,cacheWriteInputTokens:15,outputTokens:30,reasoningOutputTokens:7,totalTokens:180};
  notify('account/rateLimits/updated',{rateLimits:{primary:{usedPercent:30,windowDurationMins:300,resetsAt:1900000000}}});
  notify('thread/tokenUsage/updated',{threadId:'other-session',turnId:'native-turn',tokenUsage:{last:next,total:next,modelContextWindow:200000}});
  notify('thread/tokenUsage/updated',{threadId,turnId:'native-turn',tokenUsage:{last:first,total:first,modelContextWindow:200000}});
  notify('thread/tokenUsage/updated',{threadId,turnId:'native-turn',tokenUsage:{last:first,total:first,modelContextWindow:200000}});
  notify('thread/tokenUsage/updated',{threadId,turnId:'native-turn',tokenUsage:{last:{inputTokens:50,cachedInputTokens:20,cacheWriteInputTokens:5,outputTokens:10,reasoningOutputTokens:2,totalTokens:60},total:next,modelContextWindow:200000}});
 }
 notify('item/completed',{threadId,turnId:'native-turn',item:{id:'assistant',type:'agentMessage',text:'native answer'}});
 notify('thread/tokenUsage/updated',{threadId,turnId:'native-turn',tokenUsage:{last:{inputTokens:2,outputTokens:3}}});
 notify('turn/completed',{threadId,turn:{id:'native-turn',status:'completed'}});
}
}});}
`;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-native-protocol-"));
  const executable = path.join(directory, "codex.mjs");
  await writeFile(executable, `#!${process.execPath}\n${protocol}`); await chmod(executable, 0o700);
  const context: ProviderDriverContext = { instanceId: "controlled-codex", driver: "codex", revision: 3, cwd: directory, homeDirectory: path.join(directory, "home"), config: codexAdapter.validateConfig({ binaryPath: executable, launchArgs: '--config model_reasoning_effort="high"' }), env: { ...process.env, HOME: path.join(directory, "home"), EVENT_LOG: path.join(directory, "events.jsonl") } };
  return { directory, context, events: async () => (await readFile(context.env.EVENT_LOG!, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("Codex native check discovers protocol models and bounded forks without starting a turn", async () => {
  const f = await fixture();
  try {
    const result = await codexAdapter.check(f.context);
    assert.equal(result.authentication, "authenticated");
    assert.deepEqual(result.models.map((model) => model.id), ["native-codex-1", "native-codex-2"]);
    assert.equal(result.capabilities?.boundedFork, true);
    const events = await f.events();
    assert.ok(events.every((event) => !event.rpc || !["turn/start", "thread/start"].includes(event.rpc.method)));
    assert.ok(events.filter((event) => event.args).every((event) => event.home === f.context.homeDirectory && event.cwd === f.context.cwd && event.args.includes("model_reasoning_effort=high")));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex native run resumes only the bound session, deduplicates deltas and requires terminal completion", async () => {
  const f = await fixture();
  try {
    const refs: NativeSessionRef[] = []; const chunks: string[] = []; const events: NativeOutputEvent[] = [];
    const first = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "controlled fixture", onText: (delta) => chunks.push(delta), onSession: (ref) => refs.push(ref), onEvent: (event) => events.push(event) });
    assert.equal(first.text, "native answer"); assert.equal(chunks.join(""), first.text);
    assert.equal(events.flatMap((event) => event.type === "item.upsert" && event.item.type === "assistant_message" ? [event.item] : []).at(-1)?.text, first.text);
    assert.equal(first.nativeSession?.sessionId, "native-session"); assert.equal(first.nativeSession?.turnId, "native-turn");
    assert.equal(first.nativeSession?.instanceRevision, 3); assert.deepEqual(first.usage, { inputTokens: 2, outputTokens: 3 });
    await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "resume fixture", resume: first.nativeSession });
    const requests = (await f.events()).filter((event) => event.rpc).map((event) => event.rpc);
    assert.equal(requests.find((rpc) => rpc.method === "thread/resume").params.threadId, "native-session");
    assert.equal(requests.find((rpc) => rpc.method === "turn/start").params.sandboxPolicy.networkAccess, false);
    assert.deepEqual(requests.find((rpc) => rpc.method === "turn/start").params.sandboxPolicy.writableRoots, [f.context.cwd]);
    await assert.rejects(codexAdapter.run(f.context, { model: "native-codex-1", prompt: "wrong account", resume: { ...first.nativeSession!, providerInstanceId: "another" } }), /another instance/);
    await assert.rejects(codexAdapter.run({ ...f.context, env: { ...f.context.env, MODE: "eof" } }, { model: "native-codex-1", prompt: "partial then eof" }), /closed before/);
    await assert.rejects(codexAdapter.run({ ...f.context, env: { ...f.context.env, MODE: "failure" } }, { model: "native-codex-1", prompt: "partial then error" }), (error: unknown) => {
      assert.ok(error instanceof Error && "errorClass" in error && error.errorClass === "usage_limit");
      assert.ok("resetAt" in error && error.resetAt === "2030-03-17T17:46:40.000Z"); return true;
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex returns real user input answers over RPC without changing approval policy", async () => {
  const f = await fixture(); const events: NativeOutputEvent[] = [];
  try {
    const result = await codexAdapter.run({ ...f.context, env: { ...f.context.env, MODE: "input" } }, {
      model: "native-codex-1", prompt: "choose", onEvent: (event) => events.push(event),
      onRequest: async (request) => {
        assert.equal(request.kind, "user_input"); assert.equal(request.respondable, true);
        assert.equal(request.questions?.[0]?.options?.[0]?.id, "Blue");
        return { answers: { color: "Blue" } };
      },
    });
    assert.equal(result.text, "native answer");
    const sent = (await f.events()).find((entry) => entry.rpc?.id === "input-1")?.rpc;
    assert.deepEqual(sent.result, { answers: { color: { answers: ["Blue"] } } });
    assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "waiting" && event.item.request?.respondable));
    assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "completed" && event.item.request?.respondable === false));
    const start = (await f.events()).find((entry) => entry.rpc?.method === "turn/start")?.rpc;
    assert.equal(start.params.approvalPolicy, "never"); assert.equal(start.params.sandboxPolicy.networkAccess, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex sends cancellation to the native input request without an answer", async () => {
  const f = await fixture();
  try {
    await assert.rejects(codexAdapter.run({ ...f.context, env: { ...f.context.env, MODE: "input" } }, {
      model: "native-codex-1", prompt: "cancel input", onRequest: async () => ({ cancelled: true }),
    }), /User input cancelled/);
    const sent = (await f.events()).find((entry) => entry.rpc?.id === "input-1")?.rpc;
    assert.equal(sent.error.code, -32800); assert.equal(sent.result, undefined);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex cancellation sends native turn/interrupt and never returns partial success", async () => {
  const f = await fixture(); const abort = new AbortController();
  try {
    await assert.rejects(codexAdapter.run({ ...f.context, env: { ...f.context.env, MODE: "cancel" } }, { model: "native-codex-1", prompt: "cancel fixture", signal: abort.signal, onText: () => abort.abort() }), (error: unknown) => error instanceof Error && "code" in error && error.code === "aborted");
    assert.ok((await f.events()).some((event) => event.rpc?.method === "turn/interrupt"));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex bounded native fork preserves exact IDs, launch configuration and account boundaries", async () => {
  const f = await fixture(); const previousData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(f.directory, "data");
  try {
    const instance = createProviderInstance({ driver: "codex", label: "Controlled fork", config: f.context.config, env: { EVENT_LOG: f.context.env.EVENT_LOG! } });
    const context = providerContext(instance, f.directory);
    const first = await codexAdapter.run(context, { model: "native-codex-1", prompt: "controlled fork source" });
    const forked = await forkNativeSession(instance, first.nativeSession!, { turnId: "native-turn" }, f.directory);
    assert.equal(forked.sessionId, "forked-native-session");
    assert.equal(forked.instanceRevision, instance.revision);
    const request = (await f.events()).find((event) => event.rpc?.method === "thread/fork").rpc;
    assert.equal(request.params.threadId, "native-session");
    assert.equal(request.params.lastTurnId, "native-turn");
    assert.equal(request.params.deferGoalContinuation, true);
    await assert.rejects(forkNativeSession(instance, { ...first.nativeSession!, instanceRevision: instance.revision + 1 }, { turnId: "native-turn" }, f.directory), /another instance/);
    await assert.rejects(forkNativeSession(instance, first.nativeSession!, { messageId: "not-a-turn" }, f.directory), /native completed turn/);
  } finally {
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Codex cancelling a waiting native login does not claim success or install credentials", async () => {
  const f = await fixture(); const abort = new AbortController();
  const context = { ...f.context, env: { ...f.context.env, REQUIRE_AUTH: "true", MODE: "auth-wait" } };
  try {
    await assert.rejects(codexAdapter.authenticate(context, {
      signal: abort.signal, methodId: "device-code", readInput: async () => "",
      onUpdate: (update) => { if (update.interaction?.type === "device-code") abort.abort(); },
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "aborted");
    assert.equal((await codexAdapter.check(context)).authentication, "unauthenticated");
    await assert.rejects(lstat(path.join(context.homeDirectory, "auth.json")), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex device and API-key native auth verify protocol state; logout confirms removal", async () => {
  const f = await fixture(); const context = { ...f.context, env: { ...f.context.env, REQUIRE_AUTH: "true" } };
  try {
    assert.equal((await codexAdapter.check(context)).authentication, "unauthenticated");
    const updates: unknown[] = [];
    await codexAdapter.authenticate(context, { signal: new AbortController().signal, onUpdate: (value) => updates.push(value), readInput: async () => "", methodId: "device-code" });
    assert.ok(updates.some((value) => JSON.stringify(value).includes("FIXT-TEST")));
    assert.equal((await codexAdapter.check(context)).authentication, "authenticated");
    await codexAdapter.logout(context); assert.equal((await codexAdapter.check(context)).authentication, "unauthenticated");
    await codexAdapter.authenticate(context, { signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => JSON.stringify({ apiKey: "controlled-native-key" }), methodId: "api-key" });
    assert.equal((await codexAdapter.check(context)).authentication, "authenticated");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex config and shadow homes reject inert, invalid and unsafe overrides and keep auth private", async () => {
  assert.throws(() => codexAdapter.validateConfig({ setupMode: "managed" }), /Unknown/);
  assert.throws(() => codexAdapter.validateConfig({ launchArgs: '--config sandbox_mode="danger-full-access"' }), /sandbox/);
  assert.throws(() => codexAdapter.validateConfig({ launchArgs: "--listen http://0.0.0.0" }), /transport/);
  assert.throws(() => codexAdapter.validateConfig({ binaryPath: true }), /expected a string/);
  assert.throws(() => tokenizeNativeArgs("--config 'unterminated"), /unterminated/);
  const f = await fixture();
  try {
    const shared = path.join(f.directory, "shared"); const shadow = path.join(f.directory, "shadow");
    await mkdir(shared); await writeFile(path.join(shared, "auth.json"), "private-shared-auth"); await writeFile(path.join(shared, "config.toml"), "model='native'");
    const context = { ...f.context, homeDirectory: shadow, config: codexAdapter.validateConfig({ homePath: shared, shadowHomePath: shadow }) };
    await codexEnvironment(context);
    assert.equal(await readlink(path.join(shadow, "sessions")), path.join(shared, "sessions"));
    assert.equal(await readFile(path.join(shadow, "config.toml"), "utf8"), "model='native'");
    await assert.rejects(lstat(path.join(shadow, "auth.json")), { code: "ENOENT" });
    await symlink(path.join(shared, "auth.json"), path.join(shadow, "auth.json"));
    await assert.rejects(codexEnvironment(context), /private file/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Codex telemetry accumulates thread deltas per turn and forwards sparse account limits", async () => {
  const f = await fixture();
  try {
    const updates: NativeUsageUpdate[] = [];
    const context = { ...f.context, env: { ...f.context.env, MODE: "telemetry" } };
    const result = await codexAdapter.run(context, { model: "native-codex-1", prompt: "fixture", onUsage: (update) => updates.push(update) });
    assert.equal(result.text, "native answer");
    assert.equal(updates.filter((update) => update.context).length, 3);
    const turns = updates.flatMap((update) => update.turn ? [update.turn] : []);
    assert.deepEqual(turns.map((turn) => turn.totals), [
      { uncachedInputTokens: 50, cachedInputTokens: 40, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      { uncachedInputTokens: 50, cachedInputTokens: 40, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      { uncachedInputTokens: 75, cachedInputTokens: 60, cacheCreationTokens: 15, outputTokens: 30, reasoningTokens: 7 },
    ]);
    assert.equal(updates.filter((update) => update.context).at(-1)?.context?.usedTokens, 60);
    assert.equal(updates.filter((update) => update.context).at(-1)?.context?.maxTokens, 200000);
    assert.deepEqual(updates[0]?.limits?.windows, [{ id: "primary", kind: "session", label: "Session", usedPercent: 30, windowDurationMins: 300, resetsAt: "2030-03-17T17:46:40.000Z" }]);
    const failure = new Error("usage consumer failed");
    await assert.rejects(codexAdapter.run(context, { model: "native-codex-1", prompt: "fixture", onUsage: () => { throw failure; } }), (error) => error === failure);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

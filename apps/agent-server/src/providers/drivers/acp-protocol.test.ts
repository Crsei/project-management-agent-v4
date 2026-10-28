import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { acpModels, acpRecord, openAcpClient, type AcpClientOptions } from "./acp.ts";
import { acpRegistryAdapter } from "./acpRegistry.ts";
import { acpAuthMethods, acpAuthenticationRequest, acpCredentialEnvironment, authenticateAcp } from "./acp-auth.ts";
import { readAcpAuthenticationConfirmation, writeAcpAuthenticationConfirmation } from "./acp-auth-state.ts";

// A real child-process ACP peer: exercises byte framing and bidirectional JSON-RPC.
const agent = String.raw`
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const mode = process.env.ACP_TEST_MODE;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const answer = (id,result) => send({id,result});
const pending = new Map(); let prompt; let seq=0;
const request = (method,params) => { const id='agent-'+(++seq); const gate=Promise.withResolvers(); pending.set(id,gate); send({id,method,params}); return gate.promise; };
const update = update => send({method:'session/update',params:{sessionId:'native-session',update}});
createInterface({input:process.stdin}).on('line',line=>{ void (async()=>{
 const frame=JSON.parse(line); const p=frame.params||{};
 if(!frame.method) { const gate=pending.get(frame.id); if(gate) { pending.delete(frame.id); frame.error?gate.reject(Error(frame.error.message)):gate.resolve(frame.result); } return; }
 if(process.env.ACP_TEST_LOG) appendFileSync(process.env.ACP_TEST_LOG,frame.method+'\n');
 switch(frame.method){
 case 'initialize': answer(frame.id,mode==='v2'?{protocolVersion:2,info:{name:'fixture'},capabilities:{session:{}},authMethods:[{type:'agent',methodId:'browser',name:'Browser'}]}:{protocolVersion:2,agentInfo:{name:'legacy-shaped'},agentCapabilities:{loadSession:true,auth:{logout:{}}},authMethods:[{id:'browser',name:'Browser',type:'agent'},{id:'key',name:'Key',type:'env_var',vars:[{name:'FIXTURE_API_KEY',label:'Fixture key'}]}],_meta:{modelState:{currentModelId:'one',availableModels:[{modelId:'one',name:'One'}]}}}); break;
 case 'authenticate': case 'auth/login':
   if(p.methodId==='browser') await request('elicitation/create',{mode:'url',url:'https://example.test/login',elicitationId:'consent',message:'Sign in'});
   answer(frame.id,{}); break;
 case 'session/new': case 'session/load': case 'session/resume':
   if(mode==='credentials' && process.env.FIXTURE_API_KEY!=='verified-secret') { send({id:frame.id,error:{code:-32000,message:'Authentication required'}}); break; }
   answer(frame.id,{sessionId:p.sessionId||'native-session',configOptions:[{type:'select',configId:'chosen-model',id:'chosen-model',category:'model',name:'Model',currentValue:'one',options:[{value:'one',name:'One'},{value:'two',name:'Two'}]}]}); break;
 case 'session/set_config_option': if(p.value!=='two') throw Error('wrong selected model'); answer(frame.id,{configOptions:[{type:'select',configId:'chosen-model',category:'model',currentValue:'two',options:[]}]}); break;
 case 'logout': case 'auth/logout': answer(frame.id,{}); break;
 case 'session/prompt':
   prompt=frame;
   if(mode==='cancel') { update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'not final'}}); break; }
   if(mode==='grok-error') {
      const id=p._meta.promptId;
      send({method:'_x.ai/session_notification',params:{sessionId:'native-session',update:{sessionUpdate:'turn_completed',prompt_id:'task-completed-background',stop_reason:'end_turn'}}});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'partial'}});
      send({method:'_x.ai/session/prompt_complete',params:{sessionId:'native-session',promptId:id,stopReason:'error',agentResult:'native failure'}}); break;
   }
   if(mode==='grok-question') {
     const response=await request('_x.ai/ask_user_question',{sessionId:'native-session',toolCallId:'question-1',mode:'default',questions:[{question:'Scope?',options:[{label:'Workspace'},{label:'Session'}]}]});
     if(response.outcome!=='accepted'||response.answers['Scope?'][0]!=='Workspace') throw Error('question answer was not delivered');
     const denied=await request('session/request_permission',{sessionId:'native-session',options:[{optionId:'deny',kind:'reject_once'},{optionId:'allow',kind:'allow_once'}]});
     if(denied.outcome.optionId!=='deny') throw Error('permission bypass');
   }
   if(mode==='terminal') {
     const created=await request('terminal/create',{sessionId:'native-session',command:process.execPath,args:['-e','process.stdout.write("0123456789")'],outputByteLimit:5});
     await request('terminal/wait_for_exit',{sessionId:'native-session',terminalId:created.terminalId});
     const output=await request('terminal/output',{sessionId:'native-session',terminalId:created.terminalId});
     if(output.output!=='56789'||!output.truncated) throw Error('terminal output not bounded');
     await request('terminal/release',{sessionId:'native-session',terminalId:created.terminalId});
     const denied=await request('session/request_permission',{sessionId:'native-session',options:[{optionId:'deny',kind:'reject_once'},{optionId:'allow',kind:'allow_once'}]});
     if(denied.outcome.optionId!=='deny') throw Error('permission bypass');
   }
   if(mode==='malformed'){ process.stdout.write('not-json\n'); break; }
   if(mode==='telemetry' || mode==='v2') {
     send({method:'session/update',params:{sessionId:'other-session',update:{sessionUpdate:'usage_update',used:999,size:1000}}});
     update({sessionUpdate:'usage_update',used:250,size:1000,cost:{amount:0.4,currency:'USD'}});
     update({sessionUpdate:'usage_update',used:-1,size:0});
   }
   if(mode==='v2') answer(frame.id,{});
   const wire=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好'}}}})+'\n');
   process.stdout.write(wire.subarray(0,wire.length-4)); process.stdout.write(wire.subarray(wire.length-4));
   if(mode==='v2') setImmediate(()=>update({sessionUpdate:'state_update',state:'idle',stopReason:'end_turn',usage:{inputTokens:7,outputTokens:2,totalTokens:300,thoughtTokens:1,cachedInputTokens:0,cacheCreationTokens:0}}));
   else answer(frame.id,mode==='telemetry'?{stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5,cachedInputTokens:4,cacheCreationTokens:2,thoughtTokens:3}}:mode==='telemetry-partial'?{stopReason:'end_turn',usage:{input_tokens:12,output_tokens:4,cached_input_tokens:3,cache_creation_tokens:'invalid'}}:{stopReason:'end_turn'});
   break;
 case 'session/cancel': setImmediate(()=>answer(prompt.id,{stopReason:'cancelled'})); break;
 default: send({id:frame.id,error:{code:-32601,message:'Unsupported fixture method'}});
 }
})().catch(error=>{process.stderr.write(String(error));process.exit(1)});});
`;

async function fixture(mode: string, options: AcpClientOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-acp-test-")); const home = path.join(root, "home"); await mkdir(home);
  const context: ProviderDriverContext = { instanceId: "acp-test", driver: "acpRegistry", config: { source: "local" }, homeDirectory: home, cwd: root, revision: 1, env: { ...process.env, HOME: home, ACP_TEST_MODE: mode, ACP_TEST_LOG: path.join(root, "wire.log") } };
  const spawn = { command: process.execPath, args: ["-e", agent], env: context.env };
  const client = await openAcpClient(context, spawn, options);
  return { context, spawn, client, async dispose() { client.close(); await client.waitForClose(); await rm(root, { recursive: true, force: true }); } };
}

test("ACP negotiates by response shape, configures models and resumes a real session", async () => {
  const f = await fixture("v1");
  try {
    const initialized = await f.client.initialize(); assert.equal(f.client.generation, 1); assert.equal(acpModels(initialized)[0]?.id, "one");
    assert.equal(acpAuthMethods(initialized).find((method) => method.id === "key")?.fields?.[0]?.name, "FIXTURE_API_KEY");
    await f.client.start("native-session"); await f.client.setModel("two");
    const deltas: string[] = []; assert.equal((await f.client.prompt("hello", (delta) => deltas.push(delta))).text, "你好"); assert.deepEqual(deltas, ["你好"]);
    assert.match(await readFile(String(f.context.env.ACP_TEST_LOG), "utf8"), /session\/load\nsession\/set_config_option\nsession\/prompt/);
  } finally { await f.dispose(); }
});
test("ACP v2 waits for idle terminal update instead of treating acknowledgement as success", async () => {
  const f = await fixture("v2");
  try {
    await f.client.start();
    const updates: NativeUsageUpdate[] = [];
    const result = await f.client.prompt("hello", undefined, undefined, undefined, undefined, (update) => updates.push(update));
    assert.equal(f.client.generation, 2); assert.equal(result.text, "你好"); assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2 });
    assert.deepEqual(updates.flatMap((update) => update.context ? [update.context.usedTokens] : []), [250, 300]);
    assert.deepEqual(updates.at(-1)?.turn?.totals, { uncachedInputTokens: 7, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 2, reasoningTokens: 1 });
  } finally { await f.dispose(); }
});
test("ACP telemetry uses real session context and per-turn counts without changing output", async () => {
  const f = await fixture("telemetry");
  const updates: NativeUsageUpdate[] = [];
  try {
    await f.client.start();
    const result = await f.client.prompt("hello", undefined, undefined, undefined, undefined, (update) => updates.push(update));
    assert.equal(result.text, "你好");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(updates.length, 2);
    assert.equal(updates[0]?.context?.usedTokens, 250);
    assert.equal(updates[0]?.context?.maxTokens, 1000);
    assert.deepEqual(updates[1]?.turn?.totals, { uncachedInputTokens: 4, cachedInputTokens: 4, cacheCreationTokens: 2, outputTokens: 5, reasoningTokens: 3 });
  } finally { await f.dispose(); }
});
test("ACP emits partial real turn counters without inventing missing cache fields", async () => {
  const f = await fixture("telemetry-partial");
  try {
    await f.client.start();
    const updates: NativeUsageUpdate[] = [];
    await f.client.prompt("hello", undefined, undefined, undefined, undefined, (update) => updates.push(update));
    assert.deepEqual(updates, [{ reportedTurn: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 } }]);
    const failure = new Error("partial usage consumer failed");
    await assert.rejects(f.client.prompt("hello", undefined, undefined, undefined, undefined, () => { throw failure; }), (error) => error === failure);
  } finally { await f.dispose(); }
});
test("ACP registry forwards telemetry and preserves callback errors", async () => {
  const f = await fixture("telemetry");
  try {
    const context = { ...f.context, config: { source: "local", commandPath: process.execPath, commandArgs: ["-e", agent] } };
    const updates: NativeUsageUpdate[] = [];
    const result = await acpRegistryAdapter.run(context, { model: "default", prompt: "hello", onUsage: (update) => updates.push(update) });
    assert.equal(result.text, "你好"); assert.equal(updates.length, 2);
    const failure = new Error("usage consumer failed");
    await assert.rejects(acpRegistryAdapter.run(context, { model: "default", prompt: "hello", onUsage: () => { throw failure; } }), (error) => error === failure);
  } finally { await f.dispose(); }
});
test("ACP cancellation waits native terminal and never returns partial text", async () => {
  const controller = new AbortController(); const f = await fixture("cancel");
  try {
    await f.client.start();
    await assert.rejects(f.client.prompt("hello", () => controller.abort(), controller.signal), { name: "AbortError" });
    assert.match(await readFile(String(f.context.env.ACP_TEST_LOG), "utf8"), /session\/cancel/);
  } finally { await f.dispose(); }
});
test("ACP terminals execute, bound UTF-8 output, release resources and deny unapproved permissions", async () => {
  const f = await fixture("terminal", { clientCapabilities: { terminal: true } });
  try { await f.client.start(); assert.equal((await f.client.prompt("hello")).text, "你好"); } finally { await f.dispose(); }
});
test("ACP native terminal and rejected permission are projected during a real prompt", async () => {
  const f = await fixture("terminal", { clientCapabilities: { terminal: true } });
  const events: NativeOutputEvent[] = [];
  try {
    await f.client.start();
    await f.client.prompt("hello", undefined, undefined, (event) => events.push(event));
    assert.equal(events.flatMap((event) => event.type === "command.output" ? [event.chunk] : []).join(""), "0123456789");
    assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "command_execution" && event.item.status === "completed"));
    assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "approval_request" && event.item.request?.respondable === false));
    assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.text === "你好"));
  } finally { await f.dispose(); }
});
test("Grok completion excludes background wakes and preserves native failure", async () => {
  const f = await fixture("grok-error", { grokCompletion: true });
  try { await f.client.start(); await assert.rejects(f.client.prompt("hello"), /native failure/); } finally { await f.dispose(); }
});
test("Grok native informational questions are answered while permissions remain denied", async () => {
  const f = await fixture("grok-question", { grokCompletion: true });
  const events: NativeOutputEvent[] = [];
  try {
    await f.client.start();
    await f.client.prompt("hello", undefined, undefined, (event) => events.push(event), async (request) => {
      assert.equal(request.kind, "user_input");
      return { answers: { "q:0": "option:0" } };
    });
    assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "approval_request" && event.item.request?.respondable === false));
  } finally { await f.dispose(); }
});
test("Malformed native ACP output fails the request instead of becoming successful partial output", async () => {
  const f = await fixture("malformed");
  try { await f.client.start(); await assert.rejects(f.client.prompt("hello"), /malformed JSON-RPC/); } finally { await f.dispose(); }
});
test("ACP browser auth emits explicit consent and accepts only a UI acknowledgement", async () => {
  const updates: unknown[] = []; const f = await fixture("v1");
  try {
    const handler = acpAuthenticationRequest({ signal: new AbortController().signal, readInput: async () => "continue", onUpdate: (update) => updates.push(update) }, () => 2);
    assert.deepEqual(await handler("elicitation/create", { mode: "url", url: "https://example.test/login", elicitationId: "consent" }), { action: "accept" });
    assert.equal(acpRecord(acpRecord(updates[0]).interaction).requiresConsent, true);
    await assert.rejects(handler("elicitation/create", { mode: "url", url: "file:///etc/passwd" }), /unsafe/);
  } finally { await f.dispose(); }
});
test("ACP credential auth verifies a native session before privately persisting instance-bound values", async () => {
  const f = await fixture("credentials");
  try {
    await authenticateAcp(f.context, f.spawn, { methodId: "key", values: { FIXTURE_API_KEY: "verified-secret" }, signal: new AbortController().signal, onUpdate() {}, readInput: async () => "" });
    assert.equal((await acpCredentialEnvironment(f.context)).FIXTURE_API_KEY, "verified-secret");
    assert.deepEqual(await acpCredentialEnvironment({ ...f.context, config: { source: "local", commandPath: "different-agent" } }), {});
    assert.deepEqual(await acpCredentialEnvironment({ ...f.context, env: { ...f.context.env, PROFILE: "changed" } }), {});
    assert.equal(await readAcpAuthenticationConfirmation(f.context), false);
    await writeAcpAuthenticationConfirmation(f.context, true);
    assert.equal(await readAcpAuthenticationConfirmation({ ...f.context }), true);
    assert.equal(await readAcpAuthenticationConfirmation({ ...f.context, env: { ...f.context.env, PROFILE: "changed" } }), false);
    await writeAcpAuthenticationConfirmation(f.context, false);
    assert.equal(await readAcpAuthenticationConfirmation(f.context), false);
  } finally { await f.dispose(); }
});

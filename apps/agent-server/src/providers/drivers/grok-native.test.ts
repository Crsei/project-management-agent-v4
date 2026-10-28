import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { acpCredentialEnvironment } from "./acp-auth.ts";
import { grokAdapter, parseGrokModelsOutput } from "./grok.ts";

const nativeGrok = String.raw`
const { appendFileSync }=require('node:fs');
const { createInterface }=require('node:readline');
const args=process.argv.slice(2); appendFileSync(process.env.GROK_TEST_LOG,JSON.stringify({args,home:process.env.GROK_HOME,updater:process.env.GROK_DISABLE_AUTOUPDATER})+'\n');
if(args[0]==='--version'){ console.log('grok 1.0.52'); process.exit(0); }
if(args[0]==='models'){ console.log('You are logged in\n* grok-native (default)'); process.exit(0); }
if(JSON.stringify(args)!==JSON.stringify(['--permission-mode','default','agent','stdio'])) throw Error('Unsafe or guessed native launch arguments');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line),p=frame.params||{}; appendFileSync(process.env.GROK_TEST_LOG,frame.method+'\n');
 if(frame.method==='initialize') return send({id:frame.id,result:{protocolVersion:1,agentInfo:{name:'Grok'},agentCapabilities:{loadSession:true,auth:{logout:{}}},authMethods:[{id:'cached_token',name:'Cached token'},{id:'grok.com',name:'Grok account'}],_meta:{modelState:{currentModelId:'grok-native',availableModels:[{modelId:'grok-native',name:'Grok native model'}]}}}});
 if(frame.method==='authenticate') {
   if(p.methodId!=='xai.api_key'||process.env.XAI_API_KEY!=='native-key') return send({id:frame.id,error:{code:-32000,message:'Authentication required'}});
   return send({id:frame.id,result:{}});
 }
 if(['session/new','session/load'].includes(frame.method)) return send({id:frame.id,result:{sessionId:p.sessionId||'grok-native-session',models:{currentModelId:'grok-native',availableModels:[{modelId:'grok-native',name:'Grok native model'}]}}});
 if(frame.method==='session/prompt') {
   send({method:'session/update',params:{sessionId:'grok-native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Native Grok result'}},_meta:{promptId:p._meta.promptId}}});
   send({method:'session/update',params:{sessionId:'grok-native-session',update:{sessionUpdate:'usage_update',used:2500,size:10000},_meta:{promptId:p._meta.promptId}}});
   return send({method:'_x.ai/session_notification',params:{sessionId:'grok-native-session',update:{sessionUpdate:'turn_completed',prompt_id:p._meta.promptId,stop_reason:'end_turn'}}});
 }
 if(frame.method==='logout') return send({id:frame.id,result:{}});
 send({id:frame.id,error:{code:-32601,message:'Unexpected method'}});
});
`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-grok-native-")); const home = path.join(root, "home"); await mkdir(home);
  const executable = path.join(root, "grok-fixture.cjs"); await writeFile(executable, `#!${process.execPath}\n${nativeGrok}`, { mode: 0o700 }); await chmod(executable, 0o700);
  const context: ProviderDriverContext = { instanceId: "grok-test", driver: "grok", config: grokAdapter.validateConfig({ binaryPath: executable }), homeDirectory: home, cwd: root, env: { HOME: home, PATH: process.env.PATH, GROK_TEST_LOG: path.join(root, "native.log") }, revision: 1 };
  return { context, root };
}
test("Grok model CLI parser preserves source login verdict and model identifiers", () => {
  assert.deepEqual(parseGrokModelsOutput("You are logged in\n* grok-4.7 (default)\n- grok-4.7\n- custom_model"), { authentication: "authenticated", models: [{ id: "grok-4.7", label: "Grok 4.7", source: "discovered", temperature: false }, { id: "custom_model", label: "custom model", source: "discovered", temperature: false }] });
  assert.equal(parseGrokModelsOutput("Not logged in").authentication, "unauthenticated");
  assert.equal(parseGrokModelsOutput("Login state unavailable").authentication, "unknown");
  assert.throws(() => grokAdapter.validateConfig({ apiKey: "not-a-native-setting" }));
});
test("Grok health discovers native metadata without authenticating or opening a workspace session", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const status = await grokAdapter.check(f.context);
  assert.equal(status.installation.status, "installed"); assert.equal(status.authentication, "authenticated"); assert.equal(status.models[0]?.label, "Grok native model");
  assert.equal(status.methods.some((method) => method.id === "xai.api_key" && method.fields?.[0]?.name === "XAI_API_KEY"), true);
  const log = await readFile(String(f.context.env.GROK_TEST_LOG), "utf8");
  assert.doesNotMatch(log, /session\/new|authenticate/);
  assert.match(log, /"updater":"1"/);
  assert.ok(log.includes(`"home":${JSON.stringify(f.context.homeDirectory)}`));
});
test("Grok native API-key auth persists only verified credentials and execution retains real native session", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await grokAdapter.authenticate(f.context, { methodId: "xai.api_key", values: { XAI_API_KEY: "native-key" }, signal: new AbortController().signal, onUpdate() {}, readInput: async () => "" });
  assert.equal((await acpCredentialEnvironment(f.context)).XAI_API_KEY, "native-key");
  const text: string[] = [];
  const result = await grokAdapter.run(f.context, { model: "grok-native", prompt: "hello", onText: (delta) => text.push(delta) });
  assert.equal(result.text, "Native Grok result"); assert.deepEqual(text, ["Native Grok result"]); assert.equal(result.nativeSession?.sessionId, "grok-native-session"); assert.equal(result.nativeSession?.driver, "grok");
  await grokAdapter.logout(f.context); assert.deepEqual(await acpCredentialEnvironment(f.context), {});
});

test("Grok forwards actual ACP context usage without changing output and propagates consumer failures", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const updates: Array<{ context?: { usedTokens: number; maxTokens?: number; updatedAt: string }; turn?: unknown }> = [];
  const output: string[] = [];
  const result = await grokAdapter.run(f.context, {
    model: "grok-native", prompt: "hello", onText: (delta) => output.push(delta), onUsage: (update) => updates.push(update),
  });
  assert.equal(result.text, "Native Grok result");
  assert.deepEqual(output, ["Native Grok result"]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.context?.usedTokens, 2500);
  assert.equal(updates[0]?.context?.maxTokens, 10000);
  assert.ok(Number.isFinite(Date.parse(updates[0]!.context!.updatedAt)));
  assert.equal(updates[0]?.turn, undefined);
  const failure = new Error("usage consumer failed");
  await assert.rejects(grokAdapter.run(f.context, {
    model: "grok-native", prompt: "hello", onUsage: () => { throw failure; },
  }), (error) => error === failure);
});

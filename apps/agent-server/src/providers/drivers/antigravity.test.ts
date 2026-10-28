import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { antigravityAdapter, buildAntigravityModelsFromSession } from "./antigravity.ts";
import { parseAntigravityAuthorizationUrl } from "./antigravity-auth.ts";

// A controlled local ACP peer, exercising the actual process/JSON-RPC transport.
const peerSource = `
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
const directory = join(process.env.GEMINI_HOME, 'antigravity-acp');
const trace = (value) => appendFileSync(join(process.env.HOME, 'trace.jsonl'), JSON.stringify(value) + '\\n');
trace({ event: 'spawn', args: process.argv.slice(2), home: process.env.HOME, geminiHome: process.env.GEMINI_HOME, credentials: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS), hostKey: Boolean(process.env.google_api_key), temp: process.env.TMPDIR, key: process.env.GEMINI_API_KEY, settings: JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8')) });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n');
let sessionId; let activePrompt; let model = 'model-a';
const config = () => [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: model, options: [{ group: 'native', options: [{ value: 'model-a', name: 'Account A' }, { value: 'model-b', name: 'Account B' }] }] }];
const delta = (text) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line); const { id, method, params = {} } = message;
  trace({ method, params });
  if (method === 'initialize') return reply(id, { protocolVersion: 2, agentInfo: { name: 'antigravity-acp', version: '1.3.0' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } }, authMethods: [{ id: 'oauth-personal', name: 'Google' }] });
  if (method === 'authenticate') {
    if (process.env.REJECT_CREDENTIALS) return error(id, -32602, 'Configured API key was rejected');
    if (!params.methodId.startsWith('oauth-') || existsSync(join(directory, 'signed-in'))) return reply(id, {});
    const state = 'opaque-native-state';
    const server = createServer((request, response) => {
      trace({ event: 'callback', path: request.url });
      writeFileSync(join(directory, 'signed-in'), 'authenticated');
      response.end('accepted'); server.close(); reply(id, {});
    });
    server.listen(0, '127.0.0.1', () => {
      const redirect = 'http://127.0.0.1:' + server.address().port + '/';
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + state;
      process.stdout.write('Open the following link to authenticate the ACP server: ' + url + '\\n');
    }); return;
  }
  if (method === 'session/new' || method === 'session/resume') {
    sessionId = params.sessionId || randomUUID();
    mkdirSync(join(directory, 'conversations'), { recursive: true });
    writeFileSync(join(directory, 'conversations', sessionId + '.meta'), JSON.stringify({ cwd: params.cwd }));
    writeFileSync(join(directory, 'conversations', sessionId + '.db'), 'native-history');
    return reply(id, { sessionId, configOptions: config() });
  }
  if (method === 'session/set_config_option') { model = params.value; return reply(id, { configOptions: config() }); }
  if (method === 'session/prompt') {
    const prompt = params.prompt[0].text;
    if (prompt === 'fail') { delta('not final'); return error(id, -32603, 'Native terminal failure'); }
    if (prompt === 'wait') { activePrompt = id; delta('partial'); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 45, size: 200 } } }) + '\\n');
    delta('answer'); return reply(id, { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 1 } });
  }
  if (method === 'session/cancel') { trace({ event: 'native-cancel' }); if (activePrompt) reply(activePrompt, { stopReason: 'cancelled' }); return; }
  if (method === 'logout') { writeFileSync(join(directory, 'signed-out'), 'yes'); return reply(id, {}); }
  return error(id, -32601, 'Unknown native method');
});
`;
async function fixture(config: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pm-antigravity-native-"));
  const home = join(root, "profile"); const cwd = join(root, "project"); const bin = join(root, "bin");
  await mkdir(home); await mkdir(cwd); await mkdir(bin);
  const executable = join(bin, "agy_acp_server.mjs");
  await writeFile(executable, `#!${process.execPath}\n${peerSource}`); await chmod(executable, 0o700);
  await writeFile(join(bin, "localharness_external"), "native harness is not invoked by this ACP peer\n"); await chmod(join(bin, "localharness_external"), 0o700);
  const context: ProviderDriverContext = { instanceId: "antigravity-test", driver: "antigravity", homeDirectory: home, cwd, env: { PATH: process.env.PATH, HOME: home, GOOGLE_APPLICATION_CREDENTIALS: "/host/adc", google_api_key: "host-key" }, revision: 1, config: { authMethod: "gemini-api-key", apiKey: "configured-native-key", binaryPath: executable, ...config } };
  const trace = async (): Promise<Record<string, unknown>[]> => (await readFile(join(home, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, home, cwd, context, trace };
}

test("Antigravity model discovery flattens account groups, deduplicates, and respects native model options", () => {
  assert.deepEqual(buildAntigravityModelsFromSession({ configOptions: [{ id: "model", type: "select", options: [{ value: "a", name: "A" }, { options: [{ value: "a", name: "duplicate" }, { value: "b", name: " " }] }] }] }).map(({ id, label }) => ({ id, label })), [{ id: "a", label: "A" }, { id: "b", label: "b" }]);
  assert.deepEqual(buildAntigravityModelsFromSession({ models: { availableModels: [{ modelId: "legacy", name: "Legacy" }] } }).map((model) => model.id), ["legacy"]);
  assert.deepEqual(buildAntigravityModelsFromSession({ configOptions: [{ id: "model", type: "boolean" }], models: { availableModels: [{ modelId: "not-a-select" }] } }), []);
});

test("native probe never spawns, authentication verifies real sessions, run/resume use exact ACP methods", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const probe = await antigravityAdapter.check(f.context);
    assert.equal(probe.authentication, "unknown"); assert.equal(probe.installation.status, "installed");
    await assert.rejects(readFile(join(f.home, "trace.jsonl")), { code: "ENOENT" });
    await antigravityAdapter.authenticate(f.context, { methodId: "gemini-api-key", signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => { throw new Error("Key authentication must not request browser input."); } });
    const status = await antigravityAdapter.check(f.context);
    assert.equal(status.authentication, "authenticated"); assert.deepEqual(status.models.map((model) => model.id), ["antigravity-default", "model-a", "model-b"]); assert.equal(status.canLogout, true);
    assert.deepEqual(await readdir(join(f.home, "antigravity-acp", "conversations")), []);
    const text: string[] = []; const usage: NativeUsageUpdate[] = [];
    const result = await antigravityAdapter.run(f.context, { model: "model-b", prompt: "hello", onText: (value) => text.push(value), onUsage: (update) => usage.push(update) });
    assert.equal(result.text, "answer"); assert.deepEqual(text, ["answer"]); assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 1 });
    assert.equal(usage[0]?.context?.usedTokens, 45); assert.equal(usage[0]?.context?.maxTokens, 200);
    assert.equal(usage.length, 2);
    assert.deepEqual(usage[1], { reportedTurn: { inputTokens: 3, outputTokens: 1 } });
    const callbackError = new Error("usage consumer failed");
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-b", prompt: "hello", onUsage: () => { throw callbackError; } }), (error) => error === callbackError);
    assert.match(result.nativeSession!.sessionId, /^[a-f0-9-]{36}$/);
    const resumed = await antigravityAdapter.run(f.context, { model: "model-b", prompt: "continue", resume: result.nativeSession });
    assert.equal(resumed.nativeSession!.sessionId, result.nativeSession!.sessionId);
    const messages = await f.trace(); const methods = messages.map((event) => event.method);
    assert.ok(methods.includes("authenticate")); assert.ok(methods.includes("session/resume")); assert.ok(methods.includes("session/set_config_option")); assert.equal(methods.includes("session/load"), false);
    const spawned = messages.find((event) => event.event === "spawn")!;
    assert.equal(spawned.home, f.home); assert.equal(spawned.geminiHome, f.home); assert.equal(spawned.credentials, false); assert.equal(spawned.hostKey, false); assert.equal(spawned.key, "configured-native-key");
    assert.deepEqual(spawned.args, process.platform === "linux" ? ["--uid="] : []);
    assert.deepEqual(await readdir(join(f.home, "antigravity-acp", "tmp")), []);
    assert.equal((await antigravityAdapter.check({ ...f.context, revision: 2 })).authentication, "unknown");
    await antigravityAdapter.logout(f.context);
    assert.equal((await antigravityAdapter.check(f.context)).authentication, "unauthenticated");
    assert.equal(await readFile(join(f.home, "antigravity-acp", "signed-out"), "utf8"), "yes");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("native cancel waits for terminal and rejects partial output; terminal errors cannot be reported as success", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    await assert.rejects(antigravityAdapter.run(f.context, { model: "antigravity-default", prompt: "wait", signal: controller.signal, onText: () => controller.abort() }), (error: unknown) => error instanceof Error && "code" in error && error.code === "aborted");
    assert.ok((await f.trace()).some((event) => event.event === "native-cancel"));
    await assert.rejects(antigravityAdapter.run(f.context, { model: "antigravity-default", prompt: "fail" }), /Native terminal failure/);
    await assert.rejects(antigravityAdapter.run(f.context, { model: "unavailable-account-model", prompt: "hello" }), /unavailable for this Google account/);
    await assert.rejects(antigravityAdapter.run(f.context, { model: "model-a", prompt: "hello", resume: { driver: "antigravity", providerInstanceId: "other", sessionId: "must-not-be-used" } }), /different provider/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("browser authentication forwards only a validated callback and learns models after native authentication", { skip: process.platform === "win32" }, async () => {
  const f = await fixture({ authMethod: "oauth-personal" });
  try {
    let redirect: string | undefined; let inputs = 0;
    await antigravityAdapter.authenticate(f.context, {
      signal: new AbortController().signal,
      onUpdate: (update) => { if (update.interaction?.type === "browser") { const authorization = parseAntigravityAuthorizationUrl(update.interaction.url); redirect = `${authorization.redirectUri}?state=${authorization.state}&code=approved`; } },
      readInput: async () => ++inputs === 1 ? "http://evil.invalid/?code=must-not-forward" : redirect!,
    });
    assert.equal(inputs, 2); assert.equal((await antigravityAdapter.check(f.context)).authentication, "authenticated");
    const callbacks = (await f.trace()).filter((event) => event.event === "callback"); assert.equal(callbacks.length, 1); assert.equal(callbacks[0]!.path, "/?state=opaque-native-state&code=approved");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejected native keys do not become authenticated and do not leak configured credentials", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    f.context.env.REJECT_CREDENTIALS = "1";
    await assert.rejects(antigravityAdapter.authenticate(f.context, { signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => "" }), /rejected the configured credentials/);
    assert.notEqual((await antigravityAdapter.check(f.context)).authentication, "authenticated");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

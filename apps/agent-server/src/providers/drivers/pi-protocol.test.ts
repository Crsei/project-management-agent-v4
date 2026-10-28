import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { piAdapter, parsePiModels } from "./pi.ts";
import { piEnvironment, resolvePiLaunchArgs } from "./pi-config.ts";
import { makePiFramer, parsePiModelSlug } from "./pi-rpc.ts";
import { PiTurnOutput, piStateIsIdle } from "./pi-protocol.ts";
import { materializePiPermissions, PI_PERMISSION_READY } from "./pi-permissions.ts";

test("Pi uses LF-only records, preserves Unicode separators, and rejects oversized frames", () => {
  const frame = makePiFramer();
  const json = JSON.stringify({ type: "message_update", delta: "a\u2028b\u2029c" });
  assert.deepEqual(frame(json.slice(0, 12)), []);
  assert.deepEqual(frame(`${json.slice(12)}\r\n`), [json]);
  assert.throws(() => makePiFramer(3)("abcd"), /framing limit/);
});

test("Pi launchArgs preserve quoted native options and reserve only lifecycle/protocol arguments", () => {
  assert.deepEqual(resolvePiLaunchArgs('--provider=anthropic --model="a/b" --skill "a b" --tools= --extension-flag=x'), ["--provider", "anthropic", "--model", "a/b", "--skill", "a b", "--tools", "", "--extension-flag=x"]);
  assert.deepEqual(resolvePiLaunchArgs('--name --help'), ["--name", "--help"]);
  for (const value of ["--mode=json", "--resume x", "--no-session", "-- hello", "@prompt.txt", "--provider x", "--model"]) assert.throws(() => resolvePiLaunchArgs(value));
  assert.deepEqual(parsePiModelSlug("provider/model/variant"), { provider: "provider", modelId: "model/variant" });
  assert.throws(() => parsePiModelSlug("model"));
  assert.throws(() => piAdapter.validateConfig({ binaryPath: false }));
  assert.throws(() => piAdapter.validateConfig({ unknown: "x" }));
});

test("Pi waits for agent_settled, retains failures, and clears only confirmed successful native recovery", () => {
  const deltas: string[] = [];
  const turn = new PiTurnOutput((text) => deltas.push(text));
  turn.consume({ type: "message_start", message: { role: "assistant" } });
  assert.equal(turn.consume({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } }), false);
  turn.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "par" } });
  turn.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "quota exceeded", usage: { input: 5, output: 2 } } });
  assert.equal(turn.consume({ type: "agent_end" }), false);
  assert.equal(turn.failure, "quota exceeded");
  turn.consume({ type: "compaction_end", result: {} });
  assert.equal(turn.failure, "quota exceeded");
  turn.consume({ type: "compaction_end", willRetry: true, errorMessage: "compaction failed" });
  assert.equal(turn.failure, "quota exceeded");
  turn.consume({ type: "auto_retry_end", success: true });
  assert.equal(turn.failure, undefined);
  assert.equal(turn.consume({ type: "agent_settled" }), true);
  assert.equal(turn.text, "partial");
  assert.equal(deltas.join(""), "partial");
  assert.deepEqual(turn.usage, { inputTokens: 5, outputTokens: 2 });
  assert.equal(piStateIsIdle({ isStreaming: false, isCompacting: false, pendingMessageCount: 1 }), false);
  assert.equal(piStateIsIdle({ isStreaming: false, pendingMessageCount: 0 }), true);
});

test("Pi aggregates native message usage per turn without adding reasoning twice", () => {
  const updates: NativeUsageUpdate[] = [];
  const turn = new PiTurnOutput(undefined, undefined, (update) => updates.push(update));
  turn.consume({ type: "message_end", message: { role: "assistant", id: "one", provider: "demo", model: "model",
    usage: { input: 10, output: 6, cacheRead: 5, cacheWrite: 2, reasoning: 3, cost: { total: 0.01 } } } });
  turn.consume({ type: "message_end", message: { role: "assistant", id: "one", usage: { input: 10, output: 6 } } });
  turn.consume({ type: "message_end", message: { role: "assistant", id: "two", provider: "demo", model: "model",
    usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 1, reasoning: 9, cost: { total: 0.02 } } } });
  turn.consume({ type: "message_end", message: { role: "assistant" } });
  assert.deepEqual(updates, [
    { turn: { model: "demo/model", costUsd: 0.01, totals: { uncachedInputTokens: 10, cachedInputTokens: 5, cacheCreationTokens: 2, outputTokens: 6, reasoningTokens: 3 } }, reportedTurn: { inputTokens: 10, outputTokens: 6, cachedInputTokens: 5, cacheCreationTokens: 2, reasoningTokens: 3 } },
    { reportedTurn: { inputTokens: 14, outputTokens: 8, cachedInputTokens: 6, cacheCreationTokens: 3, reasoningTokens: 12 } },
  ]);
});
test("Pi accumulates partial native counts without inventing cache values or recounting messages", () => {
  const updates: NativeUsageUpdate[] = [];
  const turn = new PiTurnOutput(undefined, undefined, (update) => updates.push(update));
  turn.consume({ type: "message_end", message: { role: "assistant", id: "one", usage: { input: 10, output: 3, cacheRead: 2 } } });
  turn.consume({ type: "message_end", message: { role: "assistant", id: "one", usage: { input: 10, output: 3, cacheRead: 2 } } });
  turn.consume({ type: "message_end", message: { role: "assistant", id: "two", usage: { input: 4, output: 2, cacheRead: 1, reasoning: 1 } } });
  assert.deepEqual(updates, [
    { reportedTurn: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 } },
    { reportedTurn: { inputTokens: 14, outputTokens: 5, cachedInputTokens: 3 } },
  ]);
});

test("Pi projects indexed text, thinking, tools, command chunks and compaction as stable full items", () => {
  const events: NativeOutputEvent[] = [];
  const text: string[] = [];
  const turn = new PiTurnOutput((chunk) => text.push(chunk), (event) => events.push(event));
  turn.consume({ type: "message_start", message: { role: "assistant" } });
  turn.consume({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think" } });
  turn.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hel" } });
  turn.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } });
  turn.consume({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "thinking" }, { type: "text", text: "hello" }] } });
  turn.consume({ type: "tool_execution_start", toolCallId: "cmd", toolName: "bash", args: { command: "echo hi" } });
  turn.consume({ type: "tool_execution_update", toolCallId: "cmd", toolName: "bash", partialResult: { content: [{ type: "text", text: "h" }] } });
  turn.consume({ type: "tool_execution_end", toolCallId: "cmd", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi\n" }] } });
  turn.consume({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "a.ts", oldText: "old", newText: "new" } });
  turn.consume({ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", isError: true, result: { content: [{ type: "text", text: "failed" }], details: { patch: "-old\n+new" } } });
  turn.consume({ type: "tool_execution_update", toolCallId: "sub", toolName: "subagent", partialResult: { details: { results: [{ agent: "scout", task: "find files", messages: [{ role: "assistant", content: [{ type: "text", text: "searching" }] }] }] } } });
  turn.consume({ type: "tool_execution_end", toolCallId: "sub", toolName: "subagent", result: { details: { results: [{ agent: "scout", task: "find files", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "found" }] }] }] } } });
  turn.consume({ type: "compaction_start" });
  turn.consume({ type: "compaction_end", result: { summary: "summary" } });
  turn.consume({ type: "message_start", message: { role: "assistant" } });
  turn.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
  const items = events.flatMap((event) => event.type === "item.upsert" ? [event.item] : []);
  const latest = (id: string) => items.filter((item) => item.id === id).at(-1);
  assert.equal(latest("pi:message:1:reasoning:0")?.text, "thinking");
  assert.equal(latest("pi:message:1:assistant_message:1")?.text, "hello");
  assert.equal(latest("pi:message:1:assistant_message:1")?.status, "completed");
  assert.equal(latest("pi:message:2:assistant_message:0")?.text, "done");
  assert.deepEqual(events.filter((event) => event.type === "command.output").map((event) => event.chunk), ["h", "i\n"]);
  assert.deepEqual({ input: latest("pi:tool:cmd")?.input, output: latest("pi:tool:cmd")?.output, status: latest("pi:tool:cmd")?.status }, { input: { command: "echo hi" }, output: "hi\n", status: "completed" });
  assert.deepEqual({ type: latest("pi:tool:edit")?.type, diff: latest("pi:tool:edit")?.diff, status: latest("pi:tool:edit")?.status }, { type: "file_change", diff: "-old\n+new", status: "failed" });
  assert.equal(latest("pi:tool:sub:subagent:0")?.output, "found");
  assert.equal(latest("pi:tool:sub:subagent:0")?.status, "completed");
  assert.equal(latest("pi:tool:sub:subagent:0")?.parentItemId, "pi:tool:sub");
  assert.equal(latest("pi:compaction:1")?.text, "summary");
  assert.equal(latest("pi:compaction:1")?.status, "completed");
  assert.equal(text.join(""), "hello\n\ndone");
  assert.equal(turn.text, "hello\n\ndone");
});

test("Pi exposes extension UI as nonrespondable requests without inventing permissions", () => {
  const events: NativeOutputEvent[] = [];
  const turn = new PiTurnOutput(undefined, (event) => events.push(event));
  turn.consume({ type: "extension_ui_request", method: "notify", message: "extension ready" });
  turn.consume({ type: "extension_ui_request", method: "select", id: "pick", title: "Pick", options: ["one", "two"] });
  turn.consume({ type: "extension_ui_request", method: "confirm", id: "approval", title: "Run?" });
  turn.consume({ type: "compaction_start" });
  turn.consume({ type: "compaction_end", errorMessage: "failure" });
  const items = events.flatMap((event) => event.type === "item.upsert" ? [event.item] : []);
  assert.equal(items[0]?.type, "notification");
  assert.equal(items[1]?.request?.respondable, false);
  assert.deepEqual(items[1]?.request?.questions?.[0]?.options?.map((option) => option.id), ["one", "two"]);
  assert.equal(items[2]?.type, "approval_request");
  assert.equal(items[2]?.request?.respondable, false);
  assert.equal(items.at(-1)?.status, "failed");
});

test("Pi inventories require native provider/model identities", () => {
  assert.deepEqual(parsePiModels({ models: [{ provider: "p", id: "m", name: "Model" }, { provider: "p", id: "m" }] }).map((model) => model.id), ["p/m"]);
  assert.throws(() => parsePiModels({ models: [{ id: "m" }] }), /identity/);
  assert.throws(() => parsePiModels({}), /inventory/);
});

const fixtureSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('pi 0.84.3'); process.exit(0); }
if (!process.argv.includes('--mode') || process.argv[process.argv.indexOf('--mode') + 1] !== 'rpc') process.exit(12);
const home = process.env.PI_CODING_AGENT_DIR;
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
const session = path.join(home, 'sessions', 'native.jsonl');
fs.writeFileSync(session, '{}\\n');
const log = path.join(process.env.HOME, 'calls.jsonl');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv.includes('--extension') && process.env.PI_FIXTURE_BEHAVIOR !== 'guard-missing') send({ type: 'extension_ui_request', method: 'notify', message: ${JSON.stringify(PI_PERMISSION_READY)} });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(request) + '\\n');
  const respond = data => send({ type: 'response', command: request.type, id: request.id, success: true, data });
  if (request.type === 'get_state') respond({ sessionFile: session, isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  else if (request.type === 'get_session_stats') respond(process.env.PI_FIXTURE_BEHAVIOR === 'usage' ? { contextUsage: { tokens: 41, contextWindow: 1000 } } : {});
  else if (request.type === 'get_available_models') respond({ models: process.env.PI_FIXTURE_BEHAVIOR === 'unauthenticated' ? [] : [{ provider: 'demo', id: 'model', name: 'Demo' }] });
  else if (request.type === 'prompt') {
    if (process.env.PI_FIXTURE_BEHAVIOR === 'early-exit') process.exit(0);
    send({ type: 'agent_start' });
    send({ type: 'message_start', message: { role: 'assistant' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'native answer' } });
    if (process.env.PI_FIXTURE_BEHAVIOR === 'approval') { send({ type: 'extension_ui_request', id: 'approve-test', method: 'confirm', title: 'Run command?' }); return; }
    if (process.env.PI_FIXTURE_BEHAVIOR === 'cancel') return;
    send({ type: 'message_end', message: { role: 'assistant', provider: 'demo', model: 'model', content: [{ type: 'text', text: 'native answer' }], stopReason: 'stop', ...(process.env.PI_FIXTURE_BEHAVIOR === 'usage' ? { usage: { input: 10, output: 4, cacheRead: 5, cacheWrite: 2, reasoning: 1, cost: { total: 0.01 } } } : {}) } });
    send({ type: 'agent_end' });
    send({ type: 'agent_settled', aborted: false });
    respond({});
  } else if (request.type === 'abort') process.exit(0);
  else respond({});
});
`;

async function withPiFixture(work: (context: ProviderDriverContext) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-protocol-"));
  const binaryPath = path.join(root, "pi-fixture.cjs");
  const homeDirectory = path.join(root, "home");
  await mkdir(homeDirectory);
  await writeFile(binaryPath, fixtureSource);
  await chmod(binaryPath, 0o700);
  try { await work({ instanceId: "pi-test", driver: "pi", config: { binaryPath, launchArgs: "--thinking high" }, homeDirectory, cwd: root, env: { PATH: process.env.PATH, HOME: "/must-not-use-global", PI_CODING_AGENT_DIR: "/must-not-use-global-pi" }, revision: 2 }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("Pi adapter discovers native auth/models, selects model, streams, persists session identity, and resumes", () => withPiFixture(async (context) => {
  assert.equal(piEnvironment(context).PI_CODING_AGENT_DIR, path.join(context.homeDirectory, ".pi", "agent"));
  const status = await piAdapter.check(context);
  assert.equal(status.authentication, "authenticated");
  assert.deepEqual(status.models.map((model) => model.id), ["default", "demo/model"]);
  const deltas: string[] = [];
  const events: NativeOutputEvent[] = [];
  const first = await piAdapter.run(context, { model: "demo/model", prompt: "hello", onText: (delta) => deltas.push(delta), onEvent: (event) => events.push(event) });
  assert.equal(first.text, "native answer");
  assert.equal(deltas.join(""), "native answer");
  assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.status === "completed" && event.item.text === "native answer"));
  assert.ok(first.nativeSession?.sessionId.startsWith(context.homeDirectory));
  const second = await piAdapter.run(context, { model: "default", prompt: "again", resume: first.nativeSession });
  assert.equal(second.nativeSession?.sessionId, first.nativeSession?.sessionId);
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.type === "set_model" && call.provider === "demo" && call.modelId === "model"));
  assert.ok(calls.some((call) => call.type === "switch_session" && call.sessionPath === first.nativeSession?.sessionId));
  assert.ok(calls.some((call) => call.type === "prompt" && call.streamingBehavior === "steer"));
}));

test("Pi never treats zero exit as turn success, and cancellation rejects partial text", () => withPiFixture(async (context) => {
  context.env.PI_FIXTURE_BEHAVIOR = "early-exit";
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello" }), /exited|closed/);
  context.env.PI_FIXTURE_BEHAVIOR = "cancel";
  const controller = new AbortController();
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello", signal: controller.signal, onText: () => controller.abort() }), (error: unknown) => error instanceof Error && "code" in error && error.code === "aborted");
}));

test("Pi propagates output consumer failures from the RPC event stream", () => withPiFixture(async (context) => {
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello", onEvent: () => { throw new Error("consumer failed"); } }), /consumer failed/);
}));

test("Pi adapter reports native turn usage and actual context, propagating callback failures", () => withPiFixture(async (context) => {
  context.env.PI_FIXTURE_BEHAVIOR = "usage";
  const updates: NativeUsageUpdate[] = [];
  const result = await piAdapter.run(context, { model: "demo/model", prompt: "hello", onUsage: (update) => updates.push(update) });
  assert.equal(result.text, "native answer");
  assert.deepEqual(updates[0], { turn: { model: "demo/model", costUsd: 0.01,
    totals: { uncachedInputTokens: 10, cachedInputTokens: 5, cacheCreationTokens: 2, outputTokens: 4, reasoningTokens: 1 } },
    reportedTurn: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 5, cacheCreationTokens: 2, reasoningTokens: 1 } });
  assert.deepEqual(updates[1]?.context && { ...updates[1].context, updatedAt: "timestamp" },
    { usedTokens: 41, maxTokens: 1000, model: "demo/model", updatedAt: "timestamp" });
  const failure = new Error("usage callback failed");
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello", onUsage: () => { throw failure; } }), (error) => error === failure);
  const contextFailure = new Error("context callback failed");
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello", onUsage: (update) => { if (update.context) throw contextFailure; } }), (error) => error === contextFailure);
}));

test("Pi omits telemetry when neither message usage nor actual context is reported", () => withPiFixture(async (context) => {
  const updates: NativeUsageUpdate[] = [];
  const result = await piAdapter.run(context, { model: "default", prompt: "hello", onUsage: (update) => updates.push(update) });
  assert.equal(result.text, "native answer");
  assert.deepEqual(updates, []);
}));

test("Pi manual login resolves only after native credential inventory is authenticated", () => withPiFixture(async (context) => {
  const options = { methodId: "external-login", signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => "ready" };
  context.env.PI_FIXTURE_BEHAVIOR = "unauthenticated";
  await assert.rejects(piAdapter.authenticate(context, options), /no usable models/);
  delete context.env.PI_FIXTURE_BEHAVIOR;
  await piAdapter.authenticate(context, options);
}));

test("Pi never approves native interactive actions or accepts a foreign workspace session", () => withPiFixture(async (context) => {
  context.env.PI_FIXTURE_BEHAVIOR = "approval";
  const events: NativeOutputEvent[] = [];
  let called = false;
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello", onEvent: (event) => events.push(event), onRequest: async () => { called = true; return { optionId: "approve" }; } }), /did not approve/);
  assert.equal(called, false);
  assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "approval_request" && event.item.request?.respondable === false));
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!calls.some((call) => call.type === "extension_ui_response" && call.confirmed === true));
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello", resume: { providerInstanceId: context.instanceId, driver: "pi", sessionId: "foreign", cwd: "/foreign-workspace" } }), /different.*workspace/);
}));

test("Pi fails closed before prompting when its mandatory permission extension is not active", () => withPiFixture(async (context) => {
  context.env.PI_FIXTURE_BEHAVIOR = "guard-missing";
  await assert.rejects(piAdapter.run(context, { model: "default", prompt: "hello" }), /permission guard/);
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!calls.some((call) => call.type === "prompt"));
}));

test("Pi loads the source-native blocking permission hook, allowing read tools but not silently allowing writes", () => withPiFixture(async (context) => {
  const filename = await materializePiPermissions(context.homeDirectory);
  // Intentional module-loading boundary: exercise the exact extension artifact consumed by Pi.
  const extension = await import(pathToFileURL(filename).href);
  const handlers = new Map<string, (event: Record<string, unknown>, context: unknown) => unknown>();
  extension.default({ on: (name: string, handler: (event: Record<string, unknown>, context: unknown) => unknown) => handlers.set(name, handler), getAllTools: () => [{ name: "tool_search", sourceInfo: { path: "user-extension" } }] });
  let prompts = 0;
  const nativeContext = { ui: { confirm: async () => { prompts++; return false; }, notify: () => {} }, signal: new AbortController().signal };
  assert.equal(await handlers.get("tool_call")!({ toolName: "read" }, nativeContext), undefined);
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "write", input: { path: "file" } }, nativeContext), { block: true, reason: "write was declined in Agent PM." });
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "tool_search", input: {} }, nativeContext), { block: true, reason: "tool_search was declined in Agent PM." });
  assert.equal(prompts, 2);
}));

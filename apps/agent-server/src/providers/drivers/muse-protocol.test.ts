import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { museAdapter } from "./muse.ts";
import { museEnvironment, validateMuseConfig } from "./muse-sdk.ts";
import { MuseTurnOutput, parseMuseModels } from "./muse-protocol.ts";

test("Muse consumes MSP item revisions/deltas and only its own native terminal", () => {
  const deltas: string[] = [];
  const turn = new MuseTurnOutput("session", "turn", (delta) => deltas.push(delta));
  turn.consume("item/started", { sessionId: "other", item: { itemId: "foreign", revision: 1, status: "inProgress", kind: "agentMessage", turnId: "turn", text: "wrong" } });
  turn.consume("item/started", { sessionId: "session", item: { itemId: "message", revision: 1, status: "inProgress", kind: "agentMessage", turnId: "turn", text: "a" } });
  turn.consume("item/delta", { sessionId: "session", itemId: "message", delta: "nswer" });
  turn.consume("item/updated", { sessionId: "session", item: { itemId: "message", revision: 1, status: "inProgress", kind: "agentMessage", turnId: "turn", text: "stale" } });
  assert.equal(turn.consume("turn/completed", { sessionId: "session", turnId: "other", terminal: "completed" }), false);
  assert.equal(turn.consume("turn/completed", { sessionId: "session", turnId: "turn", terminal: "completed", usage: { inputTokens: 5, outputTokens: 3 } }), true);
  assert.equal(turn.text, "answer");
  assert.equal(deltas.join(""), "answer");
  assert.deepEqual(turn.usage, { inputTokens: 5, outputTokens: 3 });
});

test("Muse preserves native failure and rejects missing/truncated response data", () => {
  const failed = new MuseTurnOutput("s", "t");
  failed.consume("turn/completed", { turnId: "t", terminal: "failed", error: { message: "not authenticated" } });
  assert.equal(failed.terminal, "failed");
  assert.equal(failed.failure, "not authenticated");
  const truncated = new MuseTurnOutput("s", "t");
  truncated.consume("item/completed", { item: { itemId: "i", turnId: "t", revision: 1, status: "completed", kind: "agentMessage", text: "partial", truncated: true } });
  assert.throws(() => truncated.consume("turn/completed", { turnId: "t", terminal: "completed" }), /truncated/);
  assert.throws(() => new MuseTurnOutput("s", "t").consume("view/gap", { sessionId: "s" }), /lost/);
  assert.throws(() => parseMuseModels({ providerId: "other", models: [] }), /another provider/);
  assert.throws(() => validateMuseConfig({ binaryPath: false }));
  assert.throws(() => validateMuseConfig({ launchArgs: "--unsafe" }));
});

test("Muse projects full native item revisions, streamed fields, command chunks, and todos", () => {
  const events: NativeOutputEvent[] = [];
  const turn = new MuseTurnOutput("s", "t", undefined, (event) => events.push(event));
  const item = (value: Record<string, unknown>) => ({ sessionId: "s", item: { turnId: "t", revision: 1, status: "inProgress", ...value } });
  turn.consume("item/started", item({ itemId: "thought", kind: "reasoning", summary: ["think"] }));
  turn.consume("item/delta", { itemId: "thought", field: "summary.0", delta: " more" });
  turn.consume("item/started", item({ itemId: "cmd", kind: "toolCall", tool: "shell", args: '{"command":"pwd"}' }));
  turn.consume("item/delta", { itemId: "cmd", field: "output", delta: "one" });
  turn.consume("item/delta", { itemId: "cmd", field: "visibleOutput", delta: " two" });
  turn.consume("item/completed", item({ itemId: "cmd", kind: "toolCall", tool: "shell", revision: 2, status: "completed", args: '{"command":"pwd"}', visibleOutput: "one two", exitCode: 0 }));
  turn.consume("item/updated", item({ itemId: "cmd", kind: "toolCall", tool: "shell", revision: 1, visibleOutput: "stale" }));
  turn.consume("item/completed", item({ itemId: "edit", kind: "toolCall", tool: "edit_file", status: "completed", args: '{"path":"a.ts","old_string":"a","new_string":"b"}' }));
  turn.consume("item/completed", item({ itemId: "web", kind: "toolCall", tool: "web_search", status: "completed", args: '{"query":"q"}', visibleOutput: '{"results":[{"title":"A","url":"https://example.com","snippet":"B"}]}' }));
  turn.consume("item/completed", item({ itemId: "agent", kind: "subagent", status: "failed", objective: "Research", childSessionId: "child", failureReason: "failure", result: { summary: "result" } }));
  turn.consume("turn/started", { sessionId: "s", turnId: "joined" });
  turn.consume("item/completed", item({ itemId: "joined-message", turnId: "joined", kind: "agentMessage", status: "completed", text: "joined" }));
  assert.equal(turn.consume("turn/completed", { sessionId: "s", turnId: "joined", terminal: "completed" }), false);
  turn.consume("item/updated", item({ itemId: "workflow", kind: "workflow", children: [{ childId: "child-a", attempt: 1, status: "running", label: "Agent A" }, { childId: "child-b", attempt: 2, status: "completed", terminal: "completed", failureKind: "failure", failureReason: "failed child" }] }));
  turn.consume("session/todoListChanged", { sessionId: "s", items: [{ text: "first", status: "completed" }, { text: "second", status: "inProgress" }] });
  const items = events.flatMap((event) => event.type === "item.upsert" ? [event.item] : []);
  assert.equal(items.filter((value) => value.id === "muse:item:thought").at(-1)?.text, "think more");
  const command = items.filter((value) => value.id === "muse:item:cmd").at(-1);
  assert.equal(command?.type, "command_execution");
  assert.equal(command?.status, "completed");
  assert.equal(command?.input, "pwd");
  assert.equal(command?.output, "one two");
  assert.equal(command?.exitCode, 0);
  assert.deepEqual(events.flatMap((event) => event.type === "command.output" ? [event.chunk] : []), ["one", " two"]);
  assert.deepEqual(items.find((value) => value.id === "muse:item:edit")?.newText, "b");
  assert.equal(items.find((value) => value.id === "muse:item:web")?.results?.[0]?.url, "https://example.com");
  assert.equal(items.find((value) => value.id === "muse:item:agent")?.childSessionId, "child");
  assert.equal(items.find((value) => value.id === "muse:item:joined-message")?.text, "joined");
  assert.equal(items.find((value) => value.id === "muse:workflow:workflow:child-a:1")?.parentItemId, "muse:item:workflow");
  assert.equal(items.find((value) => value.id === "muse:workflow:workflow:child-b:2")?.status, "failed");
  assert.deepEqual(items.find((value) => value.id === "muse:todo")?.steps?.map((step) => step.status), ["completed", "running"]);
});

const fixtureSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('muse 1.1.1'); process.exit(0); }
if (process.argv.includes('login')) { fs.writeFileSync(path.join(process.env.HOME, 'login-home'), process.env.HOME); process.exit(process.env.MUSE_FIXTURE_BEHAVIOR === 'login-fail' ? 3 : 0); }
if (!process.argv.includes('serve')) process.exit(12);
fs.appendFileSync(path.join(process.env.HOME, 'launch.jsonl'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, noUpdate: process.env.MUSE_NO_AUTO_UPDATE }) + '\\n');
const calls = path.join(process.env.HOME, 'calls.jsonl');
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
let activeTurn;
const input = require('node:readline').createInterface({ input: process.stdin });
input.on('line', line => {
  const frame = JSON.parse(line);
  if (!('id' in frame)) return;
  const params = frame.params || {};
  fs.appendFileSync(calls, JSON.stringify({ method: frame.method, params }) + '\\n');
  let result = {};
  const respond = value => send({ jsonrpc: '2.0', id: frame.id, result: value });
  if (frame.method === 'initialize') result = { schema: { version: 1, fingerprint: 't3-native-fixture' }, grantedCapabilities: [] };
  else if (frame.method === 'model/list') result = { providerId: 'meta', models: [{ modelId: 'muse-native', displayLabel: 'Native', providerId: 'meta', isDefault: true, variants: ['low', 'high'] }] };
  else if (frame.method === 'session/start' || frame.method === 'session/resume') result = { session: { sessionId: params.sessionId, modelId: frame.method === 'session/resume' ? 'old-model' : params.modelId } };
  else if (frame.method === 'turn/start') {
    if (process.env.MUSE_FIXTURE_BEHAVIOR === 'early-exit') process.exit(0);
    const sessionId = params.sessionId;
    const turnId = params.commandId;
    if (process.env.MUSE_FIXTURE_BEHAVIOR === 'approval') {
      notify('approval/requested', { sessionId, turnId, approvalId: 'approval-test', currentRequirementId: { approvalId: 'approval-test', sourceIndex: 0 }, availableChoices: [{ choiceId: 'deny-test', decision: 'denied', scope: 'once', label: 'Deny' }] });
      return respond({ turnId });
    }
    if (['question', 'question-answer', 'question-expired'].includes(process.env.MUSE_FIXTURE_BEHAVIOR)) {
      activeTurn = { sessionId, turnId };
      notify('userInput/requested', { sessionId, turnId, userInputId: 'question-test', questions: [{ id: 'q', header: 'Question', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }], selection: { mode: 'multiple', minSelections: 1, maxSelections: 2 } }] });
      if (process.env.MUSE_FIXTURE_BEHAVIOR === 'question-expired') {
        notify('userInput/settled', { sessionId, userInputId: 'question-test', outcome: 'timedOut' });
        notify('turn/completed', { sessionId, turnId, terminal: 'completed' });
      }
      return respond({ turnId });
    }
    if (process.env.MUSE_FIXTURE_BEHAVIOR === 'references') {
      notify('item/completed', { sessionId, item: { itemId: 'cmd', turnId, revision: 1, status: 'completed', kind: 'toolCall', tool: 'shell', args: '{"command":"echo"}', visibleOutput: 'short', truncated: true, outputRef: { id: 'output', availability: 'available' } } });
      notify('item/completed', { sessionId, item: { itemId: 'edit', turnId, revision: 1, status: 'completed', kind: 'toolCall', tool: 'edit_file', args: '{"path":"a"}', patchRef: { id: 'patch', availability: 'available' } } });
    }
    if (['telemetry', 'telemetry-partial', 'telemetry-optional'].includes(process.env.MUSE_FIXTURE_BEHAVIOR)) {
      notify('usage/changed', { window: { usedPercent: 103, windowDurationMins: 300, resetsAtMs: 1791465557000 }, weekly: { usedPercent: 5, resetsAtMs: 1791763200000 } });
      notify('usage/changed', { weekly: { usedPercent: 7 } });
      notify('session/contextUsage', { sessionId: 'other-session', usedTokens: 999 });
      notify('session/contextUsage', { sessionId, usedTokens: 250, windowTokens: 1000 });
      notify('session/tokenUsage', { sessionId, turnId: 'other-turn', promptTokens: 999, usage: { inputTokens: 999, outputTokens: 1 } });
      notify('session/tokenUsage', { sessionId, turnId, promptTokens: 100, usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5 } });
      notify('session/tokenUsage', { sessionId, turnId, promptTokens: 50, usage: { inputTokens: 50, outputTokens: 10, cachedTokens: 20, ...(process.env.MUSE_FIXTURE_BEHAVIOR === 'telemetry' ? { cacheWriteTokens: 0 } : process.env.MUSE_FIXTURE_BEHAVIOR === 'telemetry-partial' ? { cacheWriteTokens: 'invalid' } : {}), reasoningTokens: 2 } });
    }
    notify('item/started', { sessionId, item: { itemId: 'answer', revision: 1, status: 'inProgress', kind: 'agentMessage', turnId, text: '' } });
    notify('item/delta', { sessionId, itemId: 'answer', delta: 'native answer' });
    if (process.env.MUSE_FIXTURE_BEHAVIOR === 'cancel') return respond({ turnId });
    notify('item/completed', { sessionId, item: { itemId: 'answer', revision: 2, status: 'completed', kind: 'agentMessage', turnId, text: 'native answer' } });
    notify('turn/completed', { sessionId, turnId, terminal: process.env.MUSE_FIXTURE_BEHAVIOR === 'failed' ? 'failed' : 'completed', ...(process.env.MUSE_FIXTURE_BEHAVIOR === 'failed' ? { error: { message: 'not authenticated' } } : {}), ...(['telemetry', 'telemetry-partial', 'telemetry-optional'].includes(process.env.MUSE_FIXTURE_BEHAVIOR) ? { usage: { inputTokens: 150, outputTokens: 30, cachedTokens: 80, cacheWriteTokens: 10, reasoningTokens: 7 } } : {}) });
    return respond({ turnId });
  } else if ((frame.method === 'userInput/answer' || frame.method === 'userInput/cancel') && process.env.MUSE_FIXTURE_BEHAVIOR === 'question-answer') {
    notify('userInput/settled', { sessionId: activeTurn.sessionId, userInputId: 'question-test', outcome: frame.method === 'userInput/answer' ? 'answered' : 'cancelled' });
    notify('turn/completed', { sessionId: activeTurn.sessionId, turnId: activeTurn.turnId, terminal: 'completed' });
  } else if (frame.method === 'item/readOutput') {
    const content = params.outputRef === 'patch' ? '{"files":[{"path":"a"}]}' : 'short full command output';
    const start = params.offsetBytes;
    const page = content.slice(start, start + 5);
    result = { content: page, encoding: 'utf8', byteLen: Buffer.byteLength(page), offsetBytes: start, eof: start + page.length === content.length, mediaType: 'text/plain' };
  } else if (frame.method === 'turn/interrupt') result = { commandId: params.commandId };
  respond(result);
});
`;

async function withMuseFixture(work: (context: ProviderDriverContext) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "muse-native-protocol-"));
  const binaryPath = path.join(root, "muse-fixture.cjs");
  const homeDirectory = path.join(root, "home");
  await mkdir(homeDirectory);
  await writeFile(binaryPath, fixtureSource);
  await chmod(binaryPath, 0o700);
  try { await work({ instanceId: "muse-test", driver: "muse", config: { binaryPath }, homeDirectory, cwd: root, env: { PATH: process.env.PATH, HOME: "/must-not-use-global" }, revision: 3 }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("Muse SDK initializes exact MSP, preserves unknown auth, discovers models, streams native terminal, and resumes", () => withMuseFixture(async (context) => {
  assert.equal(museEnvironment(context).HOME, context.homeDirectory);
  const status = await museAdapter.check(context);
  assert.equal(status.authentication, "unknown");
  assert.deepEqual(status.models.map((model) => model.id), ["muse-native"]);
  const deltas: string[] = [];
  const events: NativeOutputEvent[] = [];
  const first = await museAdapter.run(context, { model: "default", prompt: "hello", onText: (delta) => deltas.push(delta), onEvent: (event) => events.push(event) });
  assert.equal(first.text, "native answer");
  assert.equal(deltas.join(""), "native answer");
  assert.equal(events.filter((event) => event.type === "item.upsert").at(-1)?.item.text, "native answer");
  const resumed = await museAdapter.run(context, { model: "muse-native", prompt: "again", resume: first.nativeSession });
  assert.equal(resumed.nativeSession?.sessionId, first.nativeSession?.sessionId);
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === "session/start" && call.params.providerId === "meta" && call.params.permissionProfile === ":ask-me" && call.params.approvalMode === "promptUnmatched"));
  assert.ok(calls.some((call) => call.method === "session/setModel" && call.params.model.modelId === "muse-native"));
  assert.ok(calls.some((call) => call.method === "turn/start" && call.params.workspaceRoots[0] === context.cwd && call.params.commandId === first.nativeSession?.turnId));
  const launches = (await readFile(path.join(context.homeDirectory, "launch.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(launches[0].args, ["serve", "--disable-shell", "--disable-write", "--no-session-log"]);
  assert.deepEqual(launches[1].args, ["serve", "--trust-workspace"]);
  assert.ok(launches.every((launch) => launch.home === context.homeDirectory && launch.noUpdate === "1"));
}));
test("Muse forwards sparse limits, actual context and cumulative per-turn model-call usage", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "telemetry";
  const updates: NativeUsageUpdate[] = [];
  const result = await museAdapter.run(context, { model: "muse-native", prompt: "hello", onUsage: (update) => updates.push(update) });
  assert.equal(result.text, "native answer");
  assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 30 });
  const limits = updates.flatMap((update) => update.limits ? [update.limits] : []);
  assert.equal(limits.length, 2);
  assert.deepEqual(limits[0]?.windows.map((window) => [window.id, window.usedPercent]), [["session", 100], ["weekly", 5]]);
  assert.deepEqual(limits[1]?.windows.map((window) => [window.id, window.usedPercent]), [["weekly", 7]]);
  const contexts = updates.flatMap((update) => update.context ? [update.context] : []);
  assert.equal(contexts.length, 1); assert.equal(contexts[0]?.usedTokens, 250); assert.equal(contexts[0]?.maxTokens, 1000);
  const turns = updates.flatMap((update) => update.turn ? [update.turn.totals] : []);
  assert.deepEqual(turns, [
    { uncachedInputTokens: 30, cachedInputTokens: 60, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 5 },
    { uncachedInputTokens: 60, cachedInputTokens: 80, cacheCreationTokens: 10, outputTokens: 30, reasoningTokens: 7 },
    { uncachedInputTokens: 60, cachedInputTokens: 80, cacheCreationTokens: 10, outputTokens: 30, reasoningTokens: 7 },
  ]);
}));
test("Muse does not publish a false cumulative total after malformed usage", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "telemetry-partial";
  const updates: NativeUsageUpdate[] = [];
  await museAdapter.run(context, { model: "muse-native", prompt: "hello", onUsage: (update) => updates.push(update) });
  const turns = updates.flatMap((update) => update.turn ? [update.turn.totals] : []);
  assert.deepEqual(turns, [{ uncachedInputTokens: 30, cachedInputTokens: 60, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 5 }]);
  assert.deepEqual(updates.flatMap((update) => update.reportedTurn ? [update.reportedTurn] : []), [
    { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, cacheCreationTokens: 10, reasoningTokens: 5 },
    { inputTokens: 150, outputTokens: 30, cachedInputTokens: 80, reasoningTokens: 7 },
    { inputTokens: 150, outputTokens: 30, cachedInputTokens: 80, cacheCreationTokens: 10, reasoningTokens: 7 },
  ]);
}));
test("Muse does not infer zero for omitted cache writes", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "telemetry-optional";
  const updates: NativeUsageUpdate[] = [];
  await museAdapter.run(context, { model: "muse-native", prompt: "hello", onUsage: (update) => updates.push(update) });
  const turns = updates.flatMap((update) => update.turn ? [update.turn.totals] : []);
  assert.deepEqual(turns, [{ uncachedInputTokens: 30, cachedInputTokens: 60, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 5 }]);
  assert.deepEqual(updates.flatMap((update) => update.reportedTurn ? [update.reportedTurn] : [])[1],
    { inputTokens: 150, outputTokens: 30, cachedInputTokens: 80, reasoningTokens: 7 });
}));
test("Muse rejects with the original usage callback error", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "telemetry";
  const failure = new Error("usage consumer failed");
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", onUsage: () => { throw failure; } }), (error) => error === failure);
}));

test("Muse requires successful native terminal and cancellation never returns partial output", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "failed";
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello" }), /not authenticated/);
  context.env.MUSE_FIXTURE_BEHAVIOR = "early-exit";
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello" }), /exited|closed|EOF/);
  context.env.MUSE_FIXTURE_BEHAVIOR = "cancel";
  const controller = new AbortController();
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", signal: controller.signal, onText: () => controller.abort() }), (error: unknown) => error instanceof Error && "code" in error && error.code === "aborted");
}));

test("Muse login is the actual CLI in its dedicated home, and nonzero exit cannot authenticate", () => withMuseFixture(async (context) => {
  const options = { methodId: "cli-login", signal: new AbortController().signal, onUpdate: () => {}, readInput: () => Promise.withResolvers<string>().promise };
  context.env.MUSE_FIXTURE_BEHAVIOR = "login-fail";
  await assert.rejects(museAdapter.authenticate(context, options), /unsuccessfully/);
  delete context.env.MUSE_FIXTURE_BEHAVIOR;
  await museAdapter.authenticate(context, options);
  assert.equal(await readFile(path.join(context.homeDirectory, "login-home"), "utf8"), context.homeDirectory);
  assert.equal((await museAdapter.check(context)).authentication, "unknown");
}));

test("Muse denies native approval requests and rejects foreign workspace session references", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "approval";
  const events: NativeOutputEvent[] = [];
  let requested = false;
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", onEvent: (event) => events.push(event), onRequest: async () => { requested = true; return { optionId: "allow" }; } }), /did not approve/);
  assert.equal(requested, false);
  const approval = events.find((event) => event.type === "item.upsert" && event.item.type === "approval_request");
  assert.ok(approval && approval.type === "item.upsert" && approval.item.request?.respondable === false);
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === "approval/decide" && call.params.choiceId === "deny-test"));
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", resume: { providerInstanceId: context.instanceId, driver: "muse", sessionId: "foreign", cwd: "/foreign-workspace" } }), /different.*workspace/);
}));

test("Muse exposes unavailable questions and propagates consumer errors", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "question";
  const events: NativeOutputEvent[] = [];
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", onEvent: (event) => events.push(event) }), /interactive input/);
  const question = events.find((event) => event.type === "item.upsert" && event.item.type === "user_input_request");
  assert.ok(question && question.type === "item.upsert" && question.item.request?.respondable === false);
  assert.equal(question.item.request?.questions?.[0]?.prompt, "Choose");
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === "userInput/cancel" && call.params.userInputId === "question-test"));
  delete context.env.MUSE_FIXTURE_BEHAVIOR;
  const failure = new Error("consumer failure");
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", onEvent: () => { throw failure; } }), (error) => error === failure);
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", onText: () => { throw failure; } }), (error) => error === failure);
}));

test("Muse forwards informational answers and cancellation through native commands", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "question-answer";
  const events: NativeOutputEvent[] = [];
  await museAdapter.run(context, { model: "muse-native", prompt: "hello", onEvent: (event) => events.push(event), onRequest: async (request) => {
    assert.equal(request.respondable, true);
    assert.equal(request.kind, "user_input");
    assert.equal(request.questions?.[0]?.multiple, true);
    return { answers: { q: ["A", "B", "additional context"] } };
  } });
  let calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.find((call) => call.method === "userInput/answer")?.params.answers, [{ questionId: "q", selectedLabels: ["A", "B"], note: "additional context" }]);
  assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "completed" && event.item.request?.respondable === false));
  await museAdapter.run(context, { model: "muse-native", prompt: "hello", onRequest: async () => ({ cancelled: true }) });
  calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === "userInput/cancel" && call.params.reason === "User declined the question."));
  const error = new Error("question callback failed");
  await assert.rejects(museAdapter.run(context, { model: "muse-native", prompt: "hello", onRequest: async () => { throw error; } }), (actual) => actual === error);
}));

test("Muse never sends an answer after the native question has expired", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "question-expired";
  const pending = Promise.withResolvers<{ answers: Record<string, string> }>();
  const events: NativeOutputEvent[] = [];
  await museAdapter.run(context, { model: "muse-native", prompt: "hello", onEvent: (event) => events.push(event), onRequest: () => pending.promise });
  pending.resolve({ answers: { q: "A" } });
  await Promise.resolve();
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!calls.some((call) => call.method === "userInput/answer"));
  assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "cancelled"));
}));

test("Muse accepts broker invalidation after native question settlement", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "question-expired";
  const pending = Promise.withResolvers<{ answers: Record<string, string> }>();
  const closed = Object.assign(new Error("The provider closed the interaction."), { code: "native_interaction_closed" });
  await museAdapter.run(context, {
    model: "muse-native",
    prompt: "hello",
    onEvent: (event) => {
      if (event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "cancelled") pending.reject(closed);
    },
    onRequest: () => pending.promise,
  });
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!calls.some((call) => call.method === "userInput/answer"));
}));

test("Muse reads paginated stored output and structured patches before completion", () => withMuseFixture(async (context) => {
  context.env.MUSE_FIXTURE_BEHAVIOR = "references";
  const events: NativeOutputEvent[] = [];
  const result = await museAdapter.run(context, { model: "muse-native", prompt: "hello", onEvent: (event) => events.push(event) });
  assert.equal(result.text, "native answer");
  const items = events.flatMap((event) => event.type === "item.upsert" ? [event.item] : []);
  const command = items.filter((item) => item.id === "muse:item:cmd").at(-1);
  assert.equal(command?.output, "short full command output");
  assert.equal(command?.outputTruncated, false);
  assert.deepEqual(items.find((item) => item.id === "muse:patch:edit")?.input, { files: [{ path: "a" }] });
  const calls = (await readFile(path.join(context.homeDirectory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.method === "item/readOutput" && call.params.outputRef === "output" && call.params.offsetBytes === 5));
}));

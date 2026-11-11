import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { chatRoutes } from "../chat.ts";
import { createProviderInstance } from "../providers/instances.ts";
import * as Effect from "effect/Effect";
import { startPmProviderApplication, stopPmProviderApplication } from "../providers/t3code/application.ts";
import { makePmProviderCredentials } from "../providers/t3code/credentials.ts";
import { codexDriver, makeCodexDriverLayer } from "../providers/t3code/families/codex.ts";
import { makePmProviderFamily } from "../providers/t3code/registration.ts";
import { generateThreadTitle } from "./thread-title.ts";
import { closeStore, writeRecord } from "./store.ts";
import { ensureThread, getThread, getThreadHistory, saveFormattedMessage, updateThread } from "./threads.ts";
import { getThreadSidebar, updateThreadSidebar } from "./thread-sidebar.ts";
import { getChatGeneration, type ChatGeneration } from "./chat-runtime.ts";
import { closeNativeInteractions, endNativeOutput, initializeNativeOutput, requestNativeInteraction, respondNativeInteraction, recoverNativeOutputs } from "./native-output.ts";

const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalFetch = globalThis.fetch;
const originalPmUrl = process.env.PM_API_URL;
const unavailablePmUrl = "http://127.0.0.1:1";
let networkRequests: string[];
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "thread-sidebar-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_API_URL = unavailablePmUrl;
  networkRequests = [];
  globalThis.fetch = async input => {
    networkRequests.push(input instanceof Request ? input.url : String(input));
    throw new Error("Network is unavailable.");
  };
});
afterEach(async () => {
  try {
    await stopPmProviderApplication();
  } finally {
    globalThis.fetch = originalFetch;
    closeStore();
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
      else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
      if (originalPmUrl === undefined) delete process.env.PM_API_URL;
      else process.env.PM_API_URL = originalPmUrl;
    }
  }
  // Optional provider catalog/version probes are not PM authorization requests.
  // They also fail: successful title generation cannot depend on connectivity.
  assert.deepEqual(networkRequests.filter(url => new URL(url).origin === unavailablePmUrl), [],
    "Sidebar and isolated title execution must not consult PM.");
});
const t = (day: number, hour = 0) => `2035-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
function seed(id: string) {
  ensureThread(id, "Original");
  const thread = { ...getThread(id)!, createdAt: t(1), updatedAt: t(1) };
  writeRecord("chat:threads", id, thread);
  return thread;
}
function generation(threadId: string, status: ChatGeneration["status"], createdAt = t(1), endedAt?: string) {
  const item: ChatGeneration = {
    id: `${threadId}-run`, threadId, messageId: "answer", parentId: null, status, createdAt, endedAt,
    seq: 0, request: { id: threadId, messages: [] }, providerInstanceId: "fixture",
    providerInstanceRevision: 1, modelId: "fixture", temperature: 1,
  };
  writeRecord("chat:generations", item.id, item);
  return item;
}

async function startTitleProvider() {
  await startPmProviderApplication({
    families: new Map([[codexDriver.driverKind, makePmProviderFamily(codexDriver, makeCodexDriverLayer)]]),
    protocols: new Map(),
  });
}

interface TitleCall {
  args: string[];
  input: string;
  cwd: string;
  home: string;
  secretEnv: boolean;
}

async function titlePeer(name: string, title: string, mcpOutput = JSON.stringify([
  { name: "external.server", enabled: true },
  { name: "already-off", enabled: false },
]), mcpExitCode = 0, gatePath?: string) {
  const executable = join(directory, name);
  const log = join(directory, `${name}.jsonl`);
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.156.1\\n"); process.exit(0); }
if (args.includes("--help")) process.exit(0);
const record = input => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args, input, cwd: process.cwd(), home: process.env.CODEX_HOME,
  secretEnv: Boolean(process.env.ACCESS_TOKEN || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.T3CODE_CODEX_LAUNCH_ARGS)
}) + "\\n");
// Native discovery has no stdin stream; only exec receives the title prompt.
if (args.includes("mcp") && args.includes("list")) {
  record("");
  process.stdout.write(${JSON.stringify(mcpOutput)});
  process.exit(${mcpExitCode});
}
if (args[0] !== "exec") process.exit(1);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  record(input);
  const finish = () => fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({title: ${JSON.stringify(title)}, needsRefinement: false}));
  ${gatePath
    ? `require("node:net").createConnection(${JSON.stringify(gatePath)}).on("error", () => process.exit(1)).on("end", finish).resume();`
    : "finish();"}
});
`);
  await chmod(executable, 0o700);
  return {
    executable,
    calls: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as TitleCall),
  };
}

async function titleGate(name: string) {
  const path = join(directory, `${name}.sock`);
  const started = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  let released = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    started.resolve();
    if (released) socket.end();
  });
  server.listen(path);
  await once(server, "listening");
  const release = () => {
    released = true;
    for (const socket of sockets) socket.end();
  };
  return {
    path,
    started: started.promise,
    release,
    async close() {
      release();
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    },
  };
}

async function assertIsolatedTitle(calls: TitleCall[], home: string, message: string) {
  assert.equal(calls.length, 2);
  const [enumeration, execution] = calls as [TitleCall, TitleCall];
  assert.ok(enumeration.args.includes("mcp") && enumeration.args.includes("list") && enumeration.args.includes("--json"));
  for (const call of calls) {
    assert.ok(call.args.includes("features.plugins=false"));
    assert.ok(call.args.includes("features.apps=false"));
    assert.equal(call.home, home);
    assert.notEqual(call.cwd, directory);
    assert.equal(call.cwd, execution.cwd);
  }
  assert.equal(execution.args[0], "exec");
  assert.ok(execution.args.includes("--ephemeral"));
  assert.equal(execution.args[execution.args.indexOf("-s") + 1], "read-only");
  assert.equal(execution.args[execution.args.indexOf("--model") + 1], "title-model");
  assert.ok(execution.args.includes('mcp_servers={"external.server"={enabled=false}}'));
  assert.ok(execution.input.includes(message));
  assert.match(execution.input, /untrusted/i);
  assert.match(execution.input, /do not use tools/i);
  await assert.rejects(stat(execution.cwd), { code: "ENOENT" });
  for (const flag of ["--output-schema", "--output-last-message"])
    await assert.rejects(stat(execution.args[execution.args.indexOf(flag) + 1]!), { code: "ENOENT" });
}

test("sidebar revisions are independent, persisted, conflict-safe and manual settle clears pin", () => {
  const thread = seed("one");
  const pinned = updateThreadSidebar("one", { action: "pin", revision: 0 }, t(1, 1));
  assert.equal(pinned.section, "pinned");
  assert.equal(getThread("one")!.revision, 0);
  updateThread("one", { settings: { ...thread.settings, systemPrompt: "changed" }, revision: 0 });
  assert.equal(getThread("one")!.revision, 1);
  assert.throws(() => updateThreadSidebar("one", { action: "unpin", revision: 0 }, t(1, 2)), /侧栏状态已更改/);
  assert.equal(updateThreadSidebar("one", { action: "pin", revision: 1 }, t(1, 2)).revision, 1);
  const settled = updateThreadSidebar("one", { action: "settle", revision: 1 }, t(1, 2));
  assert.equal(settled.section, "settled");
  assert.equal(settled.pinnedAt, null);
  closeStore();
  assert.deepEqual(getThreadSidebar(getThread("one")!, t(1, 3)), settled);
  assert.equal(getThread("one")!.revision, 1);
});

test("snooze survives success, wakes on failure, timer and pending input, and guards queued requests", async () => {
  const thread = seed("running");
  let run = generation("running", "running");
  assert.equal(getThreadSidebar(thread, t(1, 1)).running, true);
  let view = updateThreadSidebar("running", { action: "snooze", revision: 0, snoozedUntil: t(2) }, t(1, 1));
  run = { ...run, status: "completed", endedAt: t(1, 2) };
  writeRecord("chat:generations", run.id, run);
  assert.equal(getThreadSidebar(thread, t(1, 3)).section, "snoozed");
  run = { ...run, status: "failed", endedAt: t(1, 4) };
  writeRecord("chat:generations", run.id, run);
  view = getThreadSidebar(thread, t(1, 5));
  assert.equal(view.section, "active");
  assert.equal(view.snoozedUntil, null);
  view = updateThreadSidebar("running", { action: "snooze", revision: view.revision, snoozedUntil: t(2) }, t(1, 6));
  assert.equal(getThreadSidebar(thread, t(1, 7)).section, "snoozed");
  assert.equal(getThreadSidebar(thread, t(2)).section, "active");

  const waitingThread = seed("waiting");
  const waiting = generation("waiting", "running");
  view = updateThreadSidebar("waiting", { action: "snooze", revision: 0, snoozedUntil: t(2) }, t(1, 1));
  initializeNativeOutput(waiting.id, "waiting", "running");
  const closed = assert.rejects(requestNativeInteraction(waiting.id, {
    id: "q", itemId: "q", kind: "user_input", title: "Question", respondable: true,
    questions: [{ id: "answer", prompt: "Answer", allowText: true }],
  }));
  view = getThreadSidebar(waitingThread, t(1, 2));
  assert.equal(view.section, "active");
  assert.equal(view.canSnooze, false);
  assert.throws(() => updateThreadSidebar("waiting", { action: "snooze", revision: view.revision, snoozedUntil: t(2) }, t(1, 3)), /不能暂缓/);
  const queuedThread = seed("queued");
  generation("queued", "queued");
  assert.equal(getThreadSidebar(queuedThread, t(1, 1)).canSnooze, false);
  endNativeOutput(waiting.id, "cancelled");
  await closed;
});

test("sidebar activity uses generation authority and only live respondable waits, with terminal and SQLite recovery cleanup", async () => {
  const thread = seed("activity");
  assert.deepEqual(getThreadSidebar(thread, t(1, 1)).activity, { status: "idle" });
  let run = generation("activity", "queued");
  assert.deepEqual(getThreadSidebar(thread, t(1, 1)).activity, { status: "queued", generationId: run.id });
  run = { ...run, status: "running" };
  writeRecord("chat:generations", run.id, run);
  initializeNativeOutput(run.id, thread.remoteId, "running");
  assert.equal(getThreadSidebar(thread, t(1, 1)).activity.status, "running");
  const response = requestNativeInteraction(run.id, {
    id: "question", itemId: "question", kind: "user_input", title: "Question", respondable: true,
    questions: [{ id: "text", prompt: "Answer", allowText: true }],
  });
  assert.deepEqual(getThreadSidebar(thread, t(1, 1)).activity, { status: "waiting_input", generationId: run.id });
  const approval = requestNativeInteraction(run.id, {
    id: "approval", itemId: "approval", kind: "approval", title: "Approval", respondable: true,
    options: [{ id: "allow", label: "Allow" }],
  });
  assert.equal(getThreadSidebar(thread, t(1, 1)).activity.status, "waiting_approval");
  respondNativeInteraction(run.id, "approval", { optionId: "allow" });
  await approval;
  assert.equal(getThreadSidebar(thread, t(1, 1)).activity.status, "waiting_input");
  respondNativeInteraction(run.id, "question", { answers: { text: "Continue" } });
  await response;
  assert.equal(getThreadSidebar(thread, t(1, 1)).activity.status, "running");
  const rejected = assert.rejects(requestNativeInteraction(run.id, {
    id: "closing", itemId: "closing", kind: "approval", title: "Closing", respondable: true,
    options: [{ id: "allow", label: "Allow" }],
  }));
  closeNativeInteractions(run.id);
  await rejected;
  assert.equal(getThreadSidebar(thread, t(1, 1)).activity.status, "running");
  // A stale persisted wait is not a live channel, including before recovery runs.
  writeRecord("native-output", run.id, { generationId: run.id, threadId: thread.remoteId, sequence: 30, status: "running",
    items: [{ id: "old-wait", type: "user_input_request", status: "waiting",
      request: { id: "old-wait", itemId: "old-wait", kind: "user_input", title: "Stale", respondable: true } }] });
  closeStore();
  assert.equal(getThreadSidebar(getThread(thread.remoteId)!, t(1, 1)).activity.status, "running");
  recoverNativeOutputs();
  for (const status of ["failed", "cancelled", "interrupted", "completed"] as const) {
    writeRecord("chat:generations", run.id, { ...run, status, endedAt: t(1, 2) });
    const view = getThreadSidebar(thread, t(1, 3));
    assert.equal(view.activity.status, status === "completed" ? "idle" : status);
    assert.equal(view.running, false);
    assert.equal(view.canSnooze, true);
    assert.throws(() => respondNativeInteraction(run.id, "old-wait", { answers: { text: "stale" } }));
  }
  // A later terminal result cannot hide another still-active generation.
  writeRecord("chat:generations", "background", { ...run, id: "background", createdAt: t(1), status: "running" });
  writeRecord("chat:generations", run.id, { ...run, createdAt: t(1, 1), status: "failed", endedAt: t(1, 2) });
  assert.deepEqual(getThreadSidebar(thread, t(1, 3)).activity, { status: "running", generationId: "background" });
});

test("three-day inactivity settles only eligible threads; explicit override and wake prevent premature settling", () => {
  const thread = seed("idle");
  generation("idle", "completed", t(1), t(1, 1));
  assert.equal(getThreadSidebar(thread, t(4, 1)).section, "active");
  assert.equal(getThreadSidebar(thread, t(4, 2)).section, "settled");
  closeStore();
  let view = getThreadSidebar(getThread("idle")!, t(5));
  assert.equal(view.section, "settled");
  view = updateThreadSidebar("idle", { action: "unsettle", revision: view.revision }, t(5));
  assert.equal(getThreadSidebar(thread, t(9)).section, "active");
  const disabled = seed("disabled");
  updateThreadSidebar("disabled", { action: "auto-settle", enabled: false, revision: 0 }, t(1));
  assert.equal(getThreadSidebar(disabled, t(9)).section, "active");
  const pinned = seed("pinned");
  updateThreadSidebar("pinned", { action: "pin", revision: 0 }, t(1));
  assert.equal(getThreadSidebar(pinned, t(9)).section, "pinned");
  const awake = seed("awake");
  updateThreadSidebar("awake", { action: "snooze", revision: 0, snoozedUntil: t(5) }, t(1));
  assert.equal(getThreadSidebar(awake, t(5)).section, "active");
  assert.equal(getThreadSidebar(awake, t(8, 1)).section, "settled");
  const active = seed("active");
  generation("active", "running");
  assert.equal(getThreadSidebar(active, t(9)).section, "active");
});

test("unread visit watermark and explicit mark survive restart and subsequent completion", () => {
  const thread = seed("unread");
  let view = updateThreadSidebar("unread", { action: "visit", revision: 0 }, t(1, 1));
  const run = generation("unread", "completed", t(1, 2), t(1, 3));
  view = getThreadSidebar(thread, t(1, 4));
  assert.equal(view.unread, true);
  view = updateThreadSidebar("unread", { action: "visit", revision: view.revision }, t(1, 5));
  assert.equal(view.unread, false);
  view = updateThreadSidebar("unread", { action: "mark-unread", revision: view.revision }, t(1, 6));
  closeStore();
  assert.equal(getThreadSidebar(getThread("unread")!, t(1, 7)).unread, true);
  view = updateThreadSidebar("unread", { action: "visit", revision: view.revision }, t(1, 8));
  assert.equal(view.unread, false);
  writeRecord("chat:generations", run.id, { ...run, endedAt: t(1, 9) });
  assert.equal(getThreadSidebar(thread, t(1, 10)).unread, true);
});

test("a new user turn reactivates settled and snoozed threads without waking a continuation", () => {
  const thread = seed("new-turn");
  const old = generation("new-turn", "completed", t(1), t(1, 1));
  let view = updateThreadSidebar("new-turn", { action: "settle", revision: 0 }, t(1, 2));
  writeRecord("chat:generations", "continuation", { ...old, id: "continuation", continuationOf: old.id, status: "running", createdAt: t(1, 3), endedAt: undefined });
  assert.equal(getThreadSidebar(thread, t(1, 4)).section, "settled");
  writeRecord("chat:generations", "new-turn-user", { ...old, id: "new-turn-user", status: "running", createdAt: t(1, 5), endedAt: undefined });
  view = getThreadSidebar(thread, t(1, 6));
  assert.equal(view.section, "active");
  view = updateThreadSidebar("new-turn", { action: "snooze", revision: view.revision, snoozedUntil: t(2) }, t(1, 7));
  assert.equal(view.section, "snoozed");
  writeRecord("chat:generations", "new-turn-next", { ...old, id: "new-turn-next", status: "running", createdAt: t(1, 8), endedAt: undefined });
  assert.equal(getThreadSidebar(thread, t(1, 9)).section, "active");
});

test("sidebar and title routes work without PM and title unavailable preserves history", async () => {
  ensureThread("api", "Original");
  saveFormattedMessage("api", { id: "message", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Keep this" }] } });
  const history = getThreadHistory("api");
  const app = new Hono().route("/api", chatRoutes);
  const post = (path: string, body: object) => app.request(`http://localhost/api/chat/threads/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const pin = await post("sidebar", { action: "pin", revision: 0 });
  assert.equal(pin.status, 200);
  assert.equal((await pin.json()).thread.sidebar.section, "pinned");
  assert.equal((await post("sidebar", { action: "unpin", revision: 0 })).status, 409);
  const title = await post("regenerate-title", { revision: 0 });
  assert.equal(title.status, 503);
  assert.equal((await title.json()).code, "title_generation_unavailable");
  assert.equal(getThread("api")!.title, "Original");
  assert.deepEqual(getThreadHistory("api"), history);
});

test("Codex title helper uses isolated ephemeral read-only execution and leaves history intact", async () => {
  const peer = await titlePeer("codex-fixture", "Real generated title");
  const home = join(directory, "native-home");
  await mkdir(home);
  const workspaceFile = join(directory, "workspace.txt");
  const nativeHistory = join(home, "history.jsonl");
  await writeFile(workspaceFile, "Keep the workspace unchanged");
  await writeFile(nativeHistory, "Keep native history unchanged");
  const instance = createProviderInstance({ instanceId: "title-codex", driver: "codex", label: "Fixture",
    config: { binaryPath: peer.executable, homePath: home }, customModels: [{ id: "title-model", label: "Title model" }] });
  await startTitleProvider();
  ensureThread("title", "Original");
  updateThread("title", { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 }, revision: 0 });
  saveFormattedMessage("title", { id: "prompt", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Discuss a real topic" }] } });
  generation("title", "completed", t(1), t(1, 1));
  const history = getThreadHistory("title");
  const revision = getThread("title")!.revision;
  const app = new Hono().route("/api", chatRoutes);
  const regenerate = (revision: number) => app.request("http://localhost/api/chat/threads/title/regenerate-title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision }) });
  const result = await regenerate(revision);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).thread.title, "Real generated title");
  assert.deepEqual(getThreadHistory("title"), history);
  const calls = await peer.calls();
  await assertIsolatedTitle(calls, home, "Discuss a real topic");
  const current = getThread("title")!;
  updateThread("title", { settings: { ...current.settings, temperature: 0.5 }, revision: current.revision });
  assert.equal((await regenerate(current.revision)).status, 409);
  assert.equal(getThread("title")!.title, "Real generated title");
  assert.deepEqual(getThreadHistory("title"), history);
  assert.deepEqual(await peer.calls(), calls, "a stale settings revision must fail before native title dispatch");
  assert.equal(await readFile(workspaceFile, "utf8"), "Keep the workspace unchanged");
  assert.equal(await readFile(nativeHistory, "utf8"), "Keep native history unchanged");
});

test("managed Codex title uses the prepared runtime and broker without weakening title isolation", async () => {
  const peer = await titlePeer("codex", "Managed title");
  const instance = createProviderInstance({ instanceId: "managed-title", driver: "codex", label: "Managed fixture",
    config: { setupMode: "managed" }, environment: [
      { name: "PATH", value: `${directory}:${process.env.PATH ?? ""}`, sensitive: false },
      { name: "ACCESS_TOKEN", value: "fixture-only", sensitive: true },
      { name: "OPENAI_API_KEY", value: "fixture-only", sensitive: true },
      { name: "OPENAI_BASE_URL", value: "https://fixture.invalid", sensitive: false },
    ], customModels: [{ id: "title-model", label: "Title model" }] });
  // Seed only this fixture's source-owned store. Legacy credentials.json and
  // runtime/active.json are not the current provider's account/runtime contract.
  await Effect.runPromise(Effect.gen(function* () {
    const credentials = yield* makePmProviderCredentials()("codex-chatgpt", instance.instanceId);
    yield* credentials.set(new TextEncoder().encode(JSON.stringify({
      activeClientId: "oaiapp_fixture",
      sessions: [{ clientId: "oaiapp_fixture", subject: "fixture", email: null, accessToken: "fixture-only",
        refreshToken: null, expiresAt: Date.now() + 3600_000, earliestRefreshAt: null,
        scopes: ["chatgpt.tokens.use.direct"] }],
    })));
  }));
  await startTitleProvider();
  ensureThread("managed-title", "Original");
  updateThread("managed-title", { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 } });
  saveFormattedMessage("managed-title", { id: "prompt", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Managed title fixture" }] } });
  const original = getThread("managed-title")!;
  const history = getThreadHistory("managed-title");
  assert.equal(await generateThreadTitle(original), "Managed title");
  const calls = await peer.calls();
  await assertIsolatedTitle(calls, instance.homeDirectory, "Managed title fixture");
  for (const call of calls) {
    const command = call.args[0] === "exec" ? "exec" : "mcp list";
    assert.ok(call.args.includes('model_provider="openai_token_sharing"'), `${command} must select the managed provider`);
    assert.ok(call.args.some(arg => arg.startsWith("model_providers.openai_token_sharing=") && arg.includes("__managed-chatgpt-token")),
      `${command} must use the managed token broker`);
    assert.equal(call.secretEnv, false, `${command} must not receive stripped ambient credential overrides`);
  }
  assert.deepEqual(getThread("managed-title"), original);
  assert.deepEqual(getThreadHistory("managed-title"), history);
});

for (const failure of [
  { name: "malformed", output: "not-json", exitCode: 0 },
  { name: "invalid-schema", output: JSON.stringify([{ name: "external.server" }]), exitCode: 0 },
  { name: "nonzero", output: "[]", exitCode: 2 },
]) test(`Codex title generation fails closed on ${failure.name} MCP enumeration`, async () => {
    const peer = await titlePeer(`codex-invalid-${failure.name}`, "Must not generate", failure.output, failure.exitCode);
    const instance = createProviderInstance({ instanceId: `invalid-codex-${failure.name}`, driver: "codex", label: "Fixture",
      config: { binaryPath: peer.executable, homePath: join(directory, `home-${failure.name}`) },
      customModels: [{ id: "title-model", label: "Title model" }] });
    await startTitleProvider();
    const threadId = `failure-${failure.name}`;
    ensureThread(threadId, "Original");
    updateThread(threadId, { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 }, revision: 0 });
    saveFormattedMessage(threadId, { id: "prompt", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Keep this history" }] } });
    const original = getThread(threadId)!;
    const history = getThreadHistory(threadId);
    await assert.rejects(generateThreadTitle(original), { status: 503, code: "title_generation_unavailable" });
    const calls = await peer.calls();
    assert.equal(calls.length, 1, "enumeration failure must prevent inference dispatch");
    assert.ok(calls[0]!.args.includes("mcp") && calls[0]!.args.includes("list"));
    await assert.rejects(stat(calls[0]!.cwd), { code: "ENOENT" });
    assert.deepEqual(getThread(threadId), original);
    assert.deepEqual(getThreadHistory(threadId), history);
});

for (const status of ["queued", "running"] as const)
  test(`a ${status} generation prevents title dispatch without changing history`, async () => {
    const peer = await titlePeer("codex-busy", "Must not generate");
    const instance = createProviderInstance({ instanceId: "busy-title", driver: "codex", label: "Fixture",
      config: { binaryPath: peer.executable, homePath: join(directory, "native-home") },
      customModels: [{ id: "title-model", label: "Title model" }] });
    await startTitleProvider();
    ensureThread("busy-title", "Original");
    updateThread("busy-title", { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 } });
    saveFormattedMessage("busy-title", { id: "prompt", parent_id: null, format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "Keep this history" }] } });
    const run = generation("busy-title", status);
    const originalGeneration = getChatGeneration(run.id);
    const original = getThread("busy-title")!;
    const history = getThreadHistory("busy-title");
    const app = new Hono().route("/api", chatRoutes);
    const result = await app.request("http://localhost/api/chat/threads/busy-title/regenerate-title", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: original.revision }),
    });
    assert.equal(result.status, 409);
    assert.equal((await result.json()).code, "chat_busy");
    await assert.rejects(peer.calls(), { code: "ENOENT" });
    assert.deepEqual(getThread("busy-title"), original);
    assert.deepEqual(getThreadHistory("busy-title"), history);
    assert.deepEqual(getChatGeneration(run.id), originalGeneration);
  });

for (const change of ["settings", "manual-title", "archive", "history", "queued", "running", "completed"] as const)
  test(`title compare-and-swap rejects a concurrent ${change} change`, { timeout: 15000 }, async context => {
    const gate = await titleGate("title-race");
    context.after(() => gate.close());
    const peer = await titlePeer("codex-race", "Stale generated title", undefined, 0, gate.path);
    const home = join(directory, "native-home");
    const instance = createProviderInstance({ instanceId: "racing-title", driver: "codex", label: "Fixture",
      config: { binaryPath: peer.executable, homePath: home },
      customModels: [{ id: "title-model", label: "Title model" }] });
    await startTitleProvider();
    ensureThread("racing-title", "Original");
    updateThread("racing-title", { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 } });
    saveFormattedMessage("racing-title", { id: "prompt", parent_id: null, format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "Discuss this original topic" }] } });
    const original = getThread("racing-title")!;
    const app = new Hono().route("/api", chatRoutes);
    const pending = app.request("http://localhost/api/chat/threads/racing-title/regenerate-title", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: original.revision }), signal: context.signal,
    });
    try {
      await Promise.race([gate.started, Promise.resolve(pending).then(() => {
        throw new Error("Title generation ended before reaching the native execution gate.");
      })]);
      switch (change) {
        case "settings":
          updateThread("racing-title", { settings: { ...original.settings, temperature: 0.5 }, revision: original.revision });
          break;
        case "manual-title":
          updateThread("racing-title", { title: "User-chosen title", revision: original.revision });
          break;
        case "archive":
          updateThread("racing-title", { status: "archived", revision: original.revision });
          break;
        case "history":
          saveFormattedMessage("racing-title", { id: "new-prompt", parent_id: "prompt", format: "ai-sdk/v6",
            content: { role: "user", parts: [{ type: "text", text: "New topic after title dispatch" }] } });
          break;
        default:
          generation("racing-title", change, t(1), change === "completed" ? t(1, 1) : undefined);
      }
      const expectedThread = getThread("racing-title");
      const expectedHistory = getThreadHistory("racing-title");
      const expectedGeneration = getChatGeneration("racing-title-run");
      gate.release();
      const result = await pending;
      assert.equal(result.status, 409);
      assert.equal((await result.json()).code, "title_conflict");
      assert.deepEqual(getThread("racing-title"), expectedThread);
      assert.deepEqual(getThreadHistory("racing-title"), expectedHistory);
      assert.deepEqual(getChatGeneration("racing-title-run"), expectedGeneration);
      await assertIsolatedTitle(await peer.calls(), home, "Discuss this original topic");
    } finally {
      gate.release();
      await pending;
    }
  });

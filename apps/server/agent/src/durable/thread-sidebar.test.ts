import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { chatRoutes } from "../chat.ts";
import { createProviderInstance } from "../providers/instances.ts";
import { generateThreadTitle } from "./thread-title.ts";
import { closeStore, writeRecord } from "./store.ts";
import { ensureThread, getThread, getThreadHistory, saveFormattedMessage, updateThread } from "./threads.ts";
import { getThreadSidebar, updateThreadSidebar } from "./thread-sidebar.ts";
import type { ChatGeneration } from "./chat-runtime.ts";

const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalFetch = globalThis.fetch;
const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001" };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "thread-sidebar-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  closeStore();
  await rm(directory, { recursive: true, force: true });
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
});
const t = (day: number, hour = 0) => `2035-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
function seed(id: string) {
  ensureThread(id, "Original", scope);
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

test("snooze survives success, wakes on failure, timer and pending input, and guards queued requests", () => {
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
  writeRecord("native-output", waiting.id, { generationId: waiting.id, threadId: "waiting", sequence: 1, status: "running", items: [{ id: "q", type: "user_input_request", status: "waiting", request: { id: "q", itemId: "q", kind: "user_input", title: "Question", respondable: true } }] });
  view = getThreadSidebar(waitingThread, t(1, 2));
  assert.equal(view.section, "active");
  assert.equal(view.canSnooze, false);
  assert.throws(() => updateThreadSidebar("waiting", { action: "snooze", revision: view.revision, snoozedUntil: t(2) }, t(1, 3)), /不能暂缓/);
  const queuedThread = seed("queued");
  generation("queued", "queued");
  assert.equal(getThreadSidebar(queuedThread, t(1, 1)).canSnooze, false);
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

test("sidebar and title routes enforce PM scope and title unavailable preserves history", async () => {
  ensureThread("api", "Original", scope);
  saveFormattedMessage("api", { id: "message", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Keep this" }] } });
  const history = getThreadHistory("api");
  const area = { path: null, status: "unconfigured", revision: 1, source: null, canManage: false };
  let allowed = true;
  globalThis.fetch = async () => new Response(JSON.stringify({ workspaces: allowed ? [{ id: scope.workspaceId, name: "Workspace", fileArea: area, projects: [{ id: scope.projectId, name: "Project", fileArea: area }] }] : [] }), { status: 200, headers: { "content-type": "application/json" } });
  const app = new Hono().route("/api", chatRoutes);
  const post = (path: string, body: object) => app.request(`http://localhost/api/chat/threads/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  allowed = false;
  assert.equal((await post("sidebar", { action: "pin", revision: 0 })).status, 403);
  assert.equal((await post("regenerate-title", { revision: 0 })).status, 403);
  allowed = true;
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
  const executable = join(directory, "codex-fixture");
  const log = join(directory, "title-commands.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.TITLE_FIXTURE_LOG;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.appendFileSync(log, JSON.stringify({args, input, cwd: process.cwd(), home: process.env.CODEX_HOME}) + "\\n");
  if (args.includes("mcp")) process.stdout.write(JSON.stringify([{name: "external.server", enabled: true}]));
  else fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({title: "Real generated title"}));
});
`);
  await chmod(executable, 0o700);
  const instance = createProviderInstance({ instanceId: "title-codex", driver: "codex", label: "Fixture", config: { binaryPath: executable }, environment: [{ name: "TITLE_FIXTURE_LOG", value: log, sensitive: false }], customModels: [{ id: "title-model", label: "Title model" }] });
  ensureThread("title", "Original", scope);
  updateThread("title", { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 }, revision: 0 });
  saveFormattedMessage("title", { id: "prompt", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Discuss a real topic" }] } });
  const history = getThreadHistory("title");
  const area = { path: null, status: "unconfigured", revision: 1, source: null, canManage: false };
  globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).endsWith("/resolve")
    ? { scope, workspaceName: "Workspace", projectName: "Project", path: directory }
    : { workspaces: [{ id: scope.workspaceId, name: "Workspace", fileArea: area, projects: [{ id: scope.projectId, name: "Project", fileArea: area }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  const app = new Hono().route("/api", chatRoutes);
  const result = await app.request("http://localhost/api/chat/threads/title/regenerate-title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1 }) });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).thread.title, "Real generated title");
  assert.deepEqual(getThreadHistory("title"), history);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; input: string; cwd: string; home: string });
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.args.includes("mcp"));
  assert.ok(calls[1]!.args.includes("--ephemeral"));
  assert.ok(calls[1]!.args.includes("read-only"));
  assert.ok(calls[1]!.args.includes('mcp_servers={"external.server"={enabled=false}}'));
  assert.ok(calls[1]!.args.includes("features.plugins=false"));
  assert.ok(calls[1]!.input.includes("Discuss a real topic"));
  assert.notEqual(calls[1]!.cwd, directory);
});

test("managed Codex title uses the prepared runtime and broker without weakening title isolation", async () => {
  const binary = join(directory, "codex");
  const log = join(directory, "managed-title.jsonl");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.156.1\\n"); process.exit(0); }
if (args.includes("--help")) process.exit(0);
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.TITLE_FIXTURE_LOG, JSON.stringify({
    mcp: args.includes("mcp"), managed: args.some(arg => arg.includes('model_provider="openai_token_sharing"')),
    broker: args.some(arg => arg.includes("model_providers.openai_token_sharing=")),
    ephemeral: args.includes("--ephemeral"), readOnly: args.includes("read-only"),
    disabled: args.some(arg => arg.includes('mcp_servers=')),
    secretEnv: Boolean(process.env.ACCESS_TOKEN || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.T3CODE_CODEX_LAUNCH_ARGS)
  }) + "\\n");
  if (args.includes("mcp")) process.stdout.write(JSON.stringify([{name:"external.server",enabled:true}]));
  else fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({title:"Managed title"}));
});
`);
  await chmod(binary, 0o700);
  const instance = createProviderInstance({ instanceId: "managed-title", driver: "codex", label: "Managed fixture",
    config: { setupMode: "managed" }, environment: [
      { name: "PATH", value: `${directory}:${process.env.PATH ?? ""}`, sensitive: false },
      { name: "TITLE_FIXTURE_LOG", value: log, sensitive: false },
      { name: "ACCESS_TOKEN", value: "fixture-only", sensitive: true },
    ], customModels: [{ id: "title-model", label: "Title model" }] });
  const privateDir = join(instance.homeDirectory, ".managed-codex");
  await mkdir(join(privateDir, "runtime"), { recursive: true, mode: 0o700 });
  await writeFile(join(privateDir, "runtime", "active.json"), JSON.stringify({ source: "local", executable: binary, version: "0.156.1" }), { mode: 0o600 });
  await writeFile(join(privateDir, "credentials.json"), JSON.stringify({ hostId: "fixture", activeClientId: "fixture",
    profiles: [{ clientId: "fixture", subject: "fixture", idToken: "fixture", accessToken: "fixture-only",
      expiresAt: Date.now() + 3600_000, earliestRefreshAt: null, scopes: ["chatgpt.tokens.use.direct"] }] }), { mode: 0o600 });
  ensureThread("managed-title", "Original", scope);
  updateThread("managed-title", { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 } });
  saveFormattedMessage("managed-title", { id: "prompt", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Managed title fixture" }] } });
  globalThis.fetch = async () => new Response(JSON.stringify({ scope, workspaceName: "Workspace", projectName: "Project", path: directory }), { status: 200 });
  assert.equal(await generateThreadTitle(getThread("managed-title")!), "Managed title");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.managed && call.broker && !call.secretEnv));
  assert.ok(calls[0].mcp && calls[1].ephemeral && calls[1].readOnly && calls[1].disabled);
});

test("Codex title generation fails closed when MCP enumeration cannot be trusted", async () => {
  const executable = join(directory, "codex-invalid");
  const called = join(directory, "exec-called");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("exec")) fs.writeFileSync(process.env.CALL_MARKER, "unexpected");
else process.stdout.write("not-json");
`);
  await chmod(executable, 0o700);
  const instance = createProviderInstance({ instanceId: "invalid-codex", driver: "codex", label: "Fixture", config: { binaryPath: executable }, environment: [{ name: "CALL_MARKER", value: called, sensitive: false }], customModels: [{ id: "title-model", label: "Title model" }] });
  ensureThread("failure", "Original", scope);
  updateThread("failure", { settings: { providerInstanceId: instance.instanceId, model: "title-model", systemPrompt: "", temperature: 1 }, revision: 0 });
  saveFormattedMessage("failure", { id: "prompt", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Keep this history" }] } });
  const original = getThread("failure")!;
  const history = getThreadHistory("failure");
  globalThis.fetch = async () => new Response(JSON.stringify({ scope, workspaceName: "Workspace", projectName: "Project", path: directory }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(generateThreadTitle(original), /MCP/);
  await assert.rejects(readFile(called), { code: "ENOENT" });
  assert.deepEqual(getThread("failure"), original);
  assert.deepEqual(getThreadHistory("failure"), history);
});

import assert from "node:assert/strict";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import { codexAdapter } from "./codex.ts";
import { createProviderInstance, getStoredInstance, providerContext } from "../instances.ts";
import { closeStore, deleteRecord } from "../../durable/store.ts";
import { PM_CONTINUATIONS, continuationKey } from "../t3code/continuation.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../t3code/application.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";
import { codexDriver, makeCodexDriverLayer, codexProtocolResolver, codexCapabilities, codexInstallationMethods } from "../t3code/families/codex.ts";
import { makePmProviderFamily } from "../t3code/registration.ts";

async function fixture(environment: Record<string, string> = {}, options: { homeAlias?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-original-protocol-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, "data");
  const executable = path.join(directory, "codex.mjs");
  await copyFile(fileURLToPath(new URL("./codex-protocol-fixture.mjs", import.meta.url)), executable);
  await chmod(executable, 0o700);
  const home = path.join(directory, "native-home"); await mkdir(home);
  const configuredHome = options.homeAlias ? path.join(directory, "native-home-alias") : home;
  if (options.homeAlias) await symlink(home, configuredHome, process.platform === "win32" ? "junction" : "dir");
  let binaryPath = executable;
  if (process.platform === "win32") {
    binaryPath = path.join(directory, "codex.cmd");
    await writeFile(binaryPath, `@echo off\r\n"${process.execPath}" "${executable}" %*\r\n`);
  }
  const eventLog = path.join(directory, "events.jsonl");
  const instance = createProviderInstance({ instanceId: "controlled-codex", driver: "codex", config: { binaryPath, homePath: configuredHome },
    environment: Object.entries({ EVENT_LOG: eventLog, ...environment }).map(([name, value]) => ({ name, value, sensitive: false })) });
  const applicationOptions = { families: new Map([[codexDriver.driverKind, makePmProviderFamily(codexDriver, makeCodexDriverLayer)]]),
    protocols: new Map([["codex" as const, codexProtocolResolver]]),
    capabilities: new Map([["codex" as const, codexCapabilities]]), installations: new Map([["codex" as const, codexInstallationMethods]]) };
  await startPmProviderApplication(applicationOptions);
  return { directory, instance, context: providerContext(instance, directory),
    events: async () => (await readFile(eventLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    restart: async () => { await stopPmProviderApplication(); closeStore(); await startPmProviderApplication(applicationOptions); },
    close: async () => { await stopPmProviderApplication(); closeStore();
      if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
      await rm(directory, { recursive: true, force: true }); },
  };
}

test("source Codex check preserves independent native readiness without inventing an account or sending a prompt", async () => {
  const f = await fixture({ ACCOUNT_REPORT: JSON.stringify({ account: null, requiresOpenaiAuth: false }) });
  try {
    const status = await codexAdapter.check(f.context);
    assert.equal(status.nativeSessionReady, true); assert.equal(status.authentication, "unknown");
    assert.equal(status.requiresOpenaiAuth, false); assert.ok(status.models.some(model => model.id === "native-codex-1"));
    assert.equal(status.capabilities?.boundedFork, true);
    assert.ok((await f.events()).every(event => !["thread/start", "turn/start", "account/login/start"].includes(event.rpc?.method)));
  } finally { await f.close(); }
});

test("source Codex executes and resumes the exact native session, streams once, preserves options and classified native usage", async () => {
  const f = await fixture();
  try {
    const chunks: string[] = []; const events: NativeOutputEvent[] = []; const usage: NativeUsageUpdate[] = [];
    const first = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "controlled first turn", interactionMode: "plan",
      modelOptions: [{ id: "reasoningEffort", value: "xhigh" }, { id: "serviceTier", value: "priority" }],
      onText: delta => chunks.push(delta), onEvent: event => events.push(event), onUsage: update => usage.push(update) });
    assert.equal(first.text, "native answer"); assert.equal(chunks.join(""), first.text);
    assert.ok(first.nativeSession?.sessionId); assert.ok(first.nativeSession.turnId);
    assert.ok(events.some(event => event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.text === first.text));
    assert.ok(usage.some(update => update.turn?.totals.outputTokens === 4));
    const second = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "controlled continuation", resume: first.nativeSession });
    assert.equal(second.nativeSession?.sessionId, first.nativeSession.sessionId);
    assert.notEqual(second.nativeSession?.turnId, first.nativeSession.turnId);
    const requests = (await f.events()).flatMap(event => event.rpc ? [event.rpc] : []);
    assert.equal(requests.filter(request => request.method === "thread/start").length, 1);
    assert.equal(requests.find(request => request.method === "thread/resume").params.threadId, first.nativeSession.sessionId);
    const start = requests.find(request => request.method === "turn/start").params;
    assert.equal(start.effort, "xhigh"); assert.equal(start.serviceTier, "priority"); assert.equal(start.collaborationMode.mode, "plan");
    assert.equal(start.approvalsReviewer, "user");
  } finally { await f.close(); }
});

test("metadata-only source adoption validates legacy native cwd and completed turns before resume and exact historical fork", async () => {
  const f = await fixture();
  try {
    const first = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "first" });
    assert.ok(first.nativeSession?.turnId);
    deleteRecord(PM_CONTINUATIONS, continuationKey({ instanceId: f.instance.instanceId, revision: f.instance.revision, cwd: f.directory }, first.nativeSession.sessionId));
    const before = (await f.events()).length;
    const resumed = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "second", resume: first.nativeSession });
    assert.equal(resumed.nativeSession?.sessionId, first.nativeSession.sessionId);
    const adoption = (await f.events()).slice(before).flatMap(event => event.rpc ? [event.rpc] : []);
    assert.equal(adoption.filter(request => request.method === "thread/start").length, 0);
    assert.ok(adoption.findIndex(request => request.method === "thread/read") < adoption.findIndex(request => request.method === "thread/resume"));
    const fork = await getPmProviderApplication().execution.fork(f.context, first.nativeSession, { turnId: first.nativeSession.turnId });
    assert.notEqual(fork.sessionId, first.nativeSession.sessionId);
    const request = (await f.events()).findLast(event => event.rpc?.method === "thread/fork").rpc;
    assert.equal(request.params.lastTurnId, first.nativeSession.turnId);
    const other = path.join(f.directory, "other-cwd"); await mkdir(other);
    const invalid = { ...first.nativeSession, cwd: other };
    const beforeInvalid = (await f.events()).length;
    await assert.rejects(getPmProviderApplication().execution.run(providerContext(f.instance, other), { model: "native-codex-1", prompt: "not dispatched", resume: invalid }),
      { status: 409, code: "session_mismatch" });
    assert.ok((await f.events()).slice(beforeInvalid).every(event => !["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(event.rpc?.method)));
    const beforeUnknownBoundary = (await f.events()).length;
    await assert.rejects(getPmProviderApplication().execution.fork(f.context, first.nativeSession, { turnId: "unknown-completed-turn" }),
      { status: 409, code: "unsupported_fork" });
    assert.ok((await f.events()).slice(beforeUnknownBoundary).every(event => !["thread/start", "thread/fork", "turn/start"].includes(event.rpc?.method)));
  } finally { await f.close(); }
});

test("source Codex information answers use native RPC and cannot approve native permissions", async () => {
  const f = await fixture({ MODE: "input" }); const events: NativeOutputEvent[] = []; let informationRequests = 0;
  try {
    const result = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "choose", onEvent: event => events.push(event), onRequest: async request => {
      informationRequests++;
      assert.equal(request.kind, "user_input"); assert.equal(request.respondable, true);
      return { answers: { color: "Blue" } };
    } });
    assert.equal(result.text, "native answer");
    const answer = (await f.events()).find(event => event.answer)?.answer;
    assert.deepEqual(answer, { answers: { color: { answers: ["Blue"] } } });
    assert.equal(informationRequests, 1);
    assert.deepEqual((await f.events()).find(event => event.permissionAnswer)?.permissionAnswer, { permissions: {}, scope: "turn" });
    assert.ok(events.some(event => event.type === "item.upsert" && event.item.request?.kind === "approval" && event.item.request.respondable === false));
    const start = (await f.events()).find(event => event.rpc?.method === "turn/start").rpc.params;
    assert.equal(start.approvalsReviewer, "user"); assert.notEqual(start.approvalPolicy, "never");
  } finally { await f.close(); }
});

for (const mode of ["cancel", "eof"] as const) test(`source Codex ${mode} cannot return partial output as success`, async () => {
  const f = await fixture({ MODE: mode }); const controller = new AbortController();
  try {
    await assert.rejects(codexAdapter.run(f.context, { model: "native-codex-1", prompt: mode, signal: controller.signal,
      ...(mode === "cancel" ? { onText: () => controller.abort() } : {}) }));
    if (mode === "cancel") assert.ok((await f.events()).some(event => event.rpc?.method === "turn/interrupt"));
  } finally { await f.close(); }
});

test("source Codex callback rejection is not hidden by native completion", async () => {
  const f = await fixture(); const failure = new Error("controlled callback failure");
  try { await assert.rejects(codexAdapter.run(f.context, { model: "native-codex-1", prompt: "callback", onUsage: () => { throw failure; } }),
    error => error === failure || (error instanceof AggregateError && error.errors.includes(failure))); }
  finally { await f.close(); }
});

test("public Codex schema keeps PM transport and permission arguments authoritative", () => {
  assert.equal(codexAdapter.validateConfig({ setupMode: "managed" }).setupMode, "managed");
  assert.throws(() => codexAdapter.validateConfig({ setupMode: "other" }));
  assert.throws(() => codexAdapter.validateConfig({ launchArgs: "--listen http://0.0.0.0" }));
  assert.throws(() => codexAdapter.validateConfig({ launchArgs: '--config sandbox_mode="danger-full-access"' }));
});

test("source Codex keeps command output, native tool results and final assistant text on their own channels", async () => {
  const f = await fixture({ MODE: "tools" }); const events: NativeOutputEvent[] = [];
  try {
    const result = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "native output channels", onEvent: event => events.push(event) });
    assert.equal(result.text, "native answer");
    assert.equal(events.filter(event => event.type === "command.output").map(event => event.type === "command.output" ? event.chunk : "").join(""), "native-command\n");
    const commands = events.flatMap(event => event.type === "item.upsert" && event.item.type === "command_execution" ? [event.item] : []);
    assert.equal(commands.at(-1)?.output, "native-command\n");
    assert.ok(events.some(event => event.type === "item.upsert" && event.item.type === "dynamic_tool"));
    assert.doesNotMatch(result.text, /native-command|Sunny/);
  } finally { await f.close(); }
});

test("operation-native handshake evidence rejects a different native Home before a thread or prompt is created", async () => {
  const foreign = await mkdtemp(path.join(os.tmpdir(), "foreign-controlled-codex-home-"));
  const f = await fixture({ REPORTED_HOME: foreign });
  try {
    await f.restart();
    await assert.rejects(codexAdapter.run(f.context, { model: "native-codex-1", prompt: "must not dispatch" }), { status: 409, code: "session_mismatch" });
    assert.ok((await f.events()).every(event => !["thread/start", "turn/start"].includes(event.rpc?.method)));
  } finally { await f.close(); await rm(foreign, { recursive: true, force: true }); }
});

for (const reportedStyle of ["canonical", "windows-extended", "windows-forward", "windows-case"]) {
  if (reportedStyle.startsWith("windows-") && process.platform !== "win32") continue;
  test(`Codex ${reportedStyle} native Home evidence resumes the same session after host and SQLite restart`, async () => {
    const f = await fixture({ REPORTED_HOME_STYLE: reportedStyle }, { homeAlias: true });
    try {
      const first = await codexAdapter.run(f.context, { model: "native-codex-1", prompt: "first explicit turn" });
      assert.ok(first.nativeSession?.turnId);
      await f.restart();
      const reloaded = getStoredInstance(f.instance.instanceId)!;
      assert.equal(reloaded.revision, f.instance.revision);
      assert.equal(reloaded.homeDirectory, f.instance.homeDirectory);
      const second = await codexAdapter.run(providerContext(reloaded, f.directory), {
        model: "native-codex-1", prompt: "only the new turn", resume: first.nativeSession,
      });
      assert.equal(second.nativeSession?.sessionId, first.nativeSession.sessionId);
      assert.notEqual(second.nativeSession?.turnId, first.nativeSession.turnId);
      const requests = (await f.events()).flatMap(event => event.rpc ? [event.rpc] : []);
      assert.equal(requests.filter(request => request.method === "thread/start").length, 1);
      assert.equal(requests.filter(request => request.method === "turn/start").length, 2);
      assert.ok(requests.some(request => request.method === "thread/resume" && request.params.threadId === first.nativeSession!.sessionId));
    } finally { await f.close(); }
  });
}

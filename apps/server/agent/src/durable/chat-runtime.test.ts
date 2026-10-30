import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { UIMessage, UIMessageChunk } from "ai";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import type { NativeSessionRef, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { codexAdapter } from "../providers/drivers/codex.ts";
import { claudeAdapter } from "../providers/drivers/claude.ts";
import { getThreadUsage } from "../usage/ledger.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../providers/instances.ts";
import { chatRoutes } from "../chat.ts";
import { stopPmCoreChanges } from "../pm-core-changes/index.ts";
import { createUsageSummaryReader } from "../usage/service.ts";
import { parseRateTable } from "../usage/pricing.ts";
import {
  cancelChat,
  cancelThreadChat,
  continueChat,
  forkChatGeneration,
  getChatGeneration,
  getChatRecoveryCandidate,
  listChatGenerations,
  readChatEvents,
  startChatRuntime,
  stopChatRuntime,
  submitChat,
  subscribeChat,
  type ChatGeneration,
  type ChatRequest,
} from "./chat-runtime.ts";
import { withThreadExecution } from "./engine.ts";
import { getNativeOutput, respondNativeInteraction, subscribeCommandOutput } from "./native-output.ts";
import { closeStore, readRecord, transaction, writeRecord } from "./store.ts";
import {
  CHAT_FORMAT,
  deleteThread,
  ensureThread,
  forkThreadHistory,
  getThread,
  getThreadBranch,
  getThreadHistory,
  getThreadStableOutputs,
  importThreads,
  saveFormattedMessage,
  setThreadNativeSession,
  updateThread,
} from "./threads.ts";
import { consumeTransfers, getThreadFork, TRANSFERS } from "./transfers.ts";
import { getMergePreview, mergeThread } from "./forks.ts";
import { resolveAgentScope } from "./agent-scope.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../providers/t3code/application.ts";
import { providerApplicationOptions } from "../providers/t3code/production.ts";

let directory: string;
let pmServer: Server;
const originalPmUrl = process.env.PM_API_URL;
const fixtureScope: AgentScope = { workspaceId: "00000000-0000-4000-8000-000000000001", projectId: null };
const secondWorkspace = "00000000-0000-4000-8000-000000000002";
const thirdWorkspace = "00000000-0000-4000-8000-000000000003";
let scopePaths: Map<string, string>;
let resolvedRequests: { scope: AgentScope; cookie?: string; authorization?: string }[];
let pmStatus: number;
let onScopeResolution: (() => void) | undefined;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalCodexCheck = codexAdapter.check;
const originalCodexRun = codexAdapter.run;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "durable-chat-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  scopePaths = new Map();
  resolvedRequests = [];
  pmStatus = 200;
  onScopeResolution = undefined;
  pmServer = createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === "/api/v1/agent-contexts") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ workspaces: [fixtureScope.workspaceId, secondWorkspace, thirdWorkspace].map((id) => ({ id, projects: [] })) }));
      return;
    }
    if (incoming.method === "GET" && /^\/api\/v1\/workspaces\/[^/]+\/agent-tools\/core-files\?projectId=PRJ-\d+$/.test(incoming.url ?? "")) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ files: [], complete: true }));
      return;
    }
    assert.equal(incoming.method, "POST");
    assert.equal(incoming.url, "/api/v1/agent-contexts/resolve");
    let body = "";
    for await (const chunk of incoming) body += String(chunk);
    const scope = JSON.parse(body) as AgentScope;
    resolvedRequests.push({
      scope,
      cookie: incoming.headers.cookie,
      authorization: incoming.headers.authorization,
    });
    onScopeResolution?.();
    outgoing.writeHead(pmStatus, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({
      scope,
      workspaceName: "Fixture workspace",
      projectName: scope.projectId,
      path: scopePaths.get(JSON.stringify(scope)) ?? directory,
    }));
  });
  const listening = Promise.withResolvers<void>();
  pmServer.once("error", listening.reject);
  pmServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = pmServer.address();
  assert.ok(address && typeof address === "object");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}/ignored-prefix`;
  await startPmProviderApplication(providerApplicationOptions);
});
afterEach(async () => {
  await stopChatRuntime();
  await stopPmProviderApplication();
  codexAdapter.check = originalCodexCheck;
  codexAdapter.run = originalCodexRun;
  closeStore();
  pmServer.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  pmServer.close(error => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
  await rm(directory, { recursive: true, force: true });
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
});
function request(threadId = "chat-thread", messageId = "user-1"): ChatRequest {
  return {
    id: threadId,
    trigger: "submit-message",
    messages: [
      {
        id: messageId,
        role: "user",
        parts: [{ type: "text", text: "请继续这项任务。" }],
        metadata: { custom: { quote: { text: "引用原文", messageId: "quoted" } } },
      },
    ],
  };
}
async function localProvider(gate?: Promise<void>) {
  const prompts: { prompt: string; model: string; cwd: string; resume?: NativeSessionRef; modelOptions?: ProviderOptionSelection[]; interactionMode?: "default" | "plan" }[] = [];
  const started = Promise.withResolvers<void>();
  const instance = createProviderInstance({
    instanceId: "chat-local",
    driver: "codex",
    label: "Controlled native durable-state fixture",
    config: { binaryPath: join(directory, "unavailable-native-cli"), homePath: join(directory, "native-home") },
    environment: [{ name: "HOME", value: directory, sensitive: false }],
  });
  codexAdapter.check = async (context, signal) => {
    if (context.instanceId !== instance.instanceId) return originalCodexCheck(context, signal);
    return {
      installation: { status: "installed", checkedAt: new Date().toISOString() },
      authentication: "authenticated",
      nativeSessionReady: true,
      models: [{ id: "chat-model", label: "Controlled native model", source: "discovered", temperature: false,
        capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }] }] } }],
      methods: [],
      canLogout: false,
      capabilities: {
        nativeResume: true, nativeFork: false, boundedFork: false,
        modelTransition: "native", portableHandoff: true,
      },
    };
  };
  codexAdapter.run = async (context, options) => {
    if (context.instanceId !== instance.instanceId) return originalCodexRun(context, options);
    const aborted = Promise.withResolvers<never>();
    const abortError = Object.assign(new Error("Controlled native turn cancelled"), { code: "aborted" });
    const onAbort = () => aborted.reject(abortError);
    const nativeSession: NativeSessionRef = {
      providerInstanceId: context.instanceId,
      driver: "codex",
      sessionId: options.resume?.sessionId ?? randomUUID(),
      turnId: randomUUID(),
      cwd: context.cwd,
      modelId: options.model,
      instanceRevision: context.revision,
    };
    prompts.push({ prompt: options.prompt, model: options.model, cwd: context.cwd, resume: options.resume, modelOptions: options.modelOptions, interactionMode: options.interactionMode });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) throw abortError;
      options.onSession?.(nativeSession);
      options.onText?.("已完成的部分\n\n");
      started.resolve();
      await Promise.race([gate ?? Promise.resolve(), aborted.promise]);
      if (options.signal?.aborted) throw abortError;
      options.onText?.("；最终结果");
      return { text: "已完成的部分\n\n；最终结果", nativeSession, usage: { inputTokens: 3, outputTokens: 2 } };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  };
  return {
    prompts,
    started: started.promise,
    async close() {
      codexAdapter.check = originalCodexCheck;
      codexAdapter.run = originalCodexRun;
    },
  };
}

async function structuredProvider(initialText: string) {
  const provider = await localProvider();
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const native: { text: string; emit?: (text: string) => void } = { text: initialText };
  codexAdapter.run = async (_context, options) => {
    const aborted = Promise.withResolvers<never>();
    const abortError = Object.assign(new Error("Controlled structured native turn cancelled"), { code: "aborted" });
    const abort = () => aborted.reject(abortError);
    options.signal?.addEventListener("abort", abort, { once: true });
    native.emit = (text) => {
      native.text = text;
      options.onEvent?.({ type: "item.upsert", item: { id: "native-root", type: "assistant_message", status: "running", text } });
      // The original event adapter also delivers a legacy callback after the authoritative item.
      options.onText?.(text);
    };
    try {
      if (options.signal?.aborted) throw abortError;
      options.onEvent?.({ type: "item.upsert", item: { id: "native-child", type: "assistant_message", status: "completed",
        parentItemId: "native-child:fixture", text: "child-only paragraph\n\n" } });
      native.emit(initialText);
      started.resolve();
      await Promise.race([finished.promise, aborted.promise]);
      if (options.signal?.aborted) throw abortError;
      options.onEvent?.({ type: "item.upsert", item: { id: "native-root", type: "assistant_message", status: "completed", text: native.text } });
      return { text: native.text };
    } finally {
      native.emit = undefined;
      options.signal?.removeEventListener("abort", abort);
    }
  };
  return { ...provider, started: started.promise, native, finish: () => finished.resolve() };
}
function configure(id = "chat-thread") {
  ensureThread(id, undefined, fixtureScope);
  updateThread(id, {
    settings: {
      providerInstanceId: "chat-local",
      model: "chat-model",
      systemPrompt: "按保存的指令回答。",
      temperature: 0.4,
    },
  });
}
async function drain(id: string): Promise<UIMessageChunk[]> {
  const reader = subscribeChat(id).getReader();
  const chunks: UIMessageChunk[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  return chunks;
}

test("native events, command output and interaction responses bridge through the active generation", async () => {
  await localProvider();
  configure();
  const waiting = Promise.withResolvers<void>();
  let answered: unknown;
  codexAdapter.run = async (_context, options) => {
    options.onEvent?.({ type: "item.upsert", item: { id: "command", type: "command_execution", status: "running" } });
    options.onEvent?.({ type: "command.output", itemId: "command", chunk: "old\rnew" });
    options.onEvent?.({ type: "item.upsert", item: { id: "assistant", type: "assistant_message", status: "running", text: "结果" } });
    options.onText?.("结果");
    const pending = options.onRequest!({
      id: "approval", itemId: "approval-item", kind: "approval", title: "Confirm",
      respondable: true, options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
    });
    waiting.resolve();
    answered = await pending;
    options.onEvent?.({ type: "item.upsert", item: { id: "command", type: "command_execution", status: "completed", output: "old\rnew" } });
    options.onEvent?.({ type: "item.upsert", item: { id: "assistant", type: "assistant_message", status: "completed", text: "结果" } });
    return { text: "结果" };
  };
  const generation = await submitChat(request());
  await waiting.promise;
  const output = getNativeOutput(generation.id)!;
  assert.deepEqual(output.items.map((item) => item.id), ["command", "assistant", "approval-item"]);
  const command = subscribeCommandOutput(generation.id, "command").getReader();
  const first = await command.read();
  assert.equal(first.value?.kind, "replace");
  assert.match(first.value?.text ?? "", /new/);
  assert.throws(() => respondNativeInteraction(generation.id, "approval", { optionId: "not-offered" }));
  respondNativeInteraction(generation.id, "approval", { optionId: "allow" });
  assert.throws(() => respondNativeInteraction(generation.id, "approval", { optionId: "allow" }));
  await drain(generation.id);
  assert.deepEqual(answered, { optionId: "allow" });
  assert.equal(getNativeOutput(generation.id)?.status, "completed");
  await command.cancel();
});

test("reported native usage survives cancellation and retains cumulative turn and context", async () => {
  await localProvider();
  configure();
  const started = Promise.withResolvers<void>();
  codexAdapter.run = async (context, options) => {
    options.onSession?.({ providerInstanceId: context.instanceId, driver: "codex", sessionId: "native-session", turnId: "native-turn", cwd: context.cwd });
    const totals = { uncachedInputTokens: 5, cachedInputTokens: 3, cacheCreationTokens: 1, outputTokens: 4, reasoningTokens: 2 };
    options.onUsage?.({ turn: { totals }, context: { usedTokens: 13, maxTokens: 100, updatedAt: new Date().toISOString() } });
    options.onUsage?.({ turn: { totals: { ...totals, outputTokens: 8 } } });
    options.onText?.("partial");
    started.resolve();
    const cancelled = Promise.withResolvers<never>();
    options.signal!.addEventListener("abort", () => cancelled.reject(Object.assign(new Error("cancelled"), { code: "aborted" })), { once: true });
    return await cancelled.promise;
  };
  const generation = await submitChat(request());
  await started.promise;
  await cancelChat(generation.id);
  assert.equal(getChatGeneration(generation.id)?.status, "cancelled");
  assert.equal(getChatGeneration(generation.id)?.usage?.totals?.outputTokens, 8);
  assert.equal(getThreadUsage("chat-thread").context?.usedTokens, 13);
  await stopPmCoreChanges();
  closeStore();
  assert.equal(getThreadUsage("chat-thread").totals?.cachedInputTokens, 3);
});

test("legacy two-field usage is not classified or priced as canonical telemetry", async () => {
  await localProvider();
  configure();
  const generation = await submitChat(request());
  await drain(generation.id);
  assert.equal(getChatGeneration(generation.id)?.status, "completed");
  assert.equal(getChatGeneration(generation.id)?.usage, undefined);
  assert.equal(getThreadUsage("chat-thread").totals, undefined);
  assert.equal(getThreadUsage("chat-thread").providerInstanceId, "chat-local");
});

test("incomplete native turn counters survive in metadata without categorized totals", async () => {
  await localProvider();
  configure();
  codexAdapter.run = async (_context, options) => {
    options.onUsage?.({ reportedTurn: { inputTokens: 120, outputTokens: 8, cachedInputTokens: 40 } });
    options.onText?.("answer");
    return { text: "answer" };
  };
  const generation = await submitChat(request());
  await drain(generation.id);
  assert.deepEqual(getChatGeneration(generation.id)?.usage?.reportedTurn, { inputTokens: 120, outputTokens: 8, cachedInputTokens: 40 });
  assert.equal(getChatGeneration(generation.id)?.usage?.totals, undefined);
  assert.match(JSON.stringify(getThreadHistory("chat-thread")), /reportedTurn/);
  await stopPmCoreChanges();
  closeStore();
  assert.equal(getThreadUsage("chat-thread").reportedTurn?.cachedInputTokens, 40);
});

async function controlledCliProvider() {
  const executable = join(directory, "scope-cli.mjs");
  const log = join(directory, "scope-cli.jsonl");
  await writeFile(executable, await readFile(new URL("../providers/drivers/codex-protocol-fixture.mjs", import.meta.url), "utf8"));
  await chmod(executable, 0o700);
  const instance = createProviderInstance({
    instanceId: "scope-cli",
    driver: "codex",
    label: "Controlled scope subprocess",
    config: { binaryPath: executable, homePath: directory },
    environment: [{ name: "SCOPE_LOG", value: log, sensitive: false }],
  });
  return { instance, log };
}

function configureScopedCli(id: string, scope: AgentScope, providerInstanceId: string) {
  ensureThread(id, undefined, scope);
  updateThread(id, {
    settings: { ...getThread(id)!.settings, providerInstanceId, model: "scope-model" },
  });
}

function nextRequest(id: string, messageId: string): ChatRequest {
  return {
    ...request(id, messageId),
    messages: [
      ...getThreadBranch(id).map((entry) =>
        ({ id: entry.id, ...entry.content }) as ChatRequest["messages"][number]),
      ...request(id, messageId).messages,
    ],
  };
}

test("thread settings are isolated, revision checked, and migration never overwrites live history", () => {
  ensureThread("a");
  ensureThread("b");
  const before = getThread("a")!;
  const otherSettings = { ...getThread("b")!.settings };
  updateThread("a", {
    settings: { ...before.settings, providerInstanceId: "explicit-provider", model: "other-model" },
    revision: before.revision,
  });
  assert.deepEqual(getThread("b")!.settings, otherSettings);
  assert.throws(() => updateThread("a", { settings: before.settings, revision: before.revision }), {
    code: "thread_conflict",
  });
  saveFormattedMessage(
    "a",
    {
      id: "server-output",
      parent_id: null,
      format: CHAT_FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "authoritative" }] },
    },
    true,
  );
  const payload = [
    { remoteId: "a", title: "stale browser", histories: [{ format: CHAT_FORMAT, messages: [] }] },
    {
      remoteId: "legacy",
      title: "Imported",
      histories: [
        {
          format: CHAT_FORMAT,
          messages: [
            {
              id: "old-user",
              parent_id: null,
              format: CHAT_FORMAT,
              content: { role: "user", parts: [{ type: "text", text: "old history" }] },
            },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(importThreads("migration-once", payload), { imported: 1, skipped: 1 });
  assert.deepEqual(importThreads("migration-once", payload), { imported: 1, skipped: 1 });
  assert.equal(getThreadHistory("a").messages[0].content.parts instanceof Array, true);
  assert.match(JSON.stringify(getThreadHistory("a")), /authoritative/);
  assert.match(JSON.stringify(getThreadHistory("legacy")), /old history/);
});

test("stale browser snapshots cannot replace generated text but frontend tool results survive", () => {
  const entry = {
    id: "server-assistant",
    parent_id: null,
    format: CHAT_FORMAT,
    content: {
      role: "assistant",
      parts: [
        { type: "text", text: "server answer" },
        {
          type: "tool-weather",
          toolCallId: "weather-1",
          input: { city: "Beijing" },
          state: "input-available",
        },
      ],
    },
  };
  saveFormattedMessage("protected", entry, true);
  saveFormattedMessage(
    "protected",
    {
      ...entry,
      content: {
        role: "assistant",
        parts: [
          { type: "text", text: "old partial answer" },
          {
            type: "tool-weather",
            toolCallId: "weather-1",
            input: { city: "forged" },
            state: "output-available",
            output: { degrees: 20 },
          },
        ],
      },
    },
    false,
    false,
  );
  const saved = JSON.stringify(getThreadHistory("protected"));
  assert.match(saved, /server answer/);
  assert.match(saved, /Beijing/);
  assert.match(saved, /degrees/);
  assert.doesNotMatch(saved, /old partial answer|forged/);
});

test(
  "disconnect only unsubscribes; replay and durable history retain output with exactly one provider request",
  { timeout: 10000 },
  async () => {
    const gate = Promise.withResolvers<void>();
    const provider = await localProvider(gate.promise);
    try {
      configure();
      const first = await submitChat(request());
      assert.equal((await submitChat(request())).id, first.id);
      const changed = request();
      changed.messages[0].parts = [{ type: "text", text: "same message id, different task" }];
      await assert.rejects(submitChat(changed), { code: "idempotency_conflict" });
      const reader = subscribeChat(first.id).getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.value?.type === "text-delta") break;
      }
      await reader.cancel();
      assert.equal(getChatGeneration(first.id)!.status, "running");
      gate.resolve();
      const replay = await drain(first.id);
      assert.equal(getChatGeneration(first.id)!.status, "completed");
      assert.equal(provider.prompts.length, 1);
      assert.match(provider.prompts[0].prompt, /引用原文/);
      assert.match(provider.prompts[0].prompt, /Fixture workspace/);
      assert.equal(provider.prompts[0].cwd, directory);
      assert.equal(provider.prompts[0].model, "chat-model");
      assert.equal(getChatGeneration(first.id)!.temperature, 0.4);
      assert.match(JSON.stringify(getThreadHistory("chat-thread")), /最终结果/);
      const events = readChatEvents(first.id);
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_, index) => index + 1),
      );
      assert.deepEqual(
        replay,
        events.map((event) => event.chunk),
      );
      assert.equal(getThreadStableOutputs("chat-thread").texts.length, 1);
      await stopPmCoreChanges();
      closeStore();
      assert.match(JSON.stringify(getThreadHistory("chat-thread")), /最终结果/);
    } finally {
      gate.resolve();
      await stopChatRuntime();
      await provider.close();
    }
  },
);

test("saved model options and interaction mode reach the provider; invalid options never accept a turn", async () => {
  const provider = await localProvider();
  try {
    configure();
    const invalid = { ...getThread("chat-thread")!.settings,
      modelOptions: [{ id: "effort", value: "unsupported" }], interactionMode: "plan" as const };
    updateThread("chat-thread", { settings: invalid });
    await assert.rejects(submitChat(request()), { code: "invalid_model_options" });
    assert.equal(provider.prompts.length, 0);
    assert.equal(resolvedRequests.length, 0);
    assert.equal(getThreadHistory("chat-thread").messages.length, 0);
    const revision = getThread("chat-thread")!.revision;
    const invalidSave = await chatRoutes.request("http://localhost/chat/threads/chat-thread", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, settings: invalid }),
    });
    assert.equal(invalidSave.status, 400);
    assert.equal(getThread("chat-thread")!.revision, revision);
    const settings = { ...invalid, modelOptions: [{ id: "effort", value: "xhigh" }] };
    const saved = await chatRoutes.request("http://localhost/chat/threads/chat-thread", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, settings }),
    });
    assert.equal(saved.status, 200);
    await stopPmCoreChanges();
    closeStore();
    assert.deepEqual(getThread("chat-thread")!.settings, settings);
    const generation = await submitChat(request());
    await drain(generation.id);
    assert.deepEqual(provider.prompts[0].modelOptions, settings.modelOptions);
    assert.equal(provider.prompts[0].interactionMode, "plan");
    assert.deepEqual(getChatGeneration(generation.id)!.threadSettingsSnapshot, settings);
  } finally {
    await stopChatRuntime();
    await provider.close();
  }
});

test("frozen native launch options reach persisted transcript pricing after thread selection changes and durable reopen", async () => {
  const gate = Promise.withResolvers<void>();
  const provider = await localProvider(gate.promise);
  const check = codexAdapter.check;
  try {
    const instance = updateProviderInstance("chat-local", { config: { homePath: join(directory, "usage-native-home") } });
    codexAdapter.check = async (context, signal) => {
      const status = await check(context, signal);
      return { ...status, models: status.models.map((model) => ({ ...model, capabilities: {
        optionDescriptors: [...(model.capabilities?.optionDescriptors ?? []), { id: "serviceTier", label: "Tier", type: "select" as const,
          options: [{ id: "priority", label: "Fast" }, { id: "ultrafast", label: "Ultrafast" }] }],
      } })) };
    };
    configure();
    updateThread("chat-thread", { settings: { ...getThread("chat-thread")!.settings, modelOptions: [{ id: "serviceTier", value: "priority" }] } });
    const generation = await submitChat(request());
    await provider.started;
    updateThread("chat-thread", { settings: { ...getThread("chat-thread")!.settings, modelOptions: [{ id: "serviceTier", value: "ultrafast" }] } });
    gate.resolve();
    await drain(generation.id);
    const ref = getChatGeneration(generation.id)!.nativeSession!;
    const timestamp = new Date().toISOString();
    const native = [
      { type: "session_meta", timestamp, payload: { id: ref.sessionId, model_provider: "openai" } },
      { type: "turn_context", timestamp, payload: { model: "chat-model", turn_id: ref.turnId } },
      { type: "event_msg", timestamp, payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 15 },
        total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 15 },
      } } },
    ];
    await mkdir(join(instance.homeDirectory, "sessions"), { recursive: true });
    await writeFile(join(instance.homeDirectory, "sessions", "controlled-launch.jsonl"), native.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const read = createUsageSummaryReader({ pricing: async () => ({
      table: parseRateTable({ "chat-model": { input_cost_per_token: 1, output_cost_per_token: 2, input_cost_per_token_priority: 2, output_cost_per_token_priority: 4 } }),
      pricing: { status: "cached", source: "fixture", fetchedAt: null, knownModels: 1 },
    }) });
    const query = { sinceDay: timestamp.slice(0, 10), untilDay: timestamp.slice(0, 10), timeZone: "UTC", instanceIds: ["chat-local"] };
    const first = await read(query);
    assert.equal(first.buckets.length, 1);
    assert.equal(first.buckets[0]!.records, 1);
    assert.equal(first.buckets[0]!.fastCostUsd, 40);
    assert.equal(first.buckets[0]!.speedPremiumUsd, 20);
    await stopChatRuntime();
    closeStore();
    const restored = await read(query);
    assert.equal(restored.buckets[0]!.fastCostUsd, 40);
    assert.equal(restored.buckets[0]!.ultrafastCostUsd, undefined);
    assert.ok(!restored.sources.some((source) => source.message?.includes("unreported service tier")));
  } finally {
    gate.resolve();
    await stopChatRuntime();
    await provider.close();
  }
});

for (const mode of ["onReturn", "beforeCacheExpires"] as const) {
  test(`Claude ${mode} compacts the authorized native session as a durable turn`, { timeout: 10000 }, async () => {
    const originalCheck = claudeAdapter.check;
    const originalRun = claudeAdapter.run;
    const compactStarted = Promise.withResolvers<void>();
    const calls: { prompt: string; resume?: NativeSessionRef }[] = [];
    try {
      createProviderInstance({ instanceId: "compact-claude", driver: "claude", label: "Controlled Claude",
        config: { idleCompaction: mode } });
      claudeAdapter.check = async () => ({
        installation: { status: "installed" }, authentication: "authenticated", methods: [], canLogout: false,
        nativeSessionReady: true,
        models: [{ id: "compact-model", label: "Controlled", temperature: false }],
        capabilities: { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native", portableHandoff: true },
      });
      claudeAdapter.run = async (context, options) => {
        assert.equal(context.execution?.threadId, "compact-thread");
        assert.deepEqual(context.execution?.scope, fixtureScope);
        assert.ok(context.execution?.generationId);
        assert.ok(context.execution?.messageId);
        if (options.prompt === "/compact") assert.equal(context.pmToolBridge, undefined);
        calls.push({ prompt: options.prompt, resume: options.resume });
        const nativeSession: NativeSessionRef = { providerInstanceId: context.instanceId, driver: "claude",
          sessionId: "compact-session", modelId: options.model, cwd: context.cwd, instanceRevision: context.revision };
        options.onSession?.(nativeSession);
        if (calls.length === 1) options.onUsage?.({ context: { usedTokens: 210_000,
          updatedAt: new Date(Date.now() - (mode === "onReturn" ? 180_000 : 70_000)).toISOString(),
          promptCacheTtlMs: mode === "onReturn" ? 60_000 : 180_000 } });
        if (options.prompt === "/compact") compactStarted.resolve();
        options.onText?.("done");
        return { text: "done", nativeSession };
      };
      ensureThread("compact-thread", undefined, fixtureScope);
      updateThread("compact-thread", { settings: { providerInstanceId: "compact-claude",
        model: "compact-model", systemPrompt: "", temperature: 1 } });
      const headers = new Headers({ cookie: "fixture-session=authorized" });
      const initial = await submitChat(request("compact-thread", "first-user"), undefined, headers);
      await drain(initial.id);
      const oldBranch = getThreadBranch("compact-thread").map(({ id, content }) => ({ id, ...content }) as UIMessage);
      if (mode === "onReturn") {
        const messages = oldBranch;
        const next = await submitChat({ id: "compact-thread", messages: [...messages,
          { id: "next-user", role: "user", parts: [{ type: "text", text: "continue" }] }] }, undefined, headers);
        await drain(next.id);
      } else {
        await compactStarted.promise;
        const compact = listChatGenerations("compact-thread").find((entry) => entry.idleCompaction === mode)!;
        await drain(compact.id);
        const next = await submitChat({ id: "compact-thread", messages: [...oldBranch,
          { id: "next-user", role: "user", parts: [{ type: "text", text: "continue after idle" }] }] }, undefined, headers);
        await drain(next.id);
      }
      assert.equal(calls[1].prompt, "/compact");
      assert.equal(calls[1].resume?.sessionId, "compact-session");
      assert.ok(listChatGenerations("compact-thread").some((entry) => entry.idleCompaction === mode && entry.status === "completed"));
      assert.ok(resolvedRequests.length >= 2);
      assert.ok(resolvedRequests.every((entry) => entry.cookie === "fixture-session=authorized"));
    } finally {
      await stopChatRuntime();
      claudeAdapter.check = originalCheck;
      claudeAdapter.run = originalRun;
    }
  });
}

test(
  "explicit cancellation persists partial output and never turns late provider output into success",
  { timeout: 10000 },
  async () => {
    const gate = Promise.withResolvers<void>();
    const provider = await localProvider(gate.promise);
    try {
      configure();
      const generation = await submitChat(request());
      const reader = subscribeChat(generation.id).getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.value?.type === "text-delta") break;
      }
      await Promise.all([cancelChat(generation.id), cancelChat(generation.id)]);
      gate.resolve();
      await reader.cancel();
      assert.equal(getChatGeneration(generation.id)!.status, "cancelled");
      assert.match(JSON.stringify(getThreadHistory("chat-thread")), /已完成的部分/);
      assert.doesNotMatch(JSON.stringify(getThreadHistory("chat-thread")), /最终结果/);
      assert.equal(getThreadStableOutputs("chat-thread").texts.length, 0);
      assert.ok(readChatEvents(generation.id).some((event) => event.chunk.type === "abort"));
    } finally {
      gate.resolve();
      await stopChatRuntime();
      await provider.close();
    }
  },
);

test(
  "queued cancellation behind a workspace lock never starts the provider",
  { timeout: 10000 },
  async () => {
    const held = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<void>();
    const provider = await localProvider();
    const lock = withThreadExecution("chat-thread", async () => {
      acquired.resolve();
      await held.promise;
    });
    try {
      await acquired.promise;
      configure();
      const generation = await submitChat(request());
      assert.equal(generation.status, "queued");
      await cancelChat(generation.id);
      await stopChatRuntime();
      assert.equal(getChatGeneration(generation.id)!.status, "cancelled");
      assert.equal(provider.prompts.length, 0);
    } finally {
      held.resolve();
      await lock;
      await stopChatRuntime();
      await provider.close();
    }
  },
);

test("restart reconstructs the last committed delta and never blindly replays an interrupted prompt", async () => {
  await startChatRuntime();
  await stopChatRuntime();
  configure();
  const value = request();
  saveFormattedMessage(
    value.id,
    {
      id: "user-1",
      parent_id: null,
      format: CHAT_FORMAT,
      content: { role: "user", parts: value.messages[0].parts },
    },
    true,
  );
  const generation: ChatGeneration = {
    id: "crashed",
    threadId: value.id,
    messageId: "assistant-crashed",
    parentId: "user-1",
    status: "running",
    seq: 3,
    createdAt: new Date().toISOString(),
    request: value,
    providerInstanceId: "chat-local",
    providerInstanceRevision: 1,
    modelId: "chat-model",
    temperature: 0.4,
  };
  writeRecord("chat:generations", generation.id, generation);
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId: generation.messageId },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "committed before crash" },
  ];
  chunks.forEach((chunk, index) =>
    writeRecord("chat:events", `${generation.id}:${String(index + 1).padStart(12, "0")}`, {
      generationId: generation.id,
      seq: index + 1,
      chunk,
    }),
  );
  await startChatRuntime();
  assert.equal(getChatGeneration(generation.id)!.status, "interrupted");
  assert.match(JSON.stringify(getThreadHistory(value.id)), /committed before crash/);
  assert.equal(getChatRecoveryCandidate(generation.id)?.status, "interrupted");
});

test(
  "confirmed continuation creates one new record and consumes merge reference only once",
  { timeout: 10000 },
  async () => {
    const gate = Promise.withResolvers<void>();
    const provider = await localProvider(gate.promise);
    try {
      configure();
      updateThread("chat-thread", { settings: { ...getThread("chat-thread")!.settings,
        modelOptions: [{ id: "effort", value: "xhigh" }], interactionMode: "plan" } });
      writeRecord(TRANSFERS, "merged-child", {
        id: "transfer-1",
        sourceThreadId: "merged-child",
        parentThreadId: "chat-thread",
        text: "MERGED_REFERENCE_DO_NOT_REEXECUTE",
        createdAt: new Date().toISOString(),
      });
      const generation = await submitChat(request());
      const reader = subscribeChat(generation.id).getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.value?.type === "text-delta") break;
      }
      await stopChatRuntime();
      await reader.cancel();
      gate.resolve();
      assert.equal(getChatGeneration(generation.id)!.status, "interrupted");
      assert.match(
        getChatGeneration(generation.id)!.request.transferContext!,
        /MERGED_REFERENCE_DO_NOT_REEXECUTE/,
      );
      assert.equal(
        transaction(() => consumeTransfers("chat-thread", "another")),
        "",
      );
      await startChatRuntime();
      await assert.rejects(continueChat(generation.id, false), { code: "side_effect_confirmation_required" });
      assert.equal(getChatGeneration(generation.id)!.continuationId, undefined);
      assert.equal(provider.prompts.length, 1);
      const continuation = await continueChat(generation.id, true);
      assert.notEqual(continuation.id, generation.id);
      assert.equal(continuation.continuationOf, generation.id);
      assert.equal((await continueChat(generation.id, true)).id, continuation.id);
      await drain(continuation.id);
      assert.equal(getChatGeneration(generation.id)!.status, "interrupted");
      assert.equal(provider.prompts.length, 2);
      assert.equal(getChatGeneration(continuation.id)!.status, "completed");
      assert.equal(getChatGeneration(continuation.id)!.handoff?.mode, "native");
      assert.equal(provider.prompts[1].resume?.sessionId, getChatGeneration(generation.id)!.nativeSession?.sessionId);
      assert.deepEqual(provider.prompts.map((turn) => turn.modelOptions), [[{ id: "effort", value: "xhigh" }], [{ id: "effort", value: "xhigh" }]]);
      assert.deepEqual(provider.prompts.map((turn) => turn.interactionMode), ["plan", "plan"]);
      assert.deepEqual(getChatGeneration(continuation.id)!.modelOptions, [{ id: "effort", value: "xhigh" }]);
      assert.deepEqual(continuation.request.messages.at(-1)?.metadata, {
        custom: { continuationOf: generation.id, sideEffectsConfirmed: true },
      });
      assert.equal(
        readRecord<{ consumedByRunId: string }>(TRANSFERS, "merged-child")?.consumedByRunId,
        generation.id,
      );
    } finally {
      gate.resolve();
      await stopChatRuntime();
      await provider.close();
    }
  },
);

test("fork uses the supplied stable snapshot, not later server history, and copies thread settings", () => {
  configure("source");
  saveFormattedMessage(
    "source",
    {
      id: "late",
      parent_id: null,
      format: CHAT_FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "LATER_PRIVATE_OUTPUT" }] },
    },
    true,
  );
  forkThreadHistory("source", "branch", "stable run boundary and confirmed output");
  assert.doesNotMatch(JSON.stringify(getThreadHistory("branch")), /LATER_PRIVATE_OUTPUT/);
  assert.match(JSON.stringify(getThreadHistory("branch")), /stable run boundary/);
  assert.deepEqual(getThread("branch")!.settings, getThread("source")!.settings);
});

test("history endpoint excludes active snapshots and stale client writes cannot change the active head", async () => {
  configure();
  saveFormattedMessage(
    "chat-thread",
    {
      id: "user",
      parent_id: null,
      format: CHAT_FORMAT,
      content: { role: "user", parts: [{ type: "text", text: "task" }] },
    },
    true,
  );
  saveFormattedMessage(
    "chat-thread",
    {
      id: "assistant",
      parent_id: "user",
      format: CHAT_FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "live authoritative output" }] },
    },
    true,
  );
  const active: ChatGeneration = {
    id: "active-seed",
    threadId: "chat-thread",
    messageId: "assistant",
    parentId: "user",
    status: "running",
    seq: 0,
    request: request(),
    createdAt: new Date().toISOString(),
    providerInstanceId: "chat-local",
    providerInstanceRevision: 1,
    modelId: "chat-model",
    temperature: 0.4,
  };
  writeRecord("chat:generations", active.id, active);
  const history = await chatRoutes.request("http://localhost/chat/threads/chat-thread/history");
  const body = (await history.json()) as { activeGenerationId: string; messages: { id: string }[] };
  assert.equal(body.activeGenerationId, active.id);
  assert.equal(
    body.messages.some((message) => message.id === "assistant"),
    false,
  );
  await chatRoutes.request("http://localhost/chat/threads/chat-thread/history", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "assistant",
      parent_id: "user",
      format: CHAT_FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "stale" }] },
    }),
  });
  assert.match(JSON.stringify(getThreadHistory("chat-thread")), /live authoritative output/);
});

test("resource-first migration fills an unclaimed thread but never replaces claimed settings", () => {
  ensureThread("resource-first", "workspace shell");
  const imported = importThreads("resource-order", [
    {
      remoteId: "resource-first",
      title: "old chat title",
      settings: {
        providerInstanceId: "deepseek",
        model: "deepseek-reasoner",
        systemPrompt: "old settings",
        temperature: 0.3,
      },
      histories: [
        {
          format: CHAT_FORMAT,
          messages: [
            {
              id: "old",
              parent_id: null,
              format: CHAT_FORMAT,
              content: { role: "user", parts: [{ type: "text", text: "old chat" }] },
            },
          ],
        },
      ],
    },
  ]);
  assert.equal(imported.imported, 1);
  assert.equal(getThread("resource-first")!.title, "old chat title");
  ensureThread("claimed");
  updateThread("claimed", {
    settings: { ...getThread("claimed")!.settings, model: "chosen-model" },
  });
  assert.equal(importThreads("other-browser", [{ remoteId: "claimed" }]).skipped, 1);
  assert.equal(getThread("claimed")!.settings.model, "chosen-model");
});

test(
  "cancel before provider acceptance persists intent and never starts the late-arriving request",
  { timeout: 10000 },
  async () => {
    const provider = await localProvider();
    try {
      configure();
      await cancelThreadChat("chat-thread", { messageId: "user-1" });
      const cancelled = await submitChat(request());
      assert.equal(cancelled.status, "cancelled");
      assert.equal(provider.prompts.length, 0);
      assert.equal((await submitChat(request())).id, cancelled.id);
      assert.ok((await drain(cancelled.id)).some((chunk) => chunk.type === "abort"));
    } finally {
      await stopChatRuntime();
      await provider.close();
    }
  },
);

test("reconnect of a frontend-tool continuation restores the original tool boundary, not accumulated deltas", async () => {
  configure();
  const original = {
    id: "tool-assistant",
    role: "assistant" as const,
    parts: [
      { type: "text" as const, text: "before continuation" },
      {
        type: "tool-weather" as const,
        toolCallId: "tool-1",
        state: "output-available" as const,
        input: {},
        output: "sunny",
      },
    ],
  };
  saveFormattedMessage(
    "chat-thread",
    {
      id: "user-1",
      parent_id: null,
      format: CHAT_FORMAT,
      content: { role: "user", parts: request().messages[0].parts },
    },
    true,
  );
  saveFormattedMessage(
    "chat-thread",
    {
      id: original.id,
      parent_id: "user-1",
      format: CHAT_FORMAT,
      content: {
        role: "assistant",
        parts: [...original.parts, { type: "text", text: "live delta must replay once" }],
      },
    },
    true,
  );
  const generation: ChatGeneration = {
    id: "tool-generation",
    threadId: "chat-thread",
    messageId: original.id,
    parentId: "user-1",
    status: "running",
    createdAt: new Date().toISOString(),
    seq: 0,
    request: { ...request(), messages: [...request().messages, original] },
    providerInstanceId: "chat-local",
    providerInstanceRevision: 1,
    modelId: "chat-model",
    temperature: 0.4,
  };
  writeRecord("chat:generations", generation.id, generation);
  const response = await chatRoutes.request("http://localhost/chat/threads/chat-thread/history");
  const body = await response.text();
  assert.match(body, /before continuation/);
  assert.match(body, /sunny/);
  assert.doesNotMatch(body, /live delta must replay once/);
});

test("normal chat fork preserves an immutable historical boundary, uses native cursors only when completed, and shares merge lineage", async () => {
  configure("source-chat");
  const generation: ChatGeneration = {
    id: "completed-source",
    threadId: "source-chat",
    messageId: "source-answer",
    parentId: "user-1",
    status: "completed",
    createdAt: new Date().toISOString(),
    seq: 0,
    request: request("source-chat"),
    providerInstanceId: "native-fixture",
    providerInstanceRevision: 1,
    modelId: "fixture-model",
    temperature: 0.4,
    executionSnapshot: {
      scope: fixtureScope, workspaceName: "Fixture workspace", projectName: null, path: directory,
    },
    nativeSession: {
      providerInstanceId: "native-fixture",
      driver: "codex",
      sessionId: "real-protocol-fixture",
      turnId: "turn-boundary",
      instanceRevision: 1,
      cwd: directory,
    },
    output: {
      id: "source-answer",
      role: "assistant",
      parts: [{ type: "text", text: "EXACT_ORIGINAL_BOUNDARY" }],
    },
  };
  writeRecord("chat:generations", generation.id, generation);
  saveFormattedMessage(
    "source-chat",
    {
      id: "later",
      parent_id: null,
      format: CHAT_FORMAT,
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "LATER_HISTORY_MUST_NOT_LEAK" }],
      },
    },
    true,
  );
  const fork = await forkChatGeneration(generation.id, { idempotencyKey: "fork-source" });
  assert.deepEqual(
    await forkChatGeneration(generation.id, { idempotencyKey: "fork-source" }),
    fork,
  );
  assert.match(JSON.stringify(getThreadHistory(fork.threadId)), /EXACT_ORIGINAL_BOUNDARY/);
  assert.doesNotMatch(
    JSON.stringify(getThreadHistory(fork.threadId)),
    /LATER_HISTORY_MUST_NOT_LEAK/,
  );
  assert.equal(getThreadFork(fork.threadId)!.parentThreadId, generation.threadId);
  assert.equal(getThreadFork(fork.threadId)!.nativeFork?.boundary?.turnId, "turn-boundary");
  for (const driver of ["pi", "opencode"] as const) {
    const original = { ...generation, id: `source-${driver}`,
      nativeSession: { ...generation.nativeSession!, driver, sessionId: `${driver}-native-session` } };
    writeRecord("chat:generations", original.id, original);
    const branch = await forkChatGeneration(original.id);
    assert.equal(getThreadFork(branch.threadId)!.nativeFork?.source.driver, driver);
    assert.equal(getThreadFork(branch.threadId)!.nativeFork?.boundary?.turnId, "turn-boundary");
  }
  const legacy = { ...generation, id: "legacy-native-without-snapshot", executionSnapshot: undefined };
  writeRecord("chat:generations", legacy.id, legacy);
  const legacyFork = await forkChatGeneration(legacy.id);
  assert.equal(getThreadFork(legacyFork.threadId)!.nativeFork, undefined);
  const failed = {
    ...generation,
    id: "failed-source",
    status: "failed" as const,
    output: {
      ...generation.output!,
      parts: [{ type: "text" as const, text: "unconfirmed partial output" }],
    },
  };
  writeRecord("chat:generations", failed.id, failed);
  const portable = await forkChatGeneration(failed.id);
  assert.equal(getThreadFork(portable.threadId)!.nativeFork, undefined);
  assert.match(
    JSON.stringify(getThreadHistory(portable.threadId)),
    /failed|unconfirmed partial output/,
  );
  const childGeneration: ChatGeneration = {
    ...generation,
    id: "child-output",
    threadId: fork.threadId,
    messageId: "child-answer",
    nativeSession: undefined,
    output: {
      id: "child-answer",
      role: "assistant",
      parts: [{ type: "text", text: "CHAT_ONLY_CHILD_FINDINGS" }],
    },
  };
  writeRecord("chat:generations", childGeneration.id, childGeneration);
  const head = getThreadHistory(fork.threadId).headId;
  saveFormattedMessage(
    fork.threadId,
    {
      id: "child-answer",
      parent_id: head,
      format: CHAT_FORMAT,
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "CHAT_ONLY_CHILD_FINDINGS" }],
        metadata: { durable: { generationId: childGeneration.id, status: "completed" } },
      },
    },
    true,
  );
  const preview = getMergePreview(fork.threadId);
  assert.match(preview.text, /CHAT_ONLY_CHILD_FINDINGS/);
  const transfer = mergeThread(fork.threadId, { confirmed: true, text: preview.text });
  assert.equal(mergeThread(fork.threadId, { confirmed: true }).id, transfer.id);
  assert.match(
    transaction(() => consumeTransfers("source-chat", "explicit-next-request")),
    /CHAT_ONLY_CHILD_FINDINGS/,
  );
  assert.equal(
    transaction(() => consumeTransfers("source-chat", "second-request")),
    "",
  );
  assert.equal(getChatGeneration(generation.id)!.status, "completed");
});

test("thread scope is persistent and the same ID cannot acquire a different or previously missing scope", async () => {
  const create = (id: string, scope?: AgentScope) => chatRoutes.request("http://localhost/chat/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, scope }),
  });
  assert.equal((await create("scoped", fixtureScope)).status, 200);
  assert.equal((await create("scoped", { ...fixtureScope, projectId: "other-project" })).status, 409);
  assert.equal((await create("scoped")).status, 200);
  ensureThread("legacy-readable");
  updateThread("legacy-readable", {
    settings: { ...getThread("legacy-readable")!.settings, providerInstanceId: "deepseek", model: "deepseek-chat" },
  });
  assert.equal((await create("legacy-readable", fixtureScope)).status, 409);
  assert.equal((await chatRoutes.request("http://localhost/chat/threads/legacy-readable/history")).status, 200);
  await assert.rejects(submitChat(request("legacy-readable")), { code: "scope_required" });
  assert.equal(resolvedRequests.length, 0);
  await stopPmCoreChanges();
  closeStore();
  const listed = await chatRoutes.request("http://localhost/chat/threads");
  const body = await listed.json() as { threads: { remoteId: string; scope?: AgentScope }[] };
  assert.deepEqual(body.threads.find((thread) => thread.remoteId === "scoped")?.scope, fixtureScope);
  assert.equal(body.threads.find((thread) => thread.remoteId === "legacy-readable")?.scope, undefined);
});

test("scope resolve forwards only request-local PM credentials, rejects PM failures and ignores browser cwd", async () => {
  const provider = await localProvider();
  try {
    configure();
    const headers = {
      "content-type": "application/json",
      cookie: "pm_v4_session=request-cookie-only",
      authorization: "Bearer request-bearer-only",
      "x-forwarded-host": "untrusted.invalid",
    };
    pmStatus = 403;
    const rejected = await chatRoutes.request("http://localhost/chat", {
      method: "POST", headers, body: JSON.stringify(request()),
    });
    assert.equal(rejected.status, 403);
    assert.equal(provider.prompts.length, 0);
    pmStatus = 200;
    const response = await chatRoutes.request("http://localhost/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...request(),
        cwd: "/untrusted-browser-directory",
        config: { cwd: "/untrusted-provider-directory" },
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const generationId = response.headers.get("x-resumable-stream-id")!;
    const accepted = getChatGeneration(generationId)!;
    assert.deepEqual(accepted.executionSnapshot, {
      scope: fixtureScope,
      workspaceName: "Fixture workspace",
      projectName: null,
      path: directory,
    });
    assert.equal(resolvedRequests.at(-1)?.cookie, headers.cookie);
    assert.equal(resolvedRequests.at(-1)?.authorization, headers.authorization);
    assert.doesNotMatch(JSON.stringify(accepted), /request-cookie-only|request-bearer-only/);
    await drain(generationId);
    await stopPmCoreChanges();
    closeStore();
    assert.equal(getChatGeneration(generationId)!.executionSnapshot?.path, directory);
    await resolveAgentScope(fixtureScope);
    assert.equal(resolvedRequests.at(-1)?.cookie, undefined);
    assert.equal(resolvedRequests.at(-1)?.authorization, undefined);
  } finally {
    await provider.close();
  }
});

test("two scoped CLI sessions execute in separate cwd and queued snapshots survive directory reconfiguration", { timeout: 30000 }, async () => {
  const { instance, log } = await controlledCliProvider();
  const originalCwd = process.cwd();
  const scopeA = { ...fixtureScope, projectId: "PRJ-001" };
  const scopeB = { workspaceId: secondWorkspace, projectId: null };
  const dirA = join(directory, "scope-a");
  const dirB = join(directory, "scope-b");
  const changedA = join(directory, "scope-a-reconfigured");
  for (const [cwd, marker] of [[dirA, "A_ONLY"], [dirB, "B_ONLY"], [changedA, "A_NEW_ONLY"]]) {
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "scope.txt"), marker);
  }
  scopePaths.set(JSON.stringify(scopeA), dirA);
  scopePaths.set(JSON.stringify(scopeB), dirB);
  configureScopedCli("scope-a-thread", scopeA, instance.instanceId);
  configureScopedCli("scope-b-thread", scopeB, instance.instanceId);
  const held = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const lock = withThreadExecution("scope-a-thread", async () => {
    acquired.resolve();
    await held.promise;
  });
  try {
    await acquired.promise;
    const aRequest = request("scope-a-thread");
    const a = await submitChat(aRequest);
    assert.equal(a.status, "queued");
    const b = await submitChat(request("scope-b-thread"));
    await drain(b.id);
    scopePaths.set(JSON.stringify(scopeA), changedA);
    assert.equal((await submitChat(aRequest)).id, a.id);
    held.resolve();
    await lock;
    await drain(a.id);
    assert.equal(getChatGeneration(a.id)!.status, "completed");
    assert.equal(getChatGeneration(b.id)!.status, "completed");
    assert.equal(getChatGeneration(a.id)!.executionSnapshot?.path, dirA);
    const next = await submitChat(nextRequest("scope-a-thread", "new-directory-turn"));
    await drain(next.id);
    assert.equal(getChatGeneration(next.id)!.executionSnapshot?.path, changedA);
    assert.equal(getChatGeneration(next.id)!.handoff?.mode, "portable");
    const events = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const executions = events.filter((event) => event.turn);
    assert.deepEqual(executions.map((event) => [event.cwd, event.marker]), [
      [dirB, "B_ONLY"], [dirA, "A_ONLY"], [changedA, "A_NEW_ONLY"],
    ]);
    assert.ok(events.filter((event) => event.session).every((event) => event.session === "thread/start"));
    assert.equal(getStoredInstance(instance.instanceId)!.config.binaryPath, join(directory, "scope-cli.mjs"));
    assert.equal(process.cwd(), originalCwd);
    await stopPmCoreChanges();
    closeStore();
    assert.deepEqual(getThread("scope-a-thread")!.scope, scopeA);
    assert.equal(getChatGeneration(a.id)!.executionSnapshot?.path, dirA);
  } finally {
    held.resolve();
    await lock;
  }
});

test("native resume, continuation and fork require matching scope and accepted directory", { timeout: 30000 }, async () => {
  const { instance, log } = await controlledCliProvider();
  const scope = { ...fixtureScope, projectId: "PRJ-002" };
  const initialPath = join(directory, "native-initial");
  const changedPath = join(directory, "native-changed");
  for (const cwd of [initialPath, changedPath]) {
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "scope.txt"), cwd);
  }
  scopePaths.set(JSON.stringify(scope), initialPath);
  configureScopedCli("native-thread", scope, instance.instanceId);
  const first = await submitChat(request("native-thread"));
  await drain(first.id);
  const resumed = await submitChat(nextRequest("native-thread", "native-next"));
  await drain(resumed.id);
  assert.equal(getChatGeneration(resumed.id)!.handoff?.mode, "native");
  await writeFile(join(initialPath, "fail-next"), "");
  const failure = await submitChat(nextRequest("native-thread", "native-fail"));
  await drain(failure.id);
  assert.equal(getChatGeneration(failure.id)!.status, "failed");
  assert.match(JSON.stringify(getChatGeneration(failure.id)!.output), new RegExp(initialPath));
  assert.equal(getThreadStableOutputs("native-thread").texts.length, 2);
  assert.ok(readChatEvents(failure.id).some((event) => event.chunk.type === "error"));
  await assert.rejects(continueChat(failure.id, false), { code: "side_effect_confirmation_required" });
  const recovered = await continueChat(failure.id, true);
  await drain(recovered.id);
  assert.equal(getChatGeneration(recovered.id)!.handoff?.mode, "native");
  await writeFile(join(initialPath, "fail-next"), "");
  const changedFailure = await submitChat(nextRequest("native-thread", "changed-fail"));
  await drain(changedFailure.id);
  scopePaths.set(JSON.stringify(scope), changedPath);
  const portable = await continueChat(changedFailure.id, true);
  await drain(portable.id);
  assert.equal(getChatGeneration(portable.id)!.status, "completed");
  assert.equal(getChatGeneration(portable.id)!.handoff?.mode, "portable");
  assert.equal(getChatGeneration(portable.id)!.executionSnapshot?.path, changedPath);
  const oldFork = await forkChatGeneration(first.id);
  assert.deepEqual(getThread(oldFork.threadId)!.scope, scope);
  const oldForkTurn = await submitChat(nextRequest(oldFork.threadId, "old-fork-turn"));
  await drain(oldForkTurn.id);
  assert.equal(getChatGeneration(oldForkTurn.id)!.handoff?.mode, "portable");
  const compatibleFork = await forkChatGeneration(portable.id);
  const compatibleTurn = await submitChat(nextRequest(compatibleFork.threadId, "compatible-fork-turn"));
  await drain(compatibleTurn.id);
  assert.equal(getChatGeneration(compatibleTurn.id)!.handoff?.mode, "native-fork");
  const changedInstructionsFork = await forkChatGeneration(portable.id);
  const branch = getThread(changedInstructionsFork.threadId)!;
  updateThread(branch.remoteId, { settings: { ...branch.settings, systemPrompt: "Different instructions require portable context." } });
  const changedInstructions = await submitChat(nextRequest(branch.remoteId, "changed-instructions-fork"));
  await drain(changedInstructions.id);
  assert.equal(getChatGeneration(changedInstructions.id)!.handoff?.mode, "portable");

  const otherScope = { ...scope, workspaceId: thirdWorkspace };
  scopePaths.set(JSON.stringify(otherScope), changedPath);
  configureScopedCli("wrong-native-owner", otherScope, instance.instanceId);
  const foreign = getChatGeneration(portable.id)!;
  saveFormattedMessage("wrong-native-owner", {
    id: "foreign-boundary", parent_id: null, format: CHAT_FORMAT,
    content: { role: "user", parts: [{ type: "text", text: "saved boundary" }] },
  }, true);
  setThreadNativeSession("wrong-native-owner", foreign.nativeSession, "foreign-boundary", "", scope);
  const wrongOwner = await submitChat(nextRequest("wrong-native-owner", "wrong-owner-turn"));
  await drain(wrongOwner.id);
  assert.equal(getChatGeneration(wrongOwner.id)!.handoff?.mode, "portable");
  const events = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.rpc).length, 1);
  assert.equal(events.find((event) => event.rpc).cwd, changedPath);
  assert.equal(events.filter((event) => event.session).at(-1).session, "thread/start");
});

test("a configured scope does not turn an uninstalled native Provider into a successful response", async () => {
  createProviderInstance({
    instanceId: "no-executable",
    driver: "codex",
    label: "Explicitly unavailable native executable",
    config: { binaryPath: join(directory, "missing-codex") },
  });
  ensureThread("no-provider-thread", undefined, fixtureScope);
  updateThread("no-provider-thread", {
    settings: { ...getThread("no-provider-thread")!.settings, providerInstanceId: "no-executable", model: "chat-model" },
  });
  const response = await chatRoutes.request("http://localhost/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request("no-provider-thread")),
  });
  assert.equal(response.status, 412);
  assert.equal((await response.json() as { code: string }).code, "provider_not_configured");
  assert.equal(getThreadHistory("no-provider-thread").messages.length, 0);
});

test("historical API selections remain readable and inert until explicit native reselection", async () => {
  const registryPath = join(directory, "provider-instances.json");
  const historicalRegistry = JSON.stringify({
    version: 1,
    instances: [{ instanceId: "retired-api", driver: "deepseek", label: "Historical API selection", revision: 1, env: {} }],
  });
  await writeFile(registryPath, historicalRegistry);
  ensureThread("historical-selection", undefined, fixtureScope);
  updateThread("historical-selection", {
    settings: {
      ...getThread("historical-selection")!.settings,
      providerInstanceId: "retired-api",
      model: "deepseek-chat",
    },
  });
  saveFormattedMessage("historical-selection", {
    id: "historical-user", parent_id: null, format: CHAT_FORMAT,
    content: { role: "user", parts: [{ type: "text", text: "PRESERVED_HISTORICAL_TASK" }] },
  }, true);
  const history = getThreadHistory("historical-selection");
  const readable = await chatRoutes.request("http://localhost/chat/threads/historical-selection/history");
  assert.equal(readable.status, 200);
  assert.match(await readable.text(), /PRESERVED_HISTORICAL_TASK/);
  const rejected = await chatRoutes.request("http://localhost/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nextRequest("historical-selection", "reselect-required")),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json() as { code: string }).code, "unknown_provider");
  assert.deepEqual(getThreadHistory("historical-selection"), history);
  assert.equal(getStoredInstance("retired-api"), null);
  assert.equal(await readFile(registryPath, "utf8"), historicalRegistry);
  const provider = await localProvider();
  try {
    configure("historical-selection");
    const accepted = await submitChat(nextRequest("historical-selection", "explicit-native-selection"));
    await drain(accepted.id);
    assert.equal(getChatGeneration(accepted.id)!.status, "completed");
    assert.equal(provider.prompts.length, 1);
    assert.equal(provider.prompts[0].model, "chat-model");
    assert.match(provider.prompts[0].prompt, /PRESERVED_HISTORICAL_TASK/);
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      instances: { instanceId: string; driver: string }[];
    };
    assert.equal(registry.instances.find((instance) => instance.instanceId === "retired-api")?.driver, "deepseek");
  } finally {
    await stopChatRuntime();
    await provider.close();
  }
});

test("archive, deletion and model edits win over a pending submission before acceptance", async () => {
  const provider = await localProvider();
  try {
    const cases = [
      { id: "archived-before-accept", code: "thread_archived", mutate: (id: string) => updateThread(id, { status: "archived" }) },
      { id: "deleted-before-accept", code: "thread_deleted", mutate: (id: string) => deleteThread(id) },
      { id: "edited-before-accept", code: "stale_settings", mutate: (id: string) => updateThread(id, {
        settings: { ...getThread(id)!.settings, systemPrompt: "A newer instruction" },
      }) },
    ];
    for (const entry of cases) {
      configure(entry.id);
      onScopeResolution = () => entry.mutate(entry.id);
      await assert.rejects(submitChat(request(entry.id)), { code: entry.code });
      assert.equal(getThreadHistory(entry.id).messages.length, 0);
    }
    assert.equal(provider.prompts.length, 0);
  } finally {
    await provider.close();
  }
});

test("restoring a thread is required before retrying an interrupted generation", async () => {
  const hold = Promise.withResolvers<void>();
  const provider = await localProvider(hold.promise);
  try {
    configure();
    const generation = await submitChat(request());
    await provider.started;
    await cancelChat(generation.id);
    const before = getThreadHistory("chat-thread");
    onScopeResolution = () => updateThread("chat-thread", { status: "archived" });
    await assert.rejects(continueChat(generation.id, true), { code: "thread_archived" });
    assert.deepEqual(getThreadHistory("chat-thread"), before);
    assert.equal(getChatGeneration(generation.id)!.continuationId, undefined);
    assert.equal(provider.prompts.length, 1);
  } finally {
    hold.resolve();
    await stopChatRuntime();
    await provider.close();
  }
});

test("browser model overrides cannot replace persisted session selection", async () => {
  const provider = await localProvider();
  try {
    configure();
    await assert.rejects(submitChat({
      ...request(), config: { providerInstanceId: "another-provider", modelName: "another-model" },
    }), { code: "stale_settings" });
    assert.equal(provider.prompts.length, 0);
    assert.equal(getThreadHistory("chat-thread").messages.length, 0);
  } finally {
    await provider.close();
  }
});

test("trusted Chat identity reaches native execution and native interrupted is not promoted to failure or completion", async () => {
  const provider = await localProvider();
  try {
    configure();
    let identity: { threadId: string; generationId: string; messageId: string; scope: AgentScope } | undefined;
    codexAdapter.run = async (context, options) => {
      identity = context.execution;
      assert.ok(context.pmToolBridge);
      options.onEvent?.({ type: "item.upsert", item: { id: "partial-native", type: "assistant_message", status: "interrupted", text: "saved partial" } });
      throw Object.assign(new Error("Native process reported interrupted"), { code: "aborted", terminalStatus: "interrupted" });
    };
    const generation = await submitChat(request());
    await drain(generation.id);
    assert.deepEqual(identity, { threadId: generation.threadId, generationId: generation.id, messageId: generation.messageId, scope: fixtureScope });
    assert.equal(getChatGeneration(generation.id)?.status, "interrupted");
    assert.equal(getNativeOutput(generation.id)?.status, "interrupted");
    assert.equal(getNativeOutput(generation.id)?.items[0].text, "saved partial");
    assert.equal(getThread(generation.threadId)?.nativeSession, undefined);
    assert.match(JSON.stringify(getThreadHistory(generation.threadId).messages.find((message) => message.id === generation.messageId)?.content.parts) ?? "", /saved partial/);
    assert.doesNotMatch(getChatGeneration(generation.id)?.error ?? "", /服务端已停止/);
  } finally { await provider.close(); }
});

for (const terminal of ["completed", "cancelled"] as const) {
  test(`structured native paragraphs reach Chat consumers before ${terminal}, without releasing unfinished text`, { timeout: 10_000 }, async () => {
    const first = "First native paragraph\n\n";
    const second = "Second native paragraph\n\n";
    const unfinished = "unfinished native tail";
    const provider = await structuredProvider(`${first}unfinished`);
    let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined;
    try {
      configure();
      const generation = await submitChat({ ...request(), config: { responseStreamingMode: "paragraph" } });
      await provider.started;
      reader = subscribeChat(generation.id).getReader();
      let observed = "";
      const readUntil = async (text: string) => {
        while (!observed.includes(text)) {
          const chunk = await reader!.read();
          assert.equal(chunk.done, false, "The stream must stay open until the native turn is released.");
          if (chunk.value?.type === "text-delta") observed += chunk.value.delta;
        }
      };
      await readUntil(first);
      assert.equal(getChatGeneration(generation.id)?.status, "running");
      assert.equal(String(observed), first);
      assert.ok(provider.native.emit);
      provider.native.emit(`${first}${second}${unfinished}`);
      provider.native.emit(`${first}${second}${unfinished}`);
      await readUntil(second);
      assert.equal(getChatGeneration(generation.id)?.status, "running");
      assert.equal(String(observed), `${first}${second}`);
      assert.doesNotMatch(observed, /unfinished|child-only/);
      assert.equal(getNativeOutput(generation.id)?.items.find((item) => item.id === "native-root")?.text, `${first}${second}`);
      if (terminal === "cancelled") await cancelChat(generation.id);
      else provider.finish();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.type === "text-delta") observed += chunk.value.delta;
      }
      assert.equal(getChatGeneration(generation.id)?.status, terminal);
      assert.equal(observed, `${first}${second}${unfinished}`);
      const replay = await drain(generation.id);
      assert.equal(replay.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join(""), observed);
      assert.match(JSON.stringify(getThreadHistory(generation.threadId)), /unfinished native tail/);
    } finally {
      provider.finish();
      await reader?.cancel();
      await stopChatRuntime();
      await provider.close();
    }
  });
}

test("turn mode retains structured native paragraphs until the native terminal", { timeout: 10_000 }, async () => {
  const text = "Complete paragraph\n\nunfinished tail";
  const provider = await structuredProvider(text);
  try {
    configure();
    const generation = await submitChat({ ...request(), config: { responseStreamingMode: "turn" } });
    await provider.started;
    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    assert.equal(getChatGeneration(generation.id)?.status, "running");
    assert.equal(readChatEvents(generation.id).some((event) => event.chunk.type === "text-delta"), false);
    assert.equal(getNativeOutput(generation.id)?.items.find((item) => item.id === "native-root")?.text, "");
    provider.finish();
    const chunks = await drain(generation.id);
    assert.equal(getChatGeneration(generation.id)?.status, "completed");
    assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join(""), text);
  } finally {
    provider.finish();
    await stopChatRuntime();
    await provider.close();
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { chatOnlyExecutionSelection, type ExecutionEnvironment, type ExecutionSelection } from "@agent-workspace/contracts/chat";
import type { NativeSessionRef, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import type { AgentOutputFrame } from "@agent-workspace/contracts/output";
import { codexAdapter } from "../providers/drivers/codex.ts";
import { claudeAdapter } from "../providers/drivers/claude.ts";
import { getThreadUsage } from "../usage/ledger.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../providers/instances.ts";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { chatRoutes } from "../chat.ts";
import { openAgentWorkspace, updateAgentWorkspace } from "../agent-workspaces.ts";
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
  lookupChatSubmission,
  readChatEvents,
  startChatRuntime,
  stopChatRuntime,
  submitChat,
  subscribeChat,
  type ChatGeneration,
  type ChatRequest,
} from "./chat-runtime.ts";
import { withThreadExecution } from "./engine.ts";
import { getNativeOutput, respondNativeInteraction, subscribeCommandOutput, subscribeNativeOutput } from "./native-output.ts";
import { closeStore, listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import {
  CHAT_FORMAT,
  deleteThread,
  ensureThread,
  forkThreadHistory,
  freezeThreadExecution,
  getThread,
  getThreadBranch,
  getThreadHistory,
  getThreadStableOutputs,
  saveFormattedMessage,
  setThreadNativeSession,
  updateThread,
} from "./threads.ts";
import { consumeTransfers, getThreadFork, TRANSFERS } from "./transfers.ts";
import { getMergePreview, mergeThread } from "./forks.ts";
import { resolveAgentExecution } from "./agent-execution.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../providers/t3code/application.ts";
import { providerApplicationOptions } from "../providers/t3code/production.ts";
import { chatOnlyEnvironment } from './execution.testkit.ts';
import type { ChatContextInput } from "@agent-workspace/contracts/message-context";
import { contextDigest, resolveChatContextItems } from "./message-context.ts";
import { createPmVisibilityProjector } from "../pm-visibility.ts";
import type { ChatAttachment } from "@t3tools/contracts";
import { providerAttachmentsDirectory, resolveAttachmentPath } from "../providers/t3code/upstream-services/attachments.ts";
import { resolveProviderRuntime } from "../providers/runtime.ts";

let directory: string;
let fixtureSelection: ExecutionSelection;
let fixtureEnvironment: ExecutionEnvironment;
let networkRequests: string[];
let onProviderCheck: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const originalPmUrl = process.env.PM_API_URL;
const originalAllowedRoots = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalCodexCheck = codexAdapter.check;
const originalCodexRun = codexAdapter.run;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "durable-chat-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  process.env.PM_API_URL = "http://127.0.0.1:1";
  networkRequests = [];
  onProviderCheck = undefined;
  globalThis.fetch = async input => {
    networkRequests.push(input instanceof Request ? input.url : String(input));
    throw new Error("Plain Agent execution must not require a network request.");
  };
  const workspace = openAgentWorkspace({ path: directory, name: "Fixture directory" });
  fixtureSelection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  fixtureEnvironment = (await resolveAgentExecution(fixtureSelection, "fixture")).environment;
  await startPmProviderApplication(providerApplicationOptions);
});
afterEach(async () => {
  await stopChatRuntime();
  await stopPmProviderApplication();
  codexAdapter.check = originalCodexCheck;
  codexAdapter.run = originalCodexRun;
  closeStore();
  globalThis.fetch = originalFetch;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
  if (originalAllowedRoots === undefined) delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
  else process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = originalAllowedRoots;
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
    const onCheck = onProviderCheck;
    onProviderCheck = undefined;
    onCheck?.();
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
function configure(id = "chat-thread", selection = fixtureSelection) {
  ensureThread(id, undefined, selection);
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

test("structured Chat body excludes completion-only commentary, retains unknown phase and native order, and never trusts a mixed driver result", async () => {
  await localProvider();
  configure();
  const received = Promise.withResolvers<void>();
  const terminal = Promise.withResolvers<void>();
  codexAdapter.run = async (_context, options) => {
    const order = (ordinal: number) => ({ scope: "native-turn", ordinal });
    options.onEvent?.({ type: "item.upsert", item: { id: "progress", type: "assistant_message", status: "running",
      order: order(0), text: "Unclassified until completed\n\n" } });
    options.onText?.("Unclassified until completed\n\n");
    options.onEvent?.({ type: "item.upsert", item: { id: "tool", type: "command_execution", status: "completed", order: order(1), output: "tool-only" } });
    options.onEvent?.({ type: "item.upsert", item: { id: "final", type: "assistant_message", status: "completed",
      order: order(3), phase: "final_answer", text: "Final answer" } });
    // Same ID is a cumulative correction; phase comes only from explicit evidence.
    options.onEvent?.({ type: "item.upsert", item: { id: "progress", type: "assistant_message", status: "completed",
      order: order(0), phase: "commentary", text: "Progress, not an answer" } });
    options.onEvent?.({ type: "item.upsert", item: { id: "unknown", type: "assistant_message", status: "completed",
      order: order(2), text: "Unknown phase text" } });
    received.resolve();
    await terminal.promise;
    return { text: "Progress, not an answer\n\nFinal answer\n\nuntrusted convenience suffix" };
  };
  let generation: ChatGeneration | undefined;
  try {
    generation = await submitChat(request());
    await received.promise;
    assert.equal(getChatGeneration(generation.id)?.status, "running");
    assert.equal(readChatEvents(generation.id).some(event => event.chunk.type === "text-delta"), false);
    assert.equal(getNativeOutput(generation.id)?.items.find(item => item.id === "progress")?.phase, "commentary");
    terminal.resolve();
    const chunks = await drain(generation.id);
    const body = chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.delta).join("");
    assert.equal(body, "Unknown phase text\n\nFinal answer");
    const saved = getThreadHistory(generation.threadId).messages.find(message => message.id === generation!.messageId)!;
    const savedMessage = saved.content as unknown as UIMessage;
    assert.equal(savedMessage.parts.filter(part => part.type === "text").map(part => part.text).join(""), body);
    closeStore();
    assert.deepEqual(await drain(generation.id), chunks, "Chat replay uses saved chunks, never a provider redispatch.");
    assert.equal(getNativeOutput(generation.id)?.items.find(item => item.id === "unknown")?.phase, undefined);
    assert.equal(getChatGeneration(generation.id)?.status, "completed");
  } finally {
    terminal.resolve();
    if (generation) await cancelChat(generation.id);
  }
});

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
  await stopChatRuntime();
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
  await stopChatRuntime();
  closeStore();
  assert.equal(getThreadUsage("chat-thread").reportedTurn?.cachedInputTokens, 40);
});

async function controlledCliProvider() {
  const executable = join(directory, "directory-cli.mjs");
  const log = join(directory, "directory-cli.jsonl");
  await writeFile(executable, await readFile(new URL("../providers/drivers/codex-protocol-fixture.mjs", import.meta.url), "utf8"));
  await chmod(executable, 0o700);
  const instance = createProviderInstance({
    instanceId: "directory-cli",
    driver: "codex",
    label: "Controlled directory subprocess",
    config: { binaryPath: executable, homePath: directory },
    environment: [{ name: "SCOPE_LOG", value: log, sensitive: false }],
  });
  return { instance, log };
}

function configureDirectoryCli(id: string, selection: ExecutionSelection, providerInstanceId: string) {
  ensureThread(id, undefined, selection);
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

test("thread settings and authoritative history are isolated and revision checked", () => {
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
  assert.equal(getThreadHistory("a").messages[0].content.parts instanceof Array, true);
  assert.match(JSON.stringify(getThreadHistory("a")), /authoritative/);
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
  test(`Claude ${mode} compacts the authorized native session as a durable turn`, { timeout: 30000 }, async () => {
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
        assert.deepEqual(context.execution?.environment, { ...fixtureEnvironment, frozen: true });
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
      ensureThread("compact-thread", undefined, fixtureSelection);
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
      assert.deepEqual(networkRequests, []);
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
    threadSettingsSnapshot: { ...getThread(value.id)!.settings },
    executionSnapshot: { path: directory, environment: { ...fixtureEnvironment, frozen: true } },
  };
  freezeThreadExecution(value.id, generation.executionSnapshot!.environment!, directory);
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
      // A transfer has an actual retained source Session. A missing source is
      // intentionally unprovable and must force a clean portable rebuild.
      configure("merged-child");
      saveFormattedMessage("merged-child", {
        id: "merged-source-input", parent_id: null, format: CHAT_FORMAT,
        content: { role: "user", parts: [{ type: "text", text: "MERGED_REFERENCE_DO_NOT_REEXECUTE" }] },
      }, true);
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
      assert.match(provider.prompts[0]!.prompt, /MERGED_REFERENCE_DO_NOT_REEXECUTE/);
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

test("obsolete browser import route cannot create or overwrite Sessions", async () => {
  configure("claimed");
  const original = getThread("claimed");
  const response = await chatRoutes.request("http://localhost/chat/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ migrationId: "old-browser", threads: [{ remoteId: "claimed", title: "overwrite" }, { remoteId: "legacy-import" }] }) });
  assert.equal(response.status, 404);
  assert.deepEqual(getThread("claimed"), original);
  assert.equal(getThread("legacy-import"), null);
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
      path: directory,
      environment: { ...fixtureEnvironment, frozen: true },
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
  freezeThreadExecution("source-chat", generation.executionSnapshot!.environment, directory);
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
  await stopChatRuntime();
  await assert.rejects(forkChatGeneration(generation.id, { idempotencyKey: "fork-source" }), { code: "chat_runtime_stopping" });
  await startChatRuntime();
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

test("a fork of a frozen controlled worktree starts independently at its selected source directory", async () => {
  const provider = await localProvider();
  try {
    configure("controlled-source");
    const worktreePath = join(directory, "controlled-worktree");
    await mkdir(worktreePath);
    const worktreeEnvironment: ExecutionEnvironment = {
      ...fixtureEnvironment,
      executionPath: worktreePath,
      worktree: { deliveryId: "controlled-delivery", branch: "controlled-branch" },
      frozen: true,
    };
    freezeThreadExecution("controlled-source", worktreeEnvironment, worktreePath);
    updateThread("controlled-source", { custom: { worktreeWriteConfirmed: true } });
    forkThreadHistory("controlled-source", "standalone-branch", "Saved controlled worktree findings.");
    const branch = getThread("standalone-branch")!;
    assert.deepEqual(branch.executionSelection, fixtureSelection);
    assert.deepEqual(branch.executionEnvironment, fixtureEnvironment);
    assert.equal(branch.executionPath, undefined);
    assert.equal(branch.custom?.worktreeWriteConfirmed, undefined);
    const generation = await submitChat(nextRequest(branch.remoteId, "standalone-turn"));
    await drain(generation.id);
    assert.equal(getChatGeneration(generation.id)!.status, "completed");
    assert.deepEqual(getChatGeneration(generation.id)!.executionSnapshot, {
      path: directory,
      environment: { ...fixtureEnvironment, frozen: true },
    });
    assert.equal(provider.prompts[0]!.cwd, directory);
  } finally {
    await provider.close();
  }
});

test("independent directory and chat-only Sessions persist without PM ownership or network access", async () => {
  const create = (id: string, executionSelection = chatOnlyExecutionSelection(), extra: object = {}) => chatRoutes.request("http://localhost/chat/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, executionSelection, ...extra }),
  });
  assert.equal((await create("directory-session", fixtureSelection)).status, 200);
  assert.equal((await create("directory-session", fixtureSelection)).status, 200);
  assert.equal((await create("directory-session")).status, 409);
  assert.equal((await create("scratch-session")).status, 200);
  ensureThread("default-session");
  assert.deepEqual(getThread("default-session")!.executionSelection, chatOnlyExecutionSelection());
  for (const field of ["scope", "pmContext"]) {
    assert.equal((await create(`rejected-${field}`, fixtureSelection, { [field]: {} })).status, 400);
    assert.equal(getThread(`rejected-${field}`), null);
    const patched = await chatRoutes.request("http://localhost/chat/threads/directory-session", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: {} }),
    });
    assert.equal(patched.status, 400);
  }
  closeStore();
  const listed = await chatRoutes.request("http://localhost/chat/threads");
  assert.equal(listed.status, 200);
  const body = await listed.json() as { threads: { remoteId: string; executionSelection: ExecutionSelection; executionEnvironment?: ExecutionEnvironment }[] };
  assert.deepEqual(body.threads.find(thread => thread.remoteId === "directory-session")?.executionSelection, fixtureSelection);
  assert.deepEqual(body.threads.find(thread => thread.remoteId === "scratch-session")?.executionEnvironment, chatOnlyEnvironment());
  assert.ok(body.threads.every(thread => !Object.hasOwn(thread, "scope") && !Object.hasOwn(thread, "pmContext")));
  assert.deepEqual(networkRequests, []);
});

test("plain directory execution ignores browser cwd and never persists request-local PM credentials", async () => {
  const provider = await localProvider();
  try {
    configure();
    const response = await chatRoutes.request("http://localhost/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "pm_v4_session=request-cookie-only",
        authorization: "Bearer request-bearer-only",
        "x-forwarded-host": "untrusted.invalid",
      },
      body: JSON.stringify({
        ...request(),
        cwd: "/untrusted-browser-directory",
        config: { cwd: "/untrusted-provider-directory" },
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const generationId = response.headers.get("x-resumable-stream-id")!;
    await drain(generationId);
    const accepted = getChatGeneration(generationId)!;
    assert.equal(accepted.status, "completed");
    assert.deepEqual(accepted.executionSnapshot, { path: directory, environment: { ...fixtureEnvironment, frozen: true } });
    assert.equal(provider.prompts[0]!.cwd, directory);
    assert.deepEqual(networkRequests, []);
    await stopChatRuntime();
    closeStore();
    assert.equal(getChatGeneration(generationId)!.executionSnapshot?.path, directory);
    const persisted = JSON.stringify({
      thread: getThread("chat-thread"),
      generation: getChatGeneration(generationId),
      history: getThreadHistory("chat-thread"),
    });
    assert.doesNotMatch(persisted, /request-cookie-only|request-bearer-only|pm_v4_session|authorization/i);
  } finally {
    await provider.close();
  }
});

test("chat-only Sessions resolve private stable scratch and forks receive independent scratch", async () => {
  const provider = await localProvider();
  try {
    const selection = chatOnlyExecutionSelection();
    configure("scratch-source", selection);
    const first = await submitChat(request("scratch-source"));
    await drain(first.id);
    const accepted = getChatGeneration(first.id)!;
    const firstPath = accepted.executionSnapshot!.path;
    assert.deepEqual(accepted.executionSnapshot!.environment, chatOnlyEnvironment(true));
    assert.equal(provider.prompts[0]!.cwd, firstPath);
    assert.notEqual(firstPath, directory);
    assert.equal((await resolveAgentExecution(selection, "scratch-source")).path, firstPath);
    const fork = await forkChatGeneration(first.id);
    const child = getThread(fork.threadId)!;
    assert.deepEqual(child.executionSelection, selection);
    assert.deepEqual(child.executionEnvironment, chatOnlyEnvironment());
    assert.equal(child.executionPath, undefined);
    const turn = await submitChat(nextRequest(fork.threadId, "scratch-fork-turn"));
    await drain(turn.id);
    assert.equal(getChatGeneration(turn.id)!.handoff?.mode, "portable");
    assert.notEqual(getChatGeneration(turn.id)!.executionSnapshot!.path, firstPath);
    assert.equal(provider.prompts[1]!.resume, undefined);
    assert.deepEqual(getChatGeneration(turn.id)!.executionSnapshot!.environment, chatOnlyEnvironment(true));
    const publicThread = await chatRoutes.request(`http://localhost/chat/threads/${fork.threadId}`);
    assert.doesNotMatch(await publicThread.text(), new RegExp(firstPath));
    assert.deepEqual(networkRequests, []);
  } finally {
    await provider.close();
  }
});

test("two directory CLI Sessions keep cwd, native identity and durable history independent", { timeout: 30000 }, async () => {
  const { instance, log } = await controlledCliProvider();
  const originalCwd = process.cwd();
  const dirA = join(directory, "directory-a");
  const dirB = join(directory, "directory-b");
  for (const [cwd, marker] of [[dirA, "A_ONLY"], [dirB, "B_ONLY"]]) {
    await mkdir(cwd);
    await writeFile(join(cwd, "scope.txt"), marker);
  }
  const workspaceA = openAgentWorkspace({ path: dirA, name: "Repository" });
  const workspaceB = openAgentWorkspace({ path: dirB, name: "Repository" });
  const selectionA: ExecutionSelection = { version: 2, agentWorkspaceId: workspaceA.id, agentWorkspaceRevision: workspaceA.revision };
  const selectionB: ExecutionSelection = { version: 2, agentWorkspaceId: workspaceB.id, agentWorkspaceRevision: workspaceB.revision };
  assert.notEqual(workspaceA.id, workspaceB.id);
  configureDirectoryCli("directory-a-thread", selectionA, instance.instanceId);
  configureDirectoryCli("directory-b-thread", selectionB, instance.instanceId);
  const a = await submitChat(request("directory-a-thread"));
  await drain(a.id);
  const b = await submitChat(request("directory-b-thread"));
  await drain(b.id);
  const resumedA = await submitChat(nextRequest("directory-a-thread", "directory-a-next"));
  await drain(resumedA.id);
  assert.equal(getChatGeneration(resumedA.id)!.handoff?.mode, "native");
  assert.notEqual(getChatGeneration(a.id)!.nativeSession!.sessionId, getChatGeneration(b.id)!.nativeSession!.sessionId);
  const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.turn).map(event => [event.cwd, event.marker]), [
    [dirA, "A_ONLY"], [dirB, "B_ONLY"], [dirA, "A_ONLY"],
  ]);
  assert.match(JSON.stringify(getThreadHistory("directory-a-thread")), /A_ONLY/);
  assert.doesNotMatch(JSON.stringify(getThreadHistory("directory-a-thread")), /B_ONLY/);
  assert.match(JSON.stringify(getThreadHistory("directory-b-thread")), /B_ONLY/);
  assert.doesNotMatch(JSON.stringify(getThreadHistory("directory-b-thread")), /A_ONLY/);
  assert.equal(getStoredInstance(instance.instanceId)!.config.binaryPath, join(directory, "directory-cli.mjs"));
  assert.equal(process.cwd(), originalCwd);
  await stopChatRuntime();
  closeStore();
  assert.deepEqual(getThread("directory-a-thread")!.executionSelection, selectionA);
  assert.deepEqual(getThread("directory-b-thread")!.executionSelection, selectionB);
  assert.equal(getChatGeneration(a.id)!.executionSnapshot!.path, dirA);
  assert.equal(getChatGeneration(b.id)!.executionSnapshot!.path, dirB);
  // Catalog and CLI-version discovery may attempt optional upstream fetches;
  // every fetch still fails, and no PM request is allowed.
  assert.deepEqual(networkRequests.filter(url => new URL(url).origin === new URL(process.env.PM_API_URL!).origin), []);
});

test("missing or replaced roots reject queued and future turns without adopting replacement directories", { timeout: 10000 }, async () => {
  const provider = await localProvider();
  const root = join(directory, "frozen-root");
  const originalRoot = join(directory, "original-root");
  await mkdir(root);
  const workspace = openAgentWorkspace({ path: root });
  const selection: ExecutionSelection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  configure("replacement-thread", selection);
  const held = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const lock = withThreadExecution("replacement-thread", async () => {
    acquired.resolve();
    await held.promise;
  });
  try {
    await acquired.promise;
    const submitted = request("replacement-thread");
    const generation = await submitChat(submitted);
    assert.equal(generation.status, "queued");
    assert.equal(getThread("replacement-thread")!.executionEnvironment!.frozen, true);
    await rename(root, originalRoot);
    await assert.rejects(resolveAgentExecution(selection, "replacement-thread"), { code: "directory_unavailable" });
    await mkdir(root);
    await assert.rejects(resolveAgentExecution(selection, "replacement-thread"), { code: "workspace_directory_changed" });
    assert.throws(() => openAgentWorkspace({ path: root }), { code: "workspace_directory_changed" });
    await assert.rejects(submitChat(submitted), { code: "workspace_directory_changed" });
    held.resolve();
    await lock;
    await drain(generation.id);
    assert.equal(getChatGeneration(generation.id)!.status, "failed");
    assert.equal(getChatGeneration(generation.id)!.executionSnapshot!.path, root);
    await assert.rejects(submitChat(nextRequest("replacement-thread", "replacement-next")), { code: "workspace_directory_changed" });
    assert.equal(provider.prompts.length, 0);
    assert.deepEqual(getThread("replacement-thread")!.executionSelection, selection);
  } finally {
    held.resolve();
    await lock;
    await provider.close();
  }
});

test("native resume, continuation and fork require the accepted independent directory identity", { timeout: 90000 }, async () => {
  const { instance, log } = await controlledCliProvider();
  const initialPath = join(directory, "native-initial");
  const changedPath = join(directory, "native-other");
  const originalPath = join(directory, "native-original-identity");
  for (const cwd of [initialPath, changedPath]) {
    await mkdir(cwd);
    await writeFile(join(cwd, "scope.txt"), cwd);
  }
  const workspace = openAgentWorkspace({ path: initialPath });
  const selection: ExecutionSelection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  configureDirectoryCli("native-thread", selection, instance.instanceId);
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
  assert.ok(readChatEvents(failure.id).some(event => event.chunk.type === "error"));
  await assert.rejects(continueChat(failure.id, false), { code: "side_effect_confirmation_required" });
  const recovered = await continueChat(failure.id, true);
  await drain(recovered.id);
  assert.equal(getChatGeneration(recovered.id)!.handoff?.mode, "native");
  await writeFile(join(initialPath, "fail-next"), "");
  const changedFailure = await submitChat(nextRequest("native-thread", "changed-fail"));
  await drain(changedFailure.id);
  await rename(initialPath, originalPath);
  await mkdir(initialPath);
  await assert.rejects(continueChat(changedFailure.id, true), { code: "workspace_directory_changed" });
  assert.equal(getChatGeneration(changedFailure.id)!.continuationId, undefined);
  await rm(initialPath, { recursive: true });
  await rename(originalPath, initialPath);
  const restored = await continueChat(changedFailure.id, true);
  await drain(restored.id);
  assert.equal(getChatGeneration(restored.id)!.status, "completed");
  assert.equal(getChatGeneration(restored.id)!.handoff?.mode, "native");
  assert.equal(getChatGeneration(restored.id)!.executionSnapshot!.path, initialPath);
  const oldFork = await forkChatGeneration(first.id);
  assert.deepEqual(getThread(oldFork.threadId)!.executionSelection, selection);
  assert.equal(getThread(oldFork.threadId)!.executionEnvironment!.frozen, false);
  assert.equal(getThread(oldFork.threadId)!.executionEnvironment!.worktree, null);
  assert.equal(getThread(oldFork.threadId)!.executionPath, undefined);
  const oldForkTurn = await submitChat(nextRequest(oldFork.threadId, "old-fork-turn"));
  await drain(oldForkTurn.id);
  assert.equal(getChatGeneration(oldForkTurn.id)!.handoff?.mode, "native-fork");
  const compatibleFork = await forkChatGeneration(restored.id);
  const compatibleTurn = await submitChat(nextRequest(compatibleFork.threadId, "compatible-fork-turn"));
  await drain(compatibleTurn.id);
  assert.equal(getChatGeneration(compatibleTurn.id)!.handoff?.mode, "native-fork");
  const changedInstructionsFork = await forkChatGeneration(restored.id);
  const branch = getThread(changedInstructionsFork.threadId)!;
  updateThread(branch.remoteId, { settings: { ...branch.settings, systemPrompt: "Different instructions require portable context." } });
  const changedInstructions = await submitChat(nextRequest(branch.remoteId, "changed-instructions-fork"));
  await drain(changedInstructions.id);
  assert.equal(getChatGeneration(changedInstructions.id)!.handoff?.mode, "portable");
  const otherWorkspace = openAgentWorkspace({ path: changedPath });
  const otherSelection: ExecutionSelection = { version: 2, agentWorkspaceId: otherWorkspace.id, agentWorkspaceRevision: otherWorkspace.revision };
  configureDirectoryCli("wrong-native-owner", otherSelection, instance.instanceId);
  const foreign = getChatGeneration(restored.id)!;
  saveFormattedMessage("wrong-native-owner", {
    id: "foreign-boundary", parent_id: null, format: CHAT_FORMAT,
    content: { role: "user", parts: [{ type: "text", text: "saved boundary" }] },
  }, true);
  setThreadNativeSession("wrong-native-owner", foreign.nativeSession, "foreign-boundary", "", foreign.executionSnapshot!.environment);
  const wrongOwner = await submitChat(nextRequest("wrong-native-owner", "wrong-owner-turn"));
  await drain(wrongOwner.id);
  assert.equal(getChatGeneration(wrongOwner.id)!.handoff?.mode, "portable");
  const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.rpc).length, 2);
  assert.ok(events.filter(event => event.rpc).every(event => event.cwd === initialPath));
  assert.equal(events.filter(event => event.session).at(-1).session, "thread/start");
});

test("an independent directory does not turn an uninstalled native Provider into a successful response", async () => {
  createProviderInstance({
    instanceId: "no-executable",
    driver: "codex",
    label: "Explicitly unavailable native executable",
    config: { binaryPath: join(directory, "missing-codex") },
  });
  ensureThread("no-provider-thread", undefined, fixtureSelection);
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
  ensureThread("historical-selection", undefined, fixtureSelection);
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
      { id: "archived-before-accept", code: "thread_archived", mutate: (id: string) => updateThread(id, { status: "archived", lifecycleRevision: getThread(id)!.lifecycleRevision ?? 0 }) },
      { id: "deleted-before-accept", code: "thread_deleted", mutate: (id: string) => deleteThread(id) },
      { id: "edited-before-accept", code: "stale_settings", mutate: (id: string) => updateThread(id, {
        settings: { ...getThread(id)!.settings, systemPrompt: "A newer instruction" },
      }) },
    ];
    for (const entry of cases) {
      configure(entry.id);
      onProviderCheck = () => entry.mutate(entry.id);
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
    onProviderCheck = () => updateThread("chat-thread", { status: "archived", lifecycleRevision: getThread("chat-thread")!.lifecycleRevision ?? 0 });
    await assert.rejects(continueChat(generation.id, true), { code: "thread_archived" });
    assert.deepEqual(getThreadHistory("chat-thread"), before);
    assert.equal(getChatGeneration(generation.id)!.continuationId, undefined);
    assert.equal(provider.prompts.length, 1);
    updateThread("chat-thread", { status: "regular", lifecycleRevision: getThread("chat-thread")!.lifecycleRevision ?? 0 });
    hold.resolve();
    const continued = await continueChat(generation.id, true);
    await drain(continued.id);
    assert.equal(getChatGeneration(continued.id)!.status, "completed");
    assert.equal(provider.prompts.length, 2);
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
    let identity: ProviderDriverContext["execution"];
    codexAdapter.run = async (context, options) => {
      identity = context.execution;
      assert.ok(context.pmToolBridge);
      options.onEvent?.({ type: "item.upsert", item: { id: "partial-native", type: "assistant_message", status: "interrupted", text: "saved partial" } });
      throw Object.assign(new Error("Native process reported interrupted"), { code: "aborted", terminalStatus: "interrupted" });
    };
    const generation = await submitChat(request());
    await drain(generation.id);
    assert.ok(identity);
    assert.equal(identity.threadId, generation.threadId);
    assert.equal(identity.generationId, generation.id);
    assert.equal(identity.messageId, generation.messageId);
    assert.deepEqual(identity.environment, generation.executionSnapshot?.environment);
    assert.equal(identity.inputMessageId, generation.inputMessageId);
    assert.equal(identity.traceId, generation.traceId);
    assert.equal(identity.executionGrantId, generation.executionGrantId);
    assert.equal(getChatGeneration(generation.id)?.status, "interrupted");
    assert.equal(getNativeOutput(generation.id)?.status, "interrupted");
    assert.equal(getNativeOutput(generation.id)?.items[0].text, "saved partial");
    assert.equal(getThread(generation.threadId)?.nativeSession, undefined);
    assert.match(JSON.stringify(getThreadHistory(generation.threadId).messages.find((message) => message.id === generation.messageId)?.content.parts) ?? "", /saved partial/);
    assert.doesNotMatch(getChatGeneration(generation.id)?.error ?? "", /服务端已停止/);
  } finally { await provider.close(); }
});

for (const terminal of ["completed", "cancelled"] as const) {
  test(`unknown-phase native paragraphs reach timeline consumers before ${terminal}, without being classified as final`, { timeout: 10_000 }, async () => {
    const first = "First native paragraph\n\n";
    const second = "Second native paragraph\n\n";
    const unfinished = "unfinished native tail";
    const provider = await structuredProvider(`${first}unfinished`);
    let reader: ReadableStreamDefaultReader<AgentOutputFrame> | undefined;
    try {
      configure();
      const generation = await submitChat({ ...request(), config: { responseStreamingMode: "paragraph" } });
      await provider.started;
      const chat = subscribeChat(generation.id).getReader();
      const start = (await chat.read()).value;
      assert.ok(start?.type === "start");
      assert.deepEqual(start.messageMetadata, { durable: { generationId: generation.id, inputMessageId: generation.inputMessageId,
        traceId: generation.traceId, executionGrantId: generation.executionGrantId, executionPolicy: generation.executionPolicy, nativeOutput: true } });
      await chat.cancel();
      reader = subscribeNativeOutput(generation.id).getReader();
      let observed = "";
      const readUntil = async (text: string) => {
        while (!observed.includes(text)) {
          const chunk = await reader!.read();
          assert.equal(chunk.done, false, "The stream must stay open until the native turn is released.");
          const frame = chunk.value;
          if (frame?.kind === "snapshot") observed = frame.snapshot.items.find(item => item.id === "native-root")?.text ?? "";
          else if (frame?.kind === "item" && frame.item.id === "native-root") observed = frame.item.text ?? "";
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
      assert.equal(getNativeOutput(generation.id)?.items.find(item => item.id === "native-root")?.phase, undefined);
      assert.equal(readChatEvents(generation.id).some(event => event.chunk.type === "text-delta"), false);
      if (terminal === "cancelled") await cancelChat(generation.id);
      else provider.finish();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const frame = chunk.value;
        if (frame.kind === "snapshot") observed = frame.snapshot.items.find(item => item.id === "native-root")?.text ?? "";
        else if (frame.kind === "item" && frame.item.id === "native-root") observed = frame.item.text ?? "";
      }
      const replay = await drain(generation.id);
      assert.equal(getChatGeneration(generation.id)?.status, terminal);
      assert.equal(observed, `${first}${second}${unfinished}`);
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

test("directory selection requires CAS and freezes on first execution while metadata edits preserve the binding", async () => {
  const provider = await localProvider();
  try {
    configure();
    const one = join(directory, "selected-one");
    const two = join(directory, "selected-two");
    await mkdir(one);
    await mkdir(two);
    const workspaceOne = openAgentWorkspace({ path: one });
    const workspaceTwo = openAgentWorkspace({ path: two });
    const selectionOne: ExecutionSelection = { version: 2, agentWorkspaceId: workspaceOne.id, agentWorkspaceRevision: workspaceOne.revision };
    const selectionTwo: ExecutionSelection = { version: 2, agentWorkspaceId: workspaceTwo.id, agentWorkspaceRevision: workspaceTwo.revision };
    const put = (input: object) => chatRoutes.request("http://localhost/chat/threads/chat-thread", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const revision = getThread("chat-thread")!.revision;
    assert.equal((await put({ executionSelection: selectionOne })).status, 400);
    assert.equal((await put({ executionSelection: selectionOne, revision: revision - 1 })).status, 409);
    assert.deepEqual(getThread("chat-thread")!.executionSelection, fixtureSelection);
    assert.equal((await put({ executionSelection: selectionOne, revision })).status, 200);
    assert.deepEqual(getThread("chat-thread")!.executionSelection, selectionOne);
    assert.equal(getThread("chat-thread")!.executionEnvironment!.frozen, false);
    assert.equal((await put({ executionSelection: selectionTwo, revision: getThread("chat-thread")!.revision })).status, 200);
    const generation = await submitChat(request());
    assert.equal(getThread("chat-thread")!.executionEnvironment!.frozen, true);
    await drain(generation.id);
    assert.equal(provider.prompts[0]!.cwd, two);
    const acceptedEnvironment = getChatGeneration(generation.id)!.executionSnapshot!.environment;
    updateAgentWorkspace(workspaceTwo.id, { expectedRevision: workspaceTwo.revision, name: "Renamed directory", archived: true });
    const next = await submitChat(nextRequest("chat-thread", "after-metadata-edit"));
    await drain(next.id);
    assert.equal(getChatGeneration(next.id)!.status, "completed");
    assert.equal(getChatGeneration(next.id)!.handoff?.mode, "native");
    assert.equal(provider.prompts[1]!.cwd, two);
    assert.deepEqual(getThread("chat-thread")!.executionSelection, selectionTwo);
    const currentEnvironment = getChatGeneration(next.id)!.executionSnapshot!.environment;
    assert.deepEqual({ ...currentEnvironment, agentWorkspaceName: acceptedEnvironment.agentWorkspaceName }, acceptedEnvironment);
    assert.equal((await put({ executionSelection: selectionOne, revision: getThread("chat-thread")!.revision })).status, 409);
    assert.equal((await put({ executionSelection: chatOnlyExecutionSelection(), revision: getThread("chat-thread")!.revision })).status, 409);
    assert.deepEqual(networkRequests, []);
  } finally {
    await provider.close();
  }
});

test("accepted input context is immutable, audit-only and independent of assistant output identity", async () => {
  const provider = await localProvider();
  try {
  configure();
  const first = await submitChat(request(), undefined, new Headers({ cookie: "never-persist-this-cookie" }));
  await drain(first.id);
  assert.equal(first.inputMessageId, "user-1");
  assert.notEqual(first.messageId, first.inputMessageId);
  assert.match(first.traceId!, /^[0-9a-f-]{36}$/);
  assert.match(first.executionGrantId!, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ access: first.executionPolicy?.access, mode: first.executionPolicy?.mode }, { access: "full", mode: "audit-only" });
  const binding = getThreadHistory("chat-thread").messages.find(message => message.id === "user-1")!.turnContext!;
  assert.equal(binding.messageId, "user-1");
  assert.deepEqual(binding.pmReferences, []);
  const grant = readRecord<Record<string, unknown>>("chat:execution-grants", first.executionGrantId!)!;
  assert.equal(grant.generationId, first.id);
  assert.doesNotMatch(JSON.stringify(grant), /never-persist-this-cookie|Bearer|pm_v4_session/);
  assert.equal(networkRequests.length, 0, "No-reference admission and projection remain PM-independent.");
  const duplicate = await submitChat({ ...request(), idempotencyKey: "lost-response-new-key" });
  assert.equal(duplicate.id, first.id);
  assert.equal(provider.prompts.length, 1);
  assert.equal(lookupChatSubmission("chat-thread", "lost-response-new-key").status, "accepted");
  assert.equal(lookupChatSubmission("chat-thread", "lost-response-new-key").generationId, first.id);
  await stopChatRuntime();
  await startChatRuntime();
  assert.equal(lookupChatSubmission("chat-thread", "lost-response-new-key").generationId, first.id);
  assert.equal((await submitChat({ ...request(), idempotencyKey: "lost-response-new-key" })).id, first.id);
  assert.equal(provider.prompts.length, 1, "Original-key recovery must not dispatch the accepted input again.");
  await assert.rejects(submitChat({ ...request(), idempotencyKey: "altered", messages: [
    { ...request().messages[0]!, parts: [{ type: "text", text: "mutated same input" }] },
  ] }), { code: "idempotency_conflict" });
  const saved = getThreadHistory("chat-thread").messages.find(message => message.id === "user-1")!;
  saveFormattedMessage("chat-thread", { ...saved, turnContext: { ...binding, executionGrantId: randomUUID() } }, false, false);
  assert.deepEqual(getThreadHistory("chat-thread").messages.find(message => message.id === "user-1")!.turnContext, binding);
  const regenerated = await submitChat({ ...request(), trigger: "regenerate-message", idempotencyKey: "regenerate-original" });
  await drain(regenerated.id);
  assert.deepEqual(regenerated.turnContext, binding);
  assert.equal(regenerated.inputMessageId, first.inputMessageId);
  assert.notEqual(regenerated.traceId, first.traceId);
  assert.notEqual(regenerated.executionGrantId, first.executionGrantId);
  assert.deepEqual(getThreadHistory("chat-thread").messages.find(message => message.id === "user-1")!.turnContext, binding);
  deleteThread("chat-thread");
  assert.equal(readRecord("chat:execution-grants", first.executionGrantId!), null);
  } finally { await provider.close(); }
});

function pmReferenceFixture(deniedProjects = new Set<string>()) {
  const actorId = "33333333-3333-4333-8333-333333333333";
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    networkRequests.push(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/agent-contexts/authorize"))
      return deniedProjects.has(body.projectId) ? Response.json({ error: "revoked" }, { status: 403 }) : Response.json({ actorId, scope: body });
    if (url.endsWith("/agent-references/resolve"))
      return Response.json({ items: body.references.map((reference: Record<string, unknown>) => ({
        ...reference, title: `metadata-${reference.projectId}`, revision: "revision-1", availability: "available", reason: null,
      })) });
    throw new Error(`Unexpected PM fixture path: ${new URL(url).pathname}`);
  };
}

test("each native resume and portable turn receives its own frozen cross-workspace reference metadata", async () => {
  const provider = await localProvider();
  configure();
  pmReferenceFixture();
  const workspaces = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const references = [0, 1, 2].map(index => ({
    workspaceId: workspaces[index % 2]!, projectId: `PRJ-00${index + 1}`, kind: "issue" as const,
    id: "TASK-001", revision: "revision-1",
  }));
  const generations: ChatGeneration[] = [];
  for (let index = 0; index < references.length; index++) {
    if (index === 2) {
      const thread = getThread("chat-thread")!;
      updateThread("chat-thread", { settings: { ...thread.settings, systemPrompt: "Portable instruction cutover" } });
    }
    const messages = getThreadBranch("chat-thread").map(message => ({ id: message.id, ...message.content }) as UIMessage);
    messages.push({ id: `cross-project-${index}`, role: "user", parts: [{ type: "text", text: `input-${index}` }] });
    const generation = await submitChat({ id: "chat-thread", messages, pmReferences: [references[index]!] });
    await drain(generation.id);
    generations.push(getChatGeneration(generation.id)!);
    assert.match(provider.prompts[index]!.prompt, new RegExp(references[index]!.projectId));
    assert.match(provider.prompts[index]!.prompt, /revision-1/);
    assert.match(provider.prompts[index]!.prompt, /不是历史正文快照/);
    assert.equal(provider.prompts[index]!.cwd, directory);
    assert.equal(generation.turnContext?.messageId, `cross-project-${index}`);
  }
  assert.equal(generations[0]!.handoff?.mode, "portable");
  assert.equal(generations[1]!.handoff?.mode, "native");
  assert.equal(generations[2]!.handoff?.mode, "portable");
  assert.doesNotMatch(provider.prompts[1]!.prompt, /PRJ-001/);
  assert.equal(getThreadHistory("chat-thread").messages.find(message => message.id === "cross-project-0")!.turnContext!.pmReferences[0]!.projectId, "PRJ-001");
  const latest = generations[2]!;
  await assert.rejects(submitChat({ id: "chat-thread", trigger: "regenerate-message", idempotencyKey: "changed-ref",
    messages: latest.request.messages, pmReferences: [references[0]!] }), { code: "turn_context_conflict" });
  await provider.close();
});

test("stale reference admission is atomic and legacy history never receives an invented context", async () => {
  const provider = await localProvider();
  configure();
  pmReferenceFixture();
  const legacy = { id: "legacy-user", parent_id: null, format: CHAT_FORMAT,
    content: { role: "user", parts: [{ type: "text", text: "Legacy readable message" }] } };
  saveFormattedMessage("chat-thread", legacy, true);
  assert.equal(getThreadHistory("chat-thread").messages[0]!.turnContext, undefined);
  const messages: UIMessage[] = [{ id: legacy.id, ...legacy.content } as UIMessage,
    { id: "stale-user", role: "user", parts: [{ type: "text", text: "Must not execute" }] }];
  const before = getThreadHistory("chat-thread");
  await assert.rejects(submitChat({ id: "chat-thread", messages, pmReferences: [{
    workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001",
    kind: "issue", id: "TASK-001", revision: "old-revision",
  }] }), { code: "pm_reference_stale" });
  assert.deepEqual(getThreadHistory("chat-thread"), before);
  assert.deepEqual(listChatGenerations("chat-thread"), []);
  assert.deepEqual(listRecords("chat:execution-grants"), []);
  assert.equal(provider.prompts.length, 0);
  const response = await chatRoutes.request("http://localhost/chat/threads/chat-thread/history");
  const history = await response.json();
  assert.equal(history.messages[0].turnContext, undefined);
  await provider.close();
});

test("confirmed continuation binds a fresh input trace and sends the original frozen reference metadata", async () => {
  const gate = Promise.withResolvers<void>();
  const provider = await localProvider(gate.promise);
  configure();
  pmReferenceFixture();
  const first = await submitChat({ ...request(), pmReferences: [{
    workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001",
    kind: "issue", id: "TASK-001", revision: "revision-1",
  }] });
  await provider.started;
  await cancelChat(first.id);
  gate.resolve();
  const continuation = await continueChat(first.id, true);
  await drain(continuation.id);
  assert.notEqual(continuation.inputMessageId, first.inputMessageId);
  assert.notEqual(continuation.inputMessageId, continuation.messageId);
  assert.notEqual(continuation.traceId, first.traceId);
  assert.notEqual(continuation.executionGrantId, first.executionGrantId);
  assert.deepEqual(continuation.pmReferences, first.pmReferences);
  assert.match(provider.prompts[1]!.prompt, /PRJ-001/);
  assert.match(provider.prompts[1]!.prompt, /revision-1/);
  assert.equal(provider.prompts[1]!.cwd, directory);
  assert.deepEqual(getThreadHistory("chat-thread").messages.find(message => message.id === first.inputMessageId)!.turnContext, first.turnContext);
  await provider.close();
});

test("accepted HTTP response exposes exact server context and ignores forged grant/context metadata", async () => {
  const provider = await localProvider();
  configure();
  const forgedId = randomUUID();
  const forged = request();
  forged.messages[0]!.metadata = { turnContext: { executionGrantId: forgedId }, custom: { turnContext: { executionGrantId: forgedId } } };
  const response = await chatRoutes.request("http://localhost/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...forged, executionGrantId: forgedId, actorId: forgedId }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-accepted-input-message-id"), "user-1");
  assert.match(response.headers.get("x-turn-trace-id")!, /^[0-9a-f-]{36}$/);
  await response.text();
  const generation = listChatGenerations("chat-thread")[0]!;
  assert.notEqual(generation.executionGrantId, forgedId);
  const contextResponse = await chatRoutes.request("http://localhost/chat/threads/chat-thread/messages/user-1/context");
  const context = await contextResponse.json();
  assert.deepEqual(context.turnContext, generation.turnContext);
  assert.equal(context.visibility, "visible");
  const history = await (await chatRoutes.request("http://localhost/chat/threads/chat-thread/history")).json();
  const user = history.messages.find((message: { id: string }) => message.id === "user-1");
  assert.deepEqual(user.content.metadata.turnContext, generation.turnContext);
  assert.equal(user.content.metadata.custom?.turnContext, undefined);
  const execution = await (await chatRoutes.request("http://localhost/chat/threads/chat-thread/execution")).json();
  assert.equal(execution.executionPolicy.access, "full");
  assert.equal(execution.executionPolicy.mode, "audit-only");
  assert.equal(networkRequests.length, 0);
  await provider.close();
});

test("live output, replay, context, fork and next provider input recheck revoked PM content", { timeout: 10000 }, async () => {
  const provider = await structuredProvider("PRIVATE_PM_BODY\n\n");
  configure();
  const denied = new Set<string>();
  pmReferenceFixture(denied);
  const first = await submitChat({ ...request(), pmReferences: [{
    workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001",
    kind: "issue", id: "TASK-001", revision: "revision-1",
  }] });
  await provider.started;
  const streamResponse = await chatRoutes.request(`http://localhost/chat/generations/${first.id}/output`);
  const reader = streamResponse.body!.getReader();
  let initial = "";
  while (!initial.includes("PRIVATE_PM_BODY")) {
    const frame = await reader.read();
    assert.equal(frame.done, false);
    initial += new TextDecoder().decode(frame.value);
  }
  denied.add("PRJ-001");
  provider.native.emit!("PRIVATE_PM_BODY_AFTER_REVOCATION\n\n");
  let redacted = "";
  while (!redacted.includes("no longer accessible")) {
    const frame = await reader.read();
    assert.equal(frame.done, false);
    const text = new TextDecoder().decode(frame.value);
    assert.doesNotMatch(text, /PRIVATE_PM_BODY|metadata-PRJ-001|TASK-001/);
    redacted += text;
  }
  await reader.cancel();
  provider.finish();
  await drain(first.id);
  updateThread("chat-thread", { title: "PRIVATE_PM_TITLE" });
  for (const endpoint of ["history", "generations", "messages/user-1/context"]) {
    const text = await (await chatRoutes.request(`http://localhost/chat/threads/chat-thread/${endpoint}`)).text();
    assert.doesNotMatch(text, /PRIVATE_PM_BODY|metadata-PRJ-001|TASK-001/);
  }
  const replay = await (await chatRoutes.request(`http://localhost/chat/streams/${first.id}`)).text();
  assert.doesNotMatch(replay, /PRIVATE_PM_BODY|metadata-PRJ-001|TASK-001/);
  const thread = await (await chatRoutes.request("http://localhost/chat/threads/chat-thread")).json();
  assert.equal(thread.thread.title, "会话");
  const fork = await forkChatGeneration(first.id);
  assert.doesNotMatch(JSON.stringify(getThreadHistory(fork.threadId)), /PRIVATE_PM_BODY|metadata-PRJ-001|TASK-001/);
  assert.equal(getThread(fork.threadId)!.title, "会话 · 分支");
  assert.equal(getThreadFork(fork.threadId)!.nativeFork, undefined);
  let nextPrompt = "";
  codexAdapter.run = async (_context, options) => {
    nextPrompt = options.prompt;
    assert.equal(options.resume, undefined, "Contaminated native context must not be resumed.");
    return { text: "Fresh portable safe response" };
  };
  const messages = getThreadBranch("chat-thread").map(message => ({ id: message.id, ...message.content }) as UIMessage);
  messages.push({ id: "safe-next-user", role: "user", parts: [{ type: "text", text: "Continue ordinary code chat" }] });
  const next = await submitChat({ id: "chat-thread", messages });
  await drain(next.id);
  assert.equal(getChatGeneration(next.id)!.handoff?.mode, "portable");
  assert.doesNotMatch(nextPrompt, /PRIVATE_PM_BODY|metadata-PRJ-001|TASK-001/);
  await provider.close();
});

test("quoted PM source dependencies redact only the quotation and stay out of portable input and forks", async () => {
  const provider = await localProvider();
  configure();
  const denied = new Set<string>();
  pmReferenceFixture(denied);
  const first = await submitChat({ ...request(), pmReferences: [{
    workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001",
    kind: "issue", id: "TASK-001", revision: "revision-1",
  }] });
  await drain(first.id);
  const quoted: UIMessage = { id: "quoted-user", role: "user",
    parts: [{ type: "text", text: "USER_PROSE_STAYS" }],
    metadata: { custom: { quote: { text: "PRIVATE_QUOTED_BODY", messageId: first.messageId } } } };
  const second = await submitChat({ id: "chat-thread", messages: [
    ...getThreadBranch("chat-thread").map(message => ({ id: message.id, ...message.content }) as UIMessage), quoted,
  ] });
  await drain(second.id);
  assert.match(provider.prompts[1]!.prompt, /PRIVATE_QUOTED_BODY/);
  denied.add("PRJ-001");
  const projected = await (await chatRoutes.request("http://localhost/chat/threads/chat-thread/history")).json();
  const visibleUser = projected.messages.find((message: { id: string }) => message.id === quoted.id);
  assert.match(JSON.stringify(visibleUser.content.parts), /USER_PROSE_STAYS/);
  assert.equal(visibleUser.content.metadata.custom?.quote, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_QUOTED_BODY/);
  const nextMessages = projected.messages.map((message: { id: string; content: Record<string, unknown> }) =>
    ({ id: message.id, ...message.content }) as UIMessage);
  nextMessages.push({ id: "after-quote-revocation", role: "user", parts: [{ type: "text", text: "Continue code only" }] });
  const next = await submitChat({ id: "chat-thread", messages: nextMessages });
  await drain(next.id);
  assert.doesNotMatch(provider.prompts[2]!.prompt, /PRIVATE_QUOTED_BODY/);
  assert.match(provider.prompts[2]!.prompt, /USER_PROSE_STAYS/);
  assert.equal(getChatGeneration(next.id)!.handoff?.mode, "portable");
  const fork = await forkChatGeneration(second.id);
  assert.doesNotMatch(JSON.stringify(getThreadHistory(fork.threadId)), /PRIVATE_QUOTED_BODY/);
  await provider.close();
});

test("revoked source transfer is omitted from model context and never reintroduced by a later fork", async () => {
  const provider = await localProvider();
  configure("transfer-parent");
  const denied = new Set<string>();
  pmReferenceFixture(denied);
  const parent = await submitChat(request("transfer-parent", "transfer-parent-user"));
  await drain(parent.id);
  const child = await forkChatGeneration(parent.id);
  const childMessages = getThreadBranch(child.threadId).map(message => ({ id: message.id, ...message.content }) as UIMessage);
  childMessages.push({ id: "pm-child-user", role: "user", parts: [{ type: "text", text: "Read child PM context" }] });
  const ordinaryRun = codexAdapter.run;
  codexAdapter.run = async (_context, options) => {
    options.onText?.("PRIVATE_TRANSFER_BODY");
    return { text: "PRIVATE_TRANSFER_BODY" };
  };
  const childGeneration = await submitChat({ id: child.threadId, messages: childMessages, pmReferences: [{
    workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "PRJ-001",
    kind: "issue", id: "TASK-001", revision: "revision-1",
  }] });
  await drain(childGeneration.id);
  codexAdapter.run = ordinaryRun;
  const preview = getMergePreview(child.threadId);
  assert.match(preview.text, /PRIVATE_TRANSFER_BODY/);
  mergeThread(child.threadId, { confirmed: true, text: preview.text });
  denied.add("PRJ-001");
  const parentMessages = getThreadBranch("transfer-parent").map(message => ({ id: message.id, ...message.content }) as UIMessage);
  parentMessages.push({ id: "consume-transfer-user", role: "user", parts: [{ type: "text", text: "Continue the parent" }] });
  const next = await submitChat({ id: "transfer-parent", messages: parentMessages });
  await drain(next.id);
  assert.match(getChatGeneration(next.id)!.request.transferContext!, /PRIVATE_TRANSFER_BODY/);
  assert.equal(getChatGeneration(next.id)!.modelInputContext?.transferContext, undefined);
  assert.doesNotMatch(provider.prompts.at(-1)!.prompt, /PRIVATE_TRANSFER_BODY/);
  const safeFork = await forkChatGeneration(next.id);
  assert.doesNotMatch(JSON.stringify(getThreadHistory(safeFork.threadId)), /PRIVATE_TRANSFER_BODY/);
  // Legacy or prelaunch-failed records have admission evidence but no proven
  // model snapshot. Their raw transfer must never become a portable fork fallback.
  const acceptedOnly = getChatGeneration(next.id)!;
  delete acceptedOnly.modelInputContext;
  writeRecord("chat:generations", next.id, { ...acceptedOnly, status: "failed", seq: 0, output: undefined });
  const legacyFork = await forkChatGeneration(next.id);
  assert.doesNotMatch(JSON.stringify(getThreadHistory(legacyFork.threadId)), /PRIVATE_TRANSFER_BODY/);
  await provider.close();
});

test("all native context classes reach the Provider and immutable history across restart", async () => {
  const provider = await localProvider();
  const headers = new Headers({ host: "localhost" });
  try {
    const run = codexAdapter.run;
    codexAdapter.run = async (context, options) => {
      if (context.execution?.threadId === "context-source") {
        options.onEvent?.({ type: "item.upsert", item: { id: "selected-command", type: "command_execution", status: "completed", text: "BEFORE_NATIVE_UNSELECTED ACTUAL_COMMAND_SNAPSHOT AFTER_NATIVE_UNSELECTED" } });
        options.onEvent?.({ type: "item.upsert", item: { id: "selected-change", type: "file_change", status: "completed", fileName: "reported.ts",
          changes: [{ path: "reported.ts", operation: "update", diff: "--- a/reported.ts\n+++ b/reported.ts\n@@ -1 +1 @@\n-native-before\n+NATIVE_DIFF_EXCERPT" }] } });
        options.onEvent?.({ type: "item.upsert", item: { id: "selected-search", type: "file_search", status: "completed",
          results: [{ path: "reported.ts", line: 7, text: "NATIVE_SEARCH_EXCERPT" }] } });
      }
      return run(context, options);
    };
    configure("context-source");
    const original = request("context-source", "source-input");
    original.messages[0]!.metadata = undefined;
    const source = await submitChat(original, undefined, headers);
    await drain(source.id);
    const halfLine = await resolveChatContextItems(source.threadId, [{ contextId: "precise-response", kind: "response",
      source: { type: "response", threadId: source.threadId, messageId: source.messageId }, selectedText: "完成的部" }], headers);
    assert.equal(halfLine[0]!.text, "完成的部", "A highlighted half-line is not widened to the full response.");
    await assert.rejects(resolveChatContextItems(source.threadId, [{ contextId: "forged-response", kind: "response",
      source: { type: "response", threadId: source.threadId, messageId: source.messageId }, selectedText: "CLIENT_FABRICATED_EXCERPT" }], headers), { code: "context_selection_changed" });
    await assert.rejects(resolveChatContextItems(source.threadId, [{ contextId: "forged-native-output", kind: "terminal",
      source: { type: "native-output", threadId: source.threadId, generationId: source.id, itemId: "selected-command" }, text: "CLIENT_FABRICATED_NATIVE_OUTPUT" }], headers), { code: "context_selection_changed" });
    for (const [itemId, excerpt] of [["selected-change", "NATIVE_DIFF_EXCERPT"], ["selected-search", "NATIVE_SEARCH_EXCERPT"]] as const) {
      const resolved = await resolveChatContextItems(source.threadId, [{ contextId: `context-${itemId}`, kind: "response",
        source: { type: "response", threadId: source.threadId, messageId: source.messageId, itemId }, selectedText: excerpt }], headers);
      assert.equal(resolved[0]!.text, excerpt, "Structured saved native diff/search text is a real quote source.");
    }
    configure("context-target");
    await writeFile(join(directory, "selected.txt"), "line one\nVERIFIED_FILE_SELECTION\nline three\n");
    const contextItems: ChatContextInput[] = [
      { contextId: "command-context", kind: "terminal", source: { type: "native-output", threadId: source.threadId, generationId: source.id, itemId: "selected-command" }, text: "ACTUAL_COMMAND_SNAPSHOT" },
      { contextId: "file-context", kind: "review-comment", source: { type: "file", path: "selected.txt", contentDigest: contextDigest("line one\nVERIFIED_FILE_SELECTION\nline three\n") }, selection: { startLine: 2, endLine: 2 } },
      { contextId: "preview-context", kind: "preview-annotation", source: { type: "browser", url: "https://preview.invalid/page", captureId: "actual-capture" }, text: "USER_BROWSER_SELECTION" },
      { contextId: "element-context", kind: "element", source: { type: "browser", url: "https://preview.invalid/page", selector: "main > button", tagName: "BUTTON", rect: { x: 2, y: 3, width: 40, height: 20 } }, text: "ACTUAL_PICKER_TEXT" },
      { contextId: "thread-context", kind: "thread", source: { type: "thread", threadId: source.threadId, headMessageId: source.messageId } },
      { contextId: "environment-context", kind: "environment", source: { type: "environment", hostId: "local" } },
      { contextId: "response-context", kind: "response", source: { type: "response", threadId: source.threadId, messageId: source.messageId, generationId: source.id }, selection: { startLine: 1, endLine: 1 } },
    ];
    const input = request("context-target", "context-input");
    input.messages[0]!.metadata = undefined;
    input.contextItems = contextItems;
    const resolved = await resolveChatContextItems(input.id, contextItems, headers);
    assert.equal(resolved[2]!.provenance, "user-browser-snapshot");
    const generation = await submitChat(input, undefined, headers);
    await drain(generation.id);
    const accepted = getThreadHistory(input.id).messages.find(message => message.id === "context-input")!.turnContext!.contextItems!;
    assert.deepEqual(accepted.map(item => item.contextId), contextItems.map(item => item.contextId));
    const prompt = provider.prompts.at(-1)!.prompt;
    for (const marker of ["ACTUAL_COMMAND_SNAPSHOT", "VERIFIED_FILE_SELECTION", "USER_BROWSER_SELECTION", "ACTUAL_PICKER_TEXT", source.messageId, '"hostId": "local"']) assert.ok(prompt.includes(marker), marker);
    assert.doesNotMatch(prompt, /BEFORE_NATIVE_UNSELECTED|AFTER_NATIVE_UNSELECTED/, "Native terminal excerpts are not widened or silently ignored.");
    assert.equal(networkRequests.length, 0, "No browser URL or remote source was fetched.");
    await stopChatRuntime(); closeStore();
    assert.deepEqual(getThreadHistory(input.id).messages.find(message => message.id === "context-input")!.turnContext!.contextItems, accepted);
    await assert.rejects(submitChat({ ...input, idempotencyKey: "cannot-mutate-context", contextItems: [] }, undefined, headers), { code: "turn_context_conflict" });
    assert.equal(provider.prompts.length, 2);
  } finally { await provider.close(); }
});

test("file resolver is read-only, send rechecks changed content, and accepted metadata is never replaced by current file text", async () => {
  const provider = await localProvider(), headers = new Headers({ host: "localhost" });
  try {
    configure("file-context");
    const filename = join(directory, "frozen.txt");
    await writeFile(filename, "ORIGINAL_SELECTED_BYTES\n");
    const item: ChatContextInput = { contextId: "frozen-file", kind: "review-comment", source: { type: "file", path: "frozen.txt", contentDigest: contextDigest("ORIGINAL_SELECTED_BYTES\n") } };
    await resolveChatContextItems("file-context", [item], headers);
    assert.equal(listChatGenerations("file-context").length, 0);
    assert.equal(getThreadHistory("file-context").messages.length, 0);
    await writeFile(filename, "NEW_FILE_BYTES\n");
    const input = request("file-context", "file-input"); input.messages[0]!.metadata = undefined; input.contextItems = [item];
    await assert.rejects(submitChat(input, undefined, headers), { code: "context_source_changed" });
    assert.equal(provider.prompts.length, 0);
    await writeFile(filename, "ORIGINAL_SELECTED_BYTES\n");
    const generation = await submitChat({ ...input, idempotencyKey: "fresh-after-explicit-source-review" }, undefined, headers);
    await drain(generation.id);
    await writeFile(filename, "CURRENT_FILE_MUST_NOT_REPLACE_HISTORY\n");
    const projector = await createPmVisibilityProjector(input.id, headers);
    const history = projector.history(getThreadHistory(input.id).messages);
    assert.match(JSON.stringify(history), /ORIGINAL_SELECTED_BYTES/);
    assert.doesNotMatch(JSON.stringify(history), /CURRENT_FILE_MUST_NOT_REPLACE_HISTORY/);
  } finally { await provider.close(); }
});

test("deleted cross-Session sources redact context and derived output and force portable native handoff", async () => {
  const provider = await localProvider(), headers = new Headers({ host: "localhost" });
  try {
    configure("deletable-source");
    const input = request("deletable-source", "source-input"); input.messages[0]!.metadata = undefined;
    const source = await submitChat(input, undefined, headers); await drain(source.id);
    configure("referencing-target");
    const selected = request("referencing-target", "reference-input"); selected.messages[0]!.metadata = undefined;
    selected.contextItems = [{ contextId: "source-reference", kind: "response", source: { type: "response", threadId: source.threadId, generationId: source.id, messageId: source.messageId }, comment: "PRIVATE_SOURCE_COMMENT" }];
    const target = await submitChat(selected, undefined, headers); await drain(target.id);
    deleteThread(source.threadId);
    assert.ok(getThreadHistory("referencing-target").messages.some(message => message.id === "reference-input"));
    const projection = await createPmVisibilityProjector("referencing-target", headers);
    assert.equal(projection.nativeContextContaminated, true);
    const projected = projection.history(getThreadHistory("referencing-target").messages);
    const context = projected.find(message => message.id === "reference-input")!.turnContext!.contextItems![0]!;
    assert.equal(context.visibility, "unavailable"); assert.deepEqual(context.source, { type: "unavailable" }); assert.equal(context.input, undefined);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SOURCE_COMMENT/);
    const next = await submitChat({ id: "referencing-target", messages: [...getThreadBranch("referencing-target").map(message => ({ id: message.id, ...message.content }) as UIMessage),
      { id: "after-deletion", role: "user", parts: [{ type: "text", text: "Only use currently readable material." }] }] }, undefined, headers);
    await drain(next.id);
    assert.equal(getChatGeneration(next.id)!.handoff!.mode, "portable");
    assert.doesNotMatch(provider.prompts.at(-1)!.prompt, /PRIVATE_SOURCE_COMMENT/);
  } finally { await provider.close(); }
});

test("thread context transfers original attachment bytes and stops projecting them after source deletion", async () => {
  const provider = await localProvider(), headers = new Headers({ host: "localhost" });
  const received: (readonly ChatAttachment[])[] = [];
  const run = codexAdapter.run;
  codexAdapter.run = async (context, options) => { received.push(options.attachments ?? []); return run(context, options); };
  try {
    configure("attachment-source");
    const original = request("attachment-source", "attachment-input");
    original.messages[0]!.metadata = undefined;
    original.messages[0]!.parts = [{ type: "text", text: "SOURCE_PRIVATE_TASK_MARKER" },
      { type: "file", mediaType: "text/plain", filename: "source.txt", url: "data:text/plain;base64,U09VUkNFX0ZJTEVfQllURVM=" }];
    const source = await submitChat(original, undefined, headers); await drain(source.id);
    configure("attachment-target");
    const selected = await resolveChatContextItems("attachment-target", [{ contextId: "selected-thread", kind: "thread",
      source: { type: "thread", threadId: source.threadId, headMessageId: source.messageId } }], headers);
    assert.equal(selected[0]!.attachments!.length, 1);
    const target = request("attachment-target", "target-input"); target.messages[0]!.metadata = undefined;
    target.contextItems = selected.flatMap(item => item.input ? [item.input] : []);
    const generation = await submitChat(target, undefined, headers); await drain(generation.id);
    assert.equal(received[1]!.length, 1);
    assert.deepEqual(received[1], received[0]);
    const file = resolveAttachmentPath({ attachmentsDir: providerAttachmentsDirectory(), attachment: received[1]![0]! });
    assert.equal(await readFile(file!, "utf8"), "SOURCE_FILE_BYTES");
    const fork = await forkChatGeneration(generation.id, { idempotencyKey: "attachment-preserving-portable-fork" }, headers);
    const forkHead = getThreadHistory(fork.threadId).headId!;
    const forkReference = await resolveChatContextItems(target.id, [{ contextId: "server-created-fork-source", kind: "thread",
      source: { type: "thread", threadId: fork.threadId, headMessageId: forkHead } }], headers);
    assert.equal(forkReference[0]!.attachments!.length, 1, "A real server-created fork seed remains an accepted reference source.");
    const forkInput = { id: fork.threadId, messages: [...getThreadBranch(fork.threadId).map(message => ({ id: message.id, ...message.content }) as UIMessage),
      { id: "fork-current-input", role: "user" as const, parts: [{ type: "text" as const, text: "Read the inherited source file without replaying historical tasks." }] }] };
    const forked = await submitChat(forkInput, undefined, headers); await drain(forked.id);
    assert.equal(getChatGeneration(forked.id)!.handoff!.mode, "portable");
    assert.deepEqual(received[2], received[1], "Portable forks carry the actual inherited file, not merely its label.");
    assert.equal(await readFile(resolveAttachmentPath({ attachmentsDir: providerAttachmentsDirectory(), attachment: received[2]![0]! })!, "utf8"), "SOURCE_FILE_BYTES");
    deleteThread(source.threadId);
    const next = await submitChat({ id: target.id, messages: [...getThreadBranch(target.id).map(message => ({ id: message.id, ...message.content }) as UIMessage),
      { id: "new-current-input", role: "user", parts: [{ type: "text", text: "Use only current readable sources." }] }] }, undefined, headers);
    await drain(next.id);
    assert.equal(getChatGeneration(next.id)!.handoff!.mode, "portable");
    assert.equal(received[3]!.length, 0);
    assert.doesNotMatch(provider.prompts.at(-1)!.prompt, /SOURCE_PRIVATE_TASK_MARKER/);
    const forkAfterDelete = await submitChat({ id: fork.threadId, messages: [...getThreadBranch(fork.threadId).map(message => ({ id: message.id, ...message.content }) as UIMessage),
      { id: "fork-after-source-delete", role: "user", parts: [{ type: "text", text: "Use only current readable data." }] }] }, undefined, headers);
    await drain(forkAfterDelete.id);
    assert.equal(getChatGeneration(forkAfterDelete.id)!.handoff!.mode, "portable");
    assert.equal(received[4]!.length, 0, "Copied historical bytes remain permission-dependent.");
    deleteThread(target.id);
    assert.ok(getThreadHistory(fork.threadId).messages.some(message => (message.content.metadata as { custom?: { forkContext?: boolean } } | undefined)?.custom?.forkContext),
      "Deleting a fork source must not delete destination history.");
    const forkProjection = await createPmVisibilityProjector(fork.threadId, headers);
    assert.equal(JSON.stringify(forkProjection.history(getThreadHistory(fork.threadId).messages)).includes("U09VUkNFX0ZJTEVfQllURVM="), false);
  } finally { await provider.close(); }
});

test("explicit continuation preserves selected snapshots and real screenshot correlation without replaying original user instructions", async () => {
  const hold = Promise.withResolvers<void>(), provider = await localProvider(hold.promise), headers = new Headers({ host: "localhost" });
  const received: (readonly ChatAttachment[])[] = [];
  const run = codexAdapter.run;
  codexAdapter.run = async (context, options) => { received.push(options.attachments ?? []); return run(context, options); };
  try {
    configure("context-continuation");
    const input = request("context-continuation", "original-input");
    input.messages[0]!.parts = [{ type: "text", text: "DO_NOT_REPLAY_ORIGINAL_INSTRUCTION" },
      { type: "file", mediaType: "image/png", filename: "capture.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=" }];
    input.messages[0]!.metadata = { custom: { contextAttachments: [{ attachmentId: "capture-image", partIndex: 1 }] } };
    input.contextItems = [{ contextId: "selected-preview", kind: "preview-annotation", source: { type: "browser", url: "https://not-fetched.invalid/", attachmentId: "capture-image" }, text: "SELECTED_BROWSER_DATA" }];
    const generation = await submitChat(input, undefined, headers); await provider.started; await cancelChat(generation.id); hold.resolve();
    const continued = await continueChat(generation.id, true, "explicit-selected-context-recovery", undefined, headers); await drain(continued.id);
    const original = getThreadHistory(input.id).messages.find(message => message.id === generation.inputMessageId)!;
    const recovery = getThreadHistory(input.id).messages.find(message => message.id === continued.inputMessageId)!;
    assert.deepEqual(recovery.turnContext!.contextItems, original.turnContext!.contextItems);
    assert.equal(Array.isArray(recovery.content.parts) && recovery.content.parts[1]?.type, "file");
    assert.deepEqual(received[1], received[0]);
    assert.match(provider.prompts.at(-1)!.prompt, /SELECTED_BROWSER_DATA/);
    assert.doesNotMatch(provider.prompts.at(-1)!.prompt, /DO_NOT_REPLAY_ORIGINAL_INSTRUCTION/);
  } finally { hold.resolve(); await stopChatRuntime(); await provider.close(); }
});

test("source deletion after admission but before the queued native launch fails explicitly without a Provider turn", async () => {
  const provider = await localProvider(), headers = new Headers({ host: "localhost" });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let holding: Promise<unknown> | undefined;
  try {
    configure("queued-context-source");
    const original = request("queued-context-source", "source-input"); original.messages[0]!.metadata = undefined;
    const source = await submitChat(original, undefined, headers); await drain(source.id);
    configure("queued-context-target");
    holding = withThreadExecution("queued-context-target", async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const input = request("queued-context-target", "queued-input"); input.messages[0]!.metadata = undefined;
    input.contextItems = [{ contextId: "source-response", kind: "response", source: { type: "response", threadId: source.threadId, messageId: source.messageId, generationId: source.id } }];
    const generation = await submitChat(input, undefined, headers);
    assert.equal(getChatGeneration(generation.id)!.status, "queued");
    deleteThread(source.threadId); release.resolve(); await holding; await drain(generation.id);
    assert.equal(getChatGeneration(generation.id)!.status, "failed");
    assert.equal(provider.prompts.length, 1);
    assert.ok(getThreadHistory(input.id).messages.some(message => message.id === input.messages[0]!.id));
  } finally { release.resolve(); await holding; await stopChatRuntime(); await provider.close(); }
});

test("portable handoff preflights historical files before accepting a new text-only input", async () => {
  const provider = await localProvider(), headers = new Headers({ host: "localhost" });
  try {
    configure("historical-file-preflight");
    const first = request("historical-file-preflight", "file-input"); first.messages[0]!.metadata = undefined;
    first.messages[0]!.parts.push({ type: "file", mediaType: "text/plain", filename: "original.txt", url: "data:text/plain;base64,b3JpZ2luYWw=" });
    const original = await submitChat(first, undefined, headers); await drain(original.id);
    const runtime = await resolveProviderRuntime({ providerInstanceId: "chat-local", modelName: "chat-model" });
    const next: ChatRequest = { id: first.id, idempotencyKey: "unsupported-portable-files", messages: [...getThreadBranch(first.id).map(message => ({ id: message.id, ...message.content }) as UIMessage),
      { id: "new-text-only", role: "user", parts: [{ type: "text", text: "Continue with the selected new Provider." }] }] };
    await assert.rejects(submitChat(next, { ...runtime, driver: "cursor", capabilities: { ...runtime.capabilities, nativeResume: false, nativeFork: false } }, headers), { code: "unsupported_attachment" });
    assert.equal(listChatGenerations(first.id).length, 1);
    assert.equal(getThreadHistory(first.id).messages.some(message => message.id === "new-text-only"), false);
    assert.equal(provider.prompts.length, 1, "No accepted or late failing native turn is created for unsupported inherited payload.");
    const entered = Promise.withResolvers<void>(), run = codexAdapter.run;
    codexAdapter.run = async (context, options) => {
      const paused = Promise.withResolvers<void>(), abort = () => paused.resolve();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      entered.resolve();
      try { await paused.promise; return await run(context, options); }
      finally { options.signal?.removeEventListener("abort", abort); }
    };
    const latest = await submitChat({ id: first.id, messages: [...getThreadBranch(first.id).map(message => ({ id: message.id, ...message.content }) as UIMessage),
      { id: "latest-text-with-no-files", role: "user", parts: [{ type: "text", text: "Continue from the current native boundary." }] }] }, undefined, headers);
    await entered.promise; await cancelChat(latest.id);
    const count = listChatGenerations(first.id).length, turns = provider.prompts.length;
    await assert.rejects(continueChat(latest.id, true, "unsupported-portable-continuation", {
      ...runtime, driver: "cursor", capabilities: { ...runtime.capabilities, nativeResume: false, nativeFork: false },
    }, headers), { code: "unsupported_attachment" });
    assert.equal(listChatGenerations(first.id).length, count);
    assert.equal(getChatGeneration(latest.id)!.continuationId, undefined);
    assert.equal(provider.prompts.length, turns, "Recovery preflights historical payloads before accepting or dispatching.");
  } finally { await provider.close(); }
});

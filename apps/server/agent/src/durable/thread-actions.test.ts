import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { UIMessage } from "ai";
import { chatOnlyExecutionSelection, type ChatDraftInput } from "@agent-workspace/contracts/chat";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { codexAdapter } from "../providers/drivers/codex.ts";
import { createProviderInstance } from "../providers/instances.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../providers/t3code/application.ts";
import { providerApplicationOptions } from "../providers/t3code/production.ts";
import { registerLiveSteering } from "../providers/t3code/live-actions.ts";
import { enqueueMessage, listQueuedMessages, sendQueuedMessage } from "./message-queue.ts";
import { implementGenerationPlan, nativeForkGeneration, resolveGenerationSubagent, rewindConversation, steerActiveGeneration, threadActionCapabilities } from "./thread-actions.ts";
import { getChatGeneration, getActiveChat, listChatGenerations, stopChatRuntime, submitChat, subscribeChat } from "./chat-runtime.ts";
import { closeStore, listRecords, writeRecord } from "./store.ts";
import { ensureThread, getThread, getThreadBranch, getThreadHistory, setThreadNativeSession, updateThread } from "./threads.ts";

let directory: string;
let prompts: string[];
let nativeItems: NativeOutputItem[];
let gate: Promise<void> | undefined;
let started: { promise: Promise<void>; resolve: () => void };
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalCheck = codexAdapter.check, originalRun = codexAdapter.run;
const headers = new Headers();
const draft = (id: string, text: string): ChatDraftInput => ({ message: { id, role: "user", parts: [{ type: "text", text }] } });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "thread-actions-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  prompts = []; nativeItems = []; gate = undefined; started = Promise.withResolvers<void>();
  await startPmProviderApplication(providerApplicationOptions);
  createProviderInstance({ instanceId: "controlled", driver: "codex", label: "Isolated controlled runtime", config: { binaryPath: join(directory, "not-a-real-provider"), homePath: join(directory, "home") }, environment: [] });
  codexAdapter.check = async () => ({ installation: { status: "installed", checkedAt: new Date().toISOString() }, authentication: "authenticated", nativeSessionReady: true,
    models: [{ id: "fixture", label: "Controlled model", source: "discovered", temperature: false }], methods: [], canLogout: false,
    capabilities: { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native", portableHandoff: true } });
  codexAdapter.run = async (_context, options) => {
    prompts.push(options.prompt); started.resolve();
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(Object.assign(new Error("fixture aborted"), { code: "aborted" }));
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([gate ?? Promise.resolve(), aborted.promise]);
      for (const item of nativeItems) options.onEvent?.({ type: "item.upsert", item });
      options.onText?.("Completed authoritative reply"); return { text: "Completed authoritative reply" };
    }
    finally { options.signal?.removeEventListener("abort", abort); }
  };
  ensureThread("session", undefined, chatOnlyExecutionSelection());
  updateThread("session", { settings: { ...getThread("session")!.settings, providerInstanceId: "controlled", model: "fixture" } });
});
afterEach(async () => {
  await stopChatRuntime(); await stopPmProviderApplication(); closeStore();
  codexAdapter.check = originalCheck; codexAdapter.run = originalRun;
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  await rm(directory, { recursive: true, force: true });
});
async function finish(id: string): Promise<void> { for await (const _chunk of subscribeChat(id)) { /* Drain the real persisted stream. */ } }
async function turn(text: string) {
  const message = draft(randomUUID(), text).message as UIMessage;
  const generation = await submitChat({ id: "session", messages: [...getThreadBranch("session").map(value => ({ id: value.id, ...value.content }) as UIMessage), message] });
  await finish(generation.id); return getChatGeneration(generation.id)!;
}
test("queue send uses the current full authoritative branch and admission idempotency across restart", async () => {
  await turn("Original context must remain");
  await enqueueMessage("session", "queued", draft("queued-input", "New queued instruction"), getThread("session")!.revision, headers);
  const initial = (await listQueuedMessages("session", headers))[0]!;
  await sendQueuedMessage("session", initial.id, initial.revision, headers);
  const accepted = (await listQueuedMessages("session", headers))[0]!;
  assert.equal(accepted.status, "sent"); assert.ok(accepted.generationId);
  await finish(accepted.generationId!);
  assert.equal(prompts.length, 2); assert.match(prompts[1]!, /Original context must remain/); assert.match(prompts[1]!, /New queued instruction/);
  await stopChatRuntime(); closeStore();
  const receipt = (await listQueuedMessages("session", headers))[0]!;
  await sendQueuedMessage("session", receipt.id, receipt.revision, headers);
  assert.equal(listChatGenerations("session").length, 2); assert.equal(prompts.length, 2);
});
test("queue cannot stop or steer an active generation", async () => {
  const release = Promise.withResolvers<void>(); gate = release.promise;
  const first = await submitChat({ id: "session", messages: [draft("original", "Run original").message as UIMessage] });
  await started.promise;
  await enqueueMessage("session", "queued", draft("next", "Different next turn"), getThread("session")!.revision, headers);
  await assert.rejects(sendQueuedMessage("session", "queued", 0, headers), { code: "chat_busy" });
  assert.equal(getActiveChat("session")?.id, first.id); assert.equal(prompts.length, 1);
  release.resolve(); await finish(first.id);
});
test("confirmed conversation rewind preserves files and all branch history, detaches native cursor and changes only head", async () => {
  const first = await turn("first"), second = await turn("second");
  const file = join(directory, "unrelated-business-file.txt"); await writeFile(file, "PM and files are not rolled back");
  setThreadNativeSession("session", { providerInstanceId: "controlled", driver: "codex", sessionId: "native", cwd: second.executionSnapshot!.path });
  const before = getThreadHistory("session"), request = { messageId: first.messageId, expectedHeadId: before.headId, revision: getThread("session")!.revision, confirmed: false, idempotencyKey: "rewind-once" };
  await assert.rejects(rewindConversation("session", request, headers), { code: "confirmation_required" });
  await assert.rejects(rewindConversation("session", { ...request, confirmed: true, expectedHeadId: "stale" }, headers), { code: "rewind_conflict" });
  assert.deepEqual(await rewindConversation("session", { ...request, confirmed: true }, headers), { headId: first.messageId, effects: "conversation-only" });
  assert.deepEqual(await rewindConversation("session", { ...request, confirmed: true }, headers), { headId: first.messageId, effects: "conversation-only" });
  assert.equal(getThreadHistory("session").messages.length, before.messages.length); assert.equal(getThreadHistory("session").headId, first.messageId);
  assert.equal(getThread("session")!.nativeSession, undefined); assert.equal(await readFile(file, "utf8"), "PM and files are not rolled back");
});
test("plan implementation uses only authoritative completed item, starts one new session and never replays historical inputs", async () => {
  nativeItems = [{ id: "plan", type: "proposed_plan", status: "completed", text: "Implement the selected plan exactly." }];
  const source = await turn("Do not replay this historical instruction");
  nativeItems = [];
  const implemented = await implementGenerationPlan(source.id, "plan", "plan-once", headers);
  await finish(implemented.generationId);
  const duplicate = await implementGenerationPlan(source.id, "plan", "plan-once", headers);
  assert.deepEqual(duplicate, implemented); assert.notEqual(implemented.threadId, "session"); assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /Implement the selected plan exactly/); assert.doesNotMatch(prompts[1]!, /Do not replay this historical instruction/);
  assert.equal(getThread(implemented.threadId)!.settings.interactionMode, "default");
});
test("unsupported native fork and unbound native subagents are explicit rather than portable/fake navigation", async () => {
  nativeItems = [{ id: "child", type: "subagent", status: "completed", childSessionId: "provider-native-only" }];
  const source = await turn("source");
  await assert.rejects(nativeForkGeneration(source.id, "fork", headers), { code: "unsupported_fork" });
  const child = await resolveGenerationSubagent(source.id, "child", headers); assert.equal(child.threadId, null); assert.ok(child.reason);
});
test("real steering is a separate at-most-once live dispatch and unknown results are never replayed", async () => {
  const release = Promise.withResolvers<void>(); gate = release.promise;
  const generation = await submitChat({ id: "session", messages: [draft("original", "Run original").message as UIMessage] });
  await started.promise;
  let calls = 0;
  const unregister = registerLiveSteering({ generationId: generation.id, threadId: "session", interruptsTools: false, async steer(input) { calls++; assert.equal(input.text, "Change direction"); } });
  try {
    const input = { generationId: generation.id, idempotencyKey: "steer-once", text: "Change direction" };
    assert.equal((await threadActionCapabilities("session", headers)).steer.supported, true);
    assert.deepEqual(await steerActiveGeneration("session", input, headers), { status: "accepted" });
    assert.deepEqual(await steerActiveGeneration("session", input, headers), { status: "accepted" });
    assert.equal(calls, 1); assert.equal(prompts.length, 1); assert.equal(listChatGenerations("session").length, 1);
    unregister();
    const failing = registerLiveSteering({ generationId: generation.id, threadId: "session", interruptsTools: false, async steer() { calls++; throw new Error("native reply lost after dispatch"); } });
    try {
      const unknown = { ...input, idempotencyKey: "unknown" };
      assert.deepEqual(await steerActiveGeneration("session", unknown, headers), { status: "unknown" });
      assert.deepEqual(await steerActiveGeneration("session", unknown, headers), { status: "unknown" });
      assert.equal(calls, 2);
    } finally { failing(); }
  } finally { unregister(); release.resolve(); await finish(generation.id); }
});
test("managed execution bindings cannot escape into ordinary queue, plan, fork or steering operations", async () => {
  nativeItems = [{ id: "plan", type: "proposed_plan", status: "completed", text: "escape" }];
  const source = await turn("source");
  writeRecord("pm-automation:native-thread-bindings", "managed", { threadId: "session" });
  await assert.rejects(enqueueMessage("session", "escape", draft("escape", "escape"), getThread("session")!.revision, headers), { code: "managed_session" });
  assert.equal(listRecords("chat:message-queue").length, 0);
  await assert.rejects(implementGenerationPlan(source.id, "plan", "escape", headers));
});

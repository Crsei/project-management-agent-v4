import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import type { ContextTransfer, DurableRunRequest } from "@agent-workspace/contracts/durable";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { WorkspaceRun } from "@agent-workspace/contracts/workspace";
import { CliChatError } from "../agents/cli-chat.ts";
import { codexAdapter } from "../providers/drivers/codex.ts";
import {
  createProviderInstance,
  deleteProviderInstance,
  updateProviderInstance,
} from "../providers/instances.ts";
import { workspaceRoutes } from "../workspace.ts";
import {
  cancelRun,
  continueRun,
  getRun,
  getRunRequest,
  listRuns,
  startExecution,
  stopExecution,
  submitRun,
  withThreadExecution,
} from "./engine.ts";
import { onRunEvent, readRunEvents, saveRun } from "./events.ts";
import { forkRun, forkChatSnapshot, getMergePreview, mergeThread } from "./forks.ts";
import { emptyWorkspace, getWorkspace, importWorkspaces, putWorkspace } from "./resources.ts";
import { closeStore, getDatabase, readRecord, transaction, writeRecord } from "./store.ts";
import {
  ensureThread,
  getThread,
  getThreadHistory,
  getThreadNativeSession,
  getThreadPendingFork,
  saveFormattedMessage,
  CHAT_FORMAT,
} from "./threads.ts";
import { consumeTransfers, getThreadFork, TRANSFERS } from "./transfers.ts";

let directory: string;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalCheck = codexAdapter.check;
const originalRun = codexAdapter.run;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "durable-workspace-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  codexAdapter.check = async () => ({
    installation: { status: "installed" },
    authentication: "authenticated",
    models: [{ id: "gpt-5.4", label: "Native test model", temperature: false }],
    methods: [],
    canLogout: false,
  });
  codexAdapter.run = async () => {
    throw new Error("This test did not arrange native execution.");
  };
  createProviderInstance({
    instanceId: "test-native",
    driver: "codex",
    label: "Durable native fixture",
  });
});
afterEach(async () => {
  try {
    await stopExecution();
  } finally {
    codexAdapter.check = originalCheck;
    codexAdapter.run = originalRun;
    closeStore();
    await rm(directory, { recursive: true, force: true });
    if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  }
});
const request = (id: string, threadId = "thread-1"): DurableRunRequest => ({
  runId: id,
  threadId,
  name: "Durable task",
  kind: "workflow",
  input: `task ${id}`,
  context: "saved background",
  temperature: 0.5,
  steps: [
    {
      id: "step-1",
      name: "First",
      model: "gpt-5.4",
      providerInstanceId: "test-native",
      system: "",
      instruction: "Return the result.",
    },
  ],
});
async function waitForRun(
  id: string,
  predicate: (run: WorkspaceRun) => boolean,
): Promise<WorkspaceRun> {
  const done = Promise.withResolvers<WorkspaceRun>();
  const check = () => {
    const run = getRun(id);
    if (run && predicate(run)) done.resolve(run);
  };
  const unsubscribe = onRunEvent(id, check);
  check();
  try {
    return await done.promise;
  } finally {
    unsubscribe();
  }
}

/** The adapter seam isolates durable execution from native protocol and billing endpoints. */
async function nativeProvider(handler: (input: string, index: number) => Promise<string>) {
  const prompts: string[] = [];
  const previousRun = codexAdapter.run;
  codexAdapter.run = async (_context, { prompt, signal }) => {
    signal?.throwIfAborted();
    const index = prompts.push(prompt) - 1;
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(signal?.reason ?? new Error("Native execution cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const text = await Promise.race([handler(prompt, index), cancelled.promise]);
      return { text, usage: { inputTokens: 5, outputTokens: 3 } };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    prompts,
    async close() {
      codexAdapter.run = previousRun;
    },
  };
}

test("records, nested transactions, run and event snapshots commit or roll back together", async () => {
  assert.throws(() =>
    transaction(() => {
      writeRecord("test", "first", 1);
      transaction(() => writeRecord("test", "nested", 2));
      throw new Error("rollback");
    }),
  );
  assert.equal(readRecord("test", "first"), null);
  assert.equal(readRecord("test", "nested"), null);
  const run = await submitRun(request("atomic"));
  assert.equal(run.status, "queued");
  assert.equal(readRunEvents(run.id, 0)[0]?.run.status, "queued");
  assert.throws(() =>
    transaction(() => {
      const updated = getRun(run.id)!;
      updated.status = "failed";
      saveRun(updated);
      throw new Error("rollback both");
    }),
  );
  assert.equal(getRun(run.id)?.status, "queued");
  assert.equal(readRunEvents(run.id, 0).length, 1);
});

test("submission snapshots survive reopening, deduplicate and reject different payloads", async () => {
  const value = request("dedup");
  value.idempotencyKey = "submit-key";
  const first = await submitRun(value);
  value.context = "changed only in caller memory";
  assert.equal(getRunRequest(first.id)?.context, "saved background");
  updateProviderInstance("test-native", { enabled: false });
  const same = await submitRun({ ...value, context: "saved background" });
  assert.equal(same.id, first.id);
  await assert.rejects(submitRun(value), { code: "idempotency_conflict" });
  closeStore();
  assert.equal(getRun(first.id)?.status, "queued");
  assert.deepEqual(
    readRunEvents(first.id, 0).map((event) => event.seq),
    [1],
  );
});

test("removed, missing and disabled selections reject every unfinished step before persistence or transfer consumption", async () => {
  createProviderInstance({
    instanceId: "disabled-native",
    driver: "codex",
    label: "Disabled native fixture",
    enabled: false,
  });
  const registryPath = join(directory, "provider-instances.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    instances: Record<string, unknown>[];
  };
  const removedDrivers = ["deepseek", "openai", "anthropic"];
  registry.instances.push(...removedDrivers.map((driver) => ({
    instanceId: `legacy-${driver}`,
    driver,
    label: "Historical API instance",
    env: {},
    revision: 1,
  })));
  const registryBytes = JSON.stringify(registry);
  await writeFile(registryPath, registryBytes);
  const selections = [
    ...removedDrivers.map((driver) => ({
      providerInstanceId: `legacy-${driver}`,
      model: "historical-api-model",
      code: "unknown_provider",
    })),
    { providerInstanceId: "missing-native", model: "gpt-5.4", code: "unknown_provider" },
    { providerInstanceId: undefined, model: "gpt-5.4", code: "unknown_provider" },
    { providerInstanceId: "disabled-native", model: "gpt-5.4", code: "provider_disabled" },
  ];
  for (const [index, selection] of selections.entries()) {
    const value = request(`rejected-${index}`, `rejected-thread-${index}`);
    value.steps.push({
      ...value.steps[0],
      id: "blocked-step",
      providerInstanceId: selection.providerInstanceId,
      model: selection.model,
    });
    const transfer: ContextTransfer = {
      id: `transfer-${index}`,
      sourceThreadId: `branch-${index}`,
      parentThreadId: value.threadId,
      text: "Confirmed branch context",
      createdAt: new Date().toISOString(),
    };
    writeRecord(TRANSFERS, transfer.sourceThreadId, transfer);
    await assert.rejects(submitRun(value), { code: selection.code });
    assert.equal(getThread(value.threadId), null);
    assert.equal(getRun(value.runId), null);
    assert.equal(getRunRequest(value.runId), null);
    assert.deepEqual(listRuns(value.threadId), []);
    assert.deepEqual(readRunEvents(value.runId, 0), []);
    assert.deepEqual(readRecord(TRANSFERS, transfer.sourceThreadId), transfer);

    // A corrected retry with the same IDs also proves no idempotency key leaked.
    value.steps[1].providerInstanceId = "test-native";
    value.steps[1].model = "gpt-5.4";
    const accepted = await submitRun(value);
    assert.equal(accepted.status, "queued");
    assert.match(getRunRequest(accepted.id)!.transferContext!, /Confirmed branch context/);
    assert.equal(
      readRecord<ContextTransfer>(TRANSFERS, transfer.sourceThreadId)?.consumedByRunId,
      accepted.id,
    );
  }
  assert.equal(await readFile(registryPath, "utf8"), registryBytes);
});

test("historical API snapshots remain readable and replayable but cannot create a continuation", async () => {
  const historical = request("historical-api", "historical-thread");
  historical.steps[0].model = "deepseek-chat";
  historical.steps[0].providerInstanceId = "legacy-deepseek";
  const registryPath = join(directory, "provider-instances.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    instances: Record<string, unknown>[];
  };
  registry.instances.push({
    instanceId: "legacy-deepseek",
    driver: "deepseek",
    label: "Historical API",
    env: { OLD_KEY: "historical-fixture-only" },
    revision: 7,
  });
  const registryBytes = JSON.stringify(registry);
  await writeFile(registryPath, registryBytes);
  const oldRun: WorkspaceRun = {
    id: historical.runId,
    threadId: historical.threadId,
    name: historical.name,
    kind: historical.kind,
    input: historical.input,
    startedAt: "2025-01-01T00:00:00.000Z",
    endedAt: "2025-01-01T00:00:01.000Z",
    status: "failed",
    errorClass: "provider_error",
    steps: [{
      id: historical.steps[0].id,
      name: historical.steps[0].name,
      agentName: historical.steps[0].name,
      model: historical.steps[0].model,
      providerInstanceId: "legacy-deepseek",
      status: "failed",
      executionKind: "api",
      output: "Historical partial response",
    }],
  };
  // Seed the pre-cutover durable record, including its original request digest.
  ensureThread(historical.threadId, historical.name);
  writeRecord("durable:requests", historical.runId, historical);
  writeRecord("durable:submissions", JSON.stringify([historical.threadId, historical.runId]), {
    fingerprint: createHash("sha256").update(JSON.stringify(historical)).digest("hex"),
    runId: historical.runId,
  });
  saveRun(oldRun);
  const saved = getRun(oldRun.id)!;
  const events = readRunEvents(oldRun.id, 0);
  const provider = await nativeProvider(async () => "Unexpected historical replay");
  try {
    closeStore();
    assert.deepEqual(await submitRun(historical), saved);
    await assert.rejects(submitRun({ ...historical, input: "changed retry" }), {
      code: "idempotency_conflict",
    });
    await assert.rejects(continueRun(saved.id), { code: "unknown_provider" });
    await startExecution();
    await stopExecution();
    assert.equal(provider.prompts.length, 0);
    assert.deepEqual(listRuns(historical.threadId), [saved]);
    assert.deepEqual(getWorkspace(historical.threadId).runs, [saved]);
    assert.deepEqual(getRunRequest(saved.id), historical);
    assert.deepEqual(readRunEvents(saved.id, 0), events);
    assert.equal(await readFile(registryPath, "utf8"), registryBytes);
  } finally {
    await stopExecution();
    await provider.close();
  }
});

test("continuation rejects unavailable unfinished native selections without changing its source or consuming new transfers", async () => {
  for (const mode of ["removed", "disabled"] as const) {
    const instanceId = `continuation-${mode}`;
    createProviderInstance({ instanceId, driver: "codex", label: mode });
    const value = request(`source-${mode}`, `continuation-thread-${mode}`);
    value.steps[0].providerInstanceId = instanceId;
    const source = await submitRun(value);
    await cancelRun(source.id);
    const saved = getRun(source.id)!;
    const snapshot = getRunRequest(source.id);
    const transfer: ContextTransfer = {
      id: `continuation-transfer-${mode}`,
      sourceThreadId: `continuation-branch-${mode}`,
      parentThreadId: source.threadId,
      text: "New context belongs to a future submission",
      createdAt: new Date().toISOString(),
    };
    writeRecord(TRANSFERS, transfer.sourceThreadId, transfer);
    if (mode === "removed") deleteProviderInstance(instanceId);
    else updateProviderInstance(instanceId, { enabled: false });
    const options = { idempotencyKey: `continue-${mode}` };
    await assert.rejects(continueRun(source.id, options), {
      code: mode === "removed" ? "unknown_provider" : "provider_disabled",
    });
    assert.deepEqual(listRuns(source.threadId), [saved]);
    assert.deepEqual(getRunRequest(source.id), snapshot);
    assert.deepEqual(readRecord(TRANSFERS, transfer.sourceThreadId), transfer);
    if (mode === "removed") {
      createProviderInstance({ instanceId, driver: "codex", label: "Explicitly restored native" });
    } else {
      updateProviderInstance(instanceId, { enabled: true });
    }
    const continuation = await continueRun(source.id, options);
    assert.equal(continuation.continuationOf, source.id);
    assert.equal(listRuns(source.threadId).length, 2);
    assert.deepEqual(getRun(source.id), saved);
    assert.deepEqual(getRunRequest(source.id), snapshot);
    assert.deepEqual(readRecord(TRANSFERS, transfer.sourceThreadId), transfer);
  }
});

test("a failed native step stops dependent steps and continuation reuses only confirmed outputs", async () => {
  const provider = await nativeProvider(async (_, index) => {
    if (index === 1) throw new Error("Native turn failed after an unknown side effect.");
    return `confirmed output ${index}`;
  });
  try {
    const value = request("failed-dependency");
    value.steps.push(
      { ...value.steps[0], id: "step-2", name: "Second" },
      { ...value.steps[0], id: "step-3", name: "Dependent" },
    );
    await startExecution();
    const submitted = await submitRun(value);
    const failed = await waitForRun(submitted.id, (run) => run.status === "failed");
    assert.equal(failed.steps[0].status, "completed");
    assert.equal(failed.steps[0].sideEffects, "confirmed");
    assert.equal(failed.steps[1].status, "failed");
    assert.equal(failed.steps[1].sideEffects, "unknown");
    assert.equal(failed.steps[2].status, "pending");
    assert.equal(failed.steps[2].startedAt, undefined);
    assert.equal(provider.prompts.length, 2);
    await assert.rejects(continueRun(failed.id), { code: "side_effect_confirmation_required" });
    assert.equal(listRuns(failed.threadId).length, 1);
    const continuation = await continueRun(failed.id, { confirmSideEffects: true });
    const completed = await waitForRun(continuation.id, (run) => run.status === "completed");
    assert.equal(completed.steps[0].reusedFrom, failed.id);
    assert.equal(completed.steps[0].output, failed.steps[0].output);
    assert.equal(completed.steps[1].reusedFrom, undefined);
    assert.equal(completed.steps[2].reusedFrom, undefined);
    assert.equal(provider.prompts.length, 4);
    assert.match(provider.prompts[2], /confirmed output 0/);
    assert.deepEqual(getRun(failed.id), failed);
  } finally {
    await stopExecution();
    await provider.close();
  }
});

test(
  "one thread executes FIFO while another thread can execute, subscriptions do not own requests",
  { timeout: 10000 },
  async () => {
    const release = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const provider = await nativeProvider(async (prompt) => {
      if (prompt.includes("task first")) {
        started.resolve();
        return release.promise;
      }
      return "confirmed output";
    });
    try {
      await startExecution();
      const first = await submitRun(request("first"));
      await started.promise;
      const second = await submitRun(request("second"));
      const independent = await submitRun(request("independent", "thread-2"));
      await waitForRun(independent.id, (run) => run.status === "completed");
      assert.equal(getRun(second.id)?.status, "queued");
      const subscription = await workspaceRoutes.request(
        `http://localhost/workspace/runs/${first.id}/events`,
      );
      const reader = subscription.body!.getReader();
      assert.equal((await reader.read()).done, false);
      await reader.cancel(); // Real NDJSON subscription closure cannot cancel provider execution.
      assert.equal(getRun(first.id)?.status, "running");
      release.resolve("first output");
      await waitForRun(second.id, (run) => run.status === "completed");
      assert.equal(provider.prompts.length, 3);
      const events = readRunEvents(first.id, 1);
      assert.ok(events.length >= 3);
      assert.equal(events.at(-1)?.run.status, "completed");
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_, index) => index + 2),
      );
    } finally {
      release.resolve("released");
      await stopExecution();
      await provider.close();
    }
  },
);

test(
  "explicit queued cancellation never invokes the provider and active cancellation stays terminal",
  { timeout: 10000 },
  async () => {
    const gate = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const provider = await nativeProvider(async () => {
      started.resolve();
      return gate.promise;
    });
    try {
      await startExecution();
      const active = await submitRun(request("active"));
      await started.promise;
      const queued = await submitRun(request("queued"));
      await Promise.all([cancelRun(queued.id), cancelRun(queued.id), cancelRun(active.id)]);
      gate.resolve("late output");
      await stopExecution();
      assert.equal(getRun(active.id)?.status, "cancelled");
      assert.equal(getRun(queued.id)?.status, "cancelled");
      assert.equal(provider.prompts.length, 1);
    } finally {
      gate.resolve("released");
      await stopExecution();
      await provider.close();
    }
  },
);

test("restart reconciles running records without replay and continuation reuses confirmed steps", async () => {
  const value = request("reconcile");
  createProviderInstance({ instanceId: "retired-native", driver: "codex", label: "Retired" });
  value.steps[0].providerInstanceId = "retired-native";
  value.steps.push({
    ...value.steps[0],
    id: "step-2",
    name: "Second",
    providerInstanceId: "test-native",
  });
  const source = await submitRun(value);
  source.status = "running";
  source.steps[0] = {
    ...source.steps[0],
    status: "completed",
    output: "already done",
    executionKind: "agent",
    sideEffects: "confirmed",
  };
  source.steps[1] = {
    ...source.steps[1],
    status: "running",
    executionKind: "agent",
    sideEffects: "unknown",
  };
  saveRun(source);
  deleteProviderInstance("retired-native");
  const provider = await nativeProvider(async () => "continued output");
  try {
    await startExecution();
    const interrupted = getRun(source.id)!;
    assert.equal(interrupted.status, "interrupted");
    assert.equal(provider.prompts.length, 0);
    await assert.rejects(continueRun(source.id), { code: "side_effect_confirmation_required" });
    const continuation = await continueRun(source.id, {
      idempotencyKey: "continue-confirmed",
      confirmSideEffects: true,
    });
    const duplicate = await continueRun(source.id, {
      idempotencyKey: "continue-confirmed",
      confirmSideEffects: true,
    });
    assert.equal(continuation.id, duplicate.id);
    const completed = await waitForRun(continuation.id, (run) => run.status === "completed");
    assert.equal(completed.steps[0].reusedFrom, source.id);
    assert.equal(completed.steps[0].output, "already done");
    assert.equal(completed.steps[0].providerInstanceId, "retired-native");
    assert.equal(provider.prompts.length, 1);
    assert.match(provider.prompts[0], /already done/);
    assert.equal(getRun(source.id)?.status, "interrupted");
  } finally {
    await stopExecution();
    await provider.close();
  }
});

test("chat and workspace tasks share a thread execution boundary", async () => {
  const gate = Promise.withResolvers<void>();
  const chatStarted = Promise.withResolvers<void>();
  const entered: string[] = [];
  const chat = withThreadExecution("shared", async () => {
    entered.push("chat");
    chatStarted.resolve();
    await gate.promise;
  });
  const run = withThreadExecution("shared", async () => {
    entered.push("run");
  });
  await chatStarted.promise;
  assert.deepEqual(entered, ["chat"]);
  gate.resolve();
  await Promise.all([chat, run]);
  assert.deepEqual(entered, ["chat", "run"]);
});

test("workspace revision rejects stale writers and browser runs cannot replace authoritative execution", async () => {
  const run = await submitRun(request("server-owned"));
  const initial = getWorkspace("thread-1");
  const saved = putWorkspace("thread-1", { ...initial, runs: [{ id: "forged" }] });
  assert.equal(saved.revision, 1);
  assert.deepEqual(
    saved.runs.map((item) => item.id),
    [run.id],
  );
  assert.throws(() => putWorkspace("thread-1", initial), { code: "revision_conflict" });
});

test("legacy import is idempotent, never executes, and cannot be continued without a snapshot", async () => {
  const legacy = {
    ...emptyWorkspace(),
    runs: [
      {
        id: "old",
        threadId: "legacy",
        name: "Old",
        kind: "agent" as const,
        status: "running" as const,
        input: "legacy task",
        startedAt: new Date().toISOString(),
        steps: [
          {
            id: "old-step",
            name: "Old",
            agentName: "Old",
            model: "deepseek-chat",
            status: "running" as const,
            output: "partial",
          },
        ],
      },
    ],
  };
  const payload = { importId: "migration", threads: { legacy } };
  assert.deepEqual(importWorkspaces(payload), { imported: ["legacy"], skipped: [] });
  assert.deepEqual(importWorkspaces(payload), { imported: ["legacy"], skipped: [] });
  const imported = listRuns("legacy")[0];
  assert.equal(imported.status, "interrupted");
  assert.equal(imported.steps[0].output, "partial");
  await assert.rejects(continueRun(imported.id), { code: "missing_request_snapshot" });
  assert.throws(() => importWorkspaces({ ...payload, threads: {} }), {
    code: "idempotency_conflict",
  });
});

test("fork keeps an exact completed prefix, omits later chat, and merge is confirmed/direct-parent/single-consumption", async () => {
  const source = await submitRun(request("fork-source"));
  source.status = "interrupted";
  source.steps[0] = { ...source.steps[0], status: "completed", output: "stable boundary output" };
  saveRun(source);
  saveFormattedMessage(
    source.threadId,
    {
      id: "later-message",
      parent_id: null,
      format: CHAT_FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "LATER DO NOT COPY" }] },
    },
    true,
  );
  const fork = forkRun(source.id, { stepId: "step-1", idempotencyKey: "fork-once" });
  assert.deepEqual(forkRun(source.id, { stepId: "step-1", idempotencyKey: "fork-once" }), fork);
  assert.equal(
    JSON.stringify(getThreadHistory(fork.threadId)).includes("LATER DO NOT COPY"),
    false,
  );
  const child = await submitRun(request("child-result", fork.threadId));
  child.status = "completed";
  child.steps[0] = { ...child.steps[0], status: "completed", output: "branch findings" };
  saveRun(child);
  const preview = getMergePreview(fork.threadId);
  assert.match(preview.text, /branch findings/);
  assert.throws(() => mergeThread(fork.threadId, { confirmed: false }), {
    code: "confirmation_required",
  });
  assert.throws(
    () => mergeThread(fork.threadId, { confirmed: true, parentThreadId: "wrong-parent" }),
    { code: "direct_parent_only" },
  );
  const transfer = mergeThread(fork.threadId, { confirmed: true, text: preview.text });
  assert.equal(mergeThread(fork.threadId, { confirmed: true }).id, transfer.id);
  assert.equal(listRuns(source.threadId).length, 1); // Merge never starts the parent.
  const parentNext = await submitRun(request("parent-next", source.threadId));
  assert.match(getRunRequest(parentNext.id)!.transferContext!, /branch findings/);
  assert.equal(
    transaction(() => consumeTransfers(source.threadId, "other-consumer")),
    "",
  );
  assert.equal(
    readRecord<{ consumedByRunId: string }>(TRANSFERS, fork.threadId)?.consumedByRunId,
    parentNext.id,
  );
  assert.equal(getRun(source.id)?.status, "interrupted");
});

test("failed first-step snapshots fork portably without replaying or accepting an active source", async () => {
  const source = await submitRun(request("failed-fork"));
  assert.throws(() => forkRun(source.id), { code: "unstable_fork_boundary" });
  source.status = "failed";
  source.steps[0] = {
    ...source.steps[0],
    status: "failed",
    output: "partial evidence",
    nativeSession: {
      providerInstanceId: "codex",
      driver: "codex",
      sessionId: "native",
      turnId: "failed-turn",
    },
  };
  saveRun(source);
  const fork = forkRun(source.id);
  const lineage = readRecord<{ context: string; nativeFork?: unknown }>(
    "durable:forks",
    fork.threadId,
  )!;
  assert.match(lineage.context, /partial evidence/);
  assert.match(lineage.context, /未完成/);
  assert.equal(lineage.nativeFork, undefined);
  assert.equal(listRuns(fork.threadId).length, 0);
  assert.equal(getRun(source.id)?.status, "failed");
});

test("SQLite schema is lazily opened and preserves generic namespaces", () => {
  writeRecord("one", "same", { value: 1 });
  writeRecord("two", "same", { value: 2 });
  assert.deepEqual(readRecord("one", "same"), { value: 1 });
  assert.deepEqual(readRecord("two", "same"), { value: 2 });
  assert.ok(
    getDatabase().prepare("SELECT name FROM sqlite_master WHERE name = 'run_events'").get(),
  );
});

test("a second process cannot own the durable execution store", { timeout: 10000 }, async () => {
  getDatabase();
  const source = `import { getDatabase } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)}; getDatabase();`;
  await assert.rejects(
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, AGENT_WORKSPACE_DATA_DIR: directory },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error);
      assert.match(String(error.stderr), /already owned|already active/);
      return true;
    },
  );
});

test("resource drafts import without requiring execution-ready workflow fields", () => {
  const draft = {
    ...emptyWorkspace(),
    workflows: [
      {
        id: "draft",
        name: "",
        steps: [{ id: "draft-step", name: "", agentId: "", instruction: "" }],
      },
    ],
  };
  assert.deepEqual(importWorkspaces({ importId: "drafts", threads: { drafts: draft } }).imported, [
    "drafts",
  ]);
  assert.equal(getWorkspace("drafts").workflows[0].steps[0].agentId, "");
});

test("run routes accept detached snapshots, reject changed retries, and replay after the durable sequence", async () => {
  const send = (path: string, value: unknown, method = "POST") =>
    workspaceRoutes.request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const value = request("route-run");
  assert.equal(
    (await send("/workspace/runs", { ...value, transferContext: "forged transfer" })).status,
    400,
  );
  assert.equal((await send("/workspace/runs", value)).status, 202);
  assert.equal((await send("/workspace/runs", value)).status, 202);
  assert.equal(listRuns().length, 1);
  assert.equal((await send("/workspace/runs", { ...value, input: "different task" })).status, 409);
  assert.equal(
    (await workspaceRoutes.request("http://localhost/workspace/runs/route-run")).status,
    200,
  );
  assert.equal((await send("/workspace/runs/route-run/fork", {})).status, 409);
  assert.equal((await send("/workspace/runs/route-run/cancel", {})).status, 200);
  const replay = await workspaceRoutes.request(
    "http://localhost/workspace/runs/route-run/events?after=1",
  );
  const events = (await replay.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.seq),
    [2],
  );
  assert.equal(events[0].run.status, "cancelled");
  assert.equal(
    (await workspaceRoutes.request("http://localhost/workspace/runs/route-run/events?after=-1"))
      .status,
    400,
  );
  assert.equal(
    (await send("/workspace/runs/route-run/continue", { idempotencyKey: "route-continue" })).status,
    202,
  );
  assert.equal(listRuns().length, 2);
  const initial = emptyWorkspace();
  assert.equal((await send("/workspace/threads/route-resources", initial, "PUT")).status, 200);
  assert.equal((await send("/workspace/threads/route-resources", initial, "PUT")).status, 409);
  assert.equal(getWorkspace("route-resources").revision, 1);
  assert.equal((await send("/workspace/run", value)).status, 404);
});

test(
  "queued requests resume after reopening and structured quota failures retain reset/account evidence",
  { timeout: 10000 },
  async () => {
    const resetAt = new Date(Date.now() + 3600000).toISOString();
    const provider = await nativeProvider(async (_, index) => {
      if (index === 0) {
        throw new CliChatError(
          "provider_error",
          "Usage limit reached",
          { code: "usage_limit", reset_at: resetAt },
          "test-native",
        );
      }
      return "recovered output";
    });
    try {
      const queued = await submitRun(request("quota"));
      closeStore();
      await startExecution();
      const failed = await waitForRun(queued.id, (run) => run.status === "failed");
      assert.equal(failed.errorClass, "usage_limit");
      assert.equal(failed.resetAt, resetAt);
      assert.equal(failed.providerInstanceId, "test-native");
      assert.equal(typeof failed.providerInstanceRevision, "number");
      assert.equal(failed.steps[0].executionKind, "agent");
      assert.equal(failed.steps[0].sideEffects, "unknown");
      await assert.rejects(
        continueRun(failed.id, { idempotencyKey: "quota-recovery:quota", confirmSideEffects: false }),
        { code: "side_effect_confirmation_required" },
      );
      const continuation = await continueRun(failed.id, {
        idempotencyKey: "quota-recovery:quota",
        confirmSideEffects: true,
      });
      const recovered = await waitForRun(continuation.id, (run) => run.status === "completed");
      assert.equal(recovered.continuationOf, failed.id);
      assert.equal(getRun(failed.id)?.status, "failed");
      assert.equal(provider.prompts.length, 2);
    } finally {
      await stopExecution();
      await provider.close();
    }
  },
);

test("chat snapshot fork copies only its stable context/resources and deduplicates retries", () => {
  const parent = putWorkspace("chat-parent", {
    ...emptyWorkspace(),
    skills: [{ id: "saved-skill", name: "Parent skill", instructions: "Keep this resource" }],
  });
  saveFormattedMessage(
    "chat-parent",
    {
      id: "later-chat",
      parent_id: null,
      format: CHAT_FORMAT,
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "LATER HISTORY MUST NOT BE COPIED" }],
      },
    },
    true,
  );
  const source = {
    threadId: "chat-parent",
    generationId: "failed-generation",
    messageId: "partial-assistant",
    context: "原任务与已保存的失败边界；partial output is not confirmed success.",
  };
  const fork = forkChatSnapshot(source, {
    title: "Failed chat branch",
    idempotencyKey: "chat-fork-once",
  });
  assert.deepEqual(
    forkChatSnapshot(source, { title: "Failed chat branch", idempotencyKey: "chat-fork-once" }),
    fork,
  );
  assert.throws(
    () =>
      forkChatSnapshot(
        { ...source, context: "changed boundary" },
        { title: "Failed chat branch", idempotencyKey: "chat-fork-once" },
      ),
    { code: "idempotency_conflict" },
  );
  assert.deepEqual(getWorkspace(fork.threadId).skills, parent.skills);
  assert.equal(getWorkspace("chat-parent").revision, parent.revision);
  assert.equal(listRuns(fork.threadId).length, 0);
  const history = JSON.stringify(getThreadHistory(fork.threadId));
  assert.match(history, /partial output is not confirmed success/);
  assert.equal(history.includes("LATER HISTORY MUST NOT BE COPIED"), false);
  assert.equal(getThreadHistory("chat-parent").messages.length, 1);
  assert.equal(getThreadFork(fork.threadId)?.sourceRunId, source.generationId);
  assert.equal(getThreadFork(fork.threadId)?.sourceStepId, source.messageId);
  assert.equal(getThreadPendingFork(fork.threadId), undefined);
  assert.equal(getThreadNativeSession(fork.threadId), undefined);
});

test("chat native fork is lazy, requires driver-specific provider boundaries and never resumes the parent head", () => {
  putWorkspace("native-chat-parent", emptyWorkspace());
  const nativeSession: NativeSessionRef = {
    providerInstanceId: "not-configured-on-purpose",
    driver: "codex",
    sessionId: "provider-issued-session",
    turnId: "provider-issued-turn",
    instanceRevision: 1,
  };
  const source = {
    threadId: "native-chat-parent",
    generationId: "completed-generation",
    messageId: "completed-assistant",
    context: "Confirmed chat output",
    nativeSession,
  };
  const fork = forkChatSnapshot(source);
  assert.deepEqual(getThreadPendingFork(fork.threadId), {
    source: nativeSession,
    boundary: { turnId: nativeSession.turnId },
  });
  assert.equal(getThreadNativeSession(fork.threadId), undefined);
  assert.equal(listRuns(fork.threadId).length, 0); // No provider lookup or execution at Fork time.
  const portable = forkChatSnapshot({
    ...source,
    generationId: "no-native-turn",
    nativeSession: { ...nativeSession, turnId: undefined, messageId: "not-a-codex-turn" },
  });
  assert.equal(getThreadPendingFork(portable.threadId), undefined);
  assert.throws(() => forkChatSnapshot({ ...source, threadId: "missing-parent" }), {
    code: "thread_not_found",
  });
});

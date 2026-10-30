import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import { getStoredInstance, providerContext, recordProviderObservations, updateProviderInstance } from "../instances.ts";
import { listRecords, closeStore, deleteRecord } from "../../durable/store.ts";
import { PM_CONTINUATIONS, continuationKey } from "../t3code/continuation.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";
import { opencodeAdapter } from "./opencode.ts";
import { createOpenCodeTestHarness, waitForOpenCodeFixtureGate } from "./opencode-test-harness.ts";
import { runNativeRuntime, type ProviderRuntime } from "../runtime.ts";
import { ensureThread, getThreadPendingFork } from "../../durable/threads.ts";
import { forkChatSnapshot } from "../../durable/forks.ts";

const model = "native-api/model/one";

test("OpenCode settings retain password secrecy and reject embedded URL credentials", () => {
  const config = opencodeAdapter.validateConfig({});
  assert.equal(config.binaryPath, "opencode"); assert.equal(config.serverUrl, ""); assert.equal(config.serverPassword, "");
  assert.equal(opencodeAdapter.definition.fields.find(field => field.key === "serverPassword")?.type, "password");
  for (const serverUrl of ["file:///tmp/socket", "http://user:secret@localhost", "http://localhost?token=secret", "http://localhost/#secret"])
    assert.throws(() => opencodeAdapter.validateConfig({ serverUrl }));
  assert.throws(() => opencodeAdapter.validateConfig({ apiKey: "not-a-provider" }));
});

for (const generation of ["v1", "v2"] as const) {
  test(`original OpenCode ${generation} checks models without prompting or taking ownership of the external server`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const status = await opencodeAdapter.check(f.context);
      assert.equal(status.installation.status, "installed");
      assert.equal(status.nativeSessionReady, true);
      assert.equal(status.authentication, "unknown", "Model discovery is not a vendor login or paid-inference proof");
      assert.deepEqual(status.models.map(entry => entry.id), [model]);
      const variant = status.models[0]?.capabilities?.optionDescriptors?.find(entry => entry.id === "variant");
      assert.ok(variant?.type === "select"); assert.deepEqual(variant.options.map(entry => entry.id), ["low", "high"]);
      assert.deepEqual(status.methods, []); assert.equal(status.canLogout, false);
      assert.equal(f.wire.prompts.length, 0, "Settings checks must never perform inference");
      await assert.rejects(opencodeAdapter.authenticate(f.context, { signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => "" }));
      await assert.rejects(opencodeAdapter.logout(f.context));
      assert.equal(f.wire.requests.some(request => /auth|credential|integration|dispose|reload|shutdown/.test(request.path)), false);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} computes, deduplicates events and resumes native memory without replay or new session`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const chunks: string[] = []; const events: NativeOutputEvent[] = [];
      const first = await f.run(f.context, { model, modelOptions: [{ id: "variant", value: "high" }], interactionMode: "plan",
        prompt: "ADD 19 23", onText: delta => chunks.push(delta), onEvent: event => events.push(event) });
      assert.equal(first.text, "計算=42"); assert.equal(chunks.join(""), first.text);
      assert.ok(events.some(event => event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.text === first.text));
      assert.doesNotMatch(JSON.stringify(events), /FOREIGN MUST NOT APPEAR|PROMPT MUST NOT APPEAR/);
      assert.equal(first.nativeSession?.cwd, f.context.cwd); assert.ok(first.nativeSession?.sessionId.startsWith("ses_fixture_"));
      const records = listRecords<{ protocol: string }>(PM_CONTINUATIONS);
      assert.equal(records.length, 1); assert.equal(records[0]!.protocol, generation === "v2" ? "opencode-v2-http.sse" : "opencode-v1-sdk.sse");
      closeStore(); // Reopen the actual sidecar, not an in-memory session cache.
      const second = await f.run(f.context, { model, modelOptions: [{ id: "variant", value: "high" }], interactionMode: "default", prompt: "ACCUMULATE 8", resume: first.nativeSession });
      assert.equal(second.text, "計算=50"); assert.equal(second.nativeSession?.sessionId, first.nativeSession?.sessionId);
      assert.deepEqual(f.wire.prompts.map(entry => [entry.text, entry.total]), [["ADD 19 23", 42], ["ACCUMULATE 8", 50]]);
      assert.deepEqual(f.wire.prompts.map(entry => entry.agent), ["plan", "build"], "Each turn must use its effective native agent, including v1's build default");
      const nativeRoot = generation === "v2" ? "/api/session" : "/session";
      assert.equal(f.wire.requests.filter(request => request.method === "POST" && request.path === nativeRoot).length, 1);
      if (generation === "v2") {
        const create = f.wire.requests.find(request => request.method === "POST" && request.path === nativeRoot)!;
        assert.deepEqual(create.body.model, { providerID: "native-api", id: "model/one", variant: "high" });
        assert.deepEqual(f.wire.requests.filter(request => request.method === "POST" && request.path.endsWith("/agent")).map(request => request.body.agent), ["plan", "build"]);
      } else {
        const prompts = f.wire.requests.filter(request => request.path.endsWith("/prompt_async"));
        assert.deepEqual(prompts[0]!.body.model, { providerID: "native-api", modelID: "model/one" });
        assert.equal(prompts[0]!.body.variant, "high");
      }
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} keeps its issued historical boundary through Chat fork planning and runtime dispatch`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const status = await opencodeAdapter.check(f.context);
      const instance = getStoredInstance(f.context.instanceId)!;
      recordProviderObservations(instance.instanceId, instance.revision, { discoveredModels: status.models });
      assert.ok(status.capabilities);
      assert.equal(status.capabilities?.nativeFork, true);
      assert.equal(status.capabilities.boundedFork, true);
      const runtime: ProviderRuntime = { kind: "agent", providerInstanceId: instance.instanceId, providerLabel: instance.label,
        driver: "opencode", modelId: model, model: status.models.find(entry => entry.id === model)!,
        temperatureAllowed: false, capabilities: status.capabilities, instanceRevision: instance.revision, instance };
      const first = await f.run(f.context, { model, prompt: "ADD 19 23", signal: t.signal });
      assert.ok(first.nativeSession?.turnId);
      const second = await f.run(f.context, { model, prompt: "ACCUMULATE 8", resume: first.nativeSession, signal: t.signal });
      assert.equal(second.text, "計算=50");
      await assert.rejects(runNativeRuntime(runtime, { prompt: "ACCUMULATE 100", cwd: f.context.cwd,
        session: { resume: first.nativeSession }, signal: t.signal }), { code: "session_mismatch" });
      assert.equal(f.wire.prompts.length, 2);
      ensureThread("native-opencode-fork", undefined, { workspaceId: "fixture-workspace", projectId: null });
      const branch = forkChatSnapshot({ threadId: "native-opencode-fork", generationId: "native-source-generation",
        messageId: "native-source-answer", context: first.text, nativeSession: first.nativeSession });
      const fork = getThreadPendingFork(branch.threadId);
      assert.equal(fork?.source.sessionId, first.nativeSession.sessionId);
      assert.equal(fork?.boundary?.turnId, first.nativeSession.turnId);
      const result = await runNativeRuntime(runtime, { prompt: "ACCUMULATE 1", cwd: f.context.cwd, session: { fork }, signal: t.signal });
      assert.equal(result.text, "計算=43");
      assert.notEqual(result.nativeSession?.sessionId, first.nativeSession.sessionId);
      assert.equal(f.wire.requests.filter(request => request.method === "POST" && request.path.endsWith("/fork")).length, 1);
      assert.deepEqual(f.wire.prompts.map(entry => entry.text), ["ADD 19 23", "ACCUMULATE 8", "ACCUMULATE 1"]);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} rejects revision/cwd/instance and stable-boundary continuation mismatches without prompting`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const first = await f.run(f.context, { model, prompt: "ADD 8 9" }); assert.ok(first.nativeSession);
      const before = f.wire.prompts.length;
      for (const source of [
        { ...first.nativeSession, providerInstanceId: "other-instance" },
        { ...first.nativeSession, instanceRevision: f.context.revision + 1 },
        { ...first.nativeSession, cwd: "/not-the-original-cwd" },
        { ...first.nativeSession, turnId: "msg_unproven_boundary" },
      ]) await assert.rejects(f.run(f.context, { model, prompt: "ACCUMULATE 1", resume: source }), { code: "session_mismatch" });
      assert.equal(f.wire.prompts.length, before); f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} adopts verified legacy history without an ensure or probe prompt`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const first = await f.run(f.context, { model, prompt: "ADD 13 29" }); assert.ok(first.nativeSession);
      // Delete only the new continuation sidecar, leaving the real native transcript.
      // Legacy adoption must prove the saved native turn/message and cwd from that transcript.
      deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, first.nativeSession.sessionId));
      const second = await f.run(f.context, { model, prompt: "ACCUMULATE 2", resume: first.nativeSession });
      assert.equal(second.text, "計算=44");
      assert.equal(f.wire.prompts.length, 2);
      assert.equal(f.wire.requests.filter(request => request.method === "POST" && request.path === (generation === "v2" ? "/api/session" : "/session")).length, 1);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} refuses legacy native cwd mismatch instead of moving or silently replacing it`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const first = await f.run(f.context, { model, prompt: "ADD 3 4" }); assert.ok(first.nativeSession);
      deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, first.nativeSession.sessionId));
      f.wire.changeNativeCwd("/different-native-directory");
      await assert.rejects(f.run(f.context, { model, prompt: "ACCUMULATE 2", resume: first.nativeSession }), { code: "session_mismatch" });
      assert.equal(f.wire.prompts.length, 1);
      assert.equal(f.wire.requests.some(request => request.path.endsWith("/move")), false); f.wire.assertClean();
    } finally { await f.close(); }
  });

  for (const [scenario, status, errorClass] of [["authentication", 401, "authentication"], ["payment", 402, "provider_error"], ["quota", 429, "usage_limit"]] as const) {
    test(`original OpenCode ${generation} preserves ${status} as ${errorClass} rather than reporting partial-output success`, { timeout: 20_000 }, async () => {
      const f = await createOpenCodeTestHarness(generation, { scenario });
      try {
        await assert.rejects(f.run(f.context, { model, prompt: "ADD 19 23" }), (error: unknown) => {
          assert.ok(error instanceof Error && "status" in error && "errorClass" in error);
          assert.equal(error.status, status); assert.equal(error.errorClass, errorClass);
          assert.doesNotMatch(JSON.stringify(error), /päss-密碼-fixture/); return true;
        });
        assert.equal(f.wire.prompts.length, 1); f.wire.assertClean();
      } finally { await f.close(); }
    });
  }

  for (const scenario of ["disconnect", "interrupted"] as const) {
    test(`original OpenCode ${generation} ${scenario} does not complete from text or another session's terminal`, { timeout: 65_000 }, async () => {
      const f = await createOpenCodeTestHarness(generation, { scenario });
      try {
        await assert.rejects(f.run(f.context, { model, prompt: "ADD 19 23" }), (error: unknown) => {
          assert.ok(error instanceof Error);
          if (scenario === "interrupted") assert.equal("terminalStatus" in error && error.terminalStatus, "interrupted");
          return true;
        });
        assert.equal(f.wire.prompts.length, 1); f.wire.assertClean();
      } finally { await f.close(); }
    });
  }

  test(`original OpenCode ${generation} cancellation interrupts only its native session and external server survives application shutdown`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "hold" });
    const controller = new AbortController();
    const run = f.run(f.context, { model, prompt: "ADD 19 23", signal: AbortSignal.any([controller.signal, t.signal]) });
    try {
      await waitForOpenCodeFixtureGate(f.wire.prompted, run, t.signal, "native prompt admission");
      controller.abort(); await assert.rejects(run, { terminalStatus: "cancelled" });
      assert.ok(f.wire.requests.some(request => request.path.endsWith(generation === "v2" ? "/interrupt" : "/abort")));
      const { stopPmProviderApplication } = await import("../t3code/application.ts");
      await stopPmProviderApplication();
      const response = await fetch(`${f.wire.url}/${generation === "v2" ? "api/info" : "global/health"}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${f.wire.password}`, "utf8").toString("base64")}` } });
      assert.equal(response.status, 200);
      assert.equal(f.wire.requests.some(request => /shutdown|dispose|reload/.test(request.path)), false); f.wire.assertClean();
    } finally { controller.abort(); await f.close(); }
  });

  test(`original OpenCode ${generation} rejects a second turn while the native session is busy`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "hold" }); const controller = new AbortController();
    let nativeSession: NativeSessionRef | undefined;
    const first = f.run(f.context, { model, prompt: "ADD 1 2", signal: AbortSignal.any([controller.signal, t.signal]), onSession: ref => { nativeSession = ref; } });
    try {
      await waitForOpenCodeFixtureGate(f.wire.prompted, first, t.signal, "held native prompt admission"); assert.ok(nativeSession);
      await assert.rejects(f.run(f.context, { model, prompt: "ACCUMULATE 9", resume: nativeSession, signal: t.signal }));
      assert.equal(f.wire.prompts.length, 1); f.wire.assertClean();
      controller.abort(); await assert.rejects(first, { terminalStatus: "cancelled" });
    } finally { controller.abort(); await f.close(); }
  });

  for (const callback of ["onText", "onEvent"] as const) {
    test(`original OpenCode ${generation} ${callback} failure interrupts an active native root`, { timeout: 20_000 }, async (t) => {
      const f = await createOpenCodeTestHarness(generation, { scenario: "hold" });
      let invoked = false;
      const failure = new Error(`${callback} consumer failed`);
      try {
        await assert.rejects(f.run(f.context, { model, prompt: "ADD 2 3", signal: t.signal,
          ...(callback === "onText" ? { onText: () => { invoked = true; throw failure; } }
            : { onEvent: (event: NativeOutputEvent) => {
              if (event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.text) {
                invoked = true; throw failure;
              }
            } }),
        }), { message: failure.message });
        assert.equal(invoked, true);
        assert.equal(f.wire.prompts.length, 1);
        const root = f.wire.prompts[0]!.sessionId;
        assert.ok(f.wire.requests.some(request => request.path === `${generation === "v2" ? "/api/session" : "/session"}/${root}/${generation === "v2" ? "interrupt" : "abort"}`));
        f.wire.assertClean();
      } finally { await f.close(); }
    });
  }

  test(`original OpenCode ${generation} propagates terminal usage callback failure without requiring a redundant native abort`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "usage" });
    let invoked = false;
    const failure = new Error("onUsage consumer failed");
    try {
      await assert.rejects(f.run(f.context, { model, prompt: "ADD 2 3", signal: t.signal,
        onUsage: update => {
          if (!update.turn && !update.reportedTurn) return;
          invoked = true; throw failure;
        },
      }), { message: failure.message });
      assert.equal(invoked, true);
      assert.equal(f.wire.prompts.length, 1);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} reports disjoint cumulative native usage exactly once per repeated step`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "usage" });
    try {
      const updates: NativeUsageUpdate[] = [];
      await f.run(f.context, { model, prompt: "ADD 19 23", onUsage: update => updates.push(update) });
      const totals = updates.flatMap(update => update.turn ? [update.turn.totals] : []);
      assert.ok(totals.length > 0);
      assert.deepEqual(totals.at(-1), { uncachedInputTokens: 17, cachedInputTokens: 8, cacheCreationTokens: 4, outputTokens: 10, reasoningTokens: 3 });
      assert.ok(totals.every(value => value.uncachedInputTokens <= 17 && value.outputTokens <= 10)); f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} preserves observed partial-run counters without fabricating complete usage`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "usage-partial" });
    try {
      const updates: NativeUsageUpdate[] = [];
      await assert.rejects(f.run(f.context, { model, prompt: "ADD 19 23", onUsage: update => updates.push(update) }), { terminalStatus: "interrupted" });
      const partials = updates.flatMap(update => update.reportedTurn ? [update.reportedTurn] : []);
      assert.ok(partials.length > 0);
      assert.deepEqual(partials.at(-1), { inputTokens: 19, outputTokens: 6, cachedInputTokens: 6, cacheCreationTokens: 3, reasoningTokens: 2 });
      assert.equal(updates.some(update => update.turn !== undefined), false);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} wrong external password is unauthenticated, redacted, and does not spawn a local binary`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const stored = updateProviderInstance(f.context.instanceId, { config: { ...f.context.config, serverPassword: "wrong-password" } }, f.context.revision);
      const result = await opencodeAdapter.check(providerContext(stored, f.context.cwd));
      assert.equal(result.authentication, "unauthenticated");
      assert.doesNotMatch(JSON.stringify(result), /wrong-password|päss-密碼-fixture|secret-that-must-not-leak/);
      assert.equal(f.wire.prompts.length, 0); f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} rejects an HTML-only impostor and never prompts on a rejected subscription`, { timeout: 20_000 }, async () => {
    for (const options of [{ htmlOnly: true }, { rejectStream: true }]) {
      const f = await createOpenCodeTestHarness(generation, options);
      try {
        await assert.rejects(f.run(f.context, { model, prompt: "ADD 19 23" }));
        assert.equal(f.wire.prompts.length, 0); f.wire.assertClean();
      } finally { await f.close(); }
    }
  });

  test(`original OpenCode ${generation} authoritative configuration CAS invalidates old context before new work`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const stored = getStoredInstance(f.context.instanceId)!;
      updateProviderInstance(stored.instanceId, { label: "new revision" }, stored.revision);
      await assert.rejects(f.run(f.context, { model, prompt: "ADD 19 23" }), { code: "session_mismatch" });
      assert.equal(f.wire.prompts.length, 0); f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} forks at a completed native turn and preserves the selected history only`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const first = await f.run(f.context, { model, prompt: "ADD 19 23" }); assert.ok(first.nativeSession?.turnId);
      assert.equal(first.nativeSession.turnId, f.wire.prompts[0]!.messageId, "A native cursor is the actually admitted initiating message, not an application graph ID");
      const second = await f.run(f.context, { model, prompt: "ACCUMULATE 8", resume: first.nativeSession }); assert.ok(second.nativeSession?.turnId);
      assert.equal(second.nativeSession.turnId, f.wire.prompts[1]!.messageId);
      await assert.rejects(getPmProviderApplication().execution.fork(f.context, second.nativeSession, { turnId: "msg_unproven_boundary" }), { code: "unsupported_fork" });
      assert.equal(f.wire.requests.some(request => request.path.endsWith("/fork")), false);
      const fork = await getPmProviderApplication().execution.fork(f.context, second.nativeSession, { turnId: first.nativeSession.turnId });
      assert.notEqual(fork.sessionId, second.nativeSession.sessionId);
      const forkRecords = listRecords<{ nativeSessionId: string; providerTurnsJson: unknown[];
        nativeHistory?: { nativeSessionId: string; completedTurnRefs: Array<{ nativeId: string }>; latestCompletedTurnRef?: { nativeId: string } } }>(PM_CONTINUATIONS);
      const targetRecord = forkRecords.find(record => record.nativeSessionId === fork.sessionId);
      assert.ok(targetRecord?.nativeHistory);
      assert.equal(targetRecord.nativeHistory.nativeSessionId, fork.sessionId, "Fork evidence must be read from the new native target, not relabelled source metadata");
      assert.equal(targetRecord.nativeHistory.completedTurnRefs.length, 1);
      const targetBoundary = targetRecord.nativeHistory.completedTurnRefs[0]!.nativeId;
      assert.notEqual(targetBoundary, first.nativeSession.turnId, "The controlled fork assigns new native message IDs, so source proof cannot pass as target proof");
      assert.equal(fork.turnId, targetBoundary);
      assert.equal(targetRecord.nativeHistory.latestCompletedTurnRef?.nativeId, targetBoundary);
      assert.deepEqual(targetRecord.providerTurnsJson, [], "A fresh target has native history, not invented historical PM turns");
      const forkRequestIndex = f.wire.requests.findIndex(request => request.path.endsWith("/fork"));
      assert.ok(forkRequestIndex >= 0);
      assert.ok(f.wire.requests.slice(forkRequestIndex + 1).some(request =>
        request.method === "GET" && request.path === `${generation === "v2" ? "/api/session" : "/session"}/${fork.sessionId}/message`),
      "The bounded fork must read its target transcript before publishing a resumable cursor");
      const result = await f.run(f.context, { model, prompt: "ACCUMULATE 1", resume: fork });
      assert.equal(result.text, "計算=43", "Fork must preserve 42 at the selected boundary, not the later 50");
      const request = f.wire.requests.find(entry => entry.path.endsWith("/fork")); assert.ok(request);
      assert.equal(request.body[generation === "v2" ? "before" : "messageID"], f.wire.prompts[1]!.messageId);
      assert.equal(f.wire.prompts.length, 3, "Fork metadata lookup must not add an inference prompt");
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} registers and releases a distinct generation transport on resume without granting shell`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      let authorized = true;
      const authorizeExecution = async (action: "compaction" | "tool") => {
        if (!authorized || action !== "tool") throw Object.assign(new Error("Test generation authorization revoked"), { status: 403, code: "scope_unavailable" });
      };
      const base = { ...f.context, pmToolBridge: { command: process.execPath, args: ["/controlled/pm-transport.mjs", "http://127.0.0.1:12345"] } };
      const context = { ...base, authorizeExecution, execution: { threadId: "opencode-pm-thread", generationId: "opencode-generation-1", messageId: "user-1",
        scope: { workspaceId: "fixture-workspace", projectId: null } } };
      const first = await f.run(context, { model, prompt: "ADD 19 23" }); assert.equal(first.text, "計算=42");
      assert.equal(f.wire.connectedMcpServers, 0, "A terminal generation must release its native transport");
      const second = await f.run({ ...context, execution: { ...context.execution, generationId: "opencode-generation-2", messageId: "user-2" } },
        { model, prompt: "ACCUMULATE 8", resume: first.nativeSession });
      assert.equal(second.text, "計算=50"); assert.equal(f.wire.connectedMcpServers, 0);
      const adds = f.wire.requests.filter(request => generation === "v2" ? request.method === "PUT" && request.path.includes("/mcp/") : request.method === "POST" && request.path === "/mcp");
      assert.equal(adds.length, 2);
      const names = adds.map(request => generation === "v2" ? decodeURIComponent(request.path.split("/").at(-1)!) : String(request.body.name));
      assert.notEqual(names[0], names[1]);
      for (const request of adds) {
        const config = request.body.config;
        assert.ok(config && typeof config === "object" && "command" in config);
        assert.deepEqual(config.command, [process.execPath, "/controlled/pm-transport.mjs", "http://127.0.0.1:12345", "mcp"]);
      }
      const create = f.wire.requests.find(request => request.method === "POST" && request.path === (generation === "v2" ? "/api/session" : "/session"))!;
      const rules = create.body[generation === "v2" ? "permissions" : "permission"] as Array<Record<string, unknown>>;
      assert.ok(rules.some(rule => rule[generation === "v2" ? "action" : "permission"] === `${names[0]}_*` && rule[generation === "v2" ? "effect" : "action"] === "allow"));
      assert.equal(rules.some(rule => rule[generation === "v2" ? "action" : "permission"] === (generation === "v2" ? "shell" : "bash") && rule[generation === "v2" ? "effect" : "action"] === "allow"), false);
      authorized = false;
      await assert.rejects(f.run({ ...context, execution: { ...context.execution, generationId: "opencode-generation-revoked" } },
        { model, prompt: "ACCUMULATE 100", resume: second.nativeSession }), { code: "scope_unavailable" });
      assert.equal(f.wire.prompts.length, 2, "Revoked authority must not reach native inference");
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} cannot omit a refused PM transport or grant it without Chat scope`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { rejectMcp: true });
    try {
      const context = { ...f.context, pmToolBridge: { command: process.execPath, args: ["/controlled/pm-transport.mjs"] } };
      const actions = new Set(["tool"]);
      const authorizeExecution = async (action: "compaction" | "tool") => {
        if (!actions.has(action)) throw new Error("Native fixture action is not authorized");
      };
      await assert.rejects(f.run(context, { model, prompt: "ADD 1 2" }), { code: "scope_required" });
      await assert.rejects(f.run({ ...context, authorizeExecution, execution: { threadId: "transport-refused", generationId: "transport-refused-generation", messageId: "user-1",
        scope: { workspaceId: "fixture-workspace", projectId: null } } }, { model, prompt: "ADD 1 2" }));
      assert.ok(f.wire.requests.some(request => request.path.includes("/mcp")), "Native transport refusal must be reached after explicit host admission");
      assert.equal(f.wire.prompts.length, 0); assert.equal(f.wire.connectedMcpServers, 0); f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} will not steal an already-active external legacy session`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { externalBusy: true });
    try {
      await assert.rejects(f.run(f.context, { model, prompt: "ADD 1 2", resume: {
        providerInstanceId: f.context.instanceId, driver: "opencode", sessionId: "ses_external", instanceRevision: f.context.revision, cwd: f.context.cwd, modelId: model,
      } }));
      assert.equal(f.wire.prompts.length, 0);
      assert.equal(f.wire.requests.some(request => request.method !== "GET"), false, "No interrupt, permission rewrite, move, create or prompt may touch another client's active session");
      f.wire.assertClean();
    } finally { await f.close(); }
  });
}

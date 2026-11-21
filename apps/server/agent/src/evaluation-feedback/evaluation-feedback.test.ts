import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import type { UIMessage } from "ai";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { CliRuntime } from "../../../../../packages/pm-cli/runtime.ts";
import { agentEvaluationFamily } from "../../../../../packages/pm-cli/agent-evaluation.ts";
import { agentLogin, agentLogout, connectAgent } from "../../../../../packages/pm-cli/agent-connection.ts";
import { evaluationMetadataExportSchema, evaluationWindowSummaryEnvelopeSchema, type EvaluationPolicyInput, type EvaluationWindowInput } from "@agent-workspace/contracts/evaluation-feedback";
import type { AdmissionRow, PolicyRow } from "./persistence.ts";
import type { ProviderDriverStatus } from "../providers/driver-adapter.ts";

/** Isolated runtime smoke: real SQLite, authenticated TCP API, product CLI and Chat lifecycle; synthetic adapter only, no inference/network Provider. */
test("metadata observation lifecycle, probabilities, permissions, deletion and restore smoke", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "evaluation-observation-"));
  const data = path.join(root, "data"), code = path.join(root, "code"); await mkdir(code);
  const keys = ["AGENT_WORKSPACE_DATA_DIR", "AGENT_WORKSPACE_ALLOWED_ROOTS", "AGENT_WORKSPACE_ACCESS_TOKEN", "AGENT_EVALUATION_ARTIFACT_SHA256", "AGENT_EVALUATION_SOURCE_SHA256", "PM_AGENT_URL", "PM_AGENT_SESSION_DIR", "PM_API_URL"] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = data; process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([root]);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "disposable-observation-access-" + "x".repeat(40);
  process.env.PM_AGENT_SESSION_DIR = path.join(root, "access"); process.env.PM_API_URL = "http://127.0.0.1:1";
  delete process.env.AGENT_EVALUATION_ARTIFACT_SHA256; delete process.env.AGENT_EVALUATION_SOURCE_SHA256;
  // These imports intentionally exercise the module-loading boundary after isolating the environment; static imports would capture the real service data root.
  const { accessRoutes, accessGuard } = await import("../access.ts");
  const { evaluationFeedbackRoutes } = await import("./routes.ts");
  const { EVALUATION_NAMESPACES: N, fenceEvaluationCopy } = await import("./persistence.ts");
  const service = await import("./service.ts");
  const { closeStore, getDatabase, listRecords, readRecord, writeRecord, deleteRecord } = await import("../durable/store.ts");
  const { getStoreIdentity, preflightPersistence, namespacePolicy } = await import("../durable/persistence-schema.ts");
  const { ensureThread, updateThread, getThread, getThreadBranch } = await import("../durable/threads.ts");
  const { submitChat, continueChat, waitForChatTerminal, cancelChat, stopChatRuntime, startChatRuntime, getChatGeneration } = await import("../durable/chat-runtime.ts");
  const { openAgentWorkspace } = await import("../agent-workspaces.ts");
  const { codexAdapter } = await import("../providers/drivers/codex.ts");
  const { createProviderInstance } = await import("../providers/instances.ts");
  const { startPmProviderApplication, stopPmProviderApplication } = await import("../providers/t3code/application.ts");
  const { providerApplicationOptions } = await import("../providers/t3code/production.ts");
  const { createAgentBackup, restoreAgentBackup } = await import("../maintenance/agent-backup.ts");
  const { inspectThreadRetention, commitThreadRetention } = await import("../durable/thread-retention.ts");
  const originalCheck = codexAdapter.check, originalRun = codexAdapter.run;
  const threadId = "sensitive-custom-session", outsideId = "outside-approved-scope";
  let mode: "complete" | "failure" | "pending" = "complete", nativeCalls = 0;
  let started = Promise.withResolvers<void>();
  let releasePending: (() => void) | undefined;
  const providerCheck: ProviderDriverStatus = {
    installation: { status: "installed" as const, checkedAt: new Date().toISOString() }, authentication: "authenticated" as const, nativeSessionReady: true,
    models: [{ id: "sensitive-custom-model", label: "sensitive-custom-label", source: "discovered" as const, temperature: false }], methods: [], canLogout: false,
    capabilities: { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native" as const, portableHandoff: true },
  };
  codexAdapter.check = async () => providerCheck;
  codexAdapter.run = async (context, options) => {
    nativeCalls++;
    const ref: NativeSessionRef = { providerInstanceId: context.instanceId, driver: "codex", instanceRevision: context.revision, cwd: context.cwd,
      modelId: options.model, sessionId: randomUUID(), turnId: randomUUID() };
    options.onSession?.(ref); started.resolve();
    if (mode === "pending") {
      const pending = Promise.withResolvers<void>(); releasePending = pending.resolve;
      const cancel = () => pending.reject(Object.assign(new Error("sensitive cancellation details"), { code: "aborted" }));
      if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
      try { await pending.promise; } finally { releasePending = undefined; options.signal?.removeEventListener("abort", cancel); }
    }
    if (mode === "failure") throw new Error("sensitive-error https://private.invalid/secret /private/path");
    options.onText?.("sensitive response content");
    return { text: "sensitive response content", nativeSession: ref, usage: { inputTokens: 3, outputTokens: 2 } };
  };
  const workspace = openAgentWorkspace({ path: code });
  const selection = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  createProviderInstance({ instanceId: "sensitive-provider", driver: "codex", label: "sensitive-provider-label", config: { binaryPath: path.join(root, "never-executed"), homePath: path.join(root, "native-home") }, environment: [{ name: "HOME", value: root, sensitive: false }] });
  for (const id of [threadId, outsideId]) {
    ensureThread(id, undefined, selection);
    updateThread(id, { settings: { providerInstanceId: "sensitive-provider", model: "sensitive-custom-model", temperature: 0.1, systemPrompt: "sensitive system prompt" } });
  }
  await startPmProviderApplication(providerApplicationOptions);
  const app = new Hono().route("/api", accessRoutes).use("/api/*", accessGuard).route("/api", evaluationFeedbackRoutes);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  if (!server.listening) await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`; process.env.PM_AGENT_URL = origin;
  const headers = { authorization: `Bearer ${process.env.AGENT_WORKSPACE_ACCESS_TOKEN}`, "content-type": "application/json" };
  const printed: unknown[] = [];
  const pmToken = "p".repeat(43);
  let pmAuthorityEnabled = false, pmAuthenticationCalls = 0;
  const runtime: CliRuntime = {
    async authentication() {
      if (!pmAuthorityEnabled) throw new Error("Pure metadata CLI must not implicitly load PM credentials");
      pmAuthenticationCalls++;
      return { origin: "http://127.0.0.1:1", headers: { authorization: `Bearer ${pmToken}` } };
    },
    async connection() { throw new Error("No PM connection is needed"); }, async response() { throw new Error("No PM transport"); }, async json() { throw new Error("No PM transport"); },
    print(value) { printed.push(value); },
  };
  async function command(action: string, body?: unknown, pmContext = false) {
    const args = ["agent", "evaluation", action];
    if (action === "window" && typeof body === "string") args.push(body);
    else if (body !== undefined) { const file = path.join(root, randomUUID() + ".json"); await writeFile(file, JSON.stringify(body), { mode: 0o600 }); args.push("--file", file); }
    if (pmContext) args.push("--pm-context", "true");
    assert.equal(await agentEvaluationFamily.dispatch(args, runtime), true); return printed.at(-1);
  }
  async function send(id = threadId) {
    const messageId = randomUUID();
    const request = { id, idempotencyKey: randomUUID(), messages: [...getThreadBranch(id).map(row => ({ id: row.id, ...row.content }) as UIMessage),
      { id: messageId, role: "user" as const, parts: [{ type: "text" as const, text: "sensitive input /private/file https://private.invalid/path" }] }] };
    const generation = await submitChat(request);
    return { generation, request };
  }
  const policyId = randomUUID();
  const policy: EvaluationPolicyInput = { policyId, expectedRevision: 0, purpose: "release-observation", threadIds: [threadId],
    startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), retentionDays: 2,
    randomProbability: 0.25, failureProbability: 0.75, unknownProbability: 0.5, confirmedMetadataOnly: true };
  async function scopedPolicy(id: string, overrides: Partial<EvaluationPolicyInput> = {}): Promise<EvaluationPolicyInput> {
    ensureThread(id, undefined, selection);
    updateThread(id, { settings: { providerInstanceId: "sensitive-provider", model: "sensitive-custom-model", temperature: 0.1, systemPrompt: "sensitive system prompt" } });
    const input: EvaluationPolicyInput = { ...policy, policyId: randomUUID(), expectedRevision: 0, threadIds: [id], randomProbability: 1,
      startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), ...overrides };
    await command("configure", input); return input;
  }
  function windowInput(scopedPolicyId: string, base: number): EvaluationWindowInput {
    return { windowId: randomUUID(), policyId: scopedPolicyId,
      baselineRelease: { artifactSha256: "a".repeat(64), sourceSha256: "b".repeat(64) }, candidateRelease: { artifactSha256: "c".repeat(64), sourceSha256: "b".repeat(64) },
      baseline: { startsAt: new Date(base).toISOString(), endsAt: new Date(base + 1_000).toISOString() },
      candidate: { startsAt: new Date(base + 2_000).toISOString(), endsAt: new Date(base + 3_000).toISOString() },
      kinds: ["chat"], drivers: ["codex"], minimumEligiblePerCohort: 1, maximumFailureRateIncrease: 0, maximumUnknownRateIncrease: 0,
      maximumTrafficShareChange: 0.25, expiresAt: new Date(base + 60_000).toISOString(), releaseDecisionSha256: "d".repeat(64) };
  }
  try {
    await t.test("default off and existing authentication reject unauthorized activation", async () => {
      assert.equal((await originalFetch(origin + "/api/evaluation/status")).status, 401);
      const rejected = await originalFetch(origin + "/api/evaluation/policies", { method: "POST", headers, body: JSON.stringify(policy) });
      assert.equal(rejected.status, 409, "release identity cannot come from a request");
      const first = await send(); await waitForChatTerminal(first.generation.id);
      assert.deepEqual(listRecords(N.admissions), []); assert.deepEqual(listRecords(N.denominators), []);
      process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "a".repeat(64); process.env.AGENT_EVALUATION_SOURCE_SHA256 = "b".repeat(64);
      await agentLogin({ token: process.env.AGENT_WORKSPACE_ACCESS_TOKEN! });
      await assert.rejects(command("configure", { ...policy, release: { artifactSha256: "c".repeat(64), sourceSha256: "d".repeat(64) } }));
      const configured = z.object({ enabled: z.boolean() }).loose().parse(await command("configure", policy));
      assert.equal(configured.enabled, true);
      const outside = await send(outsideId); await waitForChatTerminal(outside.generation.id);
      assert.deepEqual(listRecords(N.admissions), []);
      for (const ns of Object.values(N)) assert.equal(namespacePolicy(ns)?.owner, "evaluation");
    });
    await t.test("real acceptance and terminal hooks preserve denominator and actual independent channel probabilities", async () => {
      for (const state of ["complete", "failure", "complete", "failure"] as const) {
        mode = state; const value = await send(); await waitForChatTerminal(value.generation.id);
        assert.equal((await submitChat(value.request)).id, value.generation.id, "original admission is not sampled twice");
      }
      const admissions = listRecords<AdmissionRow>(N.admissions); assert.equal(admissions.length, 4);
      const savedPolicy = readRecord<PolicyRow>(N.policies, policyId)!;
      for (const row of admissions) {
        assert.equal(row.observation.random.selected, service.evaluationDraw(savedPolicy.seed, row.generationId, "random") < 0.25);
        assert.equal(row.observation.inclusionProbability, row.observation.status === "failed" ? 0.8125 : 0.25);
        assert.equal(row.observation.failure.probability, row.observation.status === "failed" ? 0.75 : 0);
        assert.equal(row.observation.probabilityFinal, true); assert.equal(row.expiresAt, row.observation.expiresAt);
      }
      const exported = evaluationMetadataExportSchema.parse(await command("export"));
      assert.equal(exported.denominators.reduce((sum, row) => sum + row.eligible, 0), 4);
      assert.equal(exported.denominators.reduce((sum, row) => sum + row.failed, 0), 2);
      assert.equal(exported.denominators.reduce((sum, row) => sum + row.randomCandidates, 0), 4);
      assert.doesNotMatch(JSON.stringify(exported), /sensitive|private\.invalid|\/private\/|native-home|never-executed/u);
      assert.ok(exported.observations.every(row => row.random.selected || row.failure.selected || row.unknown.selected));
    });
    await t.test("pending and cancellation are explicit, not failed or excluded", async () => {
      mode = "pending"; started = Promise.withResolvers<void>(); const value = await send(); await started.promise;
      const before = evaluationMetadataExportSchema.parse(await command("export"));
      assert.equal(before.denominators.reduce((sum, row) => sum + row.pending, 0), 1);
      await cancelChat(value.generation.id); await waitForChatTerminal(value.generation.id);
      const row = readRecord<AdmissionRow>(N.admissions, value.generation.id)!;
      assert.equal(row.observation.status, "cancelled"); assert.equal(row.observation.failure.candidate, false); assert.equal(row.observation.unknown.candidate, false);
      assert.equal(row.observation.inclusionProbability, 0.25);
    });
    await t.test("actual killed process recovers accepted pending as interruption, never dispatches it again", async () => {
      await stopChatRuntime(); await stopPmProviderApplication(); closeStore();
      const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;
      const script = `
        const { codexAdapter } = await import(${JSON.stringify(moduleUrl("../providers/drivers/codex.ts"))});
        const { startPmProviderApplication } = await import(${JSON.stringify(moduleUrl("../providers/t3code/application.ts"))});
        const { providerApplicationOptions } = await import(${JSON.stringify(moduleUrl("../providers/t3code/production.ts"))});
        const { submitChat } = await import(${JSON.stringify(moduleUrl("../durable/chat-runtime.ts"))});
        const { getThreadBranch } = await import(${JSON.stringify(moduleUrl("../durable/threads.ts"))});
        codexAdapter.check = async () => (${JSON.stringify(providerCheck)});
        const started = Promise.withResolvers();
        codexAdapter.run = async (_context, options) => { options.onText?.('synthetic partial'); started.resolve(); return await Promise.withResolvers().promise; };
        await startPmProviderApplication(providerApplicationOptions);
        const id = ${JSON.stringify(threadId)};
        const generation = await submitChat({ id, idempotencyKey: crypto.randomUUID(), messages: [...getThreadBranch(id).map(row => ({id:row.id,...row.content})), {id:crypto.randomUUID(),role:'user',parts:[{type:'text',text:'synthetic restart input'}]}] });
        await started.promise; process.send({ generationId: generation.id }); process.on('message', () => {});
      `;
      const child = spawn(process.execPath, ["--conditions=development", "--input-type=module", "-e", script], { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let diagnostic = ""; child.stderr?.on("data", bytes => { diagnostic += String(bytes); });
      const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("Isolated child exited before acceptance: " + diagnostic); })]);
      const { generationId } = z.object({ generationId: z.uuid() }).parse(message[0]);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const beforeCalls = nativeCalls;
      await startChatRuntime();
      assert.equal(getChatGeneration(generationId)?.status, "interrupted");
      const row = readRecord<AdmissionRow>(N.admissions, generationId)!;
      assert.equal(row.observation.status, "interrupted"); assert.equal(row.observation.unknown.probability, 0.5); assert.equal(row.observation.inclusionProbability, 0.625);
      assert.equal(nativeCalls, beforeCalls, "startup recovery does not rerun a Provider");
      await startPmProviderApplication(providerApplicationOptions); mode = "complete";
    });
    await t.test("lost terminal observation stays explicit even if the business result is later recovered", async () => {
      mode = "pending"; started = Promise.withResolvers<void>(); const value = await send(); await started.promise;
      const generation = getChatGeneration(value.generation.id)!;
      deleteRecord("chat:generations", generation.id); // Fault injection only inside this disposable Store.
      service.recoverEvaluationObservations();
      writeRecord("chat:generations", generation.id, generation);
      await cancelChat(generation.id);
      const row = readRecord<AdmissionRow>(N.admissions, generation.id)!;
      assert.equal(row.observation.status, "observation-lost"); assert.equal(row.observation.unknown.probability, 0.5);
      assert.equal(row.observation.inclusionProbability, 0.625); assert.equal(getChatGeneration(generation.id)?.status, "cancelled");
      mode = "complete";
    });
    await t.test("PM withdrawal/unavailability never exports restricted rows or changes PM execution facts", async () => {
      const rows = listRecords<AdmissionRow>(N.admissions), chosen = rows[0]!;
      const original = getChatGeneration(chosen.generationId)!;
      const pmIdentity = randomUUID(), pmWorkspace = randomUUID();
      writeRecord("chat:generations", original.id, { ...original, pmOperations: [{ actorId: pmIdentity, target: { workspaceId: pmWorkspace, projectId: "PRJ-009" } }] });
      const before = JSON.stringify(readRecord("chat:generations", original.id));
      try {
      let status = 403;
      globalThis.fetch = async (input, init) => {
        if (!String(input instanceof Request ? input.url : input).startsWith("http://127.0.0.1:1/")) return originalFetch(input, init);
        if (status !== 200) return Response.json({ error: "sensitive PM refusal" }, { status });
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${pmToken}`);
        const target = z.object({ workspaceId: z.uuid(), projectId: z.string().nullable() }).parse(JSON.parse(String(init?.body)));
        return Response.json({ actorId: pmIdentity, scope: target });
      };
      const denied = evaluationMetadataExportSchema.parse(await command("export"));
      assert.equal(denied.coverage.status, "incomplete"); assert.deepEqual(denied.observations, []); assert.deepEqual(denied.denominators, []);
      status = 503; const unavailable = evaluationMetadataExportSchema.parse(await command("export"));
      assert.deepEqual(unavailable.fences, denied.fences, "unavailability is not revocation/deletion");
      assert.equal(listRecords(N.admissions).length, rows.length);
      assert.equal(pmAuthenticationCalls, 0, "PM authority is never attached implicitly");
      status = 200; pmAuthorityEnabled = true;
      const authorized = evaluationMetadataExportSchema.parse(await command("export", undefined, true));
      assert.equal(authorized.coverage.status, "complete", JSON.stringify(authorized.coverage));
      assert.equal(authorized.denominators.reduce((sum, row) => sum + row.eligible, 0), rows.length);
      await command("status", undefined, true);
      const connection = await connectAgent();
      const pmContext = { origin: "http://127.0.0.1:1", headers: { authorization: `Bearer ${pmToken}` } };
      try {
        for (const route of ["/api/evaluation/policies", "/api/evaluation/windows", "/api/evaluation/decisions"]) {
          const invalid = await connection.request(route, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, pmContext);
          assert.equal(invalid.status, 400, "known PM-aware command reaches native schema validation");
          await invalid.body?.cancel();
        }
        await assert.rejects(connection.request("/api/evaluation/future-operation", {}, pmContext), { code: "AGENT_PM_CONTEXT_ROUTE_DENIED" });
        await assert.rejects(connection.request("/api/evaluation/export", { method: "GET" }, pmContext), { code: "AGENT_PM_CONTEXT_ROUTE_DENIED" });
      } finally { connection.close(); }
      } finally {
        globalThis.fetch = originalFetch; pmAuthorityEnabled = false;
        writeRecord("chat:generations", original.id, original);
        const current = readRecord<PolicyRow>(N.policies, policyId);
        if (current?.enabled) await command("revoke", { policyId, expectedRevision: current.revision });
      }
      assert.equal(listRecords(N.admissions).length, 0);
      assert.ok(listRecords<{ reason: string }>(N.fences).some(fence => fence.reason === "revoked"));
      assert.notEqual(JSON.stringify(readRecord("chat:generations", original.id)), before, "test removes only its synthetic PM authority before revocation");
      assert.deepEqual(getChatGeneration(original.id), original, "revoking feedback must not mutate the execution authority");
    });
    await t.test("retention and source deletion preserve full eligible counts and propagate fences", async () => {
      await command("configure", { ...policy, expectedRevision: 2, randomProbability: 1 });
      const first = await send(); await waitForChatTerminal(first.generation.id);
      const row = readRecord<AdmissionRow>(N.admissions, first.generation.id)!;
      service.expireEvaluationObservations(Date.parse(row.expiresAt) + 1);
      assert.equal(readRecord(N.admissions, first.generation.id), null);
      let exported = evaluationMetadataExportSchema.parse(await command("export"));
      assert.ok(exported.fences.some(fence => fence.reason === "retention" && fence.observationIds.includes(row.observation.observationId)));
      assert.equal(exported.denominators.reduce((sum, denominator) => sum + denominator.eligible, 0), 8);
      assert.ok(exported.denominators.reduce((sum, denominator) => sum + denominator.removed, 0) >= 8);
      const second = await send(); await waitForChatTerminal(second.generation.id);
      const secondRow = readRecord<AdmissionRow>(N.admissions, second.generation.id)!;
      const retention = inspectThreadRetention(getDatabase(), threadId); assert.deepEqual(retention.blockers, []);
      getDatabase().exec("BEGIN IMMEDIATE");
      try { commitThreadRetention(getDatabase(), retention); getDatabase().exec("COMMIT"); } catch (error) { getDatabase().exec("ROLLBACK"); throw error; }
      assert.equal(readRecord(N.admissions, second.generation.id), null);
      exported = evaluationMetadataExportSchema.parse(await command("export"));
      assert.ok(exported.fences.some(fence => fence.reason === "deleted" && fence.observationIds.includes(secondRow.observation.observationId)));
      assert.equal(getThread(threadId)?.remoteId, threadId, "derived deletion does not delete its source facts");
    });
    await t.test("immutable preregistration rejects vacuous comparisons and records audited pause without deployment", async () => {
      const now = Date.now(), windowId = randomUUID();
      const input: EvaluationWindowInput = { windowId, policyId, baselineRelease: { artifactSha256: "a".repeat(64), sourceSha256: "b".repeat(64) },
        candidateRelease: { artifactSha256: "c".repeat(64), sourceSha256: "b".repeat(64) }, baseline: { startsAt: new Date(now - 10_000).toISOString(), endsAt: new Date(now).toISOString() },
        candidate: { startsAt: new Date(now + 60_000).toISOString(), endsAt: new Date(now + 120_000).toISOString() }, kinds: ["chat"], drivers: ["codex"], minimumEligiblePerCohort: 2,
        maximumFailureRateIncrease: 0, maximumUnknownRateIncrease: 0, maximumTrafficShareChange: 0, expiresAt: new Date(now + 180_000).toISOString(), releaseDecisionSha256: "d".repeat(64) };
      await command("window-create", input);
      await assert.rejects(command("window-create", input));
      const result = await service.summarizeEvaluationWindow(windowId, new Headers(headers));
      assert.equal(result.summary.status, "unknown"); assert.ok(result.summary.reasons.includes("window-not-closed"));
      assert.ok(result.summary.cohorts.every(cohort => !cohort.comparable));
      const before = nativeCalls, decisionId = randomUUID();
      await command("decision", { decisionId, windowId, action: "pause-sampling", reason: "insufficient-evidence", evidenceSha256: result.summarySha256,
        expiresAt: new Date(now + 150_000).toISOString(), confirmedNoDeployment: true });
      assert.equal(readRecord<PolicyRow>(N.policies, policyId)?.enabled, false); assert.equal(nativeCalls, before);
      const decisions = z.object({ decisions: z.array(z.object({ deploymentPerformed: z.boolean() }).loose()) }).loose().parse(await command("decisions"));
      assert.equal(decisions.decisions[0]!.deploymentPerformed, false);
    });
    await t.test("closed comparable cohorts report recurrence and drift without claiming a fix or deploying", async () => {
      const base = Date.now();
      t.mock.timers.enable({ apis: ["Date"], now: base });
      try {
        const current = readRecord<PolicyRow>(N.policies, policyId)!;
        await command("configure", { ...policy, expectedRevision: current.revision, randomProbability: 1 });
        const windowId = randomUUID();
        const input: EvaluationWindowInput = { windowId, policyId,
          baselineRelease: { artifactSha256: "a".repeat(64), sourceSha256: "b".repeat(64) }, candidateRelease: { artifactSha256: "c".repeat(64), sourceSha256: "b".repeat(64) },
          baseline: { startsAt: new Date(base).toISOString(), endsAt: new Date(base + 1_000).toISOString() },
          candidate: { startsAt: new Date(base + 2_000).toISOString(), endsAt: new Date(base + 3_000).toISOString() },
          kinds: ["chat"], drivers: ["codex"], minimumEligiblePerCohort: 2, maximumFailureRateIncrease: 0, maximumUnknownRateIncrease: 0,
          maximumTrafficShareChange: 0, expiresAt: new Date(base + 20_000).toISOString(), releaseDecisionSha256: "d".repeat(64) };
        await command("window-create", input);
        for (const outcome of ["complete", "failure"] as const) { mode = outcome; const value = await send(); await waitForChatTerminal(value.generation.id); }
        t.mock.timers.setTime(base + 2_100); process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "c".repeat(64);
        await command("configure", { ...policy, expectedRevision: readRecord<PolicyRow>(N.policies, policyId)!.revision, randomProbability: 1 });
        mode = "failure";
        for (let index = 0; index < 2; index++) { const value = await send(); await waitForChatTerminal(value.generation.id); }
        t.mock.timers.setTime(base + 4_000);
        const result = await service.summarizeEvaluationWindow(windowId, new Headers(headers));
        assert.equal(result.summary.status, "drift-observed", JSON.stringify(result.summary)); assert.equal(result.summary.cohorts[0]!.comparable, true);
        assert.equal(result.summary.cohorts[0]!.failureRateDifference, 0.5);
        assert.equal(result.summary.cohorts[0]!.recurrence[0]!.candidateOccurrences, 2);
        assert.equal(result.summary.cohorts[0]!.recurrence[0]!.rootCauseConfirmed, false);
        const before = nativeCalls;
        await command("decision", { decisionId: randomUUID(), windowId, action: "rollback-recommended", reason: "recurrence",
          evidenceSha256: result.summarySha256, expiresAt: new Date(base + 10_000).toISOString(), confirmedNoDeployment: true });
        assert.equal(nativeCalls, before); assert.equal(result.summary.deploymentPerformed, false);
      } finally { t.mock.timers.reset(); mode = "complete"; process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "a".repeat(64); }
    });
    await t.test("authorization awaits cannot mix pending observations with newer terminal denominators", async () => {
      const id = "snapshot-cohort", scoped = await scopedPolicy(id, { randomProbability: 0, failureProbability: 1, unknownProbability: 0 });
      const actorId = randomUUID(), workspaceId = randomUUID();
      const entered = Promise.withResolvers<void>(), permission = Promise.withResolvers<void>();
      let held = false;
      mode = "pending"; started = Promise.withResolvers<void>();
      const accepted = await send(id); await started.promise;
      const original = getChatGeneration(accepted.generation.id)!;
      writeRecord("chat:generations", original.id, { ...original, pmOperations: [{ actorId, target: { workspaceId, projectId: "PRJ-010" } }] });
      globalThis.fetch = async (input, init) => {
        if (!String(input instanceof Request ? input.url : input).startsWith("http://127.0.0.1:1/")) return originalFetch(input, init);
        if (!held && new Headers(init?.headers).get("authorization") === `Bearer ${pmToken}`) {
          held = true; entered.resolve(); await permission.promise;
        }
        return Response.json({ actorId, scope: z.object({ workspaceId: z.uuid(), projectId: z.string().nullable() }).parse(JSON.parse(String(init?.body))) });
      };
      const connection = await connectAgent();
      const auditsBefore = listRecords<{ action: string }>(N.audit).filter(row => row.action === "exported").length;
      try {
        const exporting = connection.request("/api/evaluation/export", { method: "POST" }, { origin: "http://127.0.0.1:1", headers: { authorization: `Bearer ${pmToken}` } });
        await entered.promise;
        mode = "failure"; assert.ok(releasePending); releasePending();
        assert.equal((await waitForChatTerminal(original.id)).status, "failed");
        permission.resolve();
        const response = await exporting;
        assert.equal(response.status, 409);
        assert.equal(z.object({ code: z.string() }).loose().parse(await response.json()).code, "evaluation_snapshot_changed");
        assert.equal(listRecords<{ action: string }>(N.audit).filter(row => row.action === "exported").length, auditsBefore);
        await stopChatRuntime();
        pmAuthorityEnabled = true;
        const refreshed = evaluationMetadataExportSchema.parse(await command("export", undefined, true));
        const observed = refreshed.observations.filter(row => row.policyId === scoped.policyId);
        const denominators = refreshed.denominators.filter(row => row.policyId === scoped.policyId);
        assert.equal(observed.length, 1, JSON.stringify({ coverage: refreshed.coverage, denominators })); assert.equal(observed[0]!.status, "failed"); assert.equal(observed[0]!.inclusionProbability, 1);
        assert.equal(denominators.reduce((sum, row) => sum + row.eligible, 0), 1);
        assert.equal(denominators.reduce((sum, row) => sum + row.failed, 0), 1);
        assert.equal(denominators.reduce((sum, row) => sum + row.pending, 0), 0);
      } finally {
        permission.resolve(); connection.close(); globalThis.fetch = originalFetch; pmAuthorityEnabled = false; mode = "complete";
        const current = getChatGeneration(original.id);
        if (current) { delete current.pmOperations; writeRecord("chat:generations", current.id, current); }
        await command("revoke", { policyId: scoped.policyId, expectedRevision: 1 });
      }
    });
    await t.test("a new window registered after baseline deletion keeps the removed denominator and remains unknown", async () => {
      const base = Date.now() + 10_000;
      t.mock.timers.enable({ apis: ["Date"], now: base });
      try {
        const id = "removed-baseline-cohort", scoped = await scopedPolicy(id), input = { ...windowInput(scoped.policyId, base), minimumEligiblePerCohort: 2 };
        const acceptedIds: string[] = [];
        for (const outcome of ["complete", "complete", "failure"] as const) {
          mode = outcome; const accepted = await send(id); await waitForChatTerminal(accepted.generation.id); acceptedIds.push(accepted.generation.id);
        }
        const removed = readRecord<AdmissionRow>(N.admissions, acceptedIds[2]!)!;
        t.mock.timers.setTime(base + 1_100);
        await command("delete", { observationIds: [removed.observation.observationId], reason: "deleted" });
        const registered = z.object({ invalidatedAt: z.string().nullable() }).loose().parse(await command("window-create", input));
        assert.notEqual(registered.invalidatedAt, null);
        t.mock.timers.setTime(base + 2_100); process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "c".repeat(64);
        await command("configure", { ...scoped, expectedRevision: 1 });
        mode = "complete";
        for (let index = 0; index < 2; index++) { const accepted = await send(id); await waitForChatTerminal(accepted.generation.id); }
        t.mock.timers.setTime(base + 4_000);
        const result = evaluationWindowSummaryEnvelopeSchema.parse(await command("window", input.windowId));
        assert.equal(result.summary.status, "unknown"); assert.ok(result.summary.reasons.includes("removed-observation-coverage"));
        assert.equal(result.summary.traffic.baselineEligible, 3);
        assert.equal(result.summary.cohorts[0]!.baseline.eligible, 3); assert.equal(result.summary.cohorts[0]!.baseline.removed, 1);
        assert.equal(result.summary.cohorts[0]!.baseline.completed, 2); assert.equal(result.summary.cohorts[0]!.failureRateDifference, null);
        assert.ok(result.summary.lineage.observationIds.includes(removed.observation.observationId));
        assert.equal(getChatGeneration(acceptedIds[2]!)?.status, "failed", "feedback deletion does not rewrite its execution fact");
      } finally { t.mock.timers.reset(); mode = "complete"; process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "a".repeat(64); }
    });
    await t.test("traffic threshold is an observed drift result independently of unchanged within-cohort outcomes", async () => {
      const base = Date.now() + 10_000;
      t.mock.timers.enable({ apis: ["Date"], now: base });
      try {
        const id = "traffic-mix-cohort", scoped = await scopedPolicy(id), input = windowInput(scoped.policyId, base);
        input.kinds = ["chat", "continuation"];
        await command("window-create", input); mode = "failure";
        let lastId = "";
        for (let index = 0; index < 3; index++) { const value = await send(id); await waitForChatTerminal(value.generation.id); lastId = value.generation.id; }
        const baselineContinuation = await continueChat(lastId, true, randomUUID()); await waitForChatTerminal(baselineContinuation.id);
        t.mock.timers.setTime(base + 2_100); process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "c".repeat(64);
        await command("configure", { ...scoped, expectedRevision: 1 });
        const initial = await send(id); await waitForChatTerminal(initial.generation.id); lastId = initial.generation.id;
        for (let index = 0; index < 3; index++) { const value = await continueChat(lastId, true, randomUUID()); await waitForChatTerminal(value.id); lastId = value.id; }
        t.mock.timers.setTime(base + 4_000);
        const result = evaluationWindowSummaryEnvelopeSchema.parse(await command("window", input.windowId));
        assert.equal(result.summary.status, "drift-observed", JSON.stringify(result.summary)); assert.equal(result.summary.traffic.compositionChanged, true);
        assert.deepEqual(result.summary.driftReasons, ["traffic-composition-drift"]);
        assert.ok(result.summary.cohorts.every(cohort => cohort.comparable && cohort.failureRateDifference === 0 && cohort.unknownRateDifference === 0));
      } finally { t.mock.timers.reset(); mode = "complete"; process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "a".repeat(64); }
    });
    await t.test("effective instruction changes bind private fingerprints and make cohorts incomparable without text export", async () => {
      const base = Date.now() + 10_000;
      t.mock.timers.enable({ apis: ["Date"], now: base });
      try {
        const id = "instruction-change-cohort", scoped = await scopedPolicy(id), input = windowInput(scoped.policyId, base);
        await command("window-create", input);
        const baseline = await send(id); await waitForChatTerminal(baseline.generation.id);
        t.mock.timers.setTime(base + 2_100); process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "c".repeat(64);
        const thread = getThread(id)!;
        updateThread(id, { settings: { ...thread.settings, systemPrompt: "sensitive changed instructions /private/config https://private.invalid/instructions" } });
        await command("configure", { ...scoped, expectedRevision: 1 });
        const candidate = await send(id); await waitForChatTerminal(candidate.generation.id);
        assert.equal(candidate.generation.providerInstanceRevision, baseline.generation.providerInstanceRevision,
          "Changing only the server-owned release label must not alter native Provider configuration; changed instructions remain independently incomparable.");
        t.mock.timers.setTime(base + 4_000);
        const result = evaluationWindowSummaryEnvelopeSchema.parse(await command("window", input.windowId));
        assert.equal(result.summary.status, "unknown"); assert.equal(result.summary.cohorts[0]!.comparable, false);
        assert.ok(result.summary.cohorts[0]!.reasons.includes("configuration-or-sampling-incomparable"));
        const exported = evaluationMetadataExportSchema.parse(await command("export"));
        const observed = exported.observations.filter(row => row.policyId === scoped.policyId);
        assert.equal(observed.length, 2); assert.ok(observed.every(row => row.configurationIdentity === "bound"));
        assert.notEqual(observed[0]!.configurationId, observed[1]!.configurationId);
        assert.doesNotMatch(JSON.stringify({ exported, result }), /sensitive changed instructions|sensitive system prompt|private\.invalid|\/private\//u);
        const saved = readRecord<AdmissionRow>(N.admissions, candidate.generation.id)!;
        // A lost host identity is not repaired from the current Session settings or guessed from a matching fingerprint.
        writeRecord(N.admissions, candidate.generation.id, { ...saved, observation: { ...saved.observation, configurationIdentity: "unavailable" } });
        const unknownIdentity = evaluationWindowSummaryEnvelopeSchema.parse(await command("window", input.windowId));
        assert.equal(unknownIdentity.summary.status, "unknown");
        assert.ok(unknownIdentity.summary.cohorts[0]!.reasons.includes("effective-configuration-unavailable"));
      } finally { t.mock.timers.reset(); mode = "complete"; process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "a".repeat(64); }
    });
    await t.test("variable-fraction ISO boundaries select instants with an exclusive end, not lexical strings", async () => {
      const base = Math.floor(Date.now() / 1_000) * 1_000 + 10_000;
      t.mock.timers.enable({ apis: ["Date"], now: base });
      try {
        const id = "fractional-time-cohort", scoped = await scopedPolicy(id), input = windowInput(scoped.policyId, base);
        for (const interval of [input.baseline, input.candidate]) {
          interval.startsAt = interval.startsAt.replace(".000Z", "Z"); interval.endsAt = interval.endsAt.replace(".000Z", "Z");
        }
        await command("window-create", input);
        t.mock.timers.setTime(base + 500); const inside = await send(id); await waitForChatTerminal(inside.generation.id);
        t.mock.timers.setTime(base + 1_500); const outside = await send(id); await waitForChatTerminal(outside.generation.id);
        t.mock.timers.setTime(base + 2_100); process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "c".repeat(64);
        await command("configure", { ...scoped, expectedRevision: 1 });
        t.mock.timers.setTime(base + 2_500); const candidate = await send(id); await waitForChatTerminal(candidate.generation.id);
        t.mock.timers.setTime(base + 4_000);
        const result = evaluationWindowSummaryEnvelopeSchema.parse(await command("window", input.windowId));
        assert.equal(result.summary.status, "no-drift-observed", JSON.stringify(result.summary));
        assert.equal(result.summary.traffic.baselineEligible, 1); assert.equal(result.summary.traffic.candidateEligible, 1);
        const excluded = readRecord<AdmissionRow>(N.admissions, outside.generation.id)!;
        assert.ok(!result.summary.lineage.observationIds.includes(excluded.observation.observationId));
      } finally { t.mock.timers.reset(); mode = "complete"; process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "a".repeat(64); }
    });
    await t.test("a failed observer write cannot change the accepted business result or trigger a retry", async () => {
      await command("configure", { ...policy, expectedRevision: readRecord<PolicyRow>(N.policies, policyId)!.revision, randomProbability: 1 });
      const beforeCalls = nativeCalls;
      getDatabase().exec(`CREATE TEMP TRIGGER reject_evaluation_observation BEFORE INSERT ON records
        WHEN NEW.namespace='evaluation:admissions:v1' BEGIN SELECT RAISE(ABORT, 'synthetic observer storage failure'); END`);
      let generationId: string;
      try {
        const value = await send(); generationId = value.generation.id;
        assert.equal((await waitForChatTerminal(generationId)).status, "completed");
      } finally { getDatabase().exec("DROP TRIGGER reject_evaluation_observation"); }
      assert.equal(nativeCalls, beforeCalls + 1); assert.equal(readRecord(N.admissions, generationId), null);
      const exported = evaluationMetadataExportSchema.parse(await command("export"));
      assert.equal(exported.coverage.status, "incomplete"); assert.ok(exported.coverage.observerErrors > 0);
    });
    await t.test("both portable backup and restore force policies OFF, strip observations and preserve epoch fences", async () => {
      const current = readRecord<PolicyRow>(N.policies, policyId)!;
      await command("configure", { ...policy, expectedRevision: current.revision, randomProbability: 1 });
      const accepted = await send(); await waitForChatTerminal(accepted.generation.id);
      const sourceIdentity = getStoreIdentity(getDatabase());
      await stopChatRuntime(); await stopPmProviderApplication(); closeStore();
      const bundle = path.join(root, "backup"), target = path.join(root, "restored");
      await createAgentBackup({ source: data, bundle, secrets: "exclude", stopped: true });
      const sourceDb = new DatabaseSync(path.join(data, "workspace.sqlite"), { readOnly: true });
      assert.ok(sourceDb.prepare("SELECT 1 FROM records WHERE namespace=?").get(N.admissions), "backup never deletes live source observations"); sourceDb.close();
      await restoreAgentBackup({ bundle, target, stopped: true });
      process.env.AGENT_WORKSPACE_DATA_DIR = target;
      assert.equal(listRecords(N.admissions).length, 0);
      assert.ok(listRecords<PolicyRow>(N.policies).every(value => !value.enabled && value.disabledReason === "restored"));
      assert.ok(listRecords<{ scope: string; storeId: string }>(N.fences).some(fence => fence.scope === "store-epoch" && fence.storeId === sourceIdentity.storeId));
      const identity = getStoreIdentity(getDatabase()); assert.notEqual(identity.storeId, sourceIdentity.storeId); assert.equal(identity.restoreEpoch, sourceIdentity.restoreEpoch + 1);
      assert.throws(() => service.pauseEvaluationPolicy({ policyId, expectedRevision: -1 }));
      await assert.rejects(service.configureEvaluationPolicy({ ...policy, expectedRevision: readRecord<PolicyRow>(N.policies, policyId)!.revision }, new Headers(headers)));
      const countBefore = listRecords(N.fences).length;
      getDatabase().exec("BEGIN IMMEDIATE"); fenceEvaluationCopy(getDatabase(), sourceIdentity); getDatabase().exec("COMMIT");
      assert.equal(listRecords(N.fences).length, countBefore, "copy/restore fence is idempotent under historical coverage verification");
      assert.equal(preflightPersistence(getDatabase()).legacy, false);
      const manifest = z.object({ exclusions: z.array(z.string()) }).loose().parse(JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8")));
      assert.ok(manifest.exclusions.some(value => value.includes("evaluation observations")));
    });
    await t.test("an existing legacy Store is refused without any silent migration or business rewrite", async () => {
      const currentData = process.env.AGENT_WORKSPACE_DATA_DIR;
      closeStore();
      const legacy = path.join(root, "legacy"); await mkdir(legacy, { mode: 0o700 });
      const filename = path.join(legacy, "workspace.sqlite"), db = new DatabaseSync(filename);
      db.exec(`CREATE TABLE records(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key));
        CREATE TABLE run_events(run_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(run_id,seq));
        CREATE TABLE worker_owner(singleton INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL);
        INSERT INTO records VALUES('chat:threads','legacy-source','{}');`);
      db.close();
      process.env.AGENT_WORKSPACE_DATA_DIR = legacy;
      try {
        assert.throws(() => getDatabase(), /Legacy Agent Store requires/u);
        const unchanged = new DatabaseSync(filename, { readOnly: true });
        try {
          assert.equal(unchanged.prepare("SELECT count(*) AS count FROM records").get()!.count, 1);
          assert.equal(unchanged.prepare("SELECT 1 FROM records WHERE namespace='agent:persistence:v1'").get(), undefined);
          assert.equal(unchanged.prepare("SELECT 1 FROM worker_owner").get(), undefined);
        } finally { unchanged.close(); }
      } finally {
        if (currentData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = currentData;
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    await stopChatRuntime(); await stopPmProviderApplication(); service.stopEvaluationMaintenance();
    await agentLogout().catch(() => undefined); closeStore();
    codexAdapter.check = originalCheck; codexAdapter.run = originalRun;
    const closed = once(server, "close"); server.closeAllConnections(); server.close(); await closed;
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    await rm(root, { recursive: true, force: true });
  }
});

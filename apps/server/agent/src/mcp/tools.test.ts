import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStore, listRecords, readRecord, writeRecord } from "../durable/store.ts";
import { ensureThread, getThread, listThreads, updateThread } from "../durable/threads.ts";
import { pmToolRoutes } from "../pm-tools.ts";
import { invokeMcpTool, listMcpTools } from "./tools.ts";
import { grantIdentity, MCP_EXECUTION_ROOTS, MCP_GRANTS, putGrant, reserveMcpExecutionRoot, type Grant, type McpExecutionRoot } from "./grants.ts";
import { verifyMcpServiceBearer } from "../../../../../packages/infrastructure/src/mcp-service-auth.ts";
import { createProviderInstance, recordProviderObservations } from "../providers/instances.ts";
import { chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";
import type { PmToolCallProjection, PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";

// Real service/SQLite/HTTP boundaries, without a paid model or production PM database.
test("MCP scope, readonly, atomic creation, receipt identity and revoked delayed approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-tools-authority-"));
  const previous = { data: process.env.AGENT_WORKSPACE_DATA_DIR, pm: process.env.PM_API_URL, origin: process.env.MCP_PUBLIC_ORIGIN, secret: process.env.PM_AUTOMATION_SERVICE_SECRET, approval: process.env.AGENT_APPROVAL_MODE };
  process.env.AGENT_APPROVAL_MODE = "ask";
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.MCP_PUBLIC_ORIGIN = "https://fixture.invalid";
  process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-boundary-test-secret-32-bytes";
  const workspaceId = randomUUID(), actorId = randomUUID(), grantedThread = randomUUID(), unrelatedThread = randomUUID();
  const scope = { workspaceId, projectId: "PRJ-001" };
  const fileArea = { path: null, status: "unconfigured", revision: 0, source: null, canManage: false };
  let calls = 0, resolves = 0, proofQueries = 0, forwardedActor: string | undefined, browserActor = actorId;
  let loseNextReply = false, resultsUnavailable = false, payloadAllowed = true;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/auth/me") { response.end(JSON.stringify({ actor: { id: browserActor } })); return; }
    if (request.url === "/api/v1/agent-contexts") { response.end(JSON.stringify({ workspaces: [{ id: workspaceId, name: "Fixture", fileArea, projects: [{ id: "PRJ-001", name: "Granted", fileArea }] }] })); return; }
    if (request.url?.includes("resolve")) { resolves++; response.writeHead(500).end(); return; }
    if (request.method === "GET") { response.end(JSON.stringify({ tools: [
      { name: "pm_query", write: false, inputSchema: { type: "object", properties: { target: { type: "object" }, arguments: { type: "object" } }, required: ["target", "arguments"] } },
      { name: "pm_delete_task", write: true, inputSchema: { type: "object", properties: { target: { type: "object" }, arguments: { type: "object" } }, required: ["target", "arguments"] } },
    ] })); return; }
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as Record<string, unknown>;
    if (request.url === "/api/v1/internal/agent-tools/reconcile") {
      proofQueries++;
      response.end(JSON.stringify({ ...input, status: "unknown", evidence: "unresolved", commandIds: [] })); return;
    }
    if (request.url === "/api/v1/agent-contexts/authorize") {
      if (!payloadAllowed) { response.writeHead(403).end(JSON.stringify({ error: "Current target is unavailable" })); return; }
      response.end(JSON.stringify({ actorId, scope: input })); return;
    }
    if (request.url?.endsWith("/call")) {
      calls++;
      if (loseNextReply) { loseNextReply = false; request.socket.destroy(); return; }
    }
    if (request.url?.endsWith("/result") && resultsUnavailable) { response.writeHead(503).end(JSON.stringify({ error: "Result transport unavailable" })); return; }
    forwardedActor = verifyMcpServiceBearer((request.headers.authorization ?? "").slice(7))?.actorId;
    response.end(JSON.stringify({ operationId: input.operationId, name: input.name, target: input.target, actorId, linkage: input.linkage, status: "succeeded", result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] }, error: null, threadId: input.threadId, messageId: input.messageId, generationId: input.generationId, workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string"); process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const grant: Grant = { grantId: randomUUID(), actorId, scope, access: "full", threadIds: [grantedThread], version: 1, clientHash: "fixture", clientName: "Fixture", audience: "https://fixture.invalid/mcp", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null };
  try {
    ensureThread(grantedThread, "Granted"); ensureThread(unrelatedThread, "Private"); putGrant(grant);
    const identity = grantIdentity(grant);
    const listed = await invokeMcpTool(identity, "t3_thread_list", {}) as { threads: { remoteId: string }[] };
    assert.deepEqual(listed.threads.map(thread => thread.remoteId), [grantedThread]);
    await assert.rejects(invokeMcpTool(identity, "t3_thread_read", { threadId: unrelatedThread }), /not explicitly granted/);
    const beforeCreation = listThreads().length;
    const created = await invokeMcpTool(identity, "t3_thread_launch", { clientRequestId: "create-once", title: "Client thread" }) as { thread: { remoteId: string } };
    assert.deepEqual(getThread(created.thread.remoteId)?.executionSelection, chatOnlyExecutionSelection());
    assert.ok(readRecord<Grant>(MCP_GRANTS, grant.grantId)?.threadIds.includes(created.thread.remoteId));
    const replay = await invokeMcpTool(identity, "t3_thread_launch", { clientRequestId: "create-once", title: "Client thread" }) as { thread: { remoteId: string; executionSelection: unknown } };
    assert.equal(replay.thread.remoteId, created.thread.remoteId);
    assert.deepEqual(replay.thread.executionSelection, chatOnlyExecutionSelection());
    assert.equal(listThreads().length, beforeCreation + 1, "replay does not create another thread");
    await assert.rejects(invokeMcpTool(identity, "t3_thread_launch", { clientRequestId: "create-once", title: "Changed" }), /different arguments/);
    await assert.rejects(invokeMcpTool(identity, "t3_thread_launch", { clientRequestId: "forged-directory", title: "Denied",
      executionSelection: { version: 2, agentWorkspaceId: "directory-id", agentWorkspaceRevision: 1 } }), /no Agent directory access/);
    const provider = createProviderInstance({
      instanceId: "mcp-authority-fixture", driver: "codex", label: "MCP authority fixture", enabled: true,
      config: { binaryPath: join(directory, "unavailable-native-cli"), homePath: join(directory, "native-home") },
      environment: [{ name: "HOME", value: directory, sensitive: false }, { name: "USERPROFILE", value: directory, sensitive: false }],
    });
    assert.ok(provider);
    recordProviderObservations(provider.instanceId, provider.revision, { discoveredModels: [{ id: "fixture-native-model", label: "Fixture native model", temperature: false }] });
    const selected = await invokeMcpTool(identity, "t3_thread_launch", { clientRequestId: "selected-thread", title: "Ready for send", providerInstanceId: provider.instanceId, modelId: "fixture-native-model" }) as { thread: { remoteId: string } };
    assert.equal(getThread(selected.thread.remoteId)?.settings.providerInstanceId, provider.instanceId);
    assert.equal(getThread(selected.thread.remoteId)?.settings.model, "fixture-native-model");
    assert.equal(getThread(selected.thread.remoteId)?.revision, 1, "explicit selection is persisted before submitChat's runnable-thread check");
    await assert.rejects(invokeMcpTool(identity, "t3_thread_launch", { clientRequestId: "invalid-selection", title: "Rejected", providerInstanceId: provider.instanceId, modelId: "missing-model" }), /模型/);
    const before = listThreads().length;
    const fullGrant: Grant = { ...grant, grantId: randomUUID(), threadIds: Array.from({ length: 1000 }, (_, index) => `reserved-${index}`) };
    putGrant(fullGrant);
    await assert.rejects(invokeMcpTool(grantIdentity(fullGrant), "t3_thread_launch", { clientRequestId: "no-orphan", title: "Must roll back" }), /limit/);
    assert.equal(listThreads().length, before, "grant failure rolls back thread creation and receipt atomically");
    const readonlyGrant: Grant = { ...grant, grantId: randomUUID(), access: "read-only" }; putGrant(readonlyGrant);
    const readonly = grantIdentity(readonlyGrant);
    const tools = await listMcpTools(readonly);
    assert.ok(tools.some(tool => tool.name === "pm_query")); assert.ok(!tools.some(tool => tool.name === "pm_delete_task" || tool.name === "t3_thread_send"));
    assert.equal(tools.filter(tool => tool.name === "pm_get_operation_result").length, 1);
    const querySchema = tools.find(tool => tool.name === "pm_query")!.inputSchema;
    assert.ok(!(querySchema.required as string[]).includes("threadId"));
    assert.ok((querySchema.required as string[]).includes("operationId"));
    assert.ok(!("threadId" in (querySchema.properties as Record<string, unknown>)));
    for (const name of ["t3_thread_launch", "t3_thread_send", "t3_thread_interrupt"]) await assert.rejects(invokeMcpTool(readonly, name, {}), /Read-only/);
    await assert.rejects(invokeMcpTool(readonly, "pm_delete_task", { operationId: randomUUID(), arguments: {} }), /Read-only/);
    assert.equal(listThreads().length, before); assert.equal(resolves, 0); assert.equal(calls, 0);
    const operationId = randomUUID(), input = { operationId, target: scope, arguments: { id: "TASK-001", revision: 3 } };
    const pending = await invokeMcpTool(identity, "pm_delete_task", input) as { status: string };
    assert.equal(pending.status, "pending_approval"); assert.equal(calls, 0);
    await assert.rejects(invokeMcpTool(identity, "pm_delete_task", { ...input, arguments: { id: "TASK-002", revision: 3 } }), /another request/);
    await assert.rejects(invokeMcpTool(identity, "pm_delete_task", { ...input, operationId: randomUUID(), target: { ...scope, projectId: "PRJ-002" } }), /ceiling/);
    browserActor = randomUUID();
    assert.equal((await pmToolRoutes.request(`/pm-tools/calls/${operationId}/approve`, { method: "POST", headers: { cookie: "pm_v4_session=fixture" } })).status, 403);
    browserActor = actorId;
    writeRecord(MCP_GRANTS, grant.grantId, { ...readRecord<Grant>(MCP_GRANTS, grant.grantId)!, revokedAt: new Date().toISOString(), version: 2 });
    const denied = await pmToolRoutes.request(`/pm-tools/calls/${operationId}/approve`, { method: "POST", headers: { cookie: "pm_v4_session=fixture" } });
    assert.equal(denied.status, 401); assert.equal(calls, 0);
    // A different live grant cannot adopt the old operation receipt.
    const replacement = { ...grant, grantId: randomUUID(), threadIds: [] }; putGrant(replacement);
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "pm_delete_task", input), /unavailable/);
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "pm_get_operation_result", { operationId }), /unavailable/);
    const next = { ...input, operationId: randomUUID() };
    await invokeMcpTool(grantIdentity(replacement), "pm_delete_task", next);
    const approved = await pmToolRoutes.request(`/pm-tools/calls/${next.operationId}/approve`, { method: "POST", headers: { cookie: "pm_v4_session=fixture" } });
    assert.equal(approved.status, 200); assert.equal(calls, 1); assert.equal(forwardedActor, actorId);
    assert.equal((await pmToolRoutes.request(`/pm-tools/calls/${next.operationId}/approve`, { method: "POST", headers: { cookie: "pm_v4_session=fixture" } })).status, 409); assert.equal(calls, 1);
    loseNextReply = true; resultsUnavailable = true;
    const unknownInput = { operationId: randomUUID(), target: scope, arguments: { query: "fixture" } };
    const unresolved = await invokeMcpTool(grantIdentity(replacement), "pm_query", unknownInput) as PmToolCallRecord;
    assert.equal(unresolved.status, "unknown");
    assert.equal(unresolved.threadId, ""); assert.equal(unresolved.messageId, ""); assert.equal(unresolved.generationId, "");
    assert.equal(unresolved.linkage?.executionRoot, "external");
    assert.equal(unresolved.linkage?.clientKind, "mcp");
    const root = readRecord<McpExecutionRoot>(MCP_EXECUTION_ROOTS, unknownInput.operationId)!;
    assert.equal(unresolved.linkage?.traceId, root.traceId);
    assert.equal(unresolved.linkage?.executionGrantId, root.executionId);
    assert.equal(listThreads().length, before, "PM-only execution never creates a directory or Chat Session");
    assert.equal(listRecords("chat:generations").length, 0, "external roots never fabricate ChatGenerations");
    assert.equal(calls, 2);
    const stillUnknown = await invokeMcpTool(grantIdentity(replacement), "pm_get_operation_result", { operationId: unknownInput.operationId }) as PmToolCallRecord;
    assert.equal(stillUnknown.status, "unknown"); assert.equal(calls, 2);
    resultsUnavailable = false;
    const recovered = await invokeMcpTool(grantIdentity(replacement), "pm_get_operation_result", { operationId: unknownInput.operationId }) as PmToolCallRecord;
    assert.equal(recovered.status, "succeeded");
    assert.equal(recovered.linkage?.traceId, root.traceId);
    assert.ok(proofQueries > 0);
    assert.equal((await invokeMcpTool(grantIdentity(replacement), "pm_query", unknownInput) as PmToolCallRecord).status, "succeeded");
    assert.equal(calls, 2, "business retries and explicit result queries only reconcile, never redispatch");
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "pm_query", { ...unknownInput, arguments: { query: "altered" } }), /another request/);
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "pm_get_operation_result", { operationId: unknownInput.operationId, threadId: grantedThread }));
    const orphanInput = { operationId: randomUUID(), name: "pm_query", target: scope, arguments: { query: "reserved before interruption" } };
    reserveMcpExecutionRoot(grantIdentity(replacement), orphanInput);
    const orphan = await invokeMcpTool(grantIdentity(replacement), "pm_get_operation_result", { operationId: orphanInput.operationId }) as PmToolCallProjection;
    assert.equal(orphan.visibility, "unavailable");
    const { name: orphanName, ...orphanArguments } = orphanInput;
    assert.equal((await invokeMcpTool(grantIdentity(replacement), orphanName, orphanArguments) as PmToolCallProjection).visibility, "unavailable");
    assert.equal(calls, 2, "a surviving root without a PM call record is never blindly dispatched");
    payloadAllowed = false;
    const hidden = await invokeMcpTool(grantIdentity(replacement), "pm_get_operation_result", { operationId: unknownInput.operationId }) as PmToolCallProjection;
    assert.deepEqual(hidden, { operationId: unknownInput.operationId, threadId: "", messageId: "", generationId: "", visibility: "redacted" });
    assert.equal(readRecord<{ record: PmToolCallRecord }>("pm-tool-calls", unknownInput.operationId)?.record.status, "succeeded", "read withdrawal never changes business certainty");
    payloadAllowed = true;
    const chatGrant = { ...replacement, grantId: randomUUID(), threadIds: [grantedThread] }; putGrant(chatGrant);
    const discovered = await invokeMcpTool(grantIdentity(replacement), "pm_list_workspaces", { operationId: randomUUID(), arguments: {} }) as PmToolCallRecord;
    assert.equal(discovered.result?.kind, "workspaces", "PM-only discovery remains the sole targetless capability");
    assert.equal(discovered.linkage?.executionRoot, "external");
    const readonlyInput = { operationId: randomUUID(), target: scope, arguments: { query: "read-only" } };
    const readonlyResult = await invokeMcpTool(readonly, "pm_query", readonlyInput) as PmToolCallRecord;
    assert.equal(readonlyResult.status, "succeeded");
    assert.equal(readRecord<Grant>(MCP_GRANTS, readonly.grantId)?.access, "read-only", "audit full policy does not upgrade an existing OAuth delegation");
    const updatedReplacement = { ...replacement, threadIds: [grantedThread] };
    writeRecord(MCP_GRANTS, replacement.grantId, updatedReplacement);
    assert.equal((await invokeMcpTool(grantIdentity(updatedReplacement), "pm_get_operation_result", { operationId: unknownInput.operationId }) as PmToolCallRecord).status, "succeeded", "adding separate Chat access does not change immutable PM operation ownership");
    writeRecord(MCP_GRANTS, readonly.grantId, { ...readonlyGrant, revokedAt: new Date().toISOString(), version: 2 });
    await assert.rejects(invokeMcpTool(readonly, "pm_get_operation_result", { operationId: readonlyInput.operationId }), /expired|revoked|unavailable/);
    const privateMarker = "PRIVATE-PM-CACHED-ACCEPTANCE";
    const cachedSend = { threadId: grantedThread, clientRequestId: "cached-acceptance", text: "original user turn" };
    const cachedKey = JSON.stringify([chatGrant.grantId, "t3_thread_send", cachedSend.clientRequestId]);
    const cachedGeneration = { id: randomUUID(), threadId: grantedThread, messageId: randomUUID(), status: "succeeded",
      createdAt: new Date().toISOString(), request: { idempotencyKey: cachedKey }, pmOperations: [{ actorId, target: scope }],
      pmReferences: [{ ...scope, title: privateMarker }], turnContext: { secret: privateMarker } };
    writeRecord("chat:generations", cachedGeneration.id, cachedGeneration);
    const originalAcceptance = { status: "accepted", generation: cachedGeneration };
    writeRecord("mcp:tool-receipts", cachedKey, { fingerprint: createHash("sha256").update(JSON.stringify(cachedSend)).digest("hex"),
      status: "succeeded", generationId: cachedGeneration.id, result: originalAcceptance });
    updateThread(grantedThread, { revision: getThread(grantedThread)!.revision, title: privateMarker, custom: { summary: privateMarker } });
    payloadAllowed = false;
    const cachedProjection = await invokeMcpTool(grantIdentity(chatGrant), "t3_thread_send", cachedSend);
    assert.doesNotMatch(JSON.stringify(cachedProjection), new RegExp(privateMarker), "cached acceptance metadata is reprojected under current PM access");
    assert.deepEqual(readRecord<{ result: unknown }>("mcp:tool-receipts", cachedKey)?.result, originalAcceptance, "read redaction never overwrites the private original acceptance");
    const hiddenThreads = await invokeMcpTool(grantIdentity(chatGrant), "t3_thread_list", {});
    const hiddenThread = await invokeMcpTool(grantIdentity(chatGrant), "t3_thread_read", { threadId: grantedThread });
    assert.doesNotMatch(JSON.stringify([hiddenThreads, hiddenThread]), new RegExp(privateMarker), "thread titles/custom cannot bypass history redaction");
    const recoveringSend = { threadId: grantedThread, clientRequestId: "accepted-before-receipt", text: "second original turn" };
    const recoveringKey = JSON.stringify([chatGrant.grantId, "t3_thread_send", recoveringSend.clientRequestId]);
    const recoveringGeneration = { ...cachedGeneration, id: randomUUID(), request: { idempotencyKey: recoveringKey } };
    writeRecord("chat:generations", recoveringGeneration.id, recoveringGeneration);
    writeRecord("mcp:tool-receipts", recoveringKey, { fingerprint: createHash("sha256").update(JSON.stringify(recoveringSend)).digest("hex"), status: "running" });
    const recoveredAcceptance = await invokeMcpTool(grantIdentity(chatGrant), "t3_thread_send", recoveringSend);
    assert.doesNotMatch(JSON.stringify(recoveredAcceptance), new RegExp(privateMarker), "interrupted acceptance recovery projects the original generation before returning");
    assert.match(JSON.stringify(readRecord("mcp:tool-receipts", recoveringKey)), new RegExp(privateMarker), "new receipt publication stores the original, not its request-specific redaction");
    payloadAllowed = true;
    writeRecord("chat:generations", "cross-project-evidence", { threadId: grantedThread,
      pmOperations: [{ actorId, target: { ...scope, projectId: "PRJ-002" } }] });
    await assert.rejects(invokeMcpTool(grantIdentity(chatGrant), "t3_thread_read", { threadId: grantedThread }), /history exceeds/);
    writeRecord(MCP_GRANTS, replacement.grantId, { ...replacement, expiresAt: new Date(0).toISOString() });
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "t3_thread_list", {}), /expired|revoked|unavailable/);
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "pm_get_operation_result", { operationId: unknownInput.operationId }), /expired|revoked|unavailable/);
  } finally {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise; closeStore();
    for (const [key, value] of [["AGENT_WORKSPACE_DATA_DIR", previous.data], ["PM_API_URL", previous.pm], ["MCP_PUBLIC_ORIGIN", previous.origin], ["PM_AUTOMATION_SERVICE_SECRET", previous.secret], ["AGENT_APPROVAL_MODE", previous.approval]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStore, readRecord, writeRecord } from "../durable/store.ts";
import { ensureThread, getThread, listThreads } from "../durable/threads.ts";
import { pmToolRoutes } from "../pm-tools.ts";
import { invokeMcpTool, listMcpTools } from "./tools.ts";
import { grantIdentity, MCP_GRANTS, putGrant, type Grant } from "./grants.ts";
import { verifyMcpServiceBearer } from "../../../../../packages/infrastructure/src/mcp-service-auth.ts";
import { listStoredInstances, recordProviderObservations } from "../providers/instances.ts";
import { chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";

// Real service/SQLite/HTTP boundaries, without a paid model or production PM database.
test("MCP scope, readonly, atomic creation, receipt identity and revoked delayed approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-tools-authority-"));
  const previous = { data: process.env.AGENT_WORKSPACE_DATA_DIR, pm: process.env.PM_API_URL, origin: process.env.MCP_PUBLIC_ORIGIN, secret: process.env.PM_AUTOMATION_SERVICE_SECRET };
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.MCP_PUBLIC_ORIGIN = "https://fixture.invalid";
  process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-boundary-test-secret-32-bytes";
  const workspaceId = randomUUID(), actorId = randomUUID(), grantedThread = randomUUID(), unrelatedThread = randomUUID();
  const scope = { workspaceId, projectId: "PRJ-001" };
  const fileArea = { path: null, status: "unconfigured", revision: 0, source: null, canManage: false };
  let calls = 0, resolves = 0, forwardedActor: string | undefined, browserActor = actorId;
  let loseNextReply = false;
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
    if (request.url === "/api/v1/agent-contexts/authorize") {
      response.end(JSON.stringify({ actorId, scope: input })); return;
    }
    if (request.url?.endsWith("/call")) {
      calls++;
      if (loseNextReply) { loseNextReply = false; request.socket.destroy(); return; }
    }
    forwardedActor = verifyMcpServiceBearer((request.headers.authorization ?? "").slice(7))?.actorId;
    response.end(JSON.stringify({ operationId: input.operationId, name: input.name, target: input.target, actorId, status: "succeeded", result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] }, error: null, threadId: input.threadId, messageId: input.messageId, generationId: input.generationId, workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
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
    const provider = listStoredInstances().find(instance => instance.driver === "codex")!;
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
    for (const name of ["t3_thread_launch", "t3_thread_send", "t3_thread_interrupt"]) await assert.rejects(invokeMcpTool(readonly, name, {}), /Read-only/);
    await assert.rejects(invokeMcpTool(readonly, "pm_delete_task", { threadId: grantedThread, operationId: randomUUID(), arguments: {} }), /Read-only/);
    assert.equal(listThreads().length, before); assert.equal(resolves, 0); assert.equal(calls, 0);
    const operationId = randomUUID(), input = { threadId: grantedThread, operationId, target: scope, arguments: { id: "TASK-001", revision: 3 } };
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
    const replacement = { ...grant, grantId: randomUUID() }; putGrant(replacement);
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "pm_delete_task", input), /another request/);
    const next = { ...input, operationId: randomUUID() };
    await invokeMcpTool(grantIdentity(replacement), "pm_delete_task", next);
    const approved = await pmToolRoutes.request(`/pm-tools/calls/${next.operationId}/approve`, { method: "POST", headers: { cookie: "pm_v4_session=fixture" } });
    assert.equal(approved.status, 200); assert.equal(calls, 1); assert.equal(forwardedActor, actorId);
    assert.equal((await pmToolRoutes.request(`/pm-tools/calls/${next.operationId}/approve`, { method: "POST", headers: { cookie: "pm_v4_session=fixture" } })).status, 409); assert.equal(calls, 1);
    loseNextReply = true;
    const unknownInput = { threadId: grantedThread, operationId: randomUUID(), target: scope, arguments: { query: "fixture" } };
    assert.equal((await invokeMcpTool(grantIdentity(replacement), "pm_query", unknownInput) as { status: string }).status, "unknown");
    assert.equal(calls, 2);
    assert.equal((await invokeMcpTool(grantIdentity(replacement), "pm_query", unknownInput) as { status: string }).status, "succeeded");
    assert.equal(calls, 2, "unknown retries only reconcile the original operation, never redispatch");
    writeRecord("chat:generations", "cross-project-evidence", { threadId: grantedThread,
      pmOperations: [{ actorId, target: { ...scope, projectId: "PRJ-002" } }] });
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "t3_thread_read", { threadId: grantedThread }), /history exceeds/);
    writeRecord(MCP_GRANTS, replacement.grantId, { ...replacement, expiresAt: new Date(0).toISOString() });
    await assert.rejects(invokeMcpTool(grantIdentity(replacement), "t3_thread_list", {}), /expired|revoked|unavailable/);
  } finally {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise; closeStore();
    for (const [key, value] of [["AGENT_WORKSPACE_DATA_DIR", previous.data], ["PM_API_URL", previous.pm], ["MCP_PUBLIC_ORIGIN", previous.origin], ["PM_AUTOMATION_SERVICE_SECRET", previous.secret]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

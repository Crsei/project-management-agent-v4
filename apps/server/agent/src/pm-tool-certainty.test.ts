import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { callPmTool, interruptPmToolCalls, pmToolRoutes, type StoredPmToolCall } from "./pm-tools.ts";
import { closeStore, readRecord, writeRecord } from "./durable/store.ts";
import { ensureThread } from "./durable/threads.ts";
import { endNativeOutput, getNativeOutput, initializeNativeOutput, updatePmNativeOutput } from "./durable/native-output.ts";
import { pmOutcomeFromToolOutput } from "./pm-outcomes.ts";
import { verifyPmToolReconcileBearer } from "../../../../packages/infrastructure/src/pm-tool-service-auth.ts";

// Real local HTTP transport, private disposable Agent store, no PM business data or provider account.
test("post-send HTTP errors, invalid replies and restart remain unknown; only original proof settles once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-certainty-"));
  const old = { data: process.env.AGENT_WORKSPACE_DATA_DIR, url: process.env.PM_API_URL, secret: process.env.PM_AUTOMATION_SERVICE_SECRET };
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-pm-proof-fixture-not-a-credential";
  const actorId = randomUUID(), workspaceId = randomUUID(), generationId = randomUUID(), threadId = "certainty";
  const target = { workspaceId, projectId: "PRJ-001" };
  let denial = 0, malformed = false, mismatch = false, forbidden = false, proof = false, calls = 0, proofQueries = 0, currentActor = actorId, pauseProof = false;
  const proofReached = Promise.withResolvers<void>(), proofRelease = Promise.withResolvers<void>();
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += String(chunk);
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/internal/agent-tools/reconcile") {
      const token = req.headers.authorization?.slice(7) ?? "";
      assert.ok(verifyPmToolReconcileBearer(token, "POST", req.url, body));
      proofQueries++;
      if (pauseProof) { pauseProof = false; proofReached.resolve(); await proofRelease.promise; }
      res.end(JSON.stringify({ ...body, status: proof ? "succeeded" : "unknown", evidence: proof ? "operation" : "unresolved", commandIds: proof ? ["a".repeat(64)] : [] })); return;
    }
    if (req.url === "/api/v1/agent-contexts/authorize") {
      if (forbidden) { res.writeHead(403).end(JSON.stringify({ error: "sensitive denial details" })); return; }
      res.end(JSON.stringify({ actorId: currentActor, scope: body })); return;
    }
    if (req.url?.endsWith("/result")) { res.writeHead(403).end(JSON.stringify({ error: "committed business body is hidden" })); return; }
    calls++;
    if (denial) { res.writeHead(denial).end(JSON.stringify({ error: "sensitive post-send denial" })); return; }
    if (malformed) { res.end("not JSON"); return; }
    res.end(JSON.stringify({ ...body, operationId: mismatch ? randomUUID() : body.operationId, workspaceId, actorId,
      status: "succeeded", result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] }, error: null,
      createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  ensureThread(threadId); initializeNativeOutput(generationId, threadId, "running");
  const context = { threadId, generationId, messageId: "assistant", headers: new Headers(), authorizeExecution: async () => {} };
  try {
    for (const status of [401, 403, 404, 409, 429, 500]) {
      denial = status;
      const record = await callPmTool(context, { operationId: randomUUID(), name: "pm_create_task", target, arguments: { title: "once" } });
      assert.equal(record.status, "unknown"); assert.deepEqual(record.certainty, { dispatch: "possibly_sent", evidence: "unresolved" });
      assert.doesNotMatch(JSON.stringify(record), /sensitive post-send denial/);
      const native = getNativeOutput(generationId)!.items.find(item => item.id === `pm-tool:${record.operationId}`)!;
      assert.equal(native.status, "unknown"); assert.equal(native.completedAt, undefined);
    }
    denial = 0;
    for (const mode of ["malformed", "mismatch"] as const) {
      malformed = mode === "malformed"; mismatch = mode === "mismatch";
      assert.equal((await callPmTool(context, { operationId: randomUUID(), name: "pm_query", target, arguments: {} })).status, "unknown");
    }
    malformed = false; mismatch = false; denial = 403;
    const input = { operationId: randomUUID(), name: "pm_create_task", target, arguments: { title: "original" } };
    const unknown = await callPmTool(context, input); const writes = calls;
    assert.equal(unknown.status, "unknown");
    assert.equal((await callPmTool(context, input)).status, "unknown"); assert.equal(calls, writes, "same-key read must not redispatch");
    for (const changed of [{ ...input, arguments: { title: "different" } }, { ...input, target: { ...target, projectId: "PRJ-002" } }])
      await assert.rejects(callPmTool(context, changed), /another request/);
    const saved = readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!;
    saved.record = { ...saved.record, status: "running" }; writeRecord("pm-tool-calls", input.operationId, saved);
    closeStore(); interruptPmToolCalls();
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.record.status, "unknown");
    endNativeOutput(generationId, "cancelled");
    proof = true; forbidden = true;
    const result = await pmToolRoutes.request(`/pm-tools/calls/${input.operationId}/reconcile`, { method: "POST" });
    assert.equal(result.status, 200);
    const projected = await result.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(projected).sort(), ["generationId", "messageId", "operationId", "threadId", "visibility"]);
    assert.equal(projected.visibility, "redacted");
    const settled = readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.record;
    assert.equal(settled.status, "succeeded"); assert.equal(settled.result, null); assert.equal(calls, writes);
    const native = getNativeOutput(generationId)!.items.find(item => item.id === `pm-tool:${input.operationId}`)!;
    assert.equal(native.status, "completed", "proof updates the original ended generation");
    updatePmNativeOutput(generationId, { ...native, status: "unknown" });
    assert.equal(getNativeOutput(generationId)!.items.find(item => item.id === native.id)!.status, "completed");
    const beforeRead = proofQueries;
    const deniedRead = await pmToolRoutes.request(`/pm-tools/calls/${input.operationId}`);
    assert.equal((await deniedRead.json() as { visibility: string }).visibility, "redacted");
    forbidden = false; currentActor = randomUUID();
    const foreignRead = await pmToolRoutes.request(`/pm-tools/calls/${input.operationId}`);
    assert.equal((await foreignRead.json() as { visibility: string }).visibility, "redacted");
    assert.equal((await pmToolRoutes.request(`/pm-tools/calls/${randomUUID()}`)).status, 404);
    assert.equal(proofQueries, beforeRead, "reverse lookup cannot trigger reconciliation");
    assert.equal(calls, writes, "reverse lookup cannot execute");
    currentActor = actorId; forbidden = true;
    pauseProof = true;
    const delayed = pmToolRoutes.request(`/pm-tools/calls/${input.operationId}/reconcile`, { method: "POST" });
    await proofReached.promise;
    const hydrated = readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!;
    hydrated.record = { ...hydrated.record, certainty: { dispatch: "possibly_sent", evidence: "pm_result" },
      result: { kind: "task", items: [], sources: [], nextCursor: null, truncated: false, receipt: {
        kind: "core", operationId: input.operationId, commandId: "original-command", action: "CreateTask", targetId: "TASK-001", revision: "original-revision",
      } }, commandIds: ["original-command"] };
    writeRecord("pm-tool-calls", input.operationId, hydrated);
    proofRelease.resolve(); await delayed;
    const retained = readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.record;
    assert.equal(retained.result?.receipt?.revision, "original-revision", "a delayed minimal success proof cannot erase a hydrated original receipt");
    assert.ok(retained.commandIds?.includes("original-command"));
    proof = false;
    await pmToolRoutes.request(`/pm-tools/calls/${input.operationId}/reconcile`, { method: "POST" });
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.record.status, "succeeded");
    assert.equal(pmOutcomeFromToolOutput({ isError: true, structuredContent: unknown })?.status, "unknown");
  } finally {
    proofRelease.resolve();
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; closeStore();
    for (const [name, value] of [["AGENT_WORKSPACE_DATA_DIR", old.data], ["PM_API_URL", old.url], ["PM_AUTOMATION_SERVICE_SECRET", old.secret]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("definitive local denial after admission is not sent and legacy unproven failures are not trusted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-not-sent-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousUrl = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const actorId = randomUUID(), workspaceId = randomUUID(), target = { workspaceId, projectId: null };
  let authorizations = 0, dispatches = 0;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += String(chunk);
    if (req.url !== "/api/v1/agent-contexts/authorize") { dispatches++; res.writeHead(500).end(); return; }
    res.setHeader("content-type", "application/json");
    if (++authorizations === 2) { res.writeHead(403).end(JSON.stringify({ error: "revoked before send" })); return; }
    res.end(JSON.stringify({ actorId, scope: JSON.parse(text) }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string"); process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  try {
    const input = { operationId: randomUUID(), name: "pm_query", target, arguments: {} };
    const record = await callPmTool({ threadId: "denial", generationId: randomUUID(), messageId: "assistant", authorizeExecution: async () => {} }, input);
    assert.equal(record.status, "failed"); assert.deepEqual(record.certainty, { dispatch: "not_sent", evidence: "local_rejection" }); assert.equal(dispatches, 0);
    const stored = readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!;
    const legacy = { ...stored, record: { ...stored.record, operationId: randomUUID(), certainty: undefined } };
    writeRecord("pm-tool-calls", legacy.record.operationId, legacy);
    interruptPmToolCalls();
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", legacy.record.operationId)!.record.status, "unknown");
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.record.status, "failed");
  } finally {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousUrl;
    await rm(directory, { recursive: true, force: true });
  }
});

test("new full audit-only linkage stays observable and nonblocking without a service signing key", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-audit-only-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousUrl = process.env.PM_API_URL, previousSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  delete process.env.PM_AUTOMATION_SERVICE_SECRET;
  const actorId = randomUUID(), workspaceId = randomUUID(), target = { workspaceId, projectId: "PRJ-001" };
  let dispatches = 0;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>;
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/agent-contexts/authorize") { res.end(JSON.stringify({ actorId, scope: body })); return; }
    dispatches++;
    assert.equal(req.headers["x-pm-tool-linkage"], undefined);
    assert.equal(body.linkage, undefined, "the PM request hash describes the actual unsigned request, not an untrusted hint");
    res.end(JSON.stringify({ ...body, workspaceId, actorId, status: "succeeded", result: { kind: "query", items: [], nextCursor: null, truncated: false, sources: [] },
      error: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string"); process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  try {
    const context = { threadId: "audit-only", generationId: randomUUID(), messageId: "assistant", inputMessageId: "user",
      traceId: randomUUID(), executionGrantId: randomUUID(), authorizeExecution: async () => {} };
    const input = { operationId: randomUUID(), name: "pm_query", target, arguments: {} };
    const result = await callPmTool(context, input);
    assert.equal(result.status, "succeeded"); assert.equal(dispatches, 1);
    assert.equal(result.linkage?.policy, "full"); assert.equal(result.linkage?.enforcement, "audit-only");
    assert.equal(result.notices?.[0]?.code, "pm_linkage_unavailable");
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", input.operationId)!.request.linkage, undefined);
    assert.equal((await callPmTool(context, input)).status, "succeeded"); assert.equal(dispatches, 1);
  } finally {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; closeStore();
    for (const [name, value] of [["AGENT_WORKSPACE_DATA_DIR", previousData], ["PM_API_URL", previousUrl], ["PM_AUTOMATION_SERVICE_SECRET", previousSecret]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

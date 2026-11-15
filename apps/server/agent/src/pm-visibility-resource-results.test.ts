import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pmToolCallProjectionSchema, pmToolCallRecordSchema, type PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { pmToolRequestHash } from "../../../../packages/infrastructure/src/pm-tool-service-auth.ts";
import { closeStore, readRecord, writeRecord } from "./durable/store.ts";
import { ensureThread, type StoredMessage } from "./durable/threads.ts";
import { initializeNativeOutput } from "./durable/native-output.ts";
import { callPmTool, pmToolRoutes, type StoredPmToolCall } from "./pm-tools.ts";
import { createPmVisibilityProjector, pmPayloadTargets, recordPmContentProvenance, recordPmQuoteProvenance } from "./pm-visibility.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-resource-visibility-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousUrl = process.env.PM_API_URL, previousSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-resource-result-proof-not-a-credential";
  const actorId = randomUUID(), workspaceId = randomUUID(), generationId = randomUUID(), threadId = "resource-visibility", messageId = "assistant";
  const target = { workspaceId, projectId: "PRJ-001" };
  const context = { threadId, generationId, messageId, headers: new Headers({ cookie: "pm_v4_session=private-fixture" }),
    authorizeExecution: async () => { if (!state.live) throw new Error("Execution authorization was revoked"); } };
  const originals = new Map<string, { request: StoredPmToolCall["request"]; record: PmToolCallRecord }>();
  const state = { sourceAllowed: true, deliveryStatus: 200, lostResponse: false, proof: false, writes: 0, clock: "2026-11-13T00:00:00.000Z", substituteReceipt: false, resultMissing: false, live: true, stopAtResult: false };
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as StoredPmToolCall["request"];
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/agent-contexts/authorize") {
      response.end(JSON.stringify({ actorId, scope: input })); return;
    }
    if (request.url === "/api/v1/internal/agent-tools/reconcile") {
      if (!state.proof) { response.writeHead(404).end("{}"); return; }
      const proof = JSON.parse(text) as { operationId: string; requestHash: string; actorId: string; target: typeof target };
      const original = originals.get(proof.operationId);
      assert.ok(original);
      assert.equal(proof.requestHash, pmToolRequestHash(original.request, actorId));
      response.end(JSON.stringify({ ...proof, status: "succeeded", evidence: "application_receipt", commandIds: [original.record.result!.receipt!.commandId] })); return;
    }
    assert.equal(request.headers.cookie, "pm_v4_session=private-fixture");
    if (request.url?.endsWith("/call")) {
      if (input.name === "pm_save_external_file") state.writes++;
      const receipt = { kind: "application", operationId: input.operationId, commandId: `native-${input.operationId}`, action: "SaveExternalFile", targetId: null, revision: "file-revision" };
      const result = input.name === "pm_read_timer"
        ? { kind: "dashboard_timer", activeTimer: null, serverNow: state.clock, sources: [], nextCursor: null, truncated: false }
        : { kind: "external-file-operation", sourceId: "source-one", items: [{ operationId: input.operationId, action: "save", path: "private.md", status: "succeeded", content: { path: "private.md", content: "private-source-content", size: 22, modifiedAt: state.clock, sourceRevision: 1, revision: "file-revision", canWrite: true, contentOffset: 0, nextContentOffset: null } }], receipt, sources: [], nextCursor: null, truncated: false };
      const record = pmToolCallRecordSchema.parse({ operationId: input.operationId, name: input.name, threadId: input.threadId, messageId: input.messageId, generationId: input.generationId,
        target, workspaceId, actorId, result, status: "succeeded", error: null, certainty: { dispatch: "possibly_sent", evidence: "pm_result" }, createdAt: state.clock, finishedAt: state.clock });
      originals.set(input.operationId, { request: input, record });
      if (state.lostResponse) { request.socket.destroy(); return; }
      response.end(JSON.stringify(record)); return;
    }
    assert.ok(request.url?.endsWith("/result"), "projection must never invent another business endpoint");
    const original = originals.get(input.operationId);
    assert.ok(original);
    assert.deepEqual(input, original.request, "every delivery uses the immutable original operation and arguments");
    if (state.stopAtResult) state.live = false;
    if (!state.sourceAllowed && input.name === "pm_save_external_file") {
      response.writeHead(403).end(JSON.stringify({ code: "source_unlinked", message: "private-denial-detail" })); return;
    }
    if (state.deliveryStatus !== 200) { response.writeHead(state.deliveryStatus).end(JSON.stringify({ message: "private-error-detail" })); return; }
    const result = original.record.result;
    response.end(JSON.stringify({ ...original.record, result: state.resultMissing ? null : result?.kind === "dashboard_timer" ? { ...result, serverNow: state.clock }
      : state.substituteReceipt && result ? { ...result, items: [] } : result }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string"); process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  ensureThread(threadId, "Resource visibility"); initializeNativeOutput(generationId, threadId, "running");
  const input = { operationId: randomUUID(), name: "pm_save_external_file", target,
    arguments: { sourceId: "source-one", sourceRevision: 1, path: "private.md", expectedRevision: "before", content: "private-request-content" } };
  const close = async () => {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = previousSecret;
    await rm(directory, { recursive: true, force: true });
  };
  return { context, input, target, actorId, generationId, threadId, messageId, state, close };
}

test("source unlink hides stored write results, native output, model history, quotes and copied context despite surviving project access", async () => {
  const f = await fixture();
  try {
    const call = await callPmTool(f.context, f.input);
    assert.equal(call.status, "succeeded"); assert.equal(f.state.writes, 1);
    writeRecord("chat:generations", f.generationId, { id: f.generationId, threadId: f.threadId, messageId: f.messageId, pmOperations: [{ actorId: f.actorId, target: f.target }] });
    recordPmContentProvenance({ threadId: f.threadId, generationId: f.generationId, messageIds: [f.messageId], operationIds: [call.operationId], targets: [f.target] });
    const source: StoredMessage = { id: f.messageId, parent_id: null, format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "private-model-summary" }] } };
    const quote: StoredMessage = { id: "quote", parent_id: f.messageId, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "keep-user-question" }], metadata: { custom: { quote: { messageId: f.messageId, text: "private-model-summary" } } } } };
    writeRecord("chat:history", f.threadId, { threadId: f.threadId, messages: [source, quote] });
    recordPmQuoteProvenance({ threadId: f.threadId, messageId: quote.id, sourceMessageId: source.id });
    recordPmContentProvenance({ threadId: "fork", generationId: "fork-generation", messageIds: ["fork-summary"], operationIds: [call.operationId], targets: [f.target] });
    const snapshot = { generationId: f.generationId, threadId: f.threadId, sequence: 1, status: "completed" as const,
      items: [{ id: `pm-tool:${call.operationId}`, type: "dynamic_tool" as const, status: "completed" as const, output: JSON.stringify(call) }] };
    f.state.sourceAllowed = false;
    const projector = await createPmVisibilityProjector(f.threadId, f.context.headers);
    assert.equal(pmToolCallProjectionSchema.parse(projector.calls[0]).visibility, "redacted");
    const projectedHistory = projector.history([source, quote]);
    assert.match(JSON.stringify(projectedHistory), /keep-user-question/);
    assert.doesNotMatch(JSON.stringify({ calls: projector.calls, history: projectedHistory, native: projector.nativeSnapshot(snapshot),
      generation: projector.generation({ id: f.generationId, request: { text: "private-model-summary" } }),
      chunk: projector.uiChunk({ type: "tool-output-available", toolCallId: call.operationId, output: call }, f.generationId) }), /private-(?:source|request|model|denial|error)/);
    assert.equal(projector.nativeContextContaminated, true);
    assert.deepEqual(projector.visibleProvenance([f.messageId]).operationIds, []);
    const fork = await createPmVisibilityProjector("fork", f.context.headers);
    assert.equal(fork.nativeContextContaminated, true);
    assert.doesNotMatch(JSON.stringify(fork.history([{ id: "fork-summary", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "private-model-summary" }] } }])), /private-model-summary/);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", call.operationId)!.record.status, "succeeded");
    f.state.sourceAllowed = true; f.state.deliveryStatus = 503;
    assert.equal((await createPmVisibilityProjector(f.threadId, f.context.headers)).calls[0]!.visibility, "unavailable");
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", call.operationId)!.record.status, "succeeded");
    f.state.deliveryStatus = 200; f.state.resultMissing = true;
    const proofOnly = (await createPmVisibilityProjector(f.threadId, f.context.headers)).calls[0]!;
    assert.equal(proofOnly.visibility, "unavailable");
    assert.doesNotMatch(JSON.stringify(proofOnly), /private-(?:request|source)/, "an authorized project plus a bare success proof cannot authorize old content or arguments");
    f.state.resultMissing = false; f.state.substituteReceipt = true;
    const current = (await createPmVisibilityProjector(f.threadId, f.context.headers)).calls[0]!;
    assert.equal(current.visibility, "visible");
    assert.doesNotMatch(JSON.stringify(current), /private-source-content/, "PM's authorized receipt-only response cannot revive an older Agent payload");
    assert.equal(f.state.writes, 1, "all projections and source restoration inspect the same write; no mutation is replayed");
  } finally { await f.close(); }
});

test("dynamic current reads are not compared bytewise and no-items results retain source ACL dependencies", async () => {
  const f = await fixture();
  try {
    const input = { operationId: randomUUID(), name: "pm_read_timer", target: f.target, arguments: {} };
    const first = await callPmTool(f.context, input); assert.equal(first.status, "succeeded");
    f.state.clock = "2026-11-13T00:00:01.000Z";
    const current = (await createPmVisibilityProjector(f.threadId, f.context.headers)).calls[0]!;
    assert.equal(current.visibility, "visible");
    if (current.visibility !== "visible") assert.fail("timer should remain readable");
    assert.ok(current.result?.kind === "dashboard_timer");
    assert.equal(current.result.serverNow, f.state.clock);
    const source = { kind: "task", workspaceId: f.target.workspaceId, projectId: "PRJ-002", entityId: "TASK-002", title: "Source", revision: "source", truncated: false };
    assert.deepEqual(pmPayloadTargets({ ...current.result, sources: [source] }, f.target.workspaceId), [{ workspaceId: f.target.workspaceId, projectId: "PRJ-002" }]);
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("current result delivery rechecks live execution after its asynchronous source authorization", async () => {
  const f = await fixture();
  try {
    f.state.stopAtResult = true;
    await assert.rejects(callPmTool(f.context, f.input), /Execution authorization was revoked/);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", f.input.operationId)!.record.status, "succeeded");
    assert.equal(f.state.writes, 1, "stopping delivery never rolls back or redispatches the original native mutation");
  } finally { await f.close(); }
});

test("application receipt proof settles a lost original write without exposing its revoked result or downgrading success", async () => {
  const f = await fixture();
  try {
    f.state.lostResponse = true;
    assert.equal((await callPmTool(f.context, f.input)).status, "unknown");
    assert.equal((await callPmTool(f.context, f.input)).status, "unknown");
    f.state.sourceAllowed = false;
    const unresolved = (await createPmVisibilityProjector(f.threadId, f.context.headers)).calls[0]!;
    assert.equal(unresolved.visibility, "visible");
    if (unresolved.visibility !== "visible") assert.fail("the target-bound unknown status remains recoverable");
    assert.equal(unresolved.status, "unknown");
    assert.equal(unresolved.arguments, undefined);
    assert.doesNotMatch(JSON.stringify(unresolved), /private-request-content/);
    f.state.proof = true;
    const response = await pmToolRoutes.request(`/pm-tools/calls/${f.input.operationId}/reconcile`, { method: "POST", headers: f.context.headers });
    const projection = pmToolCallProjectionSchema.parse(await response.json());
    assert.equal(projection.visibility, "redacted");
    const stored = readRecord<StoredPmToolCall>("pm-tool-calls", f.input.operationId)!.record;
    assert.equal(stored.status, "succeeded"); assert.equal(stored.result, null);
    assert.equal(stored.certainty?.evidence, "internal_proof");
    f.state.sourceAllowed = true; f.state.deliveryStatus = 409;
    assert.equal((await createPmVisibilityProjector(f.threadId, f.context.headers)).calls[0]!.visibility, "unavailable");
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", f.input.operationId)!.record.status, "succeeded");
    f.state.deliveryStatus = 200;
    const restored = await pmToolRoutes.request(`/pm-tools/calls/${f.input.operationId}/reconcile`, { method: "POST", headers: f.context.headers });
    const visible = pmToolCallProjectionSchema.parse(await restored.json());
    assert.equal(visible.visibility, "visible");
    if (visible.visibility !== "visible") assert.fail("restored original receipt should be readable");
    assert.equal(visible.status, "succeeded");
    assert.equal(visible.result?.receipt?.commandId, `native-${f.input.operationId}`);
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

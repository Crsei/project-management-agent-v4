import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { z } from "zod";
import { pmToolCallRecordSchema } from "@agent-workspace/contracts/pm-tools";
import { closeStore, listRecords, readRecord, writeRecord } from "./durable/store.ts";
import { initializeNativeOutput } from "./durable/native-output.ts";
import { ensureThread } from "./durable/threads.ts";
import { grantIdentity, MCP_GRANTS, putGrant, type Grant } from "./mcp/grants.ts";
import { openPmToolBridge, type StoredPmToolCall } from "./pm-tools.ts";
import { workspaceRoot } from "./paths.ts";
import { createPmApprovalAuthorityFixture } from "./test-fixtures/pm-approval-authority.ts";

const taskArguments = { projectId: "PRJ-001", title: "Recover this write once", description: "Original persisted arguments", assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null };
const recoveryArguments = (operationId: string) => ({ arguments: { operationId } });
const mcpResultSchema = z.object({ result: z.object({ isError: z.boolean(), structuredContent: pmToolCallRecordSchema }) });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-native-operation-result-"));
  const keys = ["AGENT_WORKSPACE_DATA_DIR", "PM_API_URL", "PM_AUTOMATION_SERVICE_SECRET", "MCP_PUBLIC_ORIGIN", "AGENT_PM_TOOL_BRIDGE", "AGENT_APPROVAL_MODE"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_AUTOMATION_SERVICE_SECRET = "native-operation-result-isolated-test-secret";
  process.env.MCP_PUBLIC_ORIGIN = "https://native-operation-result.invalid";
  process.env.AGENT_APPROVAL_MODE = "ask";
  const workspaceId = randomUUID(), actorId = randomUUID();
  const state = { live: true, targetAllowed: true, actorId, settled: false, writes: 0, results: 0, pauseResult: false, resultDenied: false };
  const approvalAuthority = await createPmApprovalAuthorityFixture({ directory, workspaceId, actorId, archived: true, enabled: () => state.targetAllowed });
  const target = approvalAuthority.target;
  const reachedResult = Promise.withResolvers<void>(), releaseResult = Promise.withResolvers<void>();
  const requests = new Map<string, Record<string, unknown>>();
  const resultRequests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/agent-contexts") {
      response.end(JSON.stringify({ workspaces: [{ id: workspaceId, name: "Fixture", workspaceAllowed: true, projects: [{ id: target.projectId, name: "Granted" }] }] })); return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify({ tools: [{ name: "pm_create_task", write: true, inputSchema: { type: "object" } }] })); return;
    }
    let text = ""; for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as Record<string, unknown>;
    if (request.url === "/api/v1/agent-contexts/authorize") {
      if (!state.targetAllowed) { response.writeHead(403).end(JSON.stringify({ error: "Revoked" })); return; }
      response.end(JSON.stringify({ actorId: state.actorId, scope: input })); return;
    }
    if (request.url === "/api/v1/internal/agent-tools/reconcile") { response.writeHead(404).end("{}"); return; }
    if (request.url?.endsWith("/agent-tools/approval-authority")) {
      const authority = await approvalAuthority.read(input);
      response.writeHead(authority.statusCode).end(authority.body); return;
    }
    if (request.url?.endsWith("/call")) {
      state.writes++; requests.set(String(input.operationId), input);
      request.socket.destroy(); return; // The business write happened; delivery was lost.
    }
    assert.ok(request.url?.endsWith("/result"));
    state.results++; resultRequests.push(input);
    assert.deepEqual(input, requests.get(String(input.operationId)), "recovery must send the persisted original request, including its linkage");
    if (state.resultDenied) { response.writeHead(403).end(JSON.stringify({ error: "Result capability revoked" })); return; }
    if (state.pauseResult) { state.pauseResult = false; reachedResult.resolve(); await releaseResult.promise; }
    response.end(JSON.stringify({ ...input, actorId, workspaceId, status: state.settled ? "succeeded" : "unknown",
      result: state.settled ? { kind: "task", items: [], nextCursor: null, truncated: false, sources: [],
        receipt: { kind: "core", operationId: input.operationId, commandId: "original-command", action: "CreateTask", targetId: "TASK-001", revision: "a".repeat(64) } } : null,
      error: null, createdAt: "2026-11-13T00:00:00.000Z", finishedAt: state.settled ? "2026-11-13T00:00:01.000Z" : null }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const context = { threadId: "native-recovery-thread", messageId: "message", generationId: randomUUID(),
    headers: new Headers({ cookie: "pm_v4_session=fixture" }),
    authorizeExecution: async () => { if (!state.live) throw new Error("Generation authorization is no longer live"); } };
  ensureThread(context.threadId, "Native recovery");
  initializeNativeOutput(context.generationId, context.threadId, "running");
  const bridge = await openPmToolBridge(context);
  const send = async (base: string, endpoint: string, input: unknown) => {
    const response = await fetch(`${base}/tools/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  let requestId = 0;
  const recover = (base: string, operationId: string, args: unknown = recoveryArguments(operationId)) => send(base, "mcp-call", {
    transportId: "recovery-regression", requestId: ++requestId, name: "pm_get_operation_result", arguments: args,
  });
  const create = () => send(bridge.url, "mcp-call", { transportId: "original-write", requestId: 1, name: "pm_create_task", arguments: { target, arguments: taskArguments } });
  const close = async () => {
    releaseResult.resolve(); await bridge.close(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    await approvalAuthority.close();
    closeStore();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, workspaceId, actorId, target, task: approvalAuthority.task, state, context, bridge, send, recover, create, requests, resultRequests, reachedResult, releaseResult, close };
}

async function stdioClient(base: string) {
  const child = spawn(process.execPath, [path.join(workspaceRoot, "packages/pm-cli/agent-tools.mjs"), base, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit"), lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    async request(message: unknown): Promise<unknown> {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      const line = await lines.next(); assert.equal(line.done, false);
      return JSON.parse(line.value as string);
    },
    async close() { child.stdin.end(); await exit; },
  };
}

test("native MCP discovers operation recovery and restores the original result without a second write or operation", async () => {
  const f = await fixture(), client = await stdioClient(f.bridge.url);
  try {
    await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    const catalog = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) })) }) }).parse(
      await client.request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const controls = catalog.result.tools.filter(tool => tool.name === "pm_get_operation_result");
    assert.equal(controls.length, 1);
    assert.deepEqual(controls[0]!.inputSchema.required, ["arguments"]);
    assert.equal(controls[0]!.inputSchema.additionalProperties, false);
    const argsSchema = z.object({ arguments: z.object({ required: z.array(z.string()), additionalProperties: z.boolean(), properties: z.record(z.string(), z.unknown()) }) }).parse(controls[0]!.inputSchema.properties).arguments;
    assert.deepEqual(argsSchema.required, ["operationId"]);
    assert.deepEqual(Object.keys(argsSchema.properties), ["operationId"]);
    assert.equal(argsSchema.additionalProperties, false);
    const initial = mcpResultSchema.parse(await client.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pm_create_task", arguments: { target: f.target, arguments: taskArguments } } }));
    assert.equal(initial.result.structuredContent.status, "unknown");
    const operationId = initial.result.structuredContent.operationId;
    const recovery = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pm_get_operation_result", arguments: recoveryArguments(operationId) } };
    const unknown = mcpResultSchema.parse(await client.request(recovery));
    assert.equal(unknown.result.structuredContent.status, "unknown");
    assert.equal(unknown.result.isError, true);
    f.state.settled = true;
    const recovered = mcpResultSchema.parse(await client.request(recovery));
    assert.equal(recovered.result.isError, false);
    assert.equal(recovered.result.structuredContent.status, "succeeded");
    assert.equal(recovered.result.structuredContent.operationId, operationId);
    assert.equal(recovered.result.structuredContent.result?.receipt?.commandId, "original-command");
    assert.equal(f.state.writes, 1);
    assert.equal(listRecords("pm-tool-calls").length, 1, "control reads never reserve a second operation");
    f.state.resultDenied = true;
    const revoked = await f.recover(f.bridge.url, operationId);
    assert.equal(revoked.status, 400); assert.equal(revoked.body.result, undefined);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!.record.status, "succeeded", "denied reads preserve internal success without exposing it");
    f.state.resultDenied = false;
    const missingId = randomUUID();
    assert.equal((await f.recover(f.bridge.url, missingId)).status, 400);
    assert.equal(readRecord("pm-tool-calls", missingId), null);
    for (const args of [{ operationId }, { ...recoveryArguments(operationId), target: f.target }, { arguments: { operationId, arguments: taskArguments } }])
      assert.equal((await f.recover(f.bridge.url, operationId, args)).status, 400);
    assert.equal((await f.send(f.bridge.url, "call", { operationId: randomUUID(), name: "pm_get_operation_result", target: f.target, arguments: { operationId } })).status, 400);
    const original = f.requests.get(operationId)!;
    const invocation = { operationId, name: original.name, target: original.target, arguments: original.arguments };
    assert.equal((await f.send(f.bridge.url, "result", { ...invocation, arguments: { ...taskArguments, title: "Reconstructed" } })).status, 400);
    assert.equal((await f.send(f.bridge.url, "result", invocation)).body.status, "succeeded", "exact original CLI result consumers remain supported");
    assert.equal(f.state.writes, 1); assert.equal(listRecords("pm-tool-calls").length, 1);
  } finally { await client.close(); await f.close(); }
});

test("native operation recovery cannot approve or dispatch a pending business command", async () => {
  const f = await fixture();
  try {
    const operationId = randomUUID();
    const pending = await f.send(f.bridge.url, "call", { operationId, name: "pm_delete_task", target: f.target, arguments: { ...f.task } });
    assert.equal(pending.body.status, "pending_approval");
    const recovered = await f.recover(f.bridge.url, operationId);
    assert.equal(recovered.body.status, "pending_approval"); assert.equal(recovered.body.result, null);
    assert.equal(f.state.writes, 0); assert.equal(f.state.results, 0);
    assert.equal(listRecords("pm-tool-calls").length, 1);
  } finally { await f.close(); }
});

test("native operation recovery rejects other threads, ceilings, actors and revoked or stopped execution", async () => {
  const f = await fixture();
  const extra: Array<Awaited<ReturnType<typeof openPmToolBridge>>> = [];
  try {
    const initial = await f.create(), operationId = z.uuid().parse(initial.body.operationId);
    for (const changes of [
      { threadId: "other-thread" },
      { targetCeiling: f.target },
      { targetCeiling: { workspaceId: randomUUID(), projectId: null } },
      { executionId: "other-execution-root" },
    ]) {
      const bridge = await openPmToolBridge({ ...f.context, ...changes }); extra.push(bridge);
      const denied = await f.recover(bridge.url, operationId);
      assert.equal(denied.status, 400); assert.equal(denied.body.operationId, undefined);
    }
    f.state.actorId = randomUUID();
    assert.equal((await f.recover(f.bridge.url, operationId)).status, 400);
    f.state.actorId = f.actorId; f.state.targetAllowed = false;
    assert.equal((await f.recover(f.bridge.url, operationId)).status, 400);
    f.state.targetAllowed = true; f.state.live = false;
    assert.equal((await f.recover(f.bridge.url, operationId)).status, 400);
    assert.equal(f.state.results, 0, "denied readers cannot even reconcile the original result");
    f.state.live = true;
    const nextGeneration = await openPmToolBridge({ ...f.context, generationId: randomUUID(), messageId: "next-message" }); extra.push(nextGeneration);
    assert.equal((await f.recover(nextGeneration.url, operationId)).body.status, "unknown", "same-thread later turns recover the persisted original generation's request");
    f.state.settled = true; f.state.pauseResult = true;
    const pending = f.recover(f.bridge.url, operationId);
    await f.reachedResult.promise;
    f.state.targetAllowed = false; f.releaseResult.resolve();
    const revoked = await pending;
    assert.equal(revoked.status, 400); assert.equal(revoked.body.operationId, undefined);
    assert.equal(revoked.body.result, undefined);
    assert.equal(f.state.writes, 1); assert.equal(listRecords("pm-tool-calls").length, 1);
  } finally { for (const bridge of extra) await bridge.close(); await f.close(); }
});

test("native recovery rechecks live execution after PM has returned a result", async () => {
  const f = await fixture();
  try {
    const initial = await f.create(), operationId = z.uuid().parse(initial.body.operationId);
    f.state.settled = true; f.state.pauseResult = true;
    const pending = f.recover(f.bridge.url, operationId);
    await f.reachedResult.promise;
    f.state.live = false; f.releaseResult.resolve();
    const denied = await pending;
    assert.equal(denied.status, 400); assert.match(String(denied.body.error), /no longer live/);
    assert.equal(denied.body.operationId, undefined); assert.equal(denied.body.result, undefined);
    assert.equal(f.state.writes, 1); assert.equal(listRecords("pm-tool-calls").length, 1);
  } finally { await f.close(); }
});

test("native recovery preserves the original delegation identity and live revocation", async () => {
  const f = await fixture();
  const bridges: Array<Awaited<ReturnType<typeof openPmToolBridge>>> = [];
  try {
    const grant: Grant = { grantId: randomUUID(), actorId: f.actorId, scope: f.target, access: "full", threadIds: [f.context.threadId], version: 1,
      clientHash: "native-recovery-client", clientName: "Fixture", audience: "https://native-operation-result.invalid/mcp",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null };
    putGrant(grant);
    const context = { ...f.context, delegation: grantIdentity(grant), targetCeiling: f.target };
    const delegated = await openPmToolBridge(context); bridges.push(delegated);
    const initial = await f.send(delegated.url, "mcp-call", { transportId: "delegated", requestId: 1, name: "pm_create_task", arguments: { target: f.target, arguments: taskArguments } });
    assert.equal(initial.body.status, "unknown");
    const operationId = z.uuid().parse(initial.body.operationId);
    const alternate: Grant = { ...grant, grantId: randomUUID() }; putGrant(alternate);
    const other = await openPmToolBridge({ ...context, delegation: grantIdentity(alternate) }); bridges.push(other);
    assert.equal((await f.recover(other.url, operationId)).status, 400);
    assert.equal((await f.recover(f.bridge.url, operationId)).status, 400, "browser authority cannot adopt a delegated operation");
    f.state.settled = true;
    assert.equal((await f.recover(delegated.url, operationId)).body.status, "succeeded");
    const changed = { ...grant, version: 2, access: "read-only" as const }; putGrant(changed);
    const changedBridge = await openPmToolBridge({ ...context, delegation: grantIdentity(changed) }); bridges.push(changedBridge);
    assert.equal((await f.recover(changedBridge.url, operationId)).status, 400, "same grant ID with another version/access cannot adopt history");
    assert.equal((await f.recover(delegated.url, operationId)).status, 400, "stale grant version is no longer live");
    writeRecord(MCP_GRANTS, grant.grantId, { ...changed, revokedAt: new Date().toISOString() });
    assert.equal((await f.recover(changedBridge.url, operationId)).status, 400);
    assert.equal(f.state.writes, 1); assert.equal(listRecords("pm-tool-calls").length, 1);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!.record.status, "succeeded", "revocation never downgrades internal business evidence");
  } finally { for (const bridge of bridges) await bridge.close(); await f.close(); }
});


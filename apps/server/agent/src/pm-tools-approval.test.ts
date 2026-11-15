import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PmChangeSet } from "@agent-workspace/contracts/pm-changes";
import type { PmToolCallRecord, PmToolRequest } from "@agent-workspace/contracts/pm-tools";
import { pmToolRequestHash } from "../../../../packages/infrastructure/src/pm-tool-service-auth.ts";
import { requestHash } from "../../../../packages/application/src/kernel.ts";
import { closeStore, readRecord, writeRecord } from "./durable/store.ts";
import { closeNativeInteractions, endNativeOutput, initializeNativeOutput, requestNativeInteraction, respondNativeInteraction } from "./durable/native-output.ts";
import { ensureThread } from "./durable/threads.ts";
import { callPmTool, listPendingPmApprovals, openPmToolBridge, pmToolRoutes, type StoredPmToolCall } from "./pm-tools.ts";
import * as pmToolOwner from "./pm-tools.ts";
import { listCollaborationInbox } from "./collaboration/inbox.ts";
import { capturePmApprovalCapabilities } from "./collaboration/approval-capabilities.ts";
import { COLLABORATION_RUNS } from "./collaboration/coordinator.ts";

const workspaceId = randomUUID();
const actorId = randomUUID(), target = { workspaceId, projectId: null };
const fileArea = { path: null, status: "unconfigured" as const, revision: 0, source: null, canManage: false };
const headers = { cookie: "pm_v4_session=fixture" };
const revision = "a".repeat(64);
const PM_TOOL_APPROVAL_AUTHORITY_HEADER = "x-pm-approval-authority";

type PmCall = { operationId: string; name: string; arguments: unknown; threadId: string };

async function fixture(mode: () => "success" | "unknown", authorized: () => boolean = () => true) {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-approval-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousUrl = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const calls: PmCall[] = [];
  const forwardedAuthorities: Array<string | undefined> = [];
  const authority = { permitted: true, category: "completed" as "completed" | "started", workflowRevision: "b".repeat(64), configurationRevision: "absent",
    onRead: null as (() => void) | null, onAuthorize: null as (() => void) | null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/v1/agent-contexts") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ workspaces: [{ id: workspaceId, name: "Workspace", fileArea, projects: [] }] }));
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/agent-capabilities")) {
      res.setHeader("content-type", "application/json");
      res.writeHead(authorized() ? 200 : 403);
      res.end(JSON.stringify(authorized() ? { scope: { kind: "workspace", projectIds: [] }, tools: ["pm_archive_task", "pm_delete_task", "pm_transition_task"].map(name => ({ name, description: name, write: true, capabilities: ["planning.lifecycle"], allowed: true, denyReason: null })) } : { error: "forbidden" }));
      return;
    }
    let text = ""; for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as PmCall & { messageId: string; generationId: string };
    if (url.pathname === "/api/v1/agent-contexts/authorize") {
      const scope = body as unknown as { workspaceId: string; projectId: string | null };
      res.setHeader("content-type", "application/json");
      if (scope.workspaceId !== workspaceId || !authorized()) { res.writeHead(403).end(JSON.stringify({ error: "forbidden" })); return; }
      authority.onAuthorize?.();
      res.end(JSON.stringify({ actorId, scope })); return;
    }
    if (url.pathname.endsWith("/agent-tools/approval-authority")) {
      res.setHeader("content-type", "application/json");
      if (!authorized() || !authority.permitted) { res.writeHead(403).end(JSON.stringify({ error: "effective capability revoked" })); return; }
      authority.onRead?.();
      const migration = body.name === "pm_apply_migration" || body.name === "pm_restore_migration";
      const transition = body.name === "pm_transition_task" || body.name === "pm_transition_entity";
      const args = body.arguments as { id: string; revision: string };
      const facts = {
        capabilities: ["domain.read", transition ? authority.category === "completed" ? "workitem.complete" : "planning.edit" : "planning.lifecycle"],
        entity: migration ? null : { id: args.id, revision: args.revision, kind: "work_item", status: "todo", archived: false },
        configuration: transition ? { schema: "pm/config/v1", revision: authority.configurationRevision, workflowRevision: authority.workflowRevision } : null,
        migration: migration ? { id: args.id, revision: args.revision } : null,
      };
      res.end(JSON.stringify({ ...facts, actorId, target: (body as PmToolRequest).target, requestHash: pmToolRequestHash(body, actorId),
        fingerprint: requestHash({ name: body.name, arguments: body.arguments, ...facts }) }));
      return;
    }
    if (url.pathname.endsWith("/agent-tools/call")) {
      calls.push({ operationId: body.operationId, name: body.name, arguments: body.arguments, threadId: body.threadId });
      forwardedAuthorities.push(req.headers[PM_TOOL_APPROVAL_AUTHORITY_HEADER] as string | undefined);
    } else assert.ok(url.pathname.endsWith("/agent-tools/result"));
    if (mode() === "unknown") { req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      operationId: body.operationId, name: body.name, status: "succeeded",
      result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] },
      error: null, threadId: body.threadId, messageId: body.messageId, generationId: body.generationId,
      workspaceId, target: (body as PmToolRequest).target ?? target, actorId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    if (previousUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousUrl;
    await rm(directory, { recursive: true, force: true });
  };
  return { calls, close, authority, forwardedAuthorities };
}

/** Accepted server-owned original fixture: real hash/authority snapshot, no live Run or generation lease. */
async function originalRunApproval() {
  const operationId = randomUUID(), threadId = `cancel-approval-${randomUUID()}`, generationId = randomUUID();
  const ids = { own: randomUUID(), ancestor: randomUUID(), root: randomUUID() };
  const pmTarget = { workspaceId, projectId: "PRJ-1" };
  const runTarget = { ...pmTarget, taskId: "TASK-1", taskRevision: revision };
  const nodes = {
    own: { id: ids.own, parentRunId: ids.ancestor, rootRunId: ids.root, status: "waiting", cancellation: null, actorId, threadId, generationId, target: runTarget },
    ancestor: { id: ids.ancestor, parentRunId: ids.root, rootRunId: ids.root, status: "waiting", cancellation: null, actorId },
    root: { id: ids.root, parentRunId: null, rootRunId: ids.root, status: "waiting", cancellation: null, actorId },
  };
  for (const node of Object.values(nodes)) writeRecord(COLLABORATION_RUNS, node.id, node);
  ensureThread(threadId, "Original Run approval"); initializeNativeOutput(generationId, threadId, "running");
  const linkage = { traceId: randomUUID(), invocationId: operationId, executionRoot: "generation" as const, clientKind: "chat" as const,
    policy: "full" as const, enforcement: "audit-only" as const,
    collaboration: { runId: ids.own, agentId: "original-agent", agentVersion: 1, delegationId: null, target: runTarget } };
  const request = { operationId, name: "pm_archive_task", target: pmTarget, arguments: { id: "TASK-1", revision }, threadId, messageId: "m", generationId, linkage };
  const value: StoredPmToolCall = { request, requestHash: pmToolRequestHash(request, actorId),
    record: { operationId, name: request.name, actorId, target: pmTarget, workspaceId, threadId, messageId: "m", generationId, linkage,
      status: "pending_approval", result: null, error: null, createdAt: new Date().toISOString(), finishedAt: null,
      certainty: { dispatch: "not_sent", evidence: "unresolved" } } };
  value.approvalCapabilities = await capturePmApprovalCapabilities(value, new Headers(headers));
  writeRecord("pm-tool-calls", operationId, value);
  return { operationId, threadId, generationId, value, nodes,
    cancel(node: keyof typeof nodes, kind: "intent" | "cancelled" = "intent") {
      const original = nodes[node];
      writeRecord(COLLABORATION_RUNS, original.id, kind === "cancelled" ? { ...original, status: "cancelled" }
        : { ...original, cancellation: { requestedAt: new Date().toISOString(), requestedBy: actorId, observedAt: null } });
    } };
}

test("destructive PM tools wait for approval and execute the original request once", async () => {
  const { calls, close } = await fixture(() => "success");
  const generationId = randomUUID();
  initializeNativeOutput(generationId, "approval-thread", "running");
  ensureThread("approval-thread", "Approval");
  ensureThread("other-thread", "Other");
  let live = true;
  const authorizeExecution = async () => { if (!live) throw new Error("Native generation authorization is no longer live"); };
  const bridge = await openPmToolBridge({ threadId: "approval-thread", messageId: "approval-message", generationId, headers: new Headers(headers), authorizeExecution });
  const send = async (input: unknown) => {
    const response = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as PmToolCallRecord };
  };
  try {
    const operationId = randomUUID();
    const input = { operationId, name: "pm_archive_task", target, arguments: { id: "TASK-1", revision } };
    const pending = await send(input);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, "pending_approval");
    assert.equal(pending.body.result, null);
    assert.equal(pending.body.error, null);
    assert.equal(calls.length, 0);
    live = false;

    const repeated = await send(input);
    assert.equal(repeated.status, 400, "a stopped generation cannot retrieve a pending PM operation");
    assert.equal(calls.length, 0);

    const conflict = await send({ ...input, arguments: { id: "TASK-1", revision: "b".repeat(64) } });
    assert.equal(conflict.status, 400);
    assert.equal(calls.length, 0);

    const listed = await pmToolRoutes.request("http://localhost/pm-tools/threads/approval-thread/calls", { headers });
    const listedBody = await listed.json() as { items: PmToolCallRecord[] };
    assert.deepEqual(listedBody.items.map((item) => [item.operationId, item.status]), [[operationId, "pending_approval"]]);
    const changes = await pmToolRoutes.request("http://localhost/pm-tools/threads/approval-thread/changes", { headers });
    assert.deepEqual((await changes.json() as { items: PmChangeSet[] }).items.map((item) => [item.id, item.state]), [[operationId, "proposed"]]);
    const other = await pmToolRoutes.request("http://localhost/pm-tools/threads/other-thread/calls", { headers });
    assert.deepEqual((await other.json() as { items: PmToolCallRecord[] }).items, []);

    const foreignWorkspaceId = randomUUID(), foreignId = randomUUID();
    ensureThread("foreign-thread", "Foreign");
    writeRecord("pm-tool-calls", foreignId, {
      record: {
        operationId: foreignId, name: "pm_archive_task", status: "unknown", result: null, error: { code: "outcome_unknown", message: "Historical interrupted write" },
        threadId: "foreign-thread", messageId: "m", generationId: "g", workspaceId: foreignWorkspaceId,
        createdAt: new Date().toISOString(), finishedAt: null,
      },
      request: { operationId: foreignId, name: "pm_archive_task", arguments: { id: "TASK-9", revision: "rev-1" }, scope: { kind: "workspace", projectIds: [] }, threadId: "foreign-thread", messageId: "m", generationId: "g" },
    });
    const foreignCalls = await pmToolRoutes.request("http://localhost/pm-tools/threads/foreign-thread/calls", { headers });
    assert.equal(foreignCalls.status, 200);
    const foreignProjection = await foreignCalls.json() as { items: { visibility: string }[] };
    assert.equal(foreignProjection.items[0]?.visibility, "unavailable");
    assert.doesNotMatch(JSON.stringify(foreignProjection), /TASK-9|Historical interrupted write|pm_archive_task/);
    assert.equal((await pmToolRoutes.request(`http://localhost/pm-tools/calls/${foreignId}/approve`, { method: "POST", headers })).status, 409);
    const foreignReconcile = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${foreignId}/reconcile`, { method: "POST", headers });
    assert.equal(foreignReconcile.status, 200);
    assert.equal((await foreignReconcile.json() as { visibility: string }).visibility, "unavailable",
      "a historical unknown write without an explicit target remains an unavailable placeholder, never upgraded or replayed");
    assert.equal((await send({ ...input, operationId: foreignId })).status, 400);
    assert.equal(calls.length, 0);

    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json() as PmToolCallRecord;
    assert.equal(approvedBody.status, "succeeded");
    assert.equal(approvedBody.operationId, operationId);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { operationId, name: "pm_archive_task", arguments: { id: "TASK-1", revision }, threadId: "approval-thread" });

    const doubleApprove = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(doubleApprove.status, 409);
    assert.equal(calls.length, 1);

    live = true;
    const rejectedId = randomUUID();
    const rejectedPending = await send({ operationId: rejectedId, name: "pm_delete_task", target, arguments: { id: "TASK-2", revision } });
    assert.equal(rejectedPending.body.status, "pending_approval");
    const rejected = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${rejectedId}/reject`, { method: "POST", headers });
    assert.equal(rejected.status, 200);
    const rejectedBody = await rejected.json() as PmToolCallRecord;
    assert.equal(rejectedBody.status, "failed");
    assert.equal(rejectedBody.error?.code, "approval_rejected");
    assert.deepEqual(rejectedBody.result, null);
    assert.equal(calls.length, 1);
    assert.equal((await pmToolRoutes.request(`http://localhost/pm-tools/calls/${rejectedId}/reject`, { method: "POST", headers })).status, 409);
    assert.equal(calls.length, 1);

    const directId = randomUUID();
    const direct = await send({ operationId: directId, name: "pm_create_task", target, arguments: { projectId: "PRJ-1", title: "Direct", description: "", assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null } });
    assert.equal(direct.body.status, "succeeded");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.operationId, directId);
  } finally {
    await bridge.close();
    await close();
  }
});

test("auto-approve dispatches destructive PM tools without waiting for a human decision", async () => {
  const previousMode = process.env.AGENT_APPROVAL_MODE;
  process.env.AGENT_APPROVAL_MODE = "auto-approve";
  const { calls, close } = await fixture(() => "success");
  const generationId = randomUUID();
  initializeNativeOutput(generationId, "auto-thread", "running");
  ensureThread("auto-thread", "Auto");
  const bridge = await openPmToolBridge({ threadId: "auto-thread", messageId: "auto-message", generationId, headers: new Headers(headers), authorizeExecution: async () => {} });
  try {
    const operationId = randomUUID();
    const response = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, name: "pm_delete_task", target, arguments: { id: "TASK-4", revision } }) });
    assert.equal(response.status, 200);
    const record = await response.json() as PmToolCallRecord;
    assert.equal(record.status, "succeeded");
    assert.equal(record.error, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { operationId, name: "pm_delete_task", arguments: { id: "TASK-4", revision }, threadId: "auto-thread" });
    const listed = await pmToolRoutes.request("http://localhost/pm-tools/threads/auto-thread/calls", { headers });
    assert.deepEqual((await listed.json() as { items: PmToolCallRecord[] }).items.map((item) => [item.operationId, item.status]), [[operationId, "succeeded"]]);
  } finally {
    await bridge.close();
    await close();
    if (previousMode === undefined) delete process.env.AGENT_APPROVAL_MODE; else process.env.AGENT_APPROVAL_MODE = previousMode;
  }
});

test("an unknown PM outcome after approval stays unknown and is never redispatched", async () => {
  const { calls, close } = await fixture(() => "unknown");
  const generationId = randomUUID();
  initializeNativeOutput(generationId, "unknown-thread", "running");
  ensureThread("unknown-thread", "Unknown");
  const bridge = await openPmToolBridge({ threadId: "unknown-thread", messageId: "unknown-message", generationId, headers: new Headers(headers), authorizeExecution: async () => {} });
  try {
    const operationId = randomUUID();
    const created = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, name: "pm_transition_task", target, arguments: { id: "TASK-3", revision, status: "done" } }) });
    assert.equal((await created.json() as PmToolCallRecord).status, "pending_approval");
    assert.equal(calls.length, 0);

    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json() as PmToolCallRecord;
    assert.equal(approvedBody.status, "unknown");
    assert.equal(approvedBody.finishedAt, null);
    assert.equal(calls.length, 1);

    for (const endpoint of ["approve", "reject"]) {
      const repeated = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/${endpoint}`, { method: "POST", headers });
      assert.equal(repeated.status, 409);
    }
    assert.equal(calls.length, 1);
  } finally {
    await bridge.close();
    await close();
  }
});

test("Inbox keeps only live information requests, omits revoked PM payloads, and never creates native approval authority", async () => {
  let authorized = true;
  const { calls, close } = await fixture(() => "success", () => authorized);
  const generationId = randomUUID(), threadId = `live-inbox-${"x".repeat(180)}`, requestId = `information-${"y".repeat(300)}`;
  ensureThread(threadId, "Inbox");
  initializeNativeOutput(generationId, threadId, "running");
  writeRecord("chat:generations", generationId, { id: generationId, threadId, messageId: "assistant", inputMessageId: "user", status: "running", createdAt: new Date().toISOString(), pmOperations: [{ actorId, target }], request: { id: threadId, messages: [] } });
  const inputPromise = requestNativeInteraction(generationId, { id: requestId, itemId: "information", kind: "user_input", title: "Current private question", respondable: true, questions: [{ id: "answer", prompt: "Answer", allowText: true }] });
  const closedPermission = assert.rejects(requestNativeInteraction(generationId, { id: "permission", itemId: "permission", kind: "approval", title: "Native permission is not Inbox authority", respondable: true, options: [{ id: "allow", label: "Allow" }] }), { code: "native_interaction_closed" });
  let inputAnswered = false;
  try {
    const items = await listCollaborationInbox({ workspaceId }, new Headers(headers));
    assert.deepEqual(items.map(item => item.kind), ["native_input"]);
    assert.equal(items[0]?.respondable, true);
    assert.equal(items[0]?.kind === "native_input" && items[0].requestId, requestId);
    assert.equal(items[0]?.kind === "native_input" && items[0].threadId, threadId);
    assert.ok(items[0]!.id.length <= 128, "aggregate identity must not truncate the genuine native source IDs");
    respondNativeInteraction(generationId, requestId, { answers: { answer: "original answer" } });
    inputAnswered = true;
    assert.deepEqual(await inputPromise, { answers: { answer: "original answer" } });
    assert.equal((await listCollaborationInbox({ workspaceId }, new Headers(headers))).length, 0, "saved request flags cannot resurrect a consumed live handle");
    assert.throws(() => respondNativeInteraction(generationId, requestId, { optionId: "answer" }));
    authorized = false;
    await assert.rejects(listCollaborationInbox({ workspaceId }, new Headers(headers)), { status: 403 });
    assert.equal(calls.length, 0);
  } finally {
    const closedInput = inputAnswered ? undefined : assert.rejects(inputPromise, { code: "native_interaction_closed" });
    closeNativeInteractions(generationId);
    await closedPermission;
    await closedInput;
    await close();
  }
});

test("capability/schema drift and changed original parameters invalidate approval before claim; revoked items are omitted", async () => {
  let authorized = true;
  const { calls, close } = await fixture(() => "success", () => authorized);
  const generationId = randomUUID(), threadId = "approval-drift";
  ensureThread(threadId, "Drift"); initializeNativeOutput(generationId, threadId, "running");
  const bridge = await openPmToolBridge({ threadId, messageId: "m", generationId, headers: new Headers(headers), authorizeExecution: async () => {} });
  try {
    const operationId = randomUUID();
    const created = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, name: "pm_archive_task", target, arguments: { id: "TASK-1", revision } }) });
    assert.equal((await created.json() as PmToolCallRecord).status, "pending_approval");
    const item = (await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) }))[0]!;
    assert.equal(item.respondable, true);
    const original = readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!;
    writeRecord("pm-tool-calls", operationId, { ...original, approvalCapabilities: { ...original.approvalCapabilities!, toolSchemaFingerprint: "0".repeat(64) } });
    const changed = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ decisionFingerprint: item.decisionFingerprint }) });
    assert.equal(changed.status, 409);
    assert.equal((await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) }))[0]?.respondable, false);
    writeRecord("pm-tool-calls", operationId, { ...original, request: { ...original.request, arguments: { id: "TASK-CHANGED", revision } } });
    const changedParameters = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(changedParameters.status, 409);
    assert.equal(calls.length, 0);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", operationId)?.record.status, "pending_approval");
    authorized = false;
    assert.deepEqual(await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) }), []);
    assert.equal((await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers })).status, 403);
    assert.equal(calls.length, 0);
  } finally { await bridge.close(); await close(); }
});

test("concurrent original-owner decisions claim once with the same Inbox fingerprint", async () => {
  const { calls, close } = await fixture(() => "success");
  const generationId = randomUUID(), threadId = "approval-concurrent";
  ensureThread(threadId, "Concurrent"); initializeNativeOutput(generationId, threadId, "running");
  const bridge = await openPmToolBridge({ threadId, messageId: "m", generationId, headers: new Headers(headers), authorizeExecution: async () => {} });
  try {
    const operationId = randomUUID();
    await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, name: "pm_archive_task", target, arguments: { id: "TASK-1", revision } }) });
    const item = (await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) }))[0]!;
    const responses = await Promise.all([0, 1].map(() => pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ decisionFingerprint: item.decisionFingerprint }) })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(calls.length, 1);
    assert.equal((await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) })).length, 0);
  } finally { await bridge.close(); await close(); }
});

for (const name of ["pm_apply_migration", "pm_restore_migration"] as const) test(`exact approval admits workspace-admin ${name} under original native authority`, async () => {
  const f = await fixture(() => "success");
  const threadId = `approval-${name}`, generationId = randomUUID();
  ensureThread(threadId, "Migration approval"); initializeNativeOutput(generationId, threadId, "running");
  try {
    const operationId = randomUUID(), args = { id: `mig-${randomUUID()}`, revision, after: null, limit: 20 };
    const pending = await callPmTool({ threadId, messageId: "m", generationId, headers: new Headers(headers), authorizeExecution: async () => {} },
      { operationId, name, target, arguments: args });
    assert.equal(pending.status, "pending_approval");
    assert.equal(f.calls.length, 0);
    const original = readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!;
    assert.deepEqual(original.approvalCapabilities?.pmAuthority.capabilities, ["domain.read", "planning.lifecycle"]);
    assert.deepEqual(original.approvalCapabilities?.pmAuthority.migration, { id: args.id, revision });
    assert.equal(original.approvalCapabilities?.pmAuthority.target.projectId, null);
    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, {
      method: "POST", headers: { ...headers, [PM_TOOL_APPROVAL_AUTHORITY_HEADER]: "f".repeat(64) },
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as PmToolCallRecord).status, "succeeded");
    assert.equal(f.calls.length, 1);
    assert.equal(f.forwardedAuthorities[0], original.approvalCapabilities?.pmAuthority.fingerprint);
    const settled = readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!;
    assert.equal(settled.requestHash, original.requestHash, "The restrictive guard is not a new operation identity");
    assert.deepEqual(settled.request, original.request, "The original action, arguments and linkage remain immutable");
  } finally { await f.close(); }
});

for (const drift of ["category", "workflow", "configuration", "effective_capability"] as const) test(`exact approval rejects ${drift} drift before claim or dispatch`, async () => {
  const f = await fixture(() => "success");
  const threadId = `approval-${drift}`, generationId = randomUUID();
  ensureThread(threadId, "Workflow approval"); initializeNativeOutput(generationId, threadId, "running");
  try {
    const operationId = randomUUID();
    await callPmTool({ threadId, messageId: "m", generationId, headers: new Headers(headers), authorizeExecution: async () => {} },
      { operationId, name: "pm_transition_task", target, arguments: { id: "TASK-1", revision, status: "done" } });
    const original = readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!;
    assert.equal(original.record.status, "pending_approval");
    if (drift === "category") f.authority.category = "started";
    else if (drift === "workflow") f.authority.workflowRevision = "c".repeat(64);
    else if (drift === "configuration") f.authority.configurationRevision = "d".repeat(64);
    else f.authority.permitted = false;
    const items = await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) });
    assert.equal(items.length, 1, "Read authorization survives; only the original approval authority is invalid");
    assert.equal(items[0]!.respondable, false);
    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, drift === "effective_capability" ? 403 : 409);
    const retained = readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!;
    assert.equal(retained.record.status, "pending_approval");
    assert.deepEqual(retained.approvalCapabilities, original.approvalCapabilities, "Drift never reseeds or retries the old approval");
    assert.equal(retained.requestHash, original.requestHash);
    assert.deepEqual(original.approvalCapabilities?.pmAuthority.capabilities, ["domain.read", "workitem.complete"]);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("exact approval never upgrades a legacy catalog-only snapshot", async () => {
  const f = await fixture(() => "success");
  const threadId = "approval-legacy", generationId = randomUUID();
  ensureThread(threadId, "Legacy"); initializeNativeOutput(generationId, threadId, "running");
  try {
    const operationId = randomUUID();
    await callPmTool({ threadId, messageId: "m", generationId, headers: new Headers(headers), authorizeExecution: async () => {} },
      { operationId, name: "pm_archive_task", target, arguments: { id: "TASK-1", revision } });
    const original = readRecord<StoredPmToolCall>("pm-tool-calls", operationId)!;
    const guard = original.approvalCapabilities!;
    const legacy = { toolSchemaFingerprint: guard.toolSchemaFingerprint, manifest: guard.manifest, bindings: guard.bindings,
      pmCapabilityFingerprint: createHash("sha256").update(JSON.stringify({ name: "pm_archive_task", write: true, capabilities: ["planning.lifecycle"], target })).digest("hex") };
    writeRecord("pm-tool-calls", operationId, { ...original, approvalCapabilities: legacy });
    assert.equal((await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) }))[0]?.respondable, false);
    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, 409);
    assert.equal((await approved.json() as { code: string }).code, "approval_capability_unverified");
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", operationId)?.record.status, "pending_approval");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("original PM approval stays callable after native terminal and notifies identity-only committed changes", async () => {
  const f = await fixture(() => "success");
  const unsubscribe: Array<() => void> = [];
  try {
    assert.equal(typeof pmToolOwner.subscribePmToolCalls, "function");
    const seen: Array<{ operationId: string; threadId: string; generationId: string; status: PmToolCallRecord["status"] }> = [];
    const dispatchStates: Array<"not_sent" | "possibly_sent" | undefined> = [];
    unsubscribe.push(pmToolOwner.subscribePmToolCalls(() => { throw new Error("An observer cannot change a durable PM outcome"); }));
    unsubscribe.push(pmToolOwner.subscribePmToolCalls(change => {
      assert.deepEqual(Object.keys(change).sort(), ["generationId", "operationId", "status", "threadId"]);
      const stored = readRecord<StoredPmToolCall>("pm-tool-calls", change.operationId)!;
      assert.equal(stored.record.status, change.status, "Only an already-committed original state is observed");
      dispatchStates.push(stored.record.certainty?.dispatch);
      seen.push(change);
    }));
    const threadId = "approval-native-terminal", generationId = randomUUID();
    ensureThread(threadId, "Terminal"); initializeNativeOutput(generationId, threadId, "running");
    const operationId = randomUUID();
    await callPmTool({ threadId, messageId: "m", generationId, headers: new Headers(headers), authorizeExecution: async () => {} },
      { operationId, name: "pm_archive_task", target, arguments: { id: "TASK-1", revision } });
    endNativeOutput(generationId, "completed");
    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as PmToolCallRecord).status, "succeeded");
    assert.deepEqual(seen.map(change => change.status), ["pending_approval", "running", "running", "succeeded"]);
    assert.deepEqual(dispatchStates, ["not_sent", "not_sent", "possibly_sent", "possibly_sent"],
      "Both running notifications describe distinct committed claim and dispatch boundaries");
    assert.ok(seen.every(change => change.operationId === operationId && change.threadId === threadId && change.generationId === generationId));
    assert.equal(f.calls.length, 1);
  } finally { for (const stop of unsubscribe) stop(); await f.close(); }
});

for (const node of ["own", "ancestor", "root"] as const) for (const kind of ["intent", "cancelled"] as const)
  test(`explicit Run ${node} ${kind} fences original approval but not reconcile/query/reject`, async () => {
    const f = await fixture(() => "success");
    try {
      const original = await originalRunApproval();
      endNativeOutput(original.generationId, "completed");
      original.cancel(node, kind);
      const items = await listPendingPmApprovals({ workspaceId, headers: new Headers(headers) });
      assert.equal(items[0]?.respondable, false);
      const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${original.operationId}/approve`, { method: "POST", headers });
      assert.equal(approved.status, 409);
      assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", original.operationId)?.record.status, "pending_approval");
      assert.equal((await pmToolOwner.reconcilePmToolCall(original.operationId, new Headers(headers))).visibility, "visible");
      assert.equal((await pmToolRoutes.request(`http://localhost/pm-tools/calls/${original.operationId}`, { headers })).status, 200);
      const rejected = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${original.operationId}/reject`, { method: "POST", headers });
      assert.equal(rejected.status, 200);
      assert.equal((await rejected.json() as PmToolCallRecord).error?.code, "approval_rejected");
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });

test("explicit Run cancellation during native authority recheck rejects before claim", async () => {
  const f = await fixture(() => "success");
  try {
    const original = await originalRunApproval();
    f.authority.onRead = () => original.cancel("ancestor");
    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${original.operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, 409);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", original.operationId)?.record.status, "pending_approval");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("explicit Run cancellation after claim and asynchronous authorization fences unsent forward admission", async () => {
  const f = await fixture(() => "success");
  let stop: (() => void) | undefined;
  try {
    const original = await originalRunApproval();
    stop = pmToolOwner.subscribePmToolCalls(change => {
      if (change.operationId === original.operationId && change.status === "running")
        f.authority.onAuthorize = () => original.cancel("root");
    });
    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${original.operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, 200);
    const saved = readRecord<StoredPmToolCall>("pm-tool-calls", original.operationId)!;
    assert.equal(saved.record.status, "failed");
    assert.deepEqual(saved.record.certainty, { dispatch: "not_sent", evidence: "local_rejection" });
    assert.equal(f.calls.length, 0);
  } finally { stop?.(); await f.close(); }
});

test("original server reconciliation remains available after terminal Run cancellation without redispatch or rollback", async () => {
  const f = await fixture(() => "success");
  try {
    const original = await originalRunApproval();
    for (const node of Object.values(original.nodes)) writeRecord(COLLABORATION_RUNS, node.id, { ...node, status: "succeeded" });
    endNativeOutput(original.generationId, "completed");
    const approved = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${original.operationId}/approve`, { method: "POST", headers });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as PmToolCallRecord).status, "succeeded", "No active generation, Run status or live lease is required for the original approval");
    original.cancel("root");
    const projected = await pmToolOwner.reconcilePmToolCall(original.operationId, new Headers(headers));
    assert.equal(projected.visibility, "visible");
    if (projected.visibility === "visible") assert.equal(projected.status, "succeeded");
    assert.equal(f.calls.length, 1);
    const routed = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${original.operationId}/reconcile`, { method: "POST", headers });
    assert.equal(routed.status, 200);
    assert.equal((await routed.json() as PmToolCallRecord).status, "succeeded");
    assert.equal(f.calls.length, 1);
    assert.equal(readRecord<StoredPmToolCall>("pm-tool-calls", original.operationId)?.record.status, "succeeded");
  } finally { await f.close(); }
});

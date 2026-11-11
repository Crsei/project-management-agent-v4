import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PmChangeSet } from "@agent-workspace/contracts/pm-changes";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { closeStore, writeRecord } from "./durable/store.ts";
import { initializeNativeOutput } from "./durable/native-output.ts";
import { ensureThread } from "./durable/threads.ts";
import { openPmToolBridge, pmToolRoutes } from "./pm-tools.ts";

const workspaceId = randomUUID();
const actorId = randomUUID(), target = { workspaceId, projectId: null };
const fileArea = { path: null, status: "unconfigured" as const, revision: 0, source: null, canManage: false };
const headers = { cookie: "pm_v4_session=fixture" };

type PmCall = { operationId: string; name: string; arguments: unknown; threadId: string };

async function fixture(mode: () => "success" | "unknown") {
  const directory = await mkdtemp(path.join(tmpdir(), "pm-tool-approval-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousUrl = process.env.PM_API_URL;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  const calls: PmCall[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/v1/agent-contexts") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ workspaces: [{ id: workspaceId, name: "Workspace", fileArea, projects: [] }] }));
      return;
    }
    let text = ""; for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as PmCall & { messageId: string; generationId: string };
    if (url.pathname === "/api/v1/agent-contexts/authorize") {
      const scope = body as unknown as { workspaceId: string; projectId: string | null };
      res.setHeader("content-type", "application/json");
      if (scope.workspaceId !== workspaceId) { res.writeHead(403).end(JSON.stringify({ error: "forbidden" })); return; }
      res.end(JSON.stringify({ actorId, scope })); return;
    }
    assert.ok(url.pathname.endsWith("/agent-tools/call"));
    calls.push({ operationId: body.operationId, name: body.name, arguments: body.arguments, threadId: body.threadId });
    if (mode() === "unknown") { req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      operationId: body.operationId, name: body.name, status: "succeeded",
      result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] },
      error: null, threadId: body.threadId, messageId: body.messageId, generationId: body.generationId,
      workspaceId, target, actorId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
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
  return { calls, close };
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
    const input = { operationId, name: "pm_archive_task", target, arguments: { id: "TASK-1", revision: "rev-1" } };
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

    const conflict = await send({ ...input, arguments: { id: "TASK-1", revision: "rev-2" } });
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
    assert.deepEqual(calls[0], { operationId, name: "pm_archive_task", arguments: { id: "TASK-1", revision: "rev-1" }, threadId: "approval-thread" });

    const doubleApprove = await pmToolRoutes.request(`http://localhost/pm-tools/calls/${operationId}/approve`, { method: "POST", headers });
    assert.equal(doubleApprove.status, 409);
    assert.equal(calls.length, 1);

    live = true;
    const rejectedId = randomUUID();
    const rejectedPending = await send({ operationId: rejectedId, name: "pm_delete_task", target, arguments: { id: "TASK-2", revision: "rev-1" } });
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
    const direct = await send({ operationId: directId, name: "pm_create_task", target, arguments: { projectId: "PRJ-1", title: "Direct" } });
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
    const response = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, name: "pm_delete_task", target, arguments: { id: "TASK-4", revision: "rev-1" } }) });
    assert.equal(response.status, 200);
    const record = await response.json() as PmToolCallRecord;
    assert.equal(record.status, "succeeded");
    assert.equal(record.error, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { operationId, name: "pm_delete_task", arguments: { id: "TASK-4", revision: "rev-1" }, threadId: "auto-thread" });
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
    const created = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, name: "pm_transition_task", target, arguments: { id: "TASK-3", revision: "rev-1", status: "done" } }) });
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

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
    assert.ok(url.pathname.endsWith("/agent-tools/call"));
    calls.push({ operationId: body.operationId, name: body.name, arguments: body.arguments, threadId: body.threadId });
    if (mode() === "unknown") { req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      operationId: body.operationId, name: body.name, status: "succeeded",
      result: { kind: "task", items: [], nextCursor: null, truncated: false, sources: [] },
      error: null, threadId: body.threadId, messageId: body.messageId, generationId: body.generationId,
      workspaceId, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
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
  ensureThread("approval-thread", "Approval", { workspaceId, projectId: null });
  ensureThread("other-thread", "Other", { workspaceId, projectId: null });
  const bridge = await openPmToolBridge({ scope: { workspaceId, projectId: null }, threadId: "approval-thread", messageId: "approval-message", generationId, headers: new Headers(headers) });
  const send = async (input: unknown) => {
    const response = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as PmToolCallRecord };
  };
  try {
    const operationId = randomUUID();
    const input = { operationId, name: "pm_archive_task", arguments: { id: "TASK-1", revision: "rev-1" } };
    const pending = await send(input);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, "pending_approval");
    assert.equal(pending.body.result, null);
    assert.equal(pending.body.error, null);
    assert.equal(calls.length, 0);

    const repeated = await send(input);
    assert.deepEqual(repeated.body, pending.body);
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
    ensureThread("foreign-thread", "Foreign", { workspaceId: foreignWorkspaceId, projectId: null });
    writeRecord("pm-tool-calls", foreignId, {
      record: {
        operationId: foreignId, name: "pm_archive_task", status: "pending_approval", result: null, error: null,
        threadId: "foreign-thread", messageId: "m", generationId: "g", workspaceId: foreignWorkspaceId,
        createdAt: new Date().toISOString(), finishedAt: null,
      },
      request: { operationId: foreignId, name: "pm_archive_task", arguments: { id: "TASK-9", revision: "rev-1" }, scope: { kind: "workspace", projectIds: [] }, threadId: "foreign-thread", messageId: "m", generationId: "g" },
    });
    assert.equal((await pmToolRoutes.request("http://localhost/pm-tools/threads/foreign-thread/calls", { headers })).status, 403);
    assert.equal((await pmToolRoutes.request(`http://localhost/pm-tools/calls/${foreignId}/approve`, { method: "POST", headers })).status, 403);
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

    const rejectedId = randomUUID();
    const rejectedPending = await send({ operationId: rejectedId, name: "pm_delete_task", arguments: { id: "TASK-2", revision: "rev-1" } });
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
    const direct = await send({ operationId: directId, name: "pm_create_task", arguments: { projectId: "PRJ-1", title: "Direct" } });
    assert.equal(direct.body.status, "succeeded");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.operationId, directId);
  } finally {
    await bridge.close();
    await close();
  }
});

test("an unknown PM outcome after approval stays unknown and is never redispatched", async () => {
  const { calls, close } = await fixture(() => "unknown");
  const generationId = randomUUID();
  initializeNativeOutput(generationId, "unknown-thread", "running");
  ensureThread("unknown-thread", "Unknown", { workspaceId, projectId: null });
  const bridge = await openPmToolBridge({ scope: { workspaceId, projectId: null }, threadId: "unknown-thread", messageId: "unknown-message", generationId, headers: new Headers(headers) });
  try {
    const operationId = randomUUID();
    const created = await fetch(`${bridge.url}/tools/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, name: "pm_transition_task", arguments: { id: "TASK-3", revision: "rev-1", status: "done" } }) });
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

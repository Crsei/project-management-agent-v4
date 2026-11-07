import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStore, writeRecord } from "../durable/store.ts";
import { digest, opaque, putGrant, MCP_TOKENS, MCP_GRANTS, type Grant } from "./grants.ts";
import { closeMcpServer, mcpRoutes, startMcpServer } from "./server.ts";
import { verifyMcpServiceBearer } from "../../../../../packages/infrastructure/src/mcp-service-auth.ts";

async function rpcBody(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").find(line => line.startsWith("data: "))?.slice(6) : text;
  assert.ok(json, text); return JSON.parse(json) as Record<string, any>;
}
test("Effect HTTP MCP initializes, isolates sessions, lists/calls/pings, terminates and fences shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-http-"));
  const keys = ["AGENT_WORKSPACE_DATA_DIR", "PM_API_URL", "PM_AUTOMATION_SERVICE_SECRET", "MCP_PUBLIC_ORIGIN"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory; process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-http-test-secret-at-least-32-bytes"; process.env.MCP_PUBLIC_ORIGIN = "https://mcp.example.test";
  const workspaceId = randomUUID(), actorId = randomUUID();
  const fileArea = { path: null, status: "unconfigured", revision: 0, source: null, canManage: false };
  let workspaceAllowed = true, actorActive = true;
  const pm = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const identity = verifyMcpServiceBearer((request.headers.authorization ?? "").slice(7));
    if (!identity || identity.actorId !== actorId || !actorActive) {
      response.writeHead(401).end(JSON.stringify({ error: "Current PM actor is not authorized" })); return;
    }
    response.end(JSON.stringify(request.url === "/api/v1/agent-contexts"
      ? { workspaces: [{ id: workspaceId, name: "Scope", workspaceAllowed, fileArea, projects: [] }] }
      : { tools: [] }));
  });
  const listening = Promise.withResolvers<void>(); pm.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = pm.address(); assert.ok(address && typeof address !== "string"); process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const grant: Grant = { grantId: randomUUID(), actorId, scope: { workspaceId, projectId: null }, access: "read-only", threadIds: [], version: 1, clientHash: "fixture", clientName: "Fixture", audience: "https://mcp.example.test/mcp", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null };
  const token = `pm-mcp-access-v1.${opaque()}`, otherToken = `pm-mcp-access-v1.${opaque()}`;
  const issue = (value: Grant, accessToken: string) => { putGrant(value); const key = digest(accessToken); writeRecord(MCP_TOKENS, key, { key, grantId: value.grantId, audience: value.audience, expiresAt: Date.now() + 600000 }); };
  const headers = (session?: string, bearer = token) => ({ authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream", "content-type": "application/json", ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" } : {}) });
  const post = (body: unknown, session?: string, bearer = token) => mcpRoutes.request("https://mcp.example.test/mcp", { method: "POST", headers: headers(session, bearer), body: JSON.stringify(body) });
  try {
    issue(grant, token); issue({ ...grant, grantId: randomUUID() }, otherToken); startMcpServer();
    const missing = await mcpRoutes.request("https://untrusted-host.test/mcp", { method: "POST", body: "{}" });
    assert.equal(missing.status, 401); assert.match(missing.headers.get("www-authenticate")!, /https:\/\/mcp.example.test\/\.well-known/); assert.ok(!missing.headers.get("www-authenticate")!.includes("untrusted-host"));
    const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "boundary-client", version: "1" } } });
    assert.equal(initialized.status, 200); const session = initialized.headers.get("mcp-session-id"); assert.ok(session);
    assert.equal((await rpcBody(initialized)).result.protocolVersion, "2025-06-18");
    const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session); assert.equal(notification.status, 202);
    const listed = await rpcBody(await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session));
    assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "t3_thread_read")); assert.ok(!listed.result.tools.some((tool: { name: string }) => tool.name === "t3_thread_send"));
    const called = await rpcBody(await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "t3_thread_list", arguments: {} } }, session));
    assert.deepEqual(JSON.parse(called.result.content[0].text).threads, []);
    const ping = await rpcBody(await post({ jsonrpc: "2.0", id: 4, method: "ping", params: {} }, session)); assert.deepEqual(ping.result, {});
    const unknown = await rpcBody(await post({ jsonrpc: "2.0", id: 5, method: "unknown/method", params: {} }, session)); assert.ok(unknown.error);
    const crossed = await post({ jsonrpc: "2.0", id: 6, method: "ping", params: {} }, session, otherToken); assert.equal(crossed.status, 404);
    workspaceAllowed = false;
    assert.equal((await post({ jsonrpc: "2.0", id: "membership-revoked", method: "ping", params: {} }, session)).status, 401);
    workspaceAllowed = true;
    actorActive = false;
    assert.equal((await post({ jsonrpc: "2.0", id: "actor-revoked", method: "ping", params: {} }, session)).status, 401);
    actorActive = true;
    assert.deepEqual((await rpcBody(await post({ jsonrpc: "2.0", id: "restored", method: "ping", params: {} }, session))).result, {});
    const terminated = await mcpRoutes.request("https://mcp.example.test/mcp", { method: "DELETE", headers: headers(session) }); assert.ok(terminated.ok);
    assert.equal((await post({ jsonrpc: "2.0", id: 7, method: "ping", params: {} }, session)).status, 404);
    writeRecord(MCP_GRANTS, grant.grantId, { ...grant, revokedAt: new Date().toISOString(), version: 2 });
    assert.equal((await post({ jsonrpc: "2.0", id: 8, method: "ping", params: {} }, session)).status, 401);
    const closing = closeMcpServer(); assert.equal((await post({ jsonrpc: "2.0", id: 9, method: "ping" })).status, 503); await closing;
    startMcpServer(); assert.equal((await post({ jsonrpc: "2.0", id: 10, method: "ping" })).status, 401);
  } finally {
    await closeMcpServer(); pm.closeAllConnections(); const closed = Promise.withResolvers<void>(); pm.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise; closeStore();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});

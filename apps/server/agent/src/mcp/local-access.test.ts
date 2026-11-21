import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeStore, listRecords } from "../durable/store.ts";
import { verifyMcpServiceBearer } from "../../../../../packages/infrastructure/src/mcp-service-auth.ts";
import { mcpOAuthRoutes } from "./routes.ts";
import { closeMcpServer, mcpRoutes, startMcpServer } from "./server.ts";
import { MCP_GRANTS, type Grant } from "./grants.ts";
import { localCatalog, localContext, localIdentityForTarget, readLocalBinding } from "./local-access.ts";
import { listMcpTools } from "./tools.ts";

const origin = "http://127.0.0.1:3224";
const actorId = randomUUID();
const workspaceOne = randomUUID(), workspaceTwo = randomUUID();
const fileArea = { path: null, status: "unconfigured", revision: 0, source: null, canManage: false };
const catalog = {
  workspaces: [
    { id: workspaceOne, name: "Workspace one", workspaceAllowed: true, fileArea,
      projects: [{ id: "PRJ-001", name: "One", fileArea }, { id: "PRJ-002", name: "Two", fileArea }] },
    { id: workspaceTwo, name: "Workspace two", workspaceAllowed: false, fileArea,
      projects: [{ id: "PRJ-003", name: "Three", fileArea }] },
  ],
};
const keys = ["AGENT_WORKSPACE_DATA_DIR", "PM_API_URL", "PM_AUTOMATION_SERVICE_SECRET", "MCP_PUBLIC_ORIGIN", "MCP_LOCAL_ACCESS"] as const;
let directory: string, previous: Record<string, string | undefined>, pm: Server;
const signedScopes: { workspaceId: string; projectId: string | null }[] = [];
beforeEach(async () => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = await mkdtemp(join(tmpdir(), "mcp-local-access-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-local-mcp-test-secret-32-bytes";
  process.env.MCP_PUBLIC_ORIGIN = origin;
  delete process.env.MCP_LOCAL_ACCESS;
  pm = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/auth/me") {
      response.end(JSON.stringify({ actor: { id: actorId, name: "Local operator" } }));
      return;
    }
    if (request.url === "/api/v1/agent-contexts" && request.method === "GET") {
      const bearer = request.headers.authorization ?? "";
      if (!bearer) { response.end(JSON.stringify(catalog)); return; }
      const identity = verifyMcpServiceBearer(bearer.slice(7));
      if (!identity || identity.actorId !== actorId) { response.writeHead(401).end(JSON.stringify({ error: "bad delegation" })); return; }
      signedScopes.push({ ...identity.scope });
      const workspace = catalog.workspaces.find(item => item.id === identity.scope.workspaceId);
      if (!workspace) { response.writeHead(404).end(JSON.stringify({ error: "missing" })); return; }
      response.end(JSON.stringify({ workspaces: [{ ...workspace,
        workspaceAllowed: identity.scope.projectId === null && workspace.workspaceAllowed,
        projects: identity.scope.projectId === null ? workspace.projects : workspace.projects.filter(project => project.id === identity.scope.projectId) }] }));
      return;
    }
    if (request.url === "/api/v1/agent-tools" && request.method === "GET") {
      const identity = verifyMcpServiceBearer((request.headers.authorization ?? "").slice(7));
      if (!identity) { response.writeHead(401).end(JSON.stringify({ error: "bad delegation" })); return; }
      signedScopes.push({ ...identity.scope });
      response.end(JSON.stringify({ tools: [
        { name: "pm_query", write: false, inputSchema: { type: "object", properties: { target: { type: "object" }, arguments: { type: "object" } }, required: ["target", "arguments"] } },
        { name: "pm_delete_task", write: true, inputSchema: { type: "object", properties: { target: { type: "object" }, arguments: { type: "object" } }, required: ["target", "arguments"] } },
      ] }));
      return;
    }
    if (request.url === "/api/v1/agent-contexts/authorize") {
      let body = ""; for await (const chunk of request) body += String(chunk);
      response.end(JSON.stringify({ actorId, scope: JSON.parse(body) })); return;
    }
    if (request.url === "/api/v1/internal/agent-tools/reconcile") {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const proof = JSON.parse(body) as { operationId: string; actorId: string; target: unknown; requestHash: string };
      response.end(JSON.stringify({ ...proof, status: "unknown", evidence: "unresolved", commandIds: [] })); return;
    }
    if (request.url?.endsWith("/call") || request.url?.endsWith("/result")) {
      const identity = verifyMcpServiceBearer((request.headers.authorization ?? "").slice(7));
      if (identity) signedScopes.push({ ...identity.scope });
      request.resume();
      response.writeHead(503).end(JSON.stringify({ error: "transport interrupted" })); return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "unexpected" }));
  });
  const listening = Promise.withResolvers<void>();
  pm.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = pm.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await closeMcpServer(); closeStore();
  const closed = Promise.withResolvers<void>(); pm.close(() => closed.resolve()); await closed.promise;
  await rm(directory, { recursive: true, force: true });
  for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const localRoutes = new Hono().route("/", mcpOAuthRoutes);
const cookie = { cookie: "pm_v4_session=valid-test-session" };
async function enable() {
  const current = await localRoutes.request(`${origin}/api/mcp/local-access`, { headers: cookie });
  assert.equal(current.status, 200, await current.clone().text());
  const state = await current.json() as { csrfToken: string };
  const enabled = await localRoutes.request(`${origin}/api/mcp/local-access`, { method: "POST",
    headers: { ...cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ csrfToken: state.csrfToken }) });
  assert.equal(enabled.status, 200);
  return state;
}
async function rpc(body: unknown, session?: string) {
  const response = await mcpRoutes.request(`${origin}/mcp`, { method: "POST",
    headers: { host: "127.0.0.1:3224", accept: "application/json, text/event-stream", "content-type": "application/json",
      ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" } : {}) }, body: JSON.stringify(body) });
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find(line => line.startsWith("data: "))?.slice(6) : text;
  return { response, text, body: json ? JSON.parse(json) as Record<string, any> : undefined };
}
test("local access binds every authorized workspace/project without OAuth and scopes each PM call", async () => {
  await enable();
  const binding = readLocalBinding();
  assert.ok(binding);
  assert.equal(binding.actorId, actorId);
  assert.equal(binding.catalog.workspaces.length, 2);
  assert.deepEqual(binding.grants.map(ref => `${ref.workspaceId}:${ref.projectId ?? "*"}`).sort(), [
    `${workspaceOne}:*`, `${workspaceTwo}:PRJ-003`,
  ].sort());
  const grants = listRecords<Grant>(MCP_GRANTS).filter(grant => grant.origin === "local");
  assert.equal(grants.length, 2);
  assert.ok(grants.every(grant => grant.access === "full" && grant.expiresAt.startsWith("9999-")));

  const context = localContext(binding);
  const live = await localCatalog(context);
  assert.deepEqual(live.workspaces.map(workspace => workspace.id).sort(), [workspaceOne, workspaceTwo].sort());
  assert.deepEqual(live.workspaces.find(workspace => workspace.id === workspaceOne)?.projects.map(project => project.id), ["PRJ-001", "PRJ-002"]);
  const scoped = localIdentityForTarget(context, { workspaceId: workspaceTwo, projectId: "PRJ-003" });
  assert.deepEqual(scoped.scope, { workspaceId: workspaceTwo, projectId: "PRJ-003" });
  assert.throws(() => localIdentityForTarget(context, { workspaceId: workspaceTwo, projectId: "PRJ-001" }), /outside the enabled local Agent access/);
  const workspaceWide = localIdentityForTarget(context, { workspaceId: workspaceOne, projectId: "PRJ-002" });
  assert.deepEqual(workspaceWide.scope, { workspaceId: workspaceOne, projectId: null });

  const tools = await listMcpTools(context);
  assert.ok(tools.some(tool => tool.name === "pm_list_workspaces"));
  assert.ok(tools.some(tool => tool.name === "pm_query"));
  assert.ok(tools.some(tool => tool.name === "t3_project_list"));
  assert.ok(!tools.some(tool => tool.name.startsWith("t3_thread_")));

  startMcpServer();
  const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-agent", version: "1" } } });
  assert.equal(initialized.response.status, 200, initialized.text);
  const session = initialized.response.headers.get("mcp-session-id"); assert.ok(session);
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
  const listedBody = listed.body!;
  assert.ok(listedBody.result.tools.some((tool: { name: string }) => tool.name === "pm_query"));
  assert.ok(!listedBody.result.tools.some((tool: { name: string }) => tool.name === "t3_thread_read"));

  const workspaces = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pm_list_workspaces", arguments: { arguments: {} } } }, session);
  const discovery = JSON.parse(workspaces.body!.result.content[0].text) as { items: { id: string; projects: { id: string }[] }[] };
  assert.deepEqual(discovery.items.map(workspace => workspace.id).sort(), [workspaceOne, workspaceTwo].sort());

  const projects = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "t3_project_list", arguments: {} } }, session);
  const flat = JSON.parse(projects.body!.result.content[0].text) as { projects: { id: string; workspaceId: string }[] };
  assert.deepEqual(flat.projects.map(project => project.id).sort(), ["PRJ-001", "PRJ-002", "PRJ-003"].sort());
  assert.equal(flat.projects.find(project => project.id === "PRJ-003")?.workspaceId, workspaceTwo);

  signedScopes.length = 0;
  const operationId = randomUUID();
  await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pm_query",
    arguments: { operationId, target: { workspaceId: workspaceTwo, projectId: "PRJ-003" }, arguments: { entity: null, projectId: "PRJ-003", query: "fixture", after: null, limit: 20 } } } }, session);
  assert.ok(signedScopes.some(scope => scope.workspaceId === workspaceTwo && scope.projectId === "PRJ-003"),
    "the business call uses the project-scoped local grant");

  const disabled = await localRoutes.request(`${origin}/api/mcp/local-access/disable`, { method: "POST",
    headers: { ...cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ csrfToken: (await (await localRoutes.request(`${origin}/api/mcp/local-access`, { headers: cookie })).json() as { csrfToken: string }).csrfToken }) });
  assert.equal(disabled.status, 200);
  const after = await rpc({ jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-agent", version: "1" } } });
  assert.equal(after.response.status, 401);
});

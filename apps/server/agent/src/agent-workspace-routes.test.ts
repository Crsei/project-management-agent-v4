import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { chatOnlyExecutionSelection, type AgentWorkspace, type ExecutionSelection } from "../../../../packages/agent-contracts/src/execution.ts";
import { automationServiceHeaders } from "../../../../packages/infrastructure/src/automation-execution-client.ts";
import { accessGuard } from "./access.ts";
import { agentWorkspaceRoutes, internalAgentWorkspaceRoutes } from "./agent-workspace-routes.ts";
import { closeStore } from "./durable/store.ts";

const app = new Hono()
  .route("/internal/agent-workspaces", internalAgentWorkspaceRoutes)
  .use("/api/*", accessGuard)
  .route("/api", agentWorkspaceRoutes);
const token = "synthetic-agent-access-token-at-least-thirty-two-characters";
const secret = "synthetic-owned-service-secret-at-least-thirty-two-characters";
const keys = ["AGENT_WORKSPACE_DATA_DIR", "AGENT_WORKSPACE_ALLOWED_ROOTS", "AGENT_WORKSPACE_ACCESS_TOKEN", "PM_AUTOMATION_SERVICE_SECRET", "PM_API_URL"] as const;
let previous: Record<string, string | undefined>;
let directory: string;
let repository: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-workspace-routes-"));
  repository = path.join(directory, "allowed", "repository");
  await mkdir(repository, { recursive: true });
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, "store");
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([path.dirname(repository)]);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  process.env.PM_AUTOMATION_SERVICE_SECRET = secret;
  process.env.PM_API_URL = "http://127.0.0.1:1";
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Directory routes must work with PM unavailable."); };
});

afterEach(async () => {
  closeStore();
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rm(directory, { recursive: true, force: true });
});

async function request(route: string, method = "GET", body?: unknown, extraHeaders: HeadersInit = {}): Promise<Response> {
  const headers = new Headers(extraHeaders);
  headers.set("host", "localhost");
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return app.request(`http://localhost${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function open(): Promise<AgentWorkspace> {
  const response = await request("/api/agent-workspaces/open", "POST", { path: repository });
  assert.equal(response.status, 200);
  return (await response.json() as { workspace: AgentWorkspace }).workspace;
}

function selection(workspace: AgentWorkspace): ExecutionSelection {
  return { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
}

async function preflight(body: string, headers = automationServiceHeaders("POST", "/internal/agent-workspaces/resolve", body, secret)): Promise<Response> {
  return app.request("http://localhost/internal/agent-workspaces/resolve", { method: "POST", headers, body });
}

test("Agent-authenticated open/list/browse/CAS works while PM is unreachable", async () => {
  const workspace = await open();
  await symlink(repository, path.join(path.dirname(repository), "alias"), "dir");
  const duplicate = await request("/api/agent-workspaces/open", "POST", { path: path.join(path.dirname(repository), "alias") });
  assert.equal((await duplicate.json() as { workspace: AgentWorkspace }).workspace.id, workspace.id);
  const listing = await request("/api/agent-workspaces");
  assert.equal(listing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listing.json(), { workspaces: [workspace] });
  assert.deepEqual(await (await request("/api/agent-workspaces/directories")).json(), { path: null, parentPath: null, roots: [path.dirname(repository)], directories: [] });
  const browsed = await request(`/api/agent-workspaces/directories?path=${encodeURIComponent(path.dirname(repository))}`);
  assert.equal(browsed.status, 200);
  assert.deepEqual((await browsed.json() as { directories: unknown }).directories, [{ name: "alias", path: repository }, { name: "repository", path: repository }]);
  const rename = await request(`/api/agent-workspaces/${workspace.id}`, "PATCH", { expectedRevision: 1, name: "Renamed" });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json() as { workspace: AgentWorkspace }).workspace.revision, 2);
  assert.equal((await request(`/api/agent-workspaces/${workspace.id}`, "PATCH", { expectedRevision: 1, archived: true })).status, 409);
  const archived = await request(`/api/agent-workspaces/${workspace.id}`, "PATCH", { expectedRevision: 2, archived: true });
  assert.ok((await archived.json() as { workspace: AgentWorkspace }).workspace.archivedAt);
  const reopened = await open();
  assert.equal(reopened.id, workspace.id);
  assert.equal(reopened.archivedAt, null);
});

test("directory APIs preserve Agent authentication, same-origin and delegated-credential boundaries", async () => {
  const unauthorized = await app.request("http://localhost/api/agent-workspaces", { headers: { host: "localhost" } });
  assert.equal(unauthorized.status, 401);
  assert.equal((await request("/api/agent-workspaces/open", "POST", { path: repository }, { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await request("/api/agent-workspaces", "GET", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await request("/api/agent-workspaces", "GET", undefined, { authorization: "Bearer pm-mcp-service-v1.synthetic" })).status, 401);
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  for (const route of ["/api/agent-workspaces", "/api/agent-workspaces/directories"]) {
    assert.equal((await request(route, "GET", undefined, { authorization: "Bearer pm-automation-v1.synthetic" })).status, 403);
    assert.equal((await request(route, "GET", undefined, { "x-pm-automation-signature": "not-directory-access" })).status, 403);
  }
});

test("directory routes reject invalid requests and never create missing folders", async () => {
  assert.equal((await request("/api/agent-workspaces/open", "POST", { path: path.join(path.dirname(repository), "missing") })).status, 412);
  assert.equal((await request("/api/agent-workspaces/open", "POST", { path: directory })).status, 403);
  assert.equal((await request("/api/agent-workspaces/open", "POST", { path: repository, workspaceId: "pm-owner" })).status, 400);
  assert.equal((await request("/api/agent-workspaces/directories?path=relative")).status, 400);
  assert.equal((await request("/api/agent-workspaces/directories?rootId=retired")).status, 400);
  assert.equal((await request("/api/agent-workspaces/absent", "PATCH", { expectedRevision: 1, archived: true })).status, 404);
  assert.equal((await request("/api/agent-workspaces/open", "POST", { path: repository, name: "x".repeat(20_000) })).status, 413);
});

test("private business preflight requires the exact method/path/body HMAC and rejects browser or bearer substitutes", async () => {
  const workspace = await open();
  const body = JSON.stringify({ executionSelection: selection(workspace) });
  const resolved = await preflight(body);
  assert.equal(resolved.status, 200);
  const value = await resolved.json() as { path: string; environment: { agentWorkspaceId: string; executionPath: string } };
  assert.equal(value.path, repository);
  assert.equal(value.environment.agentWorkspaceId, workspace.id);
  assert.equal(value.environment.executionPath, repository);
  assert.equal(resolved.headers.get("cache-control"), "no-store");
  assert.equal((await preflight(body, new Headers({ authorization: `Bearer ${token}`, cookie: "agent_v4_access=not-service-auth" }))).status, 401);
  assert.equal((await preflight(`${body} `, automationServiceHeaders("POST", "/internal/agent-workspaces/resolve", body, secret))).status, 401);
  assert.equal((await preflight(body, automationServiceHeaders("POST", "/wrong-audience", body, secret))).status, 401);
  assert.equal((await preflight(body, automationServiceHeaders("GET", "/internal/agent-workspaces/resolve", body, secret))).status, 401);
  for (const header of ["origin", "sec-fetch-site", "sec-fetch-mode"]) {
    const headers = automationServiceHeaders("POST", "/internal/agent-workspaces/resolve", body, secret);
    headers.set(header, "");
    assert.equal((await preflight(body, headers)).status, 403);
  }
  const chatOnlyBody = JSON.stringify({ executionSelection: chatOnlyExecutionSelection() });
  assert.equal((await preflight(chatOnlyBody)).status, 400);
  const unknownWorkspaceBody = JSON.stringify({ executionSelection: { ...selection(workspace), agentWorkspaceId: "missing" } });
  assert.equal((await preflight(unknownWorkspaceBody)).status, 404);
});

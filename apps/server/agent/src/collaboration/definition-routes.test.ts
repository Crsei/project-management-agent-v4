import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { Hono } from "hono";
import { defaultCollaborationResourceLimits, type AgentConfig, type AgentDefinition, type TeamDefinition } from "../../../../../packages/agent-contracts/src/collaboration.ts";
import { collaborationDefinitionRoutes } from "./definition-routes.ts";
import { accessGuard } from "../access.ts";
import { closeStore } from "../durable/store.ts";
import { getAgentDefinition, getDefinitionRequest } from "./definitions.ts";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const foreignWorkspaceId = "10000000-0000-4000-8000-000000000002";
const actorId = "20000000-0000-4000-8000-000000000001";
const token = "synthetic-definition-access-token-at-least-thirty-two-characters";
const app = new Hono().use("/api/*", accessGuard).route("/api", collaborationDefinitionRoutes);
const keys = ["AGENT_WORKSPACE_DATA_DIR", "AGENT_WORKSPACE_ACCESS_TOKEN", "PM_API_URL"] as const;
let previous: Record<string, string | undefined>;
let directory: string;
let originalFetch: typeof fetch;
let readable: boolean;
let editable: boolean;
let workspaceWide: boolean;
let unavailable: boolean;
let currentActorId: string;
let requests: Array<{ path: string; headers: Headers }>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "collaboration-definition-routes-"));
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  process.env.PM_API_URL = "http://127.0.0.1:1";
  readable = true; editable = true; workspaceWide = true; unavailable = false; currentActorId = actorId; requests = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (unavailable) throw new Error("Synthetic unavailable PM service");
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ path: url.pathname, headers: new Headers(init?.headers) });
    if (!readable) return Response.json({ error: "revoked" }, { status: 403 });
    if (url.pathname === "/api/v1/agent-contexts/authorize") {
      const scope = JSON.parse(String(init?.body)) as { workspaceId: string; projectId: string | null };
      if (scope.workspaceId !== workspaceId || !workspaceWide && scope.projectId === null)
        return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ actorId: currentActorId, scope });
    }
    if (url.pathname === `/api/v1/workspaces/${workspaceId}/agent-capabilities`) {
      const project = url.searchParams.get("projectId");
      if (project && project !== "PRJ-1") return Response.json({ error: "project unavailable" }, { status: 403 });
      return Response.json({ scope: project ? { kind: "projects", projectIds: [project] } : { kind: workspaceWide ? "workspace" : "projects", projectIds: [] }, tools: [
        { name: "pm_create_project", description: "Existing planning capability", write: true, capabilities: ["domain.read", "planning.edit"], allowed: editable, denyReason: editable ? null : "capability_required" },
      ] });
    }
    return Response.json({ error: "Unexpected PM endpoint" }, { status: 500 });
  };
});
afterEach(async () => {
  closeStore(); globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  await rm(directory, { recursive: true, force: true });
});
function config(): AgentConfig {
  return { name: "Developer", role: "Developer", instructions: "Only the explicit task", providerInstanceId: "codex", model: "model", modelOptions: [], interactionMode: "default", temperature: 1,
    owner: { label: "Metadata, not authority", actorId: null }, allowedProjectIds: ["PRJ-1"], capabilityBindings: { restriction: "observe", mcp: [], skills: [], hostTools: ["delegate_task"] },
    resourceLimits: { ...defaultCollaborationResourceLimits }, executionMode: "write" };
}
async function request(route: string, method = "GET", body?: unknown, extraHeaders: HeadersInit = {}): Promise<Response> {
  const headers = new Headers(extraHeaders); headers.set("host", "localhost");
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  headers.set("cookie", "pm_v4_session=synthetic-current-session");
  if (body !== undefined) headers.set("content-type", "application/json");
  return app.request(`http://localhost/api/collaboration${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(id = "developer"): Promise<AgentDefinition> {
  const response = await request("/agents", "POST", { requestId: `create-${id}`, id, workspaceId, config: config() });
  assert.equal(response.status, 200);
  return (await response.json() as { agent: AgentDefinition }).agent;
}

test("HTTP CRUD publishes immutable versions, CAS conflicts and exact read-only request receipts", async () => {
  const agent = await create();
  const listing = await request(`/agents?workspaceId=${workspaceId}`);
  assert.equal(listing.status, 200); assert.equal(listing.headers.get("cache-control"), "no-store");
  assert.equal((await listing.json() as { agents: AgentDefinition[] }).agents.length, 1);
  const edited = await request(`/agents/${agent.id}`, "PUT", { requestId: "edit", revision: 1, config: { ...config(), name: "Edited" } });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json() as { agent: AgentDefinition }).agent.currentVersion, 2);
  assert.equal((await request(`/agents/${agent.id}`, "PUT", { requestId: "stale", revision: 1, state: "disabled" })).status, 409);
  const detail = await request(`/agents/${agent.id}`);
  const versions = await detail.json() as { versions: Array<{ version: number; config: AgentConfig }> };
  assert.deepEqual(versions.versions.map(version => version.version), [2, 1]);
  assert.equal(versions.versions[1]!.config.name, "Developer");
  const receipt = await request(`/requests/edit?workspaceId=${workspaceId}`);
  assert.equal(receipt.status, 200);
  const result = await receipt.json() as { request: { definitionId: string; result: AgentDefinition } };
  assert.equal(result.request.definitionId, agent.id); assert.equal(result.request.result.revision, 2);
  assert.equal((await (await request(`/requests/not-accepted?workspaceId=${workspaceId}`)).json() as { request: unknown }).request, null);
  currentActorId = "20000000-0000-4000-8000-000000000002";
  assert.equal((await (await request(`/requests/edit?workspaceId=${workspaceId}`)).json() as { request: unknown }).request, null);
});

test("copy and restore are idempotent, credential-free and do not overwrite old published configuration", async () => {
  const agent = await create();
  const copiedInput = { requestId: "copy", id: "copied", revision: 1, name: "Copy" };
  const response = await request(`/agents/${agent.id}/copy`, "POST", copiedInput);
  assert.equal(response.status, 200);
  const copy = (await response.json() as { agent: AgentDefinition }).agent;
  assert.equal(copy.config.owner.actorId, null); assert.deepEqual(copy.config.allowedProjectIds, []);
  assert.deepEqual((await (await request(`/agents/${agent.id}/copy`, "POST", copiedInput)).json() as { agent: AgentDefinition }).agent, copy);
  const edited = await request(`/agents/${agent.id}`, "PUT", { requestId: "edit", revision: 1, config: { ...config(), instructions: "v2" } });
  assert.equal(edited.status, 200);
  const restored = await request(`/agents/${agent.id}/restore-version`, "POST", { requestId: "restore", revision: 2, version: 1 });
  assert.equal(restored.status, 200);
  const restoredAgent = (await restored.json() as { agent: AgentDefinition }).agent;
  assert.equal(restoredAgent.currentVersion, 3); assert.equal(restoredAgent.config.instructions, config().instructions);
  const disabled = await request(`/agents/${agent.id}`, "PUT", { requestId: "disable", revision: 3, state: "disabled" });
  assert.equal(disabled.status, 200);
  const archive = await request(`/agents/${agent.id}`, "PUT", { requestId: "archive", revision: 4, state: "archived" });
  assert.equal(archive.status, 200);
  assert.equal((await archive.json() as { agent: AgentDefinition }).agent.state, "archived");
  const replay = await request(`/agents/${agent.id}/restore-version`, "POST", { requestId: "restore", revision: 2, version: 1 });
  assert.equal((await replay.json() as { agent: AgentDefinition }).agent.revision, 3);
  assert.equal(getAgentDefinition(agent.id)!.state, "archived");
});

test("Team endpoints keep member versions fixed and validate Sequential/Supervisor definitions", async () => {
  await create(); await create("reviewer");
  const config = { name: "Team", description: "Fixed members", members: [{ agentId: "developer", agentVersion: 1 }, { agentId: "reviewer", agentVersion: 1 }],
    strategy: "supervisor", supervisorAgentId: "developer", allowedProjectIds: ["PRJ-1"], resourceLimits: { ...defaultCollaborationResourceLimits } };
  const input = { requestId: "team", id: "team", workspaceId, config };
  const created = await request("/teams", "POST", input);
  assert.equal(created.status, 200); assert.equal((await created.json() as { team: TeamDefinition }).team.currentVersion, 1);
  assert.equal((await request("/teams", "POST", { ...input, config: { ...config, name: "Changed" } })).status, 409);
  assert.equal((await request(`/teams?workspaceId=${workspaceId}`)).status, 200);
  assert.equal((await request("/teams/team", "PUT", { requestId: "team-edit", revision: 1, config: { ...config, strategy: "sequential", supervisorAgentId: null } })).status, 200);
  assert.equal((await request("/teams/team/restore-version", "POST", { requestId: "team-restore", revision: 2, version: 1 })).status, 200);
  const copied = await request("/teams/team/copy", "POST", { requestId: "team-copy", id: "team-copy", revision: 3, name: "Copy" });
  assert.equal(copied.status, 200); assert.deepEqual((await copied.json() as { team: TeamDefinition }).team.config.allowedProjectIds, []);
  const detail = await request("/teams/team");
  assert.equal((await detail.json() as { versions: unknown[] }).versions.length, 3);
  const invalid = await request("/teams", "POST", { requestId: "bad-team", id: "bad-team", workspaceId, config: { ...config, members: [{ agentId: "missing", agentVersion: 1 }], strategy: "sequential", supervisorAgentId: null } });
  assert.equal(invalid.status, 412);
  assert.equal(getDefinitionRequest("bad-team", { workspaceId, actorId }), null);
});

test("every request rechecks current PM authority, edit capability and workspace scope", async () => {
  const agent = await create();
  assert.ok(requests.some(call => call.path === "/api/v1/agent-contexts/authorize"));
  assert.ok(requests.every(call => call.headers.get("cookie") === "pm_v4_session=synthetic-current-session"));
  editable = false;
  assert.equal((await request(`/agents/${agent.id}`)).status, 200);
  assert.equal((await request(`/agents/${agent.id}`, "PUT", { requestId: "forbidden-edit", revision: 1, state: "disabled" })).status, 403);
  assert.equal(getAgentDefinition(agent.id)!.revision, 1);
  readable = false;
  assert.equal((await request(`/agents/${agent.id}`)).status, 403);
  assert.equal((await request(`/requests/create-${agent.id}?workspaceId=${workspaceId}`)).status, 403);
  assert.equal((await request("/agents", "POST", { requestId: "create-developer", id: agent.id, workspaceId, config: config() })).status, 403);
  readable = true; workspaceWide = false;
  assert.equal((await request(`/agents?workspaceId=${workspaceId}`)).status, 403);
  workspaceWide = true; unavailable = true;
  assert.equal((await request(`/agents/${agent.id}`)).status, 503);
});

test("references cannot grant cross-workspace/project access and client actor/grant/secret fields are rejected", async () => {
  assert.equal((await request("/agents", "POST", { requestId: "foreign", id: "foreign", workspaceId: foreignWorkspaceId, config: { ...config(), allowedProjectIds: [] } })).status, 403);
  assert.equal((await request("/agents", "POST", { requestId: "forbidden-project", id: "forbidden-project", workspaceId, config: { ...config(), allowedProjectIds: ["PRJ-99"] } })).status, 403);
  const valid = { requestId: "valid", id: "developer", workspaceId, config: config() };
  assert.equal((await request("/agents", "POST", { ...valid, actorId })).status, 400);
  assert.equal((await request("/agents", "POST", { ...valid, config: { ...config(), authorization: "Bearer must-not-persist" } })).status, 400);
  assert.equal((await request("/agents", "POST", { ...valid, executionGrantId: "fake-grant" })).status, 400);
  assert.equal((await request(`/agents?workspaceId=${workspaceId}&actorId=${actorId}`)).status, 400);
  assert.equal(getAgentDefinition("developer"), null);
});

test("Agent access and origin guards remain mandatory independently of PM login", async () => {
  const unauthorized = await app.request(`http://localhost/api/collaboration/agents?workspaceId=${workspaceId}`, { headers: { host: "localhost" } });
  assert.equal(unauthorized.status, 401);
  assert.equal((await request(`/agents?workspaceId=${workspaceId}`, "GET", undefined, { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await request(`/agents?workspaceId=${workspaceId}`, "GET", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  assert.equal((await request(`/agents?workspaceId=${workspaceId}`, "GET", undefined, { authorization: "Bearer pm-automation-v1.synthetic" })).status, 403);
  assert.equal((await request(`/agents?workspaceId=${workspaceId}`, "GET", undefined, { "x-pm-automation-signature": "not-definition-authority" })).status, 403);
});

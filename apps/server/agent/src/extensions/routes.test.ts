import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { accessGuard } from "../access.ts";
import { automationServiceHeaders } from "../../../../../packages/infrastructure/src/automation-execution-client.ts";
import { extensionDefinitionRoutes, extensionRoutes } from "./routes.ts";
import { stopExtensionHost } from "./service.ts";
import { createProviderInstance, getStoredInstance, listStoredInstances, updateProviderInstance } from "../providers/instances.ts";
import { projectExtensionContextId, readExtensionContexts, saveExtensionContexts } from "./storage.ts";

const app = new Hono().route("/internal/extensions/definitions", extensionDefinitionRoutes).use("/api/*", accessGuard).route("/api", extensionRoutes);
test("cross-origin requests, MCP bearers and PM service credentials cannot enter global management", async () => {
  const previous = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  try {
    const url = "http://127.0.0.1/api/extensions/contexts";
    assert.equal((await app.request(url, { headers: { host: "127.0.0.1", origin: "https://evil.invalid" } })).status, 403);
    assert.equal((await app.request(url, { headers: { host: "127.0.0.1", authorization: "Bearer pm-mcp-access-v1.synthetic" } })).status, 401);
    assert.equal((await app.request(url, { headers: { host: "127.0.0.1", authorization: "Bearer pm-automation-service-v1.synthetic" } })).status, 403);
    assert.equal((await app.request(url, { headers: { host: "127.0.0.1", "x-pm-automation-signature": "synthetic" } })).status, 403);
  } finally { if (previous === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = previous; }
});
test("registered Provider resolver rejects forged authority and keeps browser access guards", async () => {
  const previous = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  const url = "http://127.0.0.1/api/extensions/providers/unknown/context";
  try {
    const request = (body: unknown, extra: Record<string, string> = {}) => app.request(url, {
      method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", ...extra }, body: JSON.stringify(body),
    });
    assert.equal((await request({}, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await request({}, { authorization: "Bearer pm-mcp-access-v1.synthetic" })).status, 401);
    assert.equal((await request({}, { "x-pm-automation-signature": "synthetic" })).status, 403);
    for (const forged of [{ confirmed: true }, { homeDir: "/tmp/forged" }, { externalTargetIds: ["one"] }, { providerInstanceIds: ["other"] }]) {
      const response = await request(forged);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "invalid_request");
    }
  } finally { if (previous === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = previous; }
});

test("enabled-context API scopes saved native authority and rejects substitution or forged enrollment", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-saved-context-route-"));
  const url = "http://127.0.0.1/api/extensions/contexts/resolve-enabled";
  const request = (body: unknown, extra: Record<string, string> = {}) => app.request(url, {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", ...extra }, body: JSON.stringify(body),
  });
  try {
    delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CC_SWITCH_EXTERNAL_TARGETS_FILE"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    const scope = { actorId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", projectId: "PRJ-001" };
    const projectId = projectExtensionContextId(scope);
    await saveExtensionContexts([{ id: projectId, label: "Private project", kind: "project", scope, createdAt: "2026-01-01T00:00:00.000Z" }]);
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    const environment = [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }];
    const appDir = path.join(root, "codex-a");
    createProviderInstance({ instanceId: "route-saved-a", driver: "codex", config: { homePath: appDir }, environment });
    const initial = await request({});
    assert.equal(initial.status, 200);
    const a = (await initial.json() as { contexts: Array<{ id: string }> }).contexts[0]!;
    createProviderInstance({ instanceId: "route-new-opencode", driver: "opencode", environment });
    assert.equal((await request({ contextId: a.id }, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await request({ contextId: a.id }, { authorization: "Bearer pm-mcp-access-v1.synthetic" })).status, 401);
    assert.equal((await request({ contextId: a.id }, { "x-pm-automation-signature": "synthetic" })).status, 403);
    for (const forged of [{ contextId: a.id, confirmed: true }, { contextId: a.id, homeDir: "/tmp/forged" }, { contextId: a.id, externalTargetIds: ["other"] }, { contextId: a.id, providerInstanceIds: ["other"] }, { contextId: null }, { contextId: "" }]) {
      const response = await request(forged);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "invalid_request");
    }
    for (const contextId of ["unknown", projectId]) {
      const response = await request({ contextId });
      assert.equal(response.status, 404);
      assert.equal((await response.json() as { code: string }).code, "native_context_not_found");
    }
    const scoped = await request({ contextId: a.id });
    assert.equal(scoped.status, 200);
    assert.deepEqual((await scoped.json() as { contexts: Array<{ id: string }> }).contexts.map(context => context.id), [a.id]);
    assert.equal((await readExtensionContexts()).some(context => context.binding?.providerInstanceIds.includes("route-new-opencode")), false);
    const otherHome = path.join(root, "other-home");
    const conflicting = createProviderInstance({ instanceId: "route-conflicting", driver: "codex", config: { homePath: appDir }, environment: [{ name: "HOME", value: otherHome, sensitive: false }, { name: "USERPROFILE", value: otherHome, sensitive: false }] });
    const beforeConflict = await readExtensionContexts();
    const conflict = await request({ contextId: a.id });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, "native_root_owned");
    assert.deepEqual(await readExtensionContexts(), beforeConflict);
    updateProviderInstance(conflicting.instanceId, { enabled: false }, conflicting.revision);
    const current = getStoredInstance("route-saved-a")!;
    const disabled = updateProviderInstance(current.instanceId, { enabled: false }, current.revision);
    const unavailable = await request({ contextId: a.id });
    assert.equal(unavailable.status, 409);
    assert.equal((await unavailable.json() as { code: string }).code, "native_owner_stale");
    assert.deepEqual(await readExtensionContexts(), beforeConflict);
    updateProviderInstance(current.instanceId, { enabled: true, config: { homePath: path.join(root, "codex-moved") } }, disabled.revision);
    const stale = await request({ contextId: a.id });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, "native_owner_stale");
    assert.deepEqual(await readExtensionContexts(), beforeConflict);
    // Global discovery remains available only as a separate, explicit request.
    const global = await request({});
    assert.equal(global.status, 200);
    assert.equal((await global.json() as { contexts: Array<{ id: string }> }).contexts.some(context => context.id === a.id), false);
  } finally {
    await stopExtensionHost();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("private service control requires body/path-bound HMAC and rejects browser-origin even with a valid signature", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-route-fixture-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  process.env.PM_AUTOMATION_SERVICE_SECRET = "synthetic-test-service-key-that-is-at-least-thirty-two-characters";
  const body = JSON.stringify({ migrationId: "c".repeat(64) });
  const pathname = "/internal/extensions/definitions/begin-maintenance";
  try {
    const unsigned = await app.request(`http://127.0.0.1${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(unsigned.status, 401);
    const browserHeaders = automationServiceHeaders("POST", pathname, body);
    browserHeaders.set("origin", "http://127.0.0.1");
    assert.equal((await app.request(`http://127.0.0.1${pathname}`, { method: "POST", headers: browserHeaders, body })).status, 403);
    assert.equal((await app.request(`http://127.0.0.1${pathname}`, { method: "POST", headers: automationServiceHeaders("POST", pathname, body), body })).status, 200);
    const end = "/internal/extensions/definitions/end-maintenance";
    assert.equal((await app.request(`http://127.0.0.1${end}`, { method: "POST", headers: automationServiceHeaders("POST", pathname, body), body })).status, 401);
    assert.equal((await app.request(`http://127.0.0.1${end}`, { method: "POST", headers: automationServiceHeaders("POST", end, body), body })).status, 200);
  } finally {
    await stopExtensionHost();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("browser import cutover refuses direct dispatch and forged review/config/path authority before context access", async () => {
  const previous = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  const url = "http://127.0.0.1/api/extensions/contexts/untrusted/invoke";
  try {
    const obsolete = await app.request(url, { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ command: "import_mcp_from_apps", args: {} }) });
    assert.equal(obsolete.status, 403);
    const rejected: unknown = await obsolete.json();
    assert.ok(rejected && typeof rejected === "object" && "code" in rejected);
    assert.equal(rejected.code, "command_not_allowed");
    const forgeries = [
      { command: "preview_mcp_import", args: { homeDir: "/private/unbound-home" } },
      { command: "save_mcp_definition", args: { definition: { id: "one", name: "One", server: {}, apps: { claude: true } } } },
      { command: "set_mcp_agent_configuration", args: { serverId: "one", app: "claude", enabled: true, effective: { command: "injected" } } },
      { command: "apply_mcp_import", args: { previewId: "review", selections: [{ entryId: "entry", resolution: "import", definition: { id: "injected", server: {} } }] } },
      { command: "apply_mcp_import", args: { previewId: "review", selections: [{ entryId: "entry", resolution: "import" }, { entryId: "entry", resolution: "skip" }] } },
    ];
    for (const body of forgeries) {
      const response = await app.request(url, { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      const result: unknown = await response.json();
      assert.ok(result && typeof result === "object" && "code" in result);
      assert.equal(result.code, "invalid_request");
      assert.equal(JSON.stringify(result).includes("/private/unbound-home"), false);
    }
  } finally { if (previous === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = previous; }
});

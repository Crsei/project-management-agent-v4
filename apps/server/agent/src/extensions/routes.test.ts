import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { accessGuard } from "../access.ts";
import { automationServiceHeaders } from "../../../../../packages/infrastructure/src/automation-execution-client.ts";
import { extensionDefinitionRoutes, extensionRoutes } from "./routes.ts";
import { stopExtensionHost } from "./service.ts";

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

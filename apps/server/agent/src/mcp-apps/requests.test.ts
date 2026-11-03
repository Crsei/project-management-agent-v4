import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import { mcpAppMetadataSchema, type McpAppMetadata } from "@agent-workspace/contracts/mcp-apps";
import type { ProviderDriverContext } from "../providers/driver-adapter.ts";
import { snapshotMcpApp } from "../providers/t3code/upstream-services/mcp-app-snapshot.ts";
import { providerAttachmentsDirectory } from "../providers/t3code/upstream-services/attachments.ts";
import { emitNativeOutput, endNativeOutput, initializeNativeOutput } from "../durable/native-output.ts";
import { closeStore, readRecord, writeRecord } from "../durable/store.ts";
import { closeMcpAppSession, closeMcpAppSessionsForInstance, invalidateMcpAppGrant, retainMcpAppSession, shutdownMcpApps } from "./live.ts";
import { mcpAppContextForDispatch, mcpAppContextForTurn } from "./context.ts";
import { mcpAppRoutes } from "./routes.ts";
import { DurableError } from "../durable/errors.ts";
import { ensureThread } from "../durable/threads.ts";
import { MCP_GRANTS, type Grant } from "../mcp/grants.ts";
import { verifyMcpServiceBearer } from "../../../../../packages/infrastructure/src/mcp-service-auth.ts";

let directory: string;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalPmUrl = process.env.PM_API_URL;
const originalMcpOrigin = process.env.MCP_PUBLIC_ORIGIN;
const originalServiceSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
const workspaceId = "c951d34a-3d60-4655-b6d0-a55c1367e58d";
let pmServer: Server;
let pmAllowed = true;
const pmRequests: { cookie?: string; scope: unknown }[] = [];
let beforeScopeReply: (() => Promise<void>) | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mcp-app-boundary-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  pmAllowed = true;
  pmRequests.length = 0;
  beforeScopeReply = undefined;
  // A real HTTP authority boundary with a fixed membership/root record, not a
  // request-scope echo. Only this authenticated browser may access this workspace.
  pmServer = createServer(async (request, response) => {
    if (request.url === "/api/v1/agent-contexts" && request.method === "GET") {
      const authorization = request.headers.authorization ?? "";
      const identity = authorization.startsWith("Bearer ") ? verifyMcpServiceBearer(authorization.slice(7)) : null;
      if (!pmAllowed || !identity || identity.actorId !== "6def94b1-26bb-4e22-99d0-1a10321b06be" || identity.scope.workspaceId !== workspaceId) {
        response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        workspaces: [{ id: workspaceId, name: "Authorized fixture workspace", projects: [], workspaceAllowed: true }],
      }));
      return;
    }
    if (request.url !== "/api/v1/agent-contexts/resolve" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const scope = JSON.parse(body) as { workspaceId?: string; projectId?: string | null };
    pmRequests.push({ cookie: request.headers.cookie, scope });
    await beforeScopeReply?.();
    if (!pmAllowed || request.headers.cookie !== "current-browser" || scope.workspaceId !== workspaceId || scope.projectId !== null) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      actorId: "6def94b1-26bb-4e22-99d0-1a10321b06be", scope: { workspaceId, projectId: null },
      path: "/workspace", workspaceName: "Authorized fixture workspace", projectName: null,
    }));
  });
  const listening = Promise.withResolvers<void>();
  pmServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  process.env.PM_API_URL = `http://127.0.0.1:${(pmServer.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await shutdownMcpApps();
  const closing = Promise.withResolvers<void>();
  pmServer.close(error => error ? closing.reject(error) : closing.resolve());
  await closing.promise;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
  if (originalMcpOrigin === undefined) delete process.env.MCP_PUBLIC_ORIGIN;
  else process.env.MCP_PUBLIC_ORIGIN = originalMcpOrigin;
  if (originalServiceSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET;
  else process.env.PM_AUTOMATION_SERVICE_SECRET = originalServiceSecret;
  closeStore();
  await rm(directory, { recursive: true, force: true });
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
});

async function fixture(blockCall?: () => void, externalGrant = false) {
  ensureThread("thread", undefined, { workspaceId, projectId: null });
  let originatingMcpGrant: ProviderDriverContext["originatingMcpGrant"];
  if (externalGrant) {
    process.env.MCP_PUBLIC_ORIGIN = process.env.PM_API_URL;
    process.env.PM_AUTOMATION_SERVICE_SECRET = "isolated-app-grant-fixture-secret-32-bytes";
    const grant: Grant = { grantId: "35b4fce3-ec4e-4c4b-bf6c-8c9e4eae49a1", actorId: "6def94b1-26bb-4e22-99d0-1a10321b06be",
      scope: { workspaceId, projectId: null }, access: "full", threadIds: ["thread"], version: 1, clientHash: "fixture-client-hash",
      clientName: "Fixture client", audience: `${process.env.MCP_PUBLIC_ORIGIN}/mcp`, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null };
    writeRecord(MCP_GRANTS, grant.grantId, grant);
    const { grantId, actorId, scope, access, version } = grant;
    originatingMcpGrant = { grantId, actorId, scope, access, version };
  }
  const reference = await Effect.runPromise(snapshotMcpApp({ attachmentsDir: providerAttachmentsDirectory(),
    threadId: ThreadId.make("thread"), server: "weather", tool: "show", resourceUri: "ui://weather/view",
    contents: [{ uri: "ui://weather/view", mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>weather</p>" }] }));
  assert.ok(reference);
  const app = mcpAppMetadataSchema.parse({ ...reference, producing: { threadId: "thread", itemId: "app-item", generationId: "generation",
    providerInstanceId: "provider", instanceRevision: 2, providerSessionId: "provider-session", providerThreadId: "provider-thread", nativeSessionId: "native-session" } });
  initializeNativeOutput("generation", "thread", "running");
  emitNativeOutput("generation", { type: "item.upsert", item: { id: "app-item", type: "dynamic_tool", status: "completed", toolName: "weather.show",
    input: { city: "Austin" }, output: "historical serialized result", mcpApp: app, mcpToolResult: { content: [{ type: "text", text: "weather result" }] } } });
  endNativeOutput("generation", "completed");
  writeRecord("chat:generations", "generation", { executionSnapshot: { actorId: "6def94b1-26bb-4e22-99d0-1a10321b06be" } });
  writeRecord("chat:generations", "next", { executionSnapshot: { actorId: "6def94b1-26bb-4e22-99d0-1a10321b06be" } });
  let authorized = true;
  let leaseCurrent = true;
  let closed = 0;
  let checks = 0;
  const calls: { server: string; tool: string }[] = [];
  const resources: { server: string; uri: string }[] = [];
  const providerThread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThread))({ id: "provider-thread", driver: "codex", providerInstanceId: "provider",
    providerSessionId: "provider-session", appThreadId: "thread", ownerNodeId: null,
    nativeThreadRef: { driver: "codex", nativeId: "native-session", strength: "strong" }, nativeConversationHeadRef: null,
    status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 1, handoffIds: [], forkedFrom: null,
    createdAt: DateTime.makeUnsafe("2026-11-03T00:00:00.000Z"), updatedAt: DateTime.makeUnsafe("2026-11-03T00:00:00.000Z") });
  retainMcpAppSession({ apps: [app], scope: { workspaceId, projectId: null }, cwd: "/workspace", providerThread, blockedServers: ["pm_tools"], originatingMcpGrant,
    assertCurrent: async () => { if (!leaseCurrent) throw new DurableError(409, "stale_lease", "Stale lease."); },
    authorize: async (headers, identity) => { checks++; assert.deepEqual(identity, app.producing); if (!authorized || headers.get("cookie") !== "current-browser") throw new DurableError(403, "scope_revoked", "Scope revoked."); },
    close: async () => { closed++; }, mcpApps: {
      listTools: () => Effect.succeed([{ name: "refresh", annotations: { readOnlyHint: true } }, { name: "hidden", _meta: { ui: { visibility: ["model"] } } }]),
      callTool: input => Effect.sync(() => {
        calls.push({ server: input.server, tool: input.tool });
        blockCall?.();
        return { content: [{ type: "text", text: "fresh" }] };
      }).pipe(Effect.flatMap(result => blockCall ? Effect.never : Effect.succeed(result))),
      readResource: input => Effect.sync(() => { resources.push({ server: input.server, uri: input.uri }); return { contents: [{ uri: input.uri, text: "resource" }] }; }),
    } });
  return { app, calls, resources, originatingMcpGrant, counts: () => ({ closed, checks }), revoke: () => { authorized = false; }, stale: () => { leaseCurrent = false; } };
}
function request(action: string, body?: unknown, target = "thread/app-item") {
  return mcpAppRoutes.request(`/mcp-apps/${target}/${action}`, { method: body === undefined ? "GET" : "POST",
    headers: { cookie: "current-browser", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

for (const revoked of [false, true]) {
  test(`cancelling an App read during scope authorization ${revoked ? "still revokes denied authority" : "preserves its producing session"}`, { timeout: 2000 }, async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeScopeReply = async () => { entered.resolve(); await release.promise; };
    const controller = new AbortController();
    const reading = mcpAppRoutes.request("/mcp-apps/thread/app-item/snapshot", {
      headers: { cookie: "current-browser" }, signal: controller.signal,
    });
    try {
      await entered.promise;
      controller.abort();
      pmAllowed = !revoked;
      release.resolve();
      const response = await reading;
      assert.equal(response.status, revoked ? 403 : 409);
      if (!revoked) assert.equal((await response.json()).code, "mcp_app_request_cancelled");
      assert.equal(f.counts().closed, revoked ? 1 : 0);
      assert.equal(f.counts().checks, 0, "A cancelled read never reaches retained App operations.");
      assert.deepEqual(f.calls, []);
      beforeScopeReply = undefined;
      pmAllowed = true;
      assert.equal((await request("snapshot")).status, revoked ? 409 : 200,
        "A fresh read works only when authority was not revoked; no new native turn is opened.");
    } finally {
      release.resolve();
      await reading;
    }
  });
}

test("real routes load private CSP HTML and bind native calls/resources to the producing server", async () => {
  const f = await fixture();
  const snapshot = await request("snapshot");
  assert.equal(snapshot.status, 200);
  const data = await snapshot.json();
  assert.match(data.html, /Content-Security-Policy/);
  assert.match(data.html, /event.source !== window.parent/);
  assert.deepEqual(data.toolInput, { city: "Austin" });
  assert.equal(data.toolResult.content[0].text, "weather result");
  assert.equal(snapshot.headers.get("cache-control"), "no-store");
  const tools = await (await request("tools")).json();
  assert.equal(tools.tools.find((tool: { name: string }) => tool.name === "hidden").callable, false);
  assert.equal((await request("call", { name: "hidden", arguments: {} })).status, 403);
  assert.equal((await request("call", { name: "refresh", arguments: {}, server: "foreign" })).status, 400);
  assert.equal((await request("call", { name: "refresh", arguments: {} })).status, 200);
  assert.deepEqual(f.calls, [{ server: "weather", tool: "refresh" }]);
  assert.equal((await request("resource", { uri: "weather://current" })).status, 200);
  assert.deepEqual(f.resources, [{ server: "weather", uri: "weather://current" }]);
  assert.equal((await request("tools", undefined, "other-thread/app-item")).status, 404);
  assert.ok(f.counts().checks >= 10);
});

test("model context replaces/clears, persists once, and enters only a matching authorized next native turn", async () => {
  await fixture();
  assert.equal((await request("context", { content: [{ type: "text", text: "first" }] })).status, 200);
  const second = await request("context", { content: [{ type: "text", text: "latest" }], structuredContent: { city: "Austin" } });
  assert.deepEqual(await second.json(), { revision: 2 });
  const context: ProviderDriverContext = { instanceId: "provider", driver: "codex", revision: 2, config: {}, env: {}, cwd: "/workspace", homeDirectory: "/native", stateDirectory: "/state",
    execution: { threadId: "thread", generationId: "next", messageId: "next-message", scope: { workspaceId, projectId: null } }, authorizeExecution: async () => {}, authorizeMcpApp: async () => {} };
  const source = { providerInstanceId: "provider", driver: "codex" as const, instanceRevision: 2, cwd: "/workspace", sessionId: "native-session" };
  assert.deepEqual(await mcpAppContextForTurn(context, source), [{ key: "mcp_app_app-item", text: 'latest\n{"city":"Austin"}' }]);
  assert.deepEqual(await mcpAppContextForTurn(context, { ...source, sessionId: "foreign" }), []);
  assert.deepEqual(await mcpAppContextForTurn({ ...context, authorizeMcpApp: undefined }, source), []);
  writeRecord("chat:generations", "foreign-actor-turn", { executionSnapshot: { actorId: "another-actor" } });
  assert.deepEqual(await mcpAppContextForTurn({ ...context, execution: { ...context.execution!, generationId: "foreign-actor-turn" } }, source), []);
  assert.equal((await request("context", { content: [{ type: "text", text: "界".repeat(6000) }] })).status, 413);
  assert.deepEqual(await mcpAppContextForTurn(context, source), [{ key: "mcp_app_app-item", text: 'latest\n{"city":"Austin"}' }]);
  assert.deepEqual(await (await request("context", {})).json(), { revision: 3 });
  assert.deepEqual(await mcpAppContextForTurn(context, source), []);
  assert.equal((await request("context", { content: [{ type: "text", text: "preserved" }] })).status, 200);
  await closeMcpAppSession("thread", { preserveContext: true });
  assert.deepEqual(await mcpAppContextForTurn(context, source), [{ key: "mcp_app_app-item", text: "preserved" }]);
  assert.deepEqual(await mcpAppContextForTurn(context, source), [{ key: "mcp_app_app-item", text: "preserved" }], "Context is selected once, never appended.");
  await closeMcpAppSession("thread");
  assert.deepEqual(await mcpAppContextForTurn(context, source), []);
});

test("scope loss, stopped sessions and stale producing identities never reach native callbacks", async () => {
  const f = await fixture();
  f.revoke();
  assert.equal((await request("call", { name: "refresh", arguments: {} })).status, 403);
  await closeMcpAppSession("thread");
  assert.equal((await request("tools")).status, 409);
  assert.equal(f.counts().closed, 1);
  assert.deepEqual(f.calls, []);
  const output = readRecord<{ items: { mcpApp?: McpAppMetadata }[] }>("native-output", "generation")!;
  output.items[0]!.mcpApp!.producing.providerSessionId = "foreign-session";
  writeRecord("native-output", "generation", output);
  assert.equal((await request("tools")).status, 409);
});

test("private snapshots reject same-length tampering rather than serving altered executable bytes", async () => {
  const f = await fixture();
  const file = path.join(providerAttachmentsDirectory(), `${f.app.attachmentId}.html`);
  const snapshot = await request("snapshot");
  assert.equal(snapshot.status, 200);
  const html = await readFile(file, "utf8");
  await writeFile(file, html.replace("weather", "tamper!"));
  assert.equal((await request("snapshot")).status, 409);
});

test("closing a retained session interrupts an in-flight native call and does not replay an unknown write", async () => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture(() => entered.resolve());
  const response = request("call", { name: "refresh", arguments: {} });
  await entered.promise;
  const closing = closeMcpAppSession("thread");
  assert.equal((await response).status, 409);
  await closing;
  assert.deepEqual(f.calls, [{ server: "weather", tool: "refresh" }]);
  assert.equal(f.counts().closed, 1);
  assert.equal((await request("call", { name: "refresh", arguments: {} })).status, 409);
  assert.equal(f.calls.length, 1);
});

test("persisted identity tampering and invalidated leases fail before native tool side effects", async () => {
  const f = await fixture();
  const output = readRecord<{ items: { mcpApp?: McpAppMetadata }[] }>("native-output", "generation")!;
  output.items[0]!.mcpApp!.server = "foreign-server";
  writeRecord("native-output", "generation", output);
  assert.equal((await request("call", { name: "refresh", arguments: {} })).status, 404);
  output.items[0]!.mcpApp = f.app;
  writeRecord("native-output", "generation", output);
  f.stale();
  assert.equal((await request("call", { name: "refresh", arguments: {} })).status, 409);
  await closeMcpAppSession("thread");
  assert.deepEqual(f.calls, []);
  assert.equal(f.counts().closed, 1);
});

test("instance invalidation closes only matching idle Apps and shutdown fences all remaining App requests", async () => {
  const f = await fixture();
  await closeMcpAppSessionsForInstance("other-provider");
  assert.equal((await request("tools")).status, 200);
  await closeMcpAppSessionsForInstance("provider");
  assert.equal((await request("tools")).status, 409);
  assert.equal(f.counts().closed, 1);
  await shutdownMcpApps();
  assert.equal((await request("snapshot")).status, 409);
  assert.deepEqual(f.calls, []);
});

test("known stopped threads still cross the live PM HTTP authorization boundary before returning session-stopped", async () => {
  const f = await fixture();
  await closeMcpAppSession("thread");
  pmAllowed = false;
  assert.equal((await request("snapshot")).status, 403);
  assert.deepEqual(pmRequests.at(-1), { cookie: "current-browser", scope: { workspaceId, projectId: null } });
  pmAllowed = true;
  assert.equal((await request("snapshot")).status, 409);
  assert.equal((await request("tools", undefined, "missing-thread/app-item")).status, 404);
  assert.equal(f.counts().closed, 1);
  assert.deepEqual(f.calls, []);
});

test("browser continuation cannot reuse context from a revoked originating external grant", async () => {
  const f = await fixture(undefined, true);
  assert.equal((await request("context", { content: [{ type: "text", text: "external app state" }] })).status, 200);
  const context: ProviderDriverContext = { instanceId: "provider", driver: "codex", revision: 2, config: {}, env: {}, cwd: "/workspace",
    homeDirectory: "/native", stateDirectory: "/state", execution: { threadId: "thread", generationId: "next", messageId: "browser-message",
      scope: { workspaceId, projectId: null } }, authorizeExecution: async () => {}, authorizeMcpApp: async () => {} };
  const source = { providerInstanceId: "provider", driver: "codex" as const, instanceRevision: 2, cwd: "/workspace", sessionId: "native-session" };
  const selected = await mcpAppContextForTurn(context, source);
  assert.deepEqual(selected, [{ key: "mcp_app_app-item", text: "external app state" }]);
  const grant = readRecord<Grant>(MCP_GRANTS, f.originatingMcpGrant!.grantId)!;
  writeRecord(MCP_GRANTS, grant.grantId, { ...grant, revokedAt: new Date().toISOString(), version: grant.version + 1 });
  assert.deepEqual(mcpAppContextForDispatch(context, source, selected), [], "Revocation after selection must still win at dispatch.");
  assert.deepEqual(await mcpAppContextForTurn(context, source), []);
  await invalidateMcpAppGrant(grant.grantId);
  assert.equal(f.counts().closed, 1);
  assert.equal((await request("tools")).status, 409);
  assert.deepEqual(f.calls, []);
});

test("grant-revocation cleanup immediately removes matching durable context and retained native capability", async () => {
  const f = await fixture(undefined, true);
  assert.equal((await request("context", { content: [{ type: "text", text: "must be removed" }] })).status, 200);
  const grant = readRecord<Grant>(MCP_GRANTS, f.originatingMcpGrant!.grantId)!;
  writeRecord(MCP_GRANTS, grant.grantId, { ...grant, revokedAt: new Date().toISOString(), version: grant.version + 1 });
  await invalidateMcpAppGrant(grant.grantId);
  assert.equal(readRecord("mcp-app-model-context-v1", JSON.stringify(["thread", "app-item"])), null);
  assert.equal((await request("snapshot")).status, 409);
  assert.equal(f.counts().closed, 1);
  assert.deepEqual(f.calls, []);
});

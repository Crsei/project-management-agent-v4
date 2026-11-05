import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { ExtensionHost } from "./service.ts";
import { contextDataDirectory, contextSecretKey, privateDirectory, projectExtensionContextId, readExtensionContexts, saveExtensionContexts } from "./storage.ts";
import { makePrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { createProviderInstance, getStoredInstance } from "../providers/instances.ts";
import { ExtensionSidecar } from "./rpc.ts";
import type { ExtensionEvent, ExtensionMcpImportPreview, ExtensionMcpImportResult, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";

// Requires the real cc-switch-host release binary (or explicit CC_SWITCH_HOST_BINARY).
// No substitute child or fake implementation is used; all native roots and credentials below are synthetic fixtures.
test("two same-Home native contexts stay independent in cc-switch SSOT; Unified is explicit and exclusive", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-host-integration-"));
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    await mkdir(process.env.HOME, { recursive: true });
    const registry = path.join(root, "external-targets.json");
    await writeFile(registry, JSON.stringify([
      { id: "one", label: "Codex one", app: "codex", homeDir: process.env.HOME, appDir: path.join(root, "codex-one") },
      { id: "two", label: "Codex two", app: "codex", homeDir: process.env.HOME, appDir: path.join(root, "codex-two") },
      { id: "alias", label: "Same root", app: "codex", homeDir: process.env.HOME, appDir: path.join(root, "codex-one") },
    ]), { mode: 0o600 });
    makePrivatePath(registry);
    process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE = registry;
    const overlappingProvider = createProviderInstance({ instanceId: "external-codex-overlap", driver: "codex", config: { homePath: path.join(root, "codex-one") }, environment: [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }] });
    const first = (await host.bind({ providerInstanceIds: [], externalTargetIds: ["one"], confirmed: true })).context;
    const second = (await host.bind({ providerInstanceIds: [], externalTargetIds: ["two"], confirmed: true })).context;
    assert.notEqual(first.id, second.id);
    assert.equal(first.status, "stopped");
    await assert.rejects(host.bind({ providerInstanceIds: [], externalTargetIds: ["alias"], confirmed: true }), { code: "native_root_owned" });
    assert.equal((await host.invoke(first.id, "get_settings", {}) as { skillStorageLocation: string }).skillStorageLocation, "cc_switch");
    const changes: Array<Record<string, unknown>> = [];
    const unsubscribe = await host.subscribe(first.id, event => { if (event.event === "changed") changes.push(event.data as Record<string, unknown>); });
    const zip = Buffer.from("UEsDBBQAAAAAAAAAIVzoMMf6fwAAAH8AAAAPAAAAc2FtcGxlL1NLSUxMLm1kLS0tCm5hbWU6IFN5bnRoZXRpYyBzYW1wbGUKZGVzY3JpcHRpb246IE9mZmxpbmUgc291cmNlIGludGVncmF0aW9uIGZpeHR1cmUKLS0tCiMgU3ludGhldGljIHNhbXBsZQpSZWFkLW9ubHkgdGVzdCBpbnN0cnVjdGlvbnMuClBLAQIUAxQAAAAAAAAAIVzoMMf6fwAAAH8AAAAPAAAAAAAAAAAAAACAgQAAAABzYW1wbGUvU0tJTEwubWRQSwUGAAAAAAEAAQA9AAAArAAAAAAA", "base64");
    const upload = await host.upload(first.id, new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(zip); controller.close(); } }));
    const installed = await host.invoke(first.id, "install_skills_from_zip", { uploadId: upload.uploadId, currentApp: "codex" }) as { installed: Array<{ directory: string }> };
    assert.equal(installed.installed.length, 1);
    assert.match(await readFile(path.join(root, "codex-one", "skills", installed.installed[0]!.directory, "SKILL.md"), "utf8"), /Synthetic sample/);
    const change = changes.find(item => item.command === "install_skills_from_zip");
    assert.ok(change && Array.isArray(change.providerInstanceIds) && change.providerInstanceIds.includes("external-codex-overlap"));
    assert.equal(change.liveExecutionsPreserved, true);
    assert.equal(getStoredInstance("external-codex-overlap")?.revision, overlappingProvider.revision);
    unsubscribe();
    assert.equal((await host.invoke(second.id, "get_settings", {}) as { skillStorageLocation: string }).skillStorageLocation, "cc_switch");
    await host.invoke(first.id, "upsert_mcp_server", { server: { id: "private-fixture", name: "Private fixture", server: { type: "http", url: "https://mcp.example.invalid/rpc", headers: { authorization: "synthetic-at-rest-secret" } }, apps: { codex: false } } });
    const listed = await host.invoke(first.id, "get_mcp_servers", {});
    assert.equal(JSON.stringify(listed).includes("synthetic-at-rest-secret"), false);
    assert.deepEqual(await host.invoke(second.id, "get_mcp_servers", {}), {});
    for (const filename of await readdir(contextDataDirectory(first.id))) {
      if (filename.startsWith("cc-switch.db")) assert.equal((await readFile(path.join(contextDataDirectory(first.id), filename))).includes(Buffer.from("synthetic-at-rest-secret")), false);
    }
    await host.invoke(first.id, "migrate_skill_storage", { target: "unified" });
    assert.equal((await host.invoke(first.id, "get_settings", {}) as { skillStorageLocation: string }).skillStorageLocation, "unified");
    await assert.rejects(host.invoke(second.id, "migrate_skill_storage", { target: "unified" }), { code: "unified_root_owned" });
    assert.equal((await host.invoke(second.id, "get_settings", {}) as { skillStorageLocation: string }).skillStorageLocation, "cc_switch");
    assert.equal((await readExtensionContexts()).find(context => context.id === first.id)?.unifiedSkillsOwned, true);
    await host.invoke(first.id, "migrate_skill_storage", { target: "cc_switch" });
    await host.invoke(second.id, "migrate_skill_storage", { target: "unified" });
    assert.equal((await host.invoke(second.id, "get_settings", {}) as { skillStorageLocation: string }).skillStorageLocation, "unified");
    const rebound = await host.rebind(first.id, { providerInstanceIds: [], externalTargetIds: ["one"], confirmed: true });
    assert.equal(rebound.context.id, first.id);
    assert.equal(Object.keys(await host.invoke(first.id, "get_mcp_servers", {}) as object).length, 1);
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("real MCP connectivity performs no handshake until explicit start and emits correlated batch outcomes", { timeout: 45_000 }, async t => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-connectivity-"));
  const host = new ExtensionHost();
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const rpc = JSON.parse(text) as { id?: number | string; method: string; params?: { protocolVersion?: string } };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === "initialize" ? { protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic-mcp-fixture", version: "1" } } : { tools: [] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  const { promise: listening, resolve: listen } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listen);
  await listening;
  try {
    // The owned loopback fixture must not depend on a deployment's outbound proxy.
    process.env.NO_PROXY = "127.0.0.1,localhost,::1";
    process.env.no_proxy = process.env.NO_PROXY;
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    const home = path.join(root, "home");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await mkdir(home);
    const registry = path.join(root, "targets.json");
    await writeFile(registry, JSON.stringify([{ id: "fixture", label: "Fixture", app: "codex", homeDir: home, appDir: path.join(home, ".codex") }]), { mode: 0o600 });
    makePrivatePath(registry);
    process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE = registry;
    const context = (await host.bind({ providerInstanceIds: [], externalTargetIds: ["fixture"], confirmed: true })).context;
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await host.invoke(context.id, "upsert_mcp_server", { server: { id: "fixture", name: "Fixture", server: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` }, apps: { codex: false } } });
    await host.invoke(context.id, "get_mcp_servers", {});
    assert.equal(requests, 0);
    const { promise, resolve, reject } = Promise.withResolvers<{ serverId: string; connected: boolean; batchId: string }>();
    const abort = () => reject(new Error("The real IPC connectivity test was aborted"));
    t.signal.addEventListener("abort", abort, { once: true });
    const unsubscribe = await host.subscribe(context.id, event => { if (event.event === "mcp-connectivity") resolve(event.data as { serverId: string; connected: boolean; batchId: string }); });
    try {
      const batchId = await host.invoke(context.id, "start_mcp_connectivity_checks", { serverIds: ["fixture"] });
      const event = await promise;
      assert.equal(event.batchId, batchId);
      assert.equal(event.serverId, "fixture");
      assert.equal(event.connected, true);
      assert.ok(requests > 0);
      await host.invoke(context.id, "cancel_mcp_connectivity_checks", { batchId });
    } finally { t.signal.removeEventListener("abort", abort); unsubscribe(); }
  } finally {
    await host.close();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
test("real Claude projections use the exact private MCP file for default and default-looking override contexts", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-claude-path-"));
  const home = path.join(root, "home");
  const appDir = path.join(home, ".claude");
  const homeFile = path.join(home, ".claude.json");
  const overrideFile = path.join(appDir, ".claude.json");
  const filename = path.join(root, "targets.json");
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    await mkdir(appDir, { recursive: true });
    await writeFile(filename, JSON.stringify([
      { id: "default", label: "Claude default", app: "claude", homeDir: home, appDir },
      { id: "override", label: "Claude default-looking override", app: "claude", homeDir: home, appDir, claudeMcpFile: overrideFile },
    ]), { mode: 0o600 });
    makePrivatePath(filename);
    process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE = filename;
    const first = (await host.bind({ providerInstanceIds: [], externalTargetIds: ["default"], confirmed: true })).context;
    await host.invoke(first.id, "upsert_mcp_server", { server: { id: "claude-default-fixture", name: "Default fixture", server: { type: "http", url: "https://claude-default.example.invalid/mcp" }, apps: { claude: true } } });
    assert.match(await readFile(homeFile, "utf8"), /claude-default-fixture/);
    await assert.rejects(readFile(overrideFile), { code: "ENOENT" });
    await host.unbind(first.id);
    const second = (await host.bind({ providerInstanceIds: [], externalTargetIds: ["override"], confirmed: true })).context;
    assert.equal(JSON.stringify(second).includes("claudeMcpFile"), false);
    await host.invoke(second.id, "upsert_mcp_server", { server: { id: "claude-override-fixture", name: "Override fixture", server: { type: "http", url: "https://claude-override.example.invalid/mcp" }, apps: { claude: true } } });
    assert.match(await readFile(overrideFile, "utf8"), /claude-override-fixture/);
    assert.doesNotMatch(await readFile(homeFile, "utf8"), /claude-override-fixture/);
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("project definitions cannot use native probes or ambient proxy routing instead of PM verification", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-project-probe-"));
  const host = new ExtensionHost();
  const scope = { actorId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", projectId: "PRJ-001" };
  const stored = { id: projectExtensionContextId(scope), label: "Private project", kind: "project" as const, scope, createdAt: "2026-01-01T00:00:00.000Z" };
  const proxyRequests: string[] = [];
  const proxy = createServer((_request, response) => response.writeHead(502).end());
  proxy.on("connect", (request, socket) => {
    proxyRequests.push(request.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  const seed = new ExtensionSidecar(async () => {
    const dataDir = contextDataDirectory(stored.id);
    const homeDir = path.join(dataDir, "home");
    await privateDirectory(dataDir);
    await privateDirectory(homeDir);
    return { dataDir, homeDir, appDirs: {}, secretKey: await contextSecretKey(stored) };
  }, () => {});
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.PM_AUTOMATION_INTEGRATIONS_KEY = Buffer.alloc(32, 9).toString("base64");
    const listening = Promise.withResolvers<void>();
    proxy.once("error", listening.reject);
    proxy.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) process.env[name] = `http://127.0.0.1:${address.port}`;
    for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = "127.0.0.1,localhost,::1";
    await saveExtensionContexts([stored]);
    await seed.invoke("upsert_mcp_server", { server: { id: "project-fixture", name: "Project fixture", server: { type: "http", url: "https://mcp.example.org/" }, apps: {} } });
    await seed.close();
    await assert.rejects(host.invoke(stored.id, "start_mcp_connectivity_checks", { serverIds: ["project-fixture"] }), { status: 403, code: "project_connectivity_requires_pm" });
    await assert.rejects(host.invoke(stored.id, "cancel_mcp_connectivity_checks", { batchId: "ungranted-batch" }), { status: 403, code: "project_connectivity_requires_pm" });
    await assert.rejects(host.invoke(stored.id, "set_mcp_agent_configuration", { serverId: "project-fixture", app: "claude", enabled: true }), { status: 403, code: "project_native_assignment_unavailable" });
    await assert.rejects(host.invoke(stored.id, "toggle_mcp_app", { serverId: "project-fixture", app: "claude", enabled: false }), { status: 403, code: "project_native_assignment_unavailable" });
    await assert.rejects(host.invoke(stored.id, "preview_mcp_import", {}), { status: 403, code: "project_native_import_unavailable" });
    await assert.rejects(host.invoke(stored.id, "apply_mcp_import", { previewId: "forged-preview", selections: [] }), { status: 403, code: "project_native_import_unavailable" });
    await assert.rejects(host.invoke(stored.id, "validate_mcp_command", { cmd: "node" }), { status: 403, code: "project_native_operation_unavailable" });
    const management = await host.invoke(stored.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    assert.deepEqual(management.boundApps, []);
    assert.equal(Object.keys(management.agentConfigurations).every(id => Object.keys(management.agentConfigurations[id]!).length === 0), true);
    assert.equal(Object.hasOwn(management.definitions["project-fixture"]!, "apps"), false);
    await host.close();
    assert.deepEqual(proxyRequests, []);
  } finally {
    await seed.close();
    await host.close();
    proxy.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    proxy.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("real multi-Agent definitions, protected overrides and reviewed imports retain read-only and stale-preview boundaries", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-assignments-"));
  const home = path.join(root, "home");
  const claudeDir = path.join(home, ".claude");
  const codexDir = path.join(home, ".codex");
  const nativeFile = path.join(home, ".claude.json");
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    const registry = path.join(root, "targets.json");
    await writeFile(registry, JSON.stringify([
      { id: "claude", label: "Claude fixture", app: "claude", homeDir: home, appDir: claudeDir },
      { id: "codex", label: "Codex fixture", app: "codex", homeDir: home, appDir: codexDir },
    ]), { mode: 0o600 });
    makePrivatePath(registry);
    process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE = registry;
    const context = (await host.bind({ providerInstanceIds: [], externalTargetIds: ["claude", "codex"], confirmed: true })).context;
    const events: ExtensionEvent[] = [];
    const unsubscribe = await host.subscribe(context.id, event => events.push(event));
    const initial = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    assert.deepEqual([...initial.boundApps].sort(), ["claude", "codex"]);
    const emptyPreview = await host.invoke(context.id, "preview_mcp_import", {}) as ExtensionMcpImportPreview;
    assert.equal(events.some(event => event.event === "changed" || event.event === "operation"), false);
    assert.equal((await host.browserContext(context.id, new Headers())).reloadRequired, false);
    const skipped = await host.invoke(context.id, "apply_mcp_import", { previewId: emptyPreview.previewId, selections: [] }) as ExtensionMcpImportResult;
    assert.equal(skipped.applied, 0);
    assert.equal(events.some(event => event.event === "changed"), false);
    assert.equal((await host.browserContext(context.id, new Headers())).reloadRequired, false);
    const unmanagedDir = path.join(claudeDir, "skills", "native-scan");
    await mkdir(unmanagedDir, { recursive: true });
    await writeFile(path.join(unmanagedDir, "SKILL.md"), "---\nname: Native scan\ndescription: Synthetic native scan fixture\n---\n# Native scan\n");
    const scan = await host.invoke(context.id, "scan_unmanaged_skills", {});
    assert.equal(JSON.stringify(scan).includes(home), false);
    assert.equal(JSON.stringify(scan).includes("native-scan"), true);
    await assert.rejects(readFile(nativeFile), { code: "ENOENT" });
    const definition = { id: "shared-fixture", name: "Shared fixture", server: { type: "http", url: "https://shared.example.invalid/mcp", headers: { authorization: "synthetic-base-secret" } } };
    assert.equal(await host.invoke(context.id, "save_mcp_definition", { definition }), null);
    const saved = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    assert.equal(saved.agentConfigurations["shared-fixture"]!.claude!.enabled, false);
    assert.equal(saved.agentConfigurations["shared-fixture"]!.codex!.enabled, false);
    await host.invoke(context.id, "set_mcp_agent_configuration", { serverId: definition.id, app: "claude", enabled: true, override: { headers: { authorization: "synthetic-claude-override" } } });
    await host.invoke(context.id, "set_mcp_agent_configuration", { serverId: definition.id, app: "codex", enabled: true, override: null });
    const configured = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    for (const secret of ["synthetic-base-secret", "synthetic-claude-override", home, claudeDir, codexDir]) assert.equal(JSON.stringify(configured).includes(secret), false);
    assert.equal(configured.agentConfigurations["shared-fixture"]!.claude!.enabled, true);
    assert.equal(configured.agentConfigurations["shared-fixture"]!.codex!.enabled, true);
    assert.ok(configured.agentConfigurations["shared-fixture"]!.claude!.override);
    assert.equal(configured.agentConfigurations["shared-fixture"]!.codex!.override, null);
    await assert.rejects(host.invoke(context.id, "set_mcp_agent_configuration", { serverId: definition.id, app: "codex", enabled: true, override: { headers: configured.definitions[definition.id]!.server.headers } }), { code: "secret_mask_stale" });
    await assert.rejects(host.invoke(context.id, "set_mcp_agent_configuration", { serverId: definition.id, app: "gemini", enabled: true }), { code: "native_target_unbound" });
    await host.invoke(context.id, "save_mcp_definition", { definition: { ...configured.definitions[definition.id]!, name: "Renamed fixture" } });
    assert.match(await readFile(nativeFile, "utf8"), /synthetic-claude-override/);
    await host.invoke(context.id, "set_mcp_agent_configuration", { serverId: definition.id, app: "claude", enabled: true });
    assert.match(await readFile(nativeFile, "utf8"), /synthetic-claude-override/);
    await host.invoke(context.id, "set_mcp_agent_configuration", { serverId: definition.id, app: "claude", enabled: true, override: null });
    assert.match(await readFile(nativeFile, "utf8"), /synthetic-base-secret/);
    const native = JSON.parse(await readFile(nativeFile, "utf8")) as { mcpServers: Record<string, unknown> };
    native.mcpServers["native-review"] = { type: "http", url: "https://review.example.invalid/mcp", headers: { authorization: "synthetic-import-secret" } };
    await writeFile(nativeFile, JSON.stringify(native));
    const beforePreview = await readFile(nativeFile, "utf8");
    const beforeManagement = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    const eventCount = events.length;
    const preview = await host.invoke(context.id, "preview_mcp_import", {}) as ExtensionMcpImportPreview;
    assert.equal(events.length, eventCount);
    assert.equal(await readFile(nativeFile, "utf8"), beforePreview);
    const afterPreview = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    assert.deepEqual(afterPreview.definitions, beforeManagement.definitions);
    assert.equal(JSON.stringify(preview).includes("synthetic-import-secret"), false);
    assert.equal(JSON.stringify(preview).includes(home), false);
    const entry = preview.entries.find(item => item.serverId === "native-review" && item.sourceApp === "claude");
    assert.ok(entry);
    assert.equal(entry.classification, "new");
    await assert.rejects(host.invoke(context.id, "apply_mcp_import", { previewId: preview.previewId, selections: [{ entryId: entry.entryId, resolution: "import", definition: { ...definition, id: "injected" } }] }));
    native.mcpServers["native-review"] = { type: "http", url: "https://changed-after-review.example.invalid/mcp", headers: { authorization: "synthetic-import-secret" } };
    await writeFile(nativeFile, JSON.stringify(native));
    const drifted = await readFile(nativeFile, "utf8");
    const changedBeforeReject = events.filter(event => event.event === "changed").length;
    await assert.rejects(host.invoke(context.id, "apply_mcp_import", { previewId: preview.previewId, selections: [{ entryId: entry.entryId, resolution: "import" }] }), { status: 409, code: "mcp_import_preview_stale" });
    assert.equal(events.filter(event => event.event === "changed").length, changedBeforeReject);
    assert.equal(await readFile(nativeFile, "utf8"), drifted);
    const afterDrift = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    assert.equal(Object.hasOwn(afterDrift.definitions, "native-review"), false);
    const refreshed = await host.invoke(context.id, "preview_mcp_import", {}) as ExtensionMcpImportPreview;
    const approved = refreshed.entries.find(item => item.serverId === "native-review" && item.sourceApp === "claude");
    assert.ok(approved);
    const result = await host.invoke(context.id, "apply_mcp_import", { previewId: refreshed.previewId, selections: [{ entryId: approved.entryId, resolution: "import" }] }) as ExtensionMcpImportResult;
    assert.equal(result.applied, 1);
    assert.equal(await readFile(nativeFile, "utf8"), drifted);
    const imported = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    assert.ok(imported.definitions["native-review"]);
    assert.equal(imported.agentConfigurations["native-review"]!.claude!.enabled, true);
    const importEvent = events.findLast(event => event.event === "changed" && event.data !== null && typeof event.data === "object" && "command" in event.data && event.data.command === "apply_mcp_import");
    assert.ok(importEvent?.data && typeof importEvent.data === "object" && "nativeFilesWritten" in importEvent.data);
    assert.equal(importEvent.data.nativeFilesWritten, false);
    assert.equal((await host.browserContext(context.id, new Headers())).reloadRequired, true);
    unsubscribe();
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

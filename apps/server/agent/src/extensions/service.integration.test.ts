import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { ExtensionHost } from "./service.ts";
import { contextDataDirectory, contextSecretKey, privateDirectory, projectExtensionContextId, readExtensionContexts, saveExtensionContexts } from "./storage.ts";
import { makePrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { createProviderInstance, getStoredInstance, listStoredInstances, updateProviderInstance } from "../providers/instances.ts";
import { ExtensionSidecar } from "./rpc.ts";
import type { ExtensionEvent, ExtensionMcpImportPreview, ExtensionMcpImportResult, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";

// Requires the real cc-switch-host release binary (or explicit CC_SWITCH_HOST_BINARY).
// No substitute child or fake implementation is used; all native roots and credentials below are synthetic fixtures.
test("registered Provider resolution preserves real definitions, isolates roots and refreshes stale revisions", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-provider-resolution-"));
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    delete process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    const one = path.join(root, "codex-one"), two = path.join(root, "codex-two"), moved = path.join(root, "codex-moved");
    await mkdir(one);
    await mkdir(two);
    const alias = path.join(root, "codex-alias");
    await symlink(one, alias, process.platform === "win32" ? "junction" : "dir");
    const environment = [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }];
    const firstProvider = createProviderInstance({ instanceId: "resolve-one", driver: "codex", config: { homePath: one }, environment });
    const sharedProvider = createProviderInstance({ instanceId: "resolve-shared", driver: "codex", config: { homePath: alias }, environment });
    createProviderInstance({ instanceId: "resolve-two", driver: "codex", config: { homePath: two }, environment });
    createProviderInstance({ instanceId: "resolve-unsupported", driver: "opencode", config: { serverUrl: "http://127.0.0.1:4101" }, environment });
    const [first, shared, second] = await Promise.all(["resolve-one", "resolve-shared", "resolve-two"].map(id => host.resolveProviderContext(id)));
    assert.equal(first!.context.id, shared!.context.id);
    assert.deepEqual(shared!.context.providerInstanceIds, ["resolve-one", "resolve-shared"]);
    assert.notEqual(first!.context.id, second!.context.id);
    assert.equal(first!.context.status, "stopped");
    assert.deepEqual(await readdir(one), []);
    assert.deepEqual(await readdir(two), []);
    await assert.rejects(host.resolveProviderContext("resolve-unknown"), { code: "unsupported_extension_provider_target" });
    await assert.rejects(host.resolveProviderContext("resolve-unsupported"), { code: "unsupported_extension_provider_target" });
    await host.invoke(first!.context.id, "upsert_mcp_server", { server: { id: "retained", name: "Retained", server: { type: "http", url: "https://mcp.example.invalid" }, apps: { codex: false } } });
    assert.deepEqual(await host.invoke(second!.context.id, "get_mcp_servers", {}), {});
    const events: ExtensionEvent[] = [];
    const unsubscribe = await host.subscribe(first!.context.id, event => events.push(event));
    const revised = updateProviderInstance("resolve-one", { label: "Renamed Provider" }, firstProvider.revision);
    const refreshed = await host.resolveProviderContext("resolve-one");
    assert.equal(refreshed.context.id, first!.context.id);
    assert.ok(Object.hasOwn(await host.invoke(refreshed.context.id, "get_mcp_servers", {}) as object, "retained"));
    await host.invoke(refreshed.context.id, "upsert_mcp_server", { server: { id: "after-refresh", name: "After refresh", server: { type: "http", url: "https://mcp.example.invalid" }, apps: { codex: false } } });
    assert.ok(events.some(event => event.event === "changed"));
    unsubscribe();
    updateProviderInstance("resolve-one", { config: { homePath: moved } }, revised.revision);
    const newOwner = await host.resolveProviderContext("resolve-one");
    assert.notEqual(newOwner.context.id, first!.context.id);
    const previousOwner = await host.resolveProviderContext("resolve-shared");
    assert.equal(previousOwner.context.id, first!.context.id);
    assert.ok(Object.hasOwn(await host.invoke(previousOwner.context.id, "get_mcp_servers", {}) as object, "retained"));
    assert.deepEqual(await host.invoke(newOwner.context.id, "get_mcp_servers", {}), {});
    updateProviderInstance("resolve-shared", { config: { homePath: path.join(root, "shared-moved") } }, sharedProvider.revision);
    await assert.rejects(host.invoke(previousOwner.context.id, "get_mcp_servers", {}));
    const sharedMoved = await host.resolveProviderContext("resolve-shared");
    assert.notEqual(sharedMoved.context.id, previousOwner.context.id);
    assert.deepEqual(await host.invoke(sharedMoved.context.id, "get_mcp_servers", {}), {});
    assert.ok((await readExtensionContexts()).some(context => context.id === first!.context.id));
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("enabled resolution preserves a live sidecar, subscribers and reload state across revision refresh", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-live-refresh-"));
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CC_SWITCH_EXTERNAL_TARGETS_FILE"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    const environment = [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }];
    createProviderInstance({ instanceId: "live-codex", driver: "codex", environment });
    createProviderInstance({ instanceId: "live-opencode", driver: "opencode", environment });
    const original = (await host.resolveEnabledProviderContexts()).contexts[0]!;
    await host.invoke(original.id, "upsert_mcp_server", { server: { id: "retained", name: "Retained", server: { type: "http", url: "https://mcp.example.invalid" }, apps: { codex: false, opencode: false } } });
    const events: ExtensionEvent[] = [];
    const unsubscribe = await host.subscribe(original.id, event => events.push(event));
    const instance = getStoredInstance("live-codex")!;
    updateProviderInstance(instance.instanceId, { label: "Renamed" }, instance.revision);
    events.length = 0;
    const refreshed = (await host.resolveEnabledProviderContexts()).contexts[0]!;
    assert.equal(refreshed.id, original.id);
    assert.equal(refreshed.status, "ready");
    assert.equal(refreshed.reloadRequired, true);
    assert.equal(events.some(event => event.event === "status"), false);
    assert.ok(Object.hasOwn(await host.invoke(original.id, "get_mcp_servers", {}) as object, "retained"));
    await host.invoke(original.id, "upsert_mcp_server", { server: { id: "after", name: "After", server: { type: "http", url: "https://mcp.example.invalid" }, apps: { codex: false, opencode: false } } });
    assert.ok(events.some(event => event.event === "changed"));
    createProviderInstance({ instanceId: "new-pi", driver: "pi", environment });
    const expanded = await host.resolveEnabledProviderContexts();
    assert.deepEqual(expanded.contexts.find(context => context.id === original.id)!.apps, ["codex", "opencode"]);
    assert.deepEqual(expanded.contexts.find(context => context.id !== original.id)!.apps, ["pi"]);
    assert.equal(expanded.contexts.find(context => context.id === original.id)!.status, "ready");
    unsubscribe();
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("saved Provider resolution is scoped while discovery preserves independent external owners", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-saved-mixed-owners-"));
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) delete process.env[key];
    const registry = path.join(root, "external-targets.json");
    process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE = registry;
    await mkdir(process.env.HOME, { recursive: true });
    const externalTarget = { id: "external-b", label: "External B", app: "codex", homeDir: process.env.HOME, appDir: path.join(root, "codex-b") };
    await writeFile(registry, JSON.stringify([externalTarget]), { mode: 0o600 });
    makePrivatePath(registry);
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    const environment = [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }];
    const providerA = createProviderInstance({ instanceId: "saved-a", driver: "codex", config: { homePath: path.join(root, "codex-a") }, environment });
    createProviderInstance({ instanceId: "external-b", driver: "codex", config: { homePath: externalTarget.appDir }, environment });
    const a = (await host.resolveProviderContext(providerA.instanceId)).context;
    const b = (await host.bind({ providerInstanceIds: [], externalTargetIds: [externalTarget.id], confirmed: true })).context;
    await host.invoke(a.id, "upsert_mcp_server", { server: { id: "saved-a-definition", name: "Saved A", server: { type: "http", url: "https://saved-a.example.invalid/mcp" }, apps: { codex: false } } });
    const events: ExtensionEvent[] = [];
    const unsubscribe = await host.subscribe(a.id, event => events.push(event));
    try {
      const externalBeforeAssociation = (await readExtensionContexts()).find(context => context.id === b.id)!;
      createProviderInstance({ instanceId: "new-pi", driver: "pi", environment });
      const unassociated = await host.resolveEnabledProviderContexts();
      assert.equal(unassociated.contexts.some(context => context.id === b.id), false);
      assert.ok(unassociated.contexts.some(context => context.providerInstanceIds.includes("new-pi")));
      assert.deepEqual((await readExtensionContexts()).find(context => context.id === b.id), externalBeforeAssociation);
      assert.equal((await host.resolveProviderContext("external-b")).context.id, b.id);
      const externalBeforeRefresh = (await readExtensionContexts()).find(context => context.id === b.id)!;
      updateProviderInstance(providerA.instanceId, { label: "Renamed A" }, providerA.revision);
      createProviderInstance({ instanceId: "latest-opencode", driver: "opencode", environment });
      events.length = 0;
      const scoped = await host.resolveEnabledProviderContexts(a.id);
      assert.deepEqual(scoped.contexts.map(context => context.id), [a.id]);
      assert.deepEqual(scoped.contexts[0]!.apps, ["codex"]);
      assert.equal(scoped.contexts[0]!.status, "ready");
      assert.equal(scoped.contexts[0]!.reloadRequired, true);
      assert.equal(events.some(event => event.event === "status"), false);
      assert.ok(host.targets().targets.some(target => target.providerInstanceId === "latest-opencode"));
      assert.equal((await readExtensionContexts()).some(context => context.binding?.providerInstanceIds.includes("latest-opencode")), false);
      assert.deepEqual((await readExtensionContexts()).find(context => context.id === b.id), externalBeforeRefresh);
      assert.ok(Object.hasOwn(await host.invoke(a.id, "get_mcp_servers", {}) as object, "saved-a-definition"));
      await host.invoke(a.id, "upsert_mcp_server", { server: { id: "after-refresh", name: "After", server: { type: "http", url: "https://saved-a.example.invalid/mcp" }, apps: { codex: false } } });
      assert.ok(events.some(event => event.event === "changed"));
      const discovered = await host.resolveEnabledProviderContexts();
      assert.ok(discovered.contexts.some(context => context.id === a.id));
      assert.ok(discovered.contexts.some(context => context.id === b.id));
      assert.ok(discovered.contexts.some(context => context.providerInstanceIds.includes("latest-opencode")));
      assert.deepEqual((await readExtensionContexts()).find(context => context.id === b.id), externalBeforeRefresh);
      assert.deepEqual(await host.invoke(b.id, "get_mcp_servers", {}), {});
      createProviderInstance({ instanceId: "saved-a-alias", driver: "codex", config: { homePath: path.join(root, "codex-a") }, environment });
      const currentA = getStoredInstance(providerA.instanceId)!;
      updateProviderInstance(currentA.instanceId, { enabled: false }, currentA.revision);
      const aliased = (await host.resolveEnabledProviderContexts(a.id)).contexts[0]!;
      assert.equal(aliased.id, a.id);
      assert.deepEqual(aliased.providerInstanceIds, ["saved-a-alias"]);
      assert.equal(aliased.status, "ready");
      assert.ok(Object.hasOwn(await host.invoke(a.id, "get_mcp_servers", {}) as object, "saved-a-definition"));
      // An unrelated stale enrollment cannot block A, but remains an error for B.
      await writeFile(registry, JSON.stringify([{ ...externalTarget, appDir: path.join(root, "external-b-moved") }]), { mode: 0o600 });
      assert.deepEqual((await host.resolveEnabledProviderContexts(a.id)).contexts.map(context => context.id), [a.id]);
      await assert.rejects(host.resolveEnabledProviderContexts(b.id), { code: "external_binding_changed" });
      await assert.rejects(host.browserContext(b.id, new Headers()), { code: "external_binding_changed" });
      assert.deepEqual((await readExtensionContexts()).find(context => context.id === b.id), externalBeforeRefresh);
    } finally { unsubscribe(); }
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("default Claude authority through a different Home alias stays usable in either ID order", async () => {
  for (const [codexId, claudeId] of [["aaa-codex", "zzz-claude"], ["zzz-codex", "aaa-claude"]]) {
    const previous = { ...process.env };
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-home-alias-"));
    const host = new ExtensionHost();
    try {
      process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
      process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
      for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CC_SWITCH_EXTERNAL_TARGETS_FILE"]) delete process.env[key];
      await mkdir(process.env.HOME);
      const alias = path.join(root, "alias");
      await symlink(process.env.HOME, alias, process.platform === "win32" ? "junction" : "dir");
      for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
      const environment = (home: string) => [{ name: "HOME", value: home, sensitive: false }, { name: "USERPROFILE", value: home, sensitive: false }];
      createProviderInstance({ instanceId: codexId!, driver: "codex", environment: environment(alias) });
      const original = (await host.resolveProviderContext(codexId!)).context;
      const originalBinding = (await readExtensionContexts()).find(context => context.id === original.id)!.binding;
      createProviderInstance({ instanceId: claudeId!, driver: "claude", environment: environment(process.env.HOME) });
      const resolved = await host.resolveEnabledProviderContexts();
      assert.deepEqual(resolved.contexts.map(context => context.providerInstanceIds).sort(), [[codexId], [claudeId]].sort());
      assert.deepEqual((await readExtensionContexts()).find(context => context.id === original.id)!.binding!.appDirs, originalBinding!.appDirs);
      for (const context of resolved.contexts) {
        const management = await host.invoke(context.id, "get_mcp_management", {}) as ExtensionMcpManagement;
        assert.deepEqual(management.boundApps, context.apps);
      }
      const saved = await readExtensionContexts();
      assert.equal(saved.find(context => context.id === original.id)!.binding!.homeDir, alias);
      assert.equal(saved.find(context => context.id !== original.id)!.binding!.claudeMcpFile, path.join(process.env.HOME, ".claude.json"));
    } finally {
      await host.close();
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  }
});

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
    const resolvedExternalOwner = (await host.resolveProviderContext("external-codex-overlap")).context;
    assert.equal(resolvedExternalOwner.id, first.id);
    assert.deepEqual(resolvedExternalOwner.providerInstanceIds, ["external-codex-overlap"]);
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

test("new enabled OpenCode remains selectable beside a live owner and native Skills discovery never adopts", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-native-skill-observation-"));
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CC_SWITCH_EXTERNAL_TARGETS_FILE"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    const environment = [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }];
    createProviderInstance({ instanceId: "existing-codex", driver: "codex", environment });
    const original = (await host.resolveEnabledProviderContexts()).contexts[0]!;
    await host.invoke(original.id, "get_mcp_servers", {});
    const existingEvents: ExtensionEvent[] = [];
    const unsubscribeExisting = await host.subscribe(original.id, event => existingEvents.push(event));
    existingEvents.length = 0;

    const opencode = createProviderInstance({ instanceId: "late-opencode", driver: "opencode", environment });
    createProviderInstance({ instanceId: "disabled-opencode", driver: "opencode", enabled: false, environment });
    createProviderInstance({ instanceId: "borrowed-opencode", driver: "opencode", config: { serverUrl: "http://127.0.0.1:4096" }, environment });
    const targetMetadata = host.targets();
    assert.ok(targetMetadata.targets.some(target => target.providerInstanceId === opencode.instanceId && target.app === "opencode"));
    assert.equal(targetMetadata.targets.some(target => target.providerInstanceId === "disabled-opencode"), false);
    assert.deepEqual(targetMetadata.unavailableTargets.map(target => target.providerInstanceId), ["borrowed-opencode"]);
    assert.equal(JSON.stringify(targetMetadata).includes(root), false);
    const resolved = await host.resolveEnabledProviderContexts();
    const native = resolved.contexts.find(context => context.providerInstanceIds.includes(opencode.instanceId))!;
    assert.ok(native);
    assert.notEqual(native.id, original.id);
    assert.deepEqual(native.apps, ["opencode"]);
    assert.equal(resolved.contexts.find(context => context.id === original.id)!.status, "ready");
    assert.deepEqual(existingEvents, []);
    const management = await host.invoke(native.id, "get_mcp_management", {}) as ExtensionMcpManagement;
    assert.deepEqual(management.boundApps, ["opencode"]);

    const nativeSkill = path.join(process.env.HOME, ".config", "opencode", "skills", "preinstalled");
    const sharedSkill = path.join(process.env.HOME, ".agents", "skills", "shared-native");
    const unrelatedSkill = path.join(process.env.HOME, ".claude", "skills", "unbound-native");
    const document = "---\nname: Native fixture\ndescription: Preinstalled without application adoption\n---\n# Synthetic fixture\n";
    for (const directory of [nativeSkill, sharedSkill, unrelatedSkill]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), document);
    }
    const nativeEvents: ExtensionEvent[] = [];
    const unsubscribeNative = await host.subscribe(native.id, event => nativeEvents.push(event));
    nativeEvents.length = 0;
    type Scanned = { directory: string; foundIn: string[] };
    const observed = await host.invoke(native.id, "scan_unmanaged_skills", {}) as Scanned[];
    assert.deepEqual(observed.map(skill => ({ directory: skill.directory, foundIn: skill.foundIn })).sort((a, b) => a.directory.localeCompare(b.directory)), [
      { directory: "preinstalled", foundIn: ["opencode"] },
      { directory: "shared-native", foundIn: ["agents"] },
    ]);
    assert.equal(JSON.stringify(observed).includes(root), false);
    const nativeInventory = await host.invoke(native.id, "scan_native_skills", {}) as Array<Scanned & { managed: boolean }>;
    assert.deepEqual(nativeInventory.map(({ directory, managed }) => ({ directory, managed })).sort((a, b) => a.directory.localeCompare(b.directory)), [
      { directory: "preinstalled", managed: false }, { directory: "shared-native", managed: false },
    ]);
    assert.equal(JSON.stringify(nativeInventory).includes(root), false);
    assert.deepEqual(await host.invoke(native.id, "get_installed_skills", {}), []);
    assert.equal((await host.invoke(native.id, "get_settings", {}) as { skillStorageLocation: string }).skillStorageLocation, "cc_switch");
    await assert.rejects(readdir(path.join(contextDataDirectory(native.id), "skills")), { code: "ENOENT" });
    assert.equal((await host.browserContext(native.id, new Headers())).unifiedStorageOwned, false);
    assert.equal((await host.browserContext(native.id, new Headers())).reloadRequired, false);
    assert.deepEqual(nativeEvents, []);
    assert.equal(getStoredInstance(opencode.instanceId)!.revision, opencode.revision);
    for (const directory of [nativeSkill, sharedSkill, unrelatedSkill]) assert.equal(await readFile(path.join(directory, "SKILL.md"), "utf8"), document);

    // Explicit adoption copies an existing shared native skill to cc-switch storage;
    // it does not opt into Unified writes or deploy it to OpenCode.
    const imported = await host.invoke(native.id, "import_skills_from_apps", { imports: [{ directory: "shared-native", apps: {} }] }) as Array<{ id: string; apps: Record<string, boolean> }>;
    assert.equal(imported.length, 1);
    assert.equal(imported[0]!.apps.opencode, false);
    assert.equal(await readFile(path.join(contextDataDirectory(native.id), "skills", "shared-native", "SKILL.md"), "utf8"), document);
    await assert.rejects(readdir(path.join(process.env.HOME, ".config", "opencode", "skills", "shared-native")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(sharedSkill, "SKILL.md"), "utf8"), document);
    assert.deepEqual((await host.invoke(native.id, "scan_unmanaged_skills", {}) as Scanned[]).map(skill => skill.directory), ["preinstalled"]);
    const adoptedObservation = (await host.invoke(native.id, "scan_native_skills", {}) as Array<Scanned & { managed: boolean }>).find(skill => skill.directory === "shared-native");
    assert.equal(adoptedObservation?.managed, true);
    assert.deepEqual(adoptedObservation?.foundIn, ["agents"]);
    assert.equal((await host.browserContext(native.id, new Headers())).unifiedStorageOwned, false);
    assert.equal((await host.browserContext(original.id, new Headers())).status, "ready");
    unsubscribeNative(); unsubscribeExisting();
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

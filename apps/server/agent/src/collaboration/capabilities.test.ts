import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createProviderInstance, updateProviderInstance } from "../providers/instances.ts";
import { closeStore } from "../durable/store.ts";
import { stopExtensionHost } from "../extensions/service.ts";
import { resolveRegisteredExtensionProviders } from "../extensions/provider-bindings.ts";
import { contextDataDirectory, extensionDataDirectory, privateDirectory, saveExtensionContexts } from "../extensions/storage.ts";
import { assertRunCapabilitiesCurrent, collaborationHostToolSupport, defaultCapabilityBindings, readCapabilityManifest, resolveRunCapabilityFacts } from "./capabilities.ts";

async function fixture() {
  const environment = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "collaboration-capability-"));
  const workspaceId = randomUUID(), actorId = randomUUID();
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  process.env.HOME = path.join(root, "home");
  process.env.USERPROFILE = process.env.HOME;
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) delete process.env[key];
  await mkdir(process.env.HOME, { recursive: true });
  let authorized = true;
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    assert.equal(request.url, "/api/v1/agent-contexts/authorize");
    const scope = JSON.parse(text);
    response.setHeader("content-type", "application/json");
    response.writeHead(authorized ? 200 : 403);
    response.end(JSON.stringify(authorized ? { actorId, scope } : { error: "Revoked" }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
  const instance = createProviderInstance({ instanceId: "capability-codex", driver: "codex", config: { homePath: path.join(root, "home", ".codex") }, environment: [{ name: "HOME", value: process.env.HOME, sensitive: false }] });
  const input = { workspaceId, providerInstanceId: instance.instanceId, capabilityBindings: defaultCapabilityBindings(), headers: new Headers() };
  return { root, workspaceId, instance, input, revoke: () => { authorized = false; }, close: async () => {
    await stopExtensionHost(); closeStore(); server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(root, { recursive: true, force: true });
  } };
}

test("inventory remains read-only, loading unknown, and strict/unsupported combinations reject locally", async () => {
  const f = await fixture();
  try {
    const manifest = await resolveRunCapabilityFacts(f.input);
    assert.equal(existsSync(extensionDataDirectory()), false, "inventory must not prepare a context or manager root");
    assert.equal(manifest.hostTools.supported, true);
    assert.equal(manifest.sharedHome.shared, true, "native Home is shared even with no other known instance");
    await assertRunCapabilitiesCurrent(manifest, f.input);
    await assert.rejects(resolveRunCapabilityFacts({ ...f.input, capabilityBindings: { ...f.input.capabilityBindings, restriction: "bound-only" } }), { code: "capability_restriction_unsupported" });
    assert.equal(collaborationHostToolSupport("omp").supported, false);
    assert.equal(collaborationHostToolSupport("pi").supported, false);
    assert.equal(collaborationHostToolSupport("acpRegistry").supported, true);
    updateProviderInstance(f.instance.instanceId, { label: "Changed provider revision" }, f.instance.revision);
    await assert.rejects(assertRunCapabilitiesCurrent(manifest, f.input), { code: "capability_changed" });
    f.revoke();
    await assert.rejects(readCapabilityManifest(f.input), { status: 403 });
  } finally { await f.close(); }
});

test("protected config, current managed hidden content and required schema drift are not silently rebound", async () => {
  const f = await fixture();
  let database: DatabaseSync | undefined;
  try {
    const contextId = randomUUID();
    const binding = resolveRegisteredExtensionProviders([f.instance.instanceId]);
    await saveExtensionContexts([{ id: contextId, label: "Existing manager", kind: "native", binding, providerBinding: binding, createdAt: new Date().toISOString() }]);
    await privateDirectory(path.join(extensionDataDirectory(), "contexts"));
    await privateDirectory(contextDataDirectory(contextId));
    const filename = path.join(contextDataDirectory(contextId), "cc-switch.db");
    database = new DatabaseSync(filename);
    await chmod(filename, 0o600);
    database.exec("CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,server_config TEXT,enabled_codex INTEGER); CREATE TABLE mcp_agent_overrides(server_id TEXT,app TEXT,patch TEXT); CREATE TABLE skills(id TEXT PRIMARY KEY,directory TEXT,enabled_codex INTEGER,content_hash TEXT)");
    database.prepare("INSERT INTO mcp_servers VALUES(?,?,?)").run("mcp-one", "protected-config-not-decrypted", 1);
    database.prepare("INSERT INTO skills VALUES(?,?,?,?)").run("skill-one", "skill-one", 1, "untrusted-cached-hash");
    const skillRoot = path.join(contextDataDirectory(contextId), "skills", "skill-one");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "# Managed skill\n");
    await writeFile(path.join(skillRoot, ".hidden"), "one");
    const manifest = await resolveRunCapabilityFacts(f.input);
    const mcp = manifest.entries.find(entry => entry.kind === "mcp")!;
    const skill = manifest.entries.find(entry => entry.kind === "skill")!;
    assert.equal(mcp.installed, "yes"); assert.equal(mcp.assigned, "yes");
    assert.equal(mcp.authorized, "unknown"); assert.equal(mcp.loaded, "unknown"); assert.equal(mcp.schemaFingerprint, null);
    assert.equal(skill.installed, "yes"); assert.match(skill.contentFingerprint!, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(manifest), /protected-config-not-decrypted|untrusted-cached-hash/);
    await assert.rejects(resolveRunCapabilityFacts({ ...f.input, capabilityBindings: { ...f.input.capabilityBindings, mcp: [{ contextId, serverId: "mcp-one", configFingerprint: mcp.configFingerprint, schemaFingerprint: "a".repeat(64) }] } }), { code: "capability_schema_unverified" });
    await writeFile(path.join(skillRoot, ".hidden"), "two");
    await assert.rejects(assertRunCapabilitiesCurrent(manifest, f.input), { code: "capability_changed" });
    await writeFile(path.join(skillRoot, ".hidden"), "one");
    await assertRunCapabilitiesCurrent(manifest, f.input);
    database.prepare("UPDATE mcp_servers SET server_config=?").run("changed-protected-config");
    await assert.rejects(assertRunCapabilitiesCurrent(manifest, f.input), { code: "capability_changed" });
  } finally { database?.close(); await f.close(); }
});

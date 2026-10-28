import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderInstanceInput } from "@agent-workspace/contracts/provider";
import { getProviderModels, listProviderInstances, resolveCatalogModel } from "./catalog.ts";
import { getNativeProviderAdapter, nativeProviderAdapters } from "./driver-registry.ts";
import { resolveProviderRuntime } from "./runtime.ts";
import { createProviderInstance, deleteProviderInstance, getStoredInstance, listStoredInstances, providerContext, providerEnvironment, publicInstanceConfig, recordProviderObservations, updateProviderInstance } from "./instances.ts";
import { classifyProviderError } from "./errors.ts";
import { providerRoutes } from "./routes.ts";

async function isolated(fn: (directory: string) => Promise<void>) {
  const previous = { ...process.env };
  const directory = await mkdtemp(path.join(os.tmpdir(), "provider-instances-test-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.CODEX_HOME = path.join(directory, "old-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, "old-claude");
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  try { await fn(directory); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
}

test("fresh defaults are only Codex/Claude with empty dedicated homes and untouched obsolete credentials", async () => {
  await isolated(async (directory) => {
    const credentialBytes = '{"version":1,"providers":{"deepseek":{"apiKey":"offline-only-key"}}}\n';
    await writeFile(path.join(directory, "providers.json"), credentialBytes);
    await writeFile(path.join(process.env.CODEX_HOME!, "auth.json"), "global-codex-account");
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "global-claude-account");
    const first = listStoredInstances();
    assert.deepEqual(first.map((instance) => instance.driver).sort(), ["claude", "codex"]);
    assert.equal(first.every((instance) => instance.enabled), true);
    for (const instance of first) {
      assert.equal(instance.homeDirectory, path.join(directory, "provider-homes", instance.instanceId));
      assert.equal(providerEnvironment(instance).HOME, instance.homeDirectory);
      await assert.rejects(readFile(path.join(instance.homeDirectory, "auth.json")), /ENOENT/);
      await assert.rejects(readFile(path.join(instance.homeDirectory, ".credentials.json")), /ENOENT/);
    }
    assert.equal((await stat(path.join(directory, "provider-instances.json"))).mode & 0o777, 0o600);
    deleteProviderInstance("codex");
    assert.equal(getStoredInstance("codex"), null);
    assert.deepEqual(listStoredInstances().map((instance) => instance.driver), ["claude"]);
    assert.equal(await readFile(path.join(directory, "providers.json"), "utf8"), credentialBytes);
    assert.equal(await readFile(path.join(process.env.CODEX_HOME!, "auth.json"), "utf8"), "global-codex-account");
  });
});

test("all optional native drivers require explicit creation and source schema validation", async () => {
  await isolated(async () => {
    const initial = listStoredInstances().length;
    for (const adapter of nativeProviderAdapters.filter((entry) => !["codex", "claude"].includes(entry.definition.driver))) {
      assert.equal(listStoredInstances().some((entry) => entry.driver === adapter.definition.driver), false);
      const instance = createProviderInstance({ driver: adapter.definition.driver, label: adapter.definition.label });
      assert.equal(instance.enabled, true);
      assert.deepEqual(instance.config, adapter.validateConfig({}));
      assert.throws(() => updateProviderInstance(instance.instanceId, { config: { unknownNotInSourceSchema: "no" } }));
    }
    assert.equal(listStoredInstances().length, initial + 7);
  });
});

test("native config secrets/environment values are write-only and updates invalidate observations", async () => {
  await isolated(async () => {
    process.env.OPENAI_API_KEY = "ambient-secret";
    process.env.OPENAI_BASE_URL = "https://ambient.invalid";
    process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "ambient-access-secret";
    const a = createProviderInstance({ driver: "antigravity", label: "A", accentColor: "#123abc", config: { apiKey: "private-native-secret" }, env: { WORK_KEY: "private-env-value", CUSTOM_VALUE: "a" } });
    const b = createProviderInstance({ driver: "antigravity", label: "B" });
    const publicA = publicInstanceConfig(a);
    assert.equal(publicA.config.apiKey, undefined);
    assert.deepEqual(publicA.secretConfigKeys, ["apiKey"]);
    assert.deepEqual(publicA.envKeys, ["CUSTOM_VALUE", "WORK_KEY"]);
    assert.equal(publicA.accentColor, "#123abc");
    assert.doesNotMatch(JSON.stringify(publicA), /private-native-secret|private-env-value|homeDirectory/);
    assert.notEqual(a.homeDirectory, b.homeDirectory);
    const env = providerEnvironment(a);
    assert.equal(env.HOME, a.homeDirectory);
    assert.equal(env.USERPROFILE, a.homeDirectory);
    assert.equal(env.XDG_CONFIG_HOME, path.join(a.homeDirectory, ".config"));
    assert.equal(env.WORK_KEY, "private-env-value");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.equal(env.AGENT_WORKSPACE_ACCESS_TOKEN, undefined);
    assert.equal(providerEnvironment(b).WORK_KEY, undefined);
    recordProviderObservations(a.instanceId, a.revision, { lastConnectionTest: { ok: true, latencyMs: 0, kind: "agent-status", instanceRevision: a.revision }, discoveredModels: [{ id: "revision-model", label: "Observed", temperature: false }] });
    const next = updateProviderInstance(a.instanceId, { config: { apiKey: "replacement-secret" }, env: { CUSTOM_VALUE: null }, enabled: false }, a.revision);
    assert.ok(next.revision > a.revision);
    assert.equal(next.observations, undefined);
    assert.equal(next.env.CUSTOM_VALUE, undefined);
    assert.equal(next.config.apiKey, "replacement-secret");
    assert.throws(() => providerContext(next), /disabled/);
    assert.throws(() => recordProviderObservations(a.instanceId, a.revision, {}), /disabled|changed/);
    assert.throws(() => updateProviderInstance(a.instanceId, { label: "stale" }, a.revision), /changed/);
    const cleared = updateProviderInstance(a.instanceId, { config: { apiKey: null }, enabled: true }, next.revision);
    assert.deepEqual(publicInstanceConfig(cleared).secretConfigKeys, []);
    assert.equal(publicInstanceConfig(cleared).config.apiKey, undefined);
  });
});

test("home isolation rejects global, overlapping and symlinked account directories and reserves home env", async () => {
  await isolated(async (directory) => {
    const a = createProviderInstance({ driver: "codex", label: "A" });
    assert.throws(() => createProviderInstance({ driver: "codex", label: "shared", config: { homePath: a.homeDirectory } }), /already bound/);
    assert.throws(() => createProviderInstance({ driver: "claude", label: "nested", config: { homePath: path.join(a.homeDirectory, "nested") } }), /overlaps/);
    assert.throws(() => createProviderInstance({ driver: "codex", label: "parent", config: { homePath: path.dirname(a.homeDirectory) } }), /overlaps|already bound/);
    assert.throws(() => createProviderInstance({ driver: "codex", label: "global", config: { homePath: process.env.CODEX_HOME! } }), /global account/);
    assert.throws(() => createProviderInstance({ driver: "claude", label: "global", config: { homePath: path.join(os.homedir(), ".claude", "nested") } }), /global account/);
    const alias = path.join(directory, "global-home-alias");
    await symlink(process.env.CODEX_HOME!, alias);
    assert.throws(() => createProviderInstance({ driver: "codex", label: "symlink", config: { homePath: alias } }), /global account/);
    assert.throws(() => updateProviderInstance(a.instanceId, { driver: "claude" } as never), /cannot be changed/);
    assert.throws(() => updateProviderInstance(a.instanceId, { env: { HOME: "/tmp/unsafe" } }), /reserved/);
    assert.throws(() => updateProviderInstance(a.instanceId, { env: { XDG_CONFIG_HOME: "/tmp/unsafe" } }), /reserved/);
    const cwd = path.join(directory, "resolved-project");
    assert.equal(providerContext(a, cwd).cwd, cwd);
    assert.equal(providerContext(a, cwd).env.CODEX_HOME, a.homeDirectory);
  });
});

test("omitted secret config preserves its private value while explicit null clears only that field", async () => {
  await isolated(async () => {
    const original = createProviderInstance({ driver: "opencode", label: "Native server", config: { serverUrl: "https://native.invalid", serverPassword: "private-password" } });
    const renamed = updateProviderInstance(original.instanceId, { label: "Renamed", accentColor: "#112233" }, original.revision);
    assert.equal(renamed.config.serverPassword, "private-password");
    assert.equal(renamed.config.serverUrl, "https://native.invalid");
    assert.deepEqual(publicInstanceConfig(renamed).secretConfigKeys, ["serverPassword"]);
    const cleared = updateProviderInstance(original.instanceId, { config: { serverPassword: null } }, renamed.revision);
    assert.equal(publicInstanceConfig(cleared).config.serverPassword, undefined);
    assert.deepEqual(publicInstanceConfig(cleared).secretConfigKeys, []);
    assert.equal(cleared.config.serverUrl, "https://native.invalid");
    assert.equal(cleared.accentColor, "#112233");
  });
});

test("legacy native decoding is read-only and unrelated saves preserve opaque obsolete rows", async () => {
  await isolated(async (directory) => {
    const opaque = { instanceId: "legacy-api", driver: "openai", label: "Historical", revision: 19, env: { OLD_KEY: "opaque-secret" }, baseUrl: "https://old.invalid", customModels: [{ id: "old-model", label: "Old" }], futurePrivateExtension: { exact: [1, "unchanged"] } };
    const legacy = { instanceId: "legacy-codex", driver: "codex", label: "Existing account", revision: 8, env: {}, cliHome: path.join(directory, "provider-homes", "legacy-home"), executable: "/dedicated/codex", cwd: "/old/project" };
    const text = JSON.stringify({ version: 1, revisionClock: 23, unknownTopLevel: { retain: true }, instances: [opaque, legacy] }, null, 3);
    const target = path.join(directory, "provider-instances.json");
    const credentialPath = path.join(directory, "providers.json");
    await writeFile(target, text);
    await writeFile(credentialPath, "corrupt-original-credentials-must-not-be-read");
    assert.deepEqual(listStoredInstances().map((instance) => instance.instanceId), [legacy.instanceId]);
    const active = getStoredInstance(legacy.instanceId)!;
    assert.equal(active.revision, 8);
    assert.equal(active.homeDirectory, legacy.cliHome);
    assert.equal(active.config.homePath, legacy.cliHome);
    assert.equal(active.config.binaryPath, legacy.executable);
    assert.equal(getStoredInstance(opaque.instanceId), null);
    assert.equal(await readFile(target, "utf8"), text);
    assert.throws(() => updateProviderInstance(opaque.instanceId, { label: "cannot reactivate" }), /unsupported/);
    assert.throws(() => recordProviderObservations(opaque.instanceId, 19, {}), /unsupported/);
    assert.throws(() => deleteProviderInstance(opaque.instanceId), /historical/);
    updateProviderInstance(active.instanceId, { label: "Explicit native edit" }, active.revision);
    const saved = JSON.parse(await readFile(target, "utf8"));
    assert.deepEqual(saved.instances[0], opaque);
    assert.deepEqual(saved.unknownTopLevel, { retain: true });
    assert.equal(saved.instances[1].config.homePath, legacy.cliHome);
    assert.ok(saved.instances[1].revision > 23);
    assert.equal(await readFile(credentialPath, "utf8"), "corrupt-original-credentials-must-not-be-read");
  });
});

test("obsolete API drivers cannot be created, selected, checked or executed without dispatch", async () => {
  await isolated(async (directory) => {
    for (const driver of ["deepseek", "openai", "anthropic"]) {
      assert.throws(() => createProviderInstance({ driver, label: "Unsupported" } as unknown as ProviderInstanceInput), /Unsupported/);
      const response = await providerRoutes.request("http://localhost/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ driver, label: "Unsupported" }) });
      assert.equal(response.status, 400);
    }
    const text = JSON.stringify({ version: 1, instances: [{ instanceId: "legacy", driver: "deepseek", label: "Historical", revision: 1, env: {}, baseUrl: "http://127.0.0.1:1/never-contact" }] });
    await writeFile(path.join(directory, "provider-instances.json"), text);
    await writeFile(path.join(directory, "providers.json"), "offline-credentials");
    assert.deepEqual(await listProviderInstances(), []);
    assert.throws(() => resolveCatalogModel("legacy", "old-model"), { code: "unknown_provider" });
    await assert.rejects(resolveProviderRuntime({ providerInstanceId: "legacy", modelName: "old-model" }), { code: "unknown_provider" });
    const check = await providerRoutes.request("http://localhost/providers/legacy/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.ok(check.status >= 400);
    assert.equal(await readFile(path.join(directory, "provider-instances.json"), "utf8"), text);
    assert.equal(await readFile(path.join(directory, "providers.json"), "utf8"), "offline-credentials");
  });
});

test("corrupt instance stores fail closed without rewriting instance or obsolete credential bytes", async () => {
  await isolated(async (directory) => {
    const target = path.join(directory, "provider-instances.json");
    await writeFile(target, "broken-secret-file");
    await writeFile(path.join(directory, "providers.json"), "also-not-json");
    assert.throws(() => listStoredInstances(), /original data was not overwritten/);
    assert.throws(() => createProviderInstance({ driver: "codex", label: "No overwrite" }), /original data was not overwritten/);
    assert.equal(await readFile(target, "utf8"), "broken-secret-file");
    assert.equal(await readFile(path.join(directory, "providers.json"), "utf8"), "also-not-json");
  });
});

test("native custom models are explicit, revision-bound observations cannot resurrect a removed model", async () => {
  await isolated(async () => {
    const instance = createProviderInstance({ driver: "codex", label: "Native catalog", customModels: [{ id: "private-native-model", label: "Private" }] });
    assert.equal(resolveCatalogModel(instance.instanceId, "private-native-model").source, "custom");
    recordProviderObservations(instance.instanceId, instance.revision, { discoveredModels: [{ id: "discovered-native", label: "Discovered", temperature: false }] });
    assert.equal(getProviderModels(instance.instanceId).some((model) => model.id === "discovered-native"), true);
    const changed = updateProviderInstance(instance.instanceId, { customModels: [] }, instance.revision);
    assert.throws(() => resolveCatalogModel(instance.instanceId, "private-native-model"), { code: "invalid_model" });
    assert.equal(getProviderModels(instance.instanceId).some((model) => model.id === "discovered-native"), false);
    assert.throws(() => recordProviderObservations(instance.instanceId, instance.revision, {}), /changed/);
    deleteProviderInstance(instance.instanceId);
    const replacement = createProviderInstance({ instanceId: instance.instanceId, driver: "codex", label: "Replacement" });
    assert.ok(replacement.revision > changed.revision);
    assert.throws(() => recordProviderObservations(replacement.instanceId, changed.revision, {}), /changed/);
  });
});

test("native CRUD routes expose only config names for secrets and reject stale revisions", async () => {
  await isolated(async () => {
    const adapter = getNativeProviderAdapter("antigravity")!;
    const oldCheck = adapter.check;
    adapter.check = async () => ({ installation: { status: "unknown" }, authentication: "unknown", models: [], methods: [], canLogout: false });
    try {
      const response = await providerRoutes.request("http://localhost/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ driver: "antigravity", label: "Work", config: { apiKey: "route-secret" }, env: { WORK_KEY: "env-route-secret" } }) });
      assert.equal(response.status, 201);
      const provider = await response.json() as { instanceId: string; revision: number; envKeys: string[]; secretConfigKeys: string[] };
      assert.deepEqual(provider.envKeys, ["WORK_KEY"]);
      assert.deepEqual(provider.secretConfigKeys, ["apiKey"]);
      assert.doesNotMatch(JSON.stringify(provider), /route-secret/);
      const stale = await providerRoutes.request(`http://localhost/providers/${provider.instanceId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Stale", revision: provider.revision + 5 }) });
      assert.equal(stale.status, 409);
      const deleted = await providerRoutes.request(`http://localhost/providers/${provider.instanceId}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.equal(getStoredInstance(provider.instanceId), null);
    } finally { adapter.check = oldCheck; }
  });
});

test("quota classification only trusts provider reset evidence and redacts credentials", () => {
  const noTime = classifyProviderError(new Error("You've hit your usage limit. Try again later."), "account-a");
  assert.equal(noTime.errorClass, "usage_limit");
  assert.equal(noTime.resetAt, undefined);
  assert.equal(noTime.providerInstanceId, "account-a");
  assert.equal(classifyProviderError({ code: "usage_limit_reached", message: "Limit reached", resets_at: 1900000000 }).resetAt, new Date(1900000000 * 1000).toISOString());
  assert.equal(classifyProviderError({ statusCode: 429, message: "Too many requests", responseHeaders: { "retry-after": "2030-01-01T00:00:00Z" } }).resetAt, "2030-01-01T00:00:00.000Z");
  assert.equal(classifyProviderError({ code: "unsupported_fork", message: "No exact boundary" }).errorClass, "unsupported");
  assert.doesNotMatch(classifyProviderError(new Error("Bearer secret-test-bearer-token")).message, /secret-test-bearer-token/);
});

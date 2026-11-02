import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderInstance, ProviderInstanceInput, ProviderTestResult } from "@agent-workspace/contracts/provider";
import { getProviderModels, listProviderInstances, probeProviderInstance, resolveCatalogModel, resolveProviderModelOptions } from "./catalog.ts";
import { getNativeProviderAdapter, nativeProviderAdapters } from "./driver-registry.ts";
import { resolveProviderRuntime } from "./runtime.ts";
import { createProviderInstance, deleteProviderInstance, getStoredInstance, listStoredInstances, providerContext, providerEnvironment, publicInstanceConfig, recordProviderObservations, resetProviderInstance, updateProviderInstance } from "./instances.ts";
import { classifyProviderError } from "./errors.ts";
import { providerRoutes } from "./routes.ts";
import type { ProviderDriverStatus } from "./driver-adapter.ts";
import { collectAgentDiagnostics } from "../settings/diagnostics.ts";
import { checkProviderConnection } from "./checks.ts";

async function isolated(fn: (directory: string) => Promise<void>) {
  const previous = { ...process.env };
  const directory = await mkdtemp(path.join(os.tmpdir(), "provider-instances-test-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.HOME = path.join(directory, "host-home");
  process.env.USERPROFILE = process.env.HOME;
  process.env.XDG_CONFIG_HOME = path.join(process.env.HOME, ".config");
  await mkdir(process.env.HOME);
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

test("fresh native defaults inherit host homes without importing or owning their account files", async () => {
  await isolated(async (directory) => {
    const credentialBytes = '{"version":1,"providers":{"deepseek":{"apiKey":"offline-only-key"}}}\n';
    await writeFile(path.join(directory, "providers.json"), credentialBytes);
    await writeFile(path.join(process.env.CODEX_HOME!, "auth.json"), "global-codex-account");
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "global-claude-account");
    const first = listStoredInstances();
    assert.deepEqual(first.map((instance) => instance.driver).sort(), ["claude", "codex"]);
    for (const instance of first) {
      assert.equal(instance.stateDirectory, path.join(directory, "provider-homes", instance.instanceId));
      assert.equal(instance.homeDirectory, instance.driver === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR);
      assert.equal(providerEnvironment(instance).HOME, process.env.HOME);
      await assert.rejects(readFile(path.join(instance.stateDirectory, "auth.json")), /ENOENT/);
      await assert.rejects(readFile(path.join(instance.stateDirectory, ".credentials.json")), /ENOENT/);
    }
    assert.equal((await stat(path.join(directory, "provider-instances.json"))).mode & 0o777, 0o600);
    deleteProviderInstance("codex");
    assert.equal(getStoredInstance("codex"), null);
    assert.deepEqual(listStoredInstances().map((instance) => instance.driver), ["claude"]);
    assert.equal(await readFile(path.join(directory, "providers.json"), "utf8"), credentialBytes);
    assert.equal(await readFile(path.join(process.env.CODEX_HOME!, "auth.json"), "utf8"), "global-codex-account");
  });
});

test("blank native home fields leave CLI defaults and native environment paths intact", async () => {
  await isolated(async () => {
    delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR;
    const codex = getStoredInstance("codex")!; const claude = getStoredInstance("claude")!;
    assert.equal(codex.homeDirectory, path.join(process.env.HOME!, ".codex"));
    assert.equal(claude.homeDirectory, path.join(process.env.HOME!, ".claude"));
    assert.equal(providerContext(codex).env.CODEX_HOME, undefined);
    assert.equal(providerContext(claude).env.CLAUDE_CONFIG_DIR, undefined);
    for (const instance of [codex, claude]) {
      assert.equal(providerEnvironment(instance).HOME, process.env.HOME);
      assert.equal(providerEnvironment(instance).XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME);
      await assert.rejects(stat(instance.homeDirectory), /ENOENT/);
    }
  });
});

test("all optional native drivers require explicit creation and source schema validation", async () => {
  await isolated(async () => {
    const initial = listStoredInstances().length;
    const optional = nativeProviderAdapters.filter((entry) => !["codex", "claude"].includes(entry.definition.driver));
    for (const adapter of optional) {
      assert.equal(listStoredInstances().some((entry) => entry.driver === adapter.definition.driver), false);
      const instance = createProviderInstance({ driver: adapter.definition.driver, label: adapter.definition.label });
      assert.equal(instance.enabled, true);
      assert.deepEqual(instance.config, adapter.validateConfig({}));
      assert.throws(() => updateProviderInstance(instance.instanceId, { config: { unknownNotInSourceSchema: "no" } }));
    }
    assert.equal(listStoredInstances().length, initial + optional.length);
  });
});

test("reset restores built-in defaults and removes optional overrides without deleting account files", async () => {
  await isolated(async () => {
    const original = getStoredInstance("codex")!;
    const changed = updateProviderInstance("codex", { label: "Renamed", accentColor: "#123abc", enabled: false, config: { binaryPath: "/controlled/codex" }, environment: [{ name: "CUSTOM_MODE", value: "fixture", sensitive: false }] }, original.revision);
    const credential = path.join(changed.homeDirectory, "controlled-account");
    await writeFile(credential, "keep-account");
    assert.throws(() => resetProviderInstance("codex", original.revision), { status: 409 });
    const restored = resetProviderInstance("codex", changed.revision)!;
    assert.equal(publicInstanceConfig(restored).label, "Codex");
    assert.equal(restored.enabled, true);
    assert.equal(restored.config.binaryPath, "codex");
    assert.equal(restored.accentColor, undefined);
    assert.deepEqual(restored.env, {});
    assert.equal(await readFile(credential, "utf8"), "keep-account");
    const optional = createProviderInstance({ instanceId: "grok", driver: "grok", label: "Configured Grok", enabled: true });
    const optionalCredential = path.join(optional.homeDirectory, "controlled-account");
    await writeFile(optionalCredential, "keep-native-account");
    assert.equal(resetProviderInstance("grok", optional.revision), null);
    assert.equal(getStoredInstance("grok"), null);
    assert.equal(await readFile(optionalCredential, "utf8"), "keep-native-account");
    const recreated = createProviderInstance({ instanceId: "grok", driver: "grok" });
    assert.ok(recreated.revision > optional.revision);
    const extra = createProviderInstance({ instanceId: "fx-work", driver: "fx" });
    assert.throws(() => resetProviderInstance(extra.instanceId, extra.revision), { status: 400 });
    assert.equal(getStoredInstance(extra.instanceId)?.revision, extra.revision);
  });
});

test("native config secrets/environment values are write-only and updates invalidate observations", async () => {
  await isolated(async () => {
    process.env.OPENAI_API_KEY = "ambient-secret";
    process.env.OPENAI_BASE_URL = "https://ambient.invalid";
    process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "ambient-access-secret";
    process.env.FX_MODE = "ambient-fx";
    const a = createProviderInstance({ driver: "antigravity", label: "A", accentColor: "#123abc", config: { apiKey: "private-native-secret" }, environment: [{ name: "WORK_KEY", value: "private-env-value", sensitive: true }, { name: "CUSTOM_VALUE", value: "a", sensitive: false }] });
    const b = createProviderInstance({ driver: "antigravity", label: "B" });
    const publicA = publicInstanceConfig(a);
    assert.equal(publicA.config.apiKey, undefined);
    assert.deepEqual(publicA.secretConfigKeys, ["apiKey"]);
    assert.deepEqual(publicA.environment, [{ name: "CUSTOM_VALUE", value: "a", sensitive: false }, { name: "WORK_KEY", value: "", sensitive: true, valueRedacted: true }]);
    assert.equal(publicA.accentColor, "#123abc");
    assert.doesNotMatch(JSON.stringify(publicA), /private-native-secret|private-env-value|homeDirectory/);
    assert.notEqual(a.stateDirectory, b.stateDirectory);
    assert.equal(a.homeDirectory, b.homeDirectory);
    const env = providerEnvironment(a);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME);
    assert.equal(env.WORK_KEY, "private-env-value");
    assert.equal(env.OPENAI_API_KEY, "ambient-secret");
    assert.equal(env.OPENAI_BASE_URL, "https://ambient.invalid");
    assert.equal(env.AGENT_WORKSPACE_ACCESS_TOKEN, undefined);
    assert.equal(env.FX_MODE, "ambient-fx");
    const explicitFx = createProviderInstance({ driver: "fx", environment: [{ name: "FX_MODE", value: "instance-fx", sensitive: false }] });
    assert.equal(providerEnvironment(explicitFx).FX_MODE, "instance-fx");
    assert.equal(providerEnvironment(b).WORK_KEY, undefined);
    recordProviderObservations(a.instanceId, a.revision, { lastConnectionTest: { ok: true, latencyMs: 0, kind: "agent-status", instanceRevision: a.revision }, discoveredModels: [{ id: "revision-model", label: "Observed", temperature: false }] });
    const next = updateProviderInstance(a.instanceId, { config: { apiKey: "replacement-secret" }, environment: [publicA.environment[1]!], enabled: false }, a.revision);
    assert.ok(next.revision > a.revision);
    assert.equal(next.observations, undefined);
    assert.equal(next.env.CUSTOM_VALUE, undefined);
    assert.equal(next.env.WORK_KEY, "private-env-value");
    assert.equal(next.config.apiKey, "replacement-secret");
    assert.throws(() => providerContext(next), /disabled/);
    assert.throws(() => recordProviderObservations(a.instanceId, a.revision, {}), /disabled|changed/);
    assert.throws(() => updateProviderInstance(a.instanceId, { label: "stale" }, a.revision), /changed/);
    const cleared = updateProviderInstance(a.instanceId, { config: { apiKey: null }, enabled: true }, next.revision);
    assert.deepEqual(publicInstanceConfig(cleared).secretConfigKeys, []);
    assert.equal(publicInstanceConfig(cleared).config.apiKey, undefined);
  });
});

test("historical instance IDs and opaque metadata survive validated updates without reviving stale observations", async () => {
  await isolated(async directory => {
    const configured = updateProviderInstance("codex", {
      environment: [{ name: "CUSTOM_SECRET", value: "private-fixture", sensitive: true }],
      modelPreferences: { hidden: ["retired-model"], order: ["retired-model"], favorites: ["retired-model"],
        options: { "retired-model": [{ id: "retired-option", value: "retained" }] } },
    }, getStoredInstance("codex")!.revision);
    const file = path.join(directory, "provider-instances.json");
    const store = JSON.parse(await readFile(file, "utf8"));
    const raw = store.instances.find((entry: { instanceId: string }) => entry.instanceId === "codex");
    raw.instanceId = "7historical";
    raw.retainedMetadata = { unknownVersion: 19, nested: ["opaque", { preserved: true }] };
    store.instances.find((entry: { instanceId: string }) => entry.instanceId === "claude").retainedMetadata = raw.retainedMetadata;
    raw.observations = { instanceRevision: configured.revision, lastConnectionTest: { ok: true, latencyMs: 1 } };
    await writeFile(file, JSON.stringify(store));
    const historical = getStoredInstance("7historical")!;
    const renamed = updateProviderInstance(historical.instanceId, { label: "Historical account" }, historical.revision);
    assert.equal(renamed.instanceId, "7historical");
    assert.deepEqual(renamed.modelPreferences, configured.modelPreferences);
    assert.equal(renamed.env.CUSTOM_SECRET, "private-fixture");
    assert.equal(renamed.observations, undefined);
    let persisted = JSON.parse(await readFile(file, "utf8")).instances.find((entry: { instanceId: string }) => entry.instanceId === historical.instanceId);
    assert.deepEqual(persisted.retainedMetadata, raw.retainedMetadata);
    assert.equal(persisted.observations, undefined);
    assert.equal("retainedMetadata" in publicInstanceConfig(renamed), false);
    assert.throws(() => updateProviderInstance(renamed.instanceId, { retainedMetadata: {} } as never), /Unsupported/);
    assert.throws(() => updateProviderInstance(renamed.instanceId, { config: { unknownHistoricalConfig: "not executable" } }), /Unknown/);
    assert.throws(() => createProviderInstance({ instanceId: "7new", driver: "codex" }), /start with a letter/);
    const reset = resetProviderInstance("claude", getStoredInstance("claude")!.revision)!;
    persisted = JSON.parse(await readFile(file, "utf8")).instances.find((entry: { instanceId: string }) => entry.instanceId === "claude");
    assert.deepEqual(persisted.retainedMetadata, raw.retainedMetadata);
    assert.deepEqual(reset.env, {});
    assert.deepEqual(reset.modelPreferences?.favorites, []);
  });
});

test("settings expose no derived Codex config-file metadata and never create external homes", async () => {
  await isolated(async directory => {
    const external = path.join(directory, "uncreated-native-home");
    const instance = createProviderInstance({ instanceId: "custom-home", driver: "codex", config: { homePath: external } });
    assert.equal(instance.homeDirectory, external);
    assert.equal(providerContext(instance).env.CODEX_HOME, external);
    assert.equal(Object.hasOwn(publicInstanceConfig(instance), "codexConfig"), false);
    await assert.rejects(stat(external), /ENOENT/);
    const updated = updateProviderInstance(instance.instanceId, { label: "Native" }, instance.revision);
    await assert.rejects(stat(external), /ENOENT/);
    deleteProviderInstance(updated.instanceId);
    await assert.rejects(stat(external), /ENOENT/);
    const stored = await readFile(path.join(directory, "provider-instances.json"), "utf8");
    assert.doesNotMatch(stored, /"codexConfig"|"configPath"|"homeDirectory"|"stateDirectory"/);
    const diagnostic = JSON.stringify(collectAgentDiagnostics());
    assert.equal(diagnostic.includes(directory), false);
    assert.equal(diagnostic.includes("config.toml"), false);
    assert.equal(diagnostic.includes("codexConfig"), false);
  });
});

test("shared native home lifecycle preserves contents and permissions; inherited identity changes invalidate observations", async () => {
  await isolated(async directory => {
    const shared = process.env.CODEX_HOME!;
    await chmod(shared, 0o755);
    const marker = path.join(shared, "native-owned-state");
    await writeFile(marker, "host-owned-by-native-program");
    const original = getStoredInstance("codex")!;
    recordProviderObservations(original.instanceId, original.revision, { lastConnectionTest: { ok: true, latencyMs: 0, kind: "agent-status" }, discoveredModels: [{ id: "old-account-model", label: "Old account", temperature: false }] });
    const changed = updateProviderInstance("codex", { config: { homePath: shared } }, original.revision);
    const second = createProviderInstance({ instanceId: "shared-codex", driver: "codex", config: { homePath: shared } });
    resetProviderInstance("codex", changed.revision);
    deleteProviderInstance(second.instanceId);
    assert.equal(await readFile(marker, "utf8"), "host-owned-by-native-program");
    assert.equal((await stat(shared)).mode & 0o777, 0o755);
    const before = getStoredInstance("codex")!;
    recordProviderObservations(before.instanceId, before.revision, { discoveredModels: [{ id: "old-account-model", label: "Old account", temperature: false }] });
    process.env.CLAUDE_AGENT_SDK_VERSION = "fixture-sdk-version";
    assert.equal(getStoredInstance("codex")!.revision, before.revision);
    assert.ok(getProviderModels("codex").some(model => model.id === "old-account-model"));
    process.env.CODEX_HOME = path.join(directory, "replacement-native-home");
    const next = getStoredInstance("codex")!;
    assert.ok(next.revision > before.revision);
    assert.equal(next.observations, undefined);
    assert.equal(next.homeDirectory, process.env.CODEX_HOME);
    assert.equal(next.stateDirectory, before.stateDirectory);
    assert.equal(getStoredInstance("codex")!.revision, next.revision);
    assert.ok(!getProviderModels("codex").some(model => model.id === "old-account-model"));
    await assert.rejects(stat(next.homeDirectory), /ENOENT/);
  });
});

test("HTTP catalog and checks preserve native readiness independently of account identity", async () => {
  await isolated(async () => {
    const originals = ["codex", "claude", "opencode"].map(driver => {
      const adapter = getNativeProviderAdapter(driver)!;
      return { adapter, check: adapter.check };
    });
    const cases: { id: string; authentication: ProviderDriverStatus["authentication"]; native?: boolean; required?: boolean; installation?: ProviderDriverStatus["installation"]["status"]; ready: boolean; driver?: "claude" | "opencode" }[] = [
      { id: "native-key", authentication: "authenticated", native: true, required: true, ready: true },
      { id: "native-independent", authentication: "unknown", native: true, required: false, ready: true },
      { id: "native-identity-only", authentication: "authenticated", native: false, ready: false },
      { id: "native-identity-unchecked", authentication: "authenticated", ready: false },
      { id: "native-required", authentication: "unauthenticated", required: true, ready: false },
      { id: "native-unknown", authentication: "unknown", ready: false },
      { id: "native-unknown-required", authentication: "unknown", required: true, ready: false },
      { id: "native-contradictory", authentication: "unauthenticated", required: false, ready: false },
      { id: "native-no-install", authentication: "unknown", native: true, required: false, installation: "not-installed", ready: false },
      { id: "native-unknown-install", authentication: "unknown", native: true, required: false, installation: "unknown", ready: false },
      { id: "claude-unknown", driver: "claude", authentication: "unknown", native: true, ready: true },
      { id: "opencode-unknown", driver: "opencode", authentication: "unknown", native: true, ready: true },
      { id: "other-unchecked", driver: "claude", authentication: "unknown", ready: false },
    ];
    try {
      for (const expected of cases) {
        const driver = expected.driver ?? "codex";
        getNativeProviderAdapter(driver)!.check = async () => ({
          installation: { status: expected.installation ?? "installed" }, authentication: expected.authentication,
          ...(expected.required !== undefined ? { requiresOpenaiAuth: expected.required } : {}),
          ...(expected.native !== undefined ? { nativeSessionReady: expected.native } : {}),
          models: [], methods: [], canLogout: false,
        });
        const created = await providerRoutes.request("http://localhost/providers", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ instanceId: expected.id, driver, customModels: [{ id: "fixture-model", label: "Fixture" }] }),
        });
        assert.equal(created.status, 201);
        assert.equal(created.headers.get("cache-control"), "no-store");
        const provider = await created.json() as ProviderInstance;
        const required = driver === "codex" ? expected.required : undefined;
        assert.equal(provider.requiresOpenaiAuth, required);
        assert.equal(provider.configured, expected.ready);
        assert.equal(provider.nativeSessionReady, expected.ready);
        assert.equal(provider.authStatus, expected.installation === "not-installed" ? "not-installed" : expected.authentication);
        assert.equal(provider.credentialSource, expected.authentication === "authenticated" ? "provider" : null);
        assert.equal(provider.email, undefined);
        assert.equal(provider.canLogin, false);
        const checked = await providerRoutes.request(`http://localhost/providers/${expected.id}/test`, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        assert.equal(checked.status, 200);
        const result = await checked.json() as ProviderTestResult;
        assert.equal(result.kind, "agent-status");
        assert.equal(result.ok, expected.ready);
        assert.equal(result.nativeSessionReady, expected.ready);
        assert.equal(result.authentication, expected.authentication);
        assert.equal(result.requiresOpenaiAuth, required);
        assert.equal(Boolean(result.error), !expected.ready);
        assert.deepEqual(getStoredInstance(expected.id)!.observations?.lastConnectionTest, result);
        assert.deepEqual((await probeProviderInstance(expected.id)).lastConnectionTest, result);
        if (expected.ready) {
          assert.equal((await resolveProviderRuntime({ providerInstanceId: expected.id, modelName: "fixture-model" })).modelId, "fixture-model");
        } else {
          await assert.rejects(resolveProviderRuntime({ providerInstanceId: expected.id, modelName: "fixture-model" }), {
            code: expected.installation || expected.authentication !== "unauthenticated" ? "provider_not_configured" : "provider_not_authenticated",
          });
        }
      }
    } finally { for (const { adapter, check } of originals) adapter.check = check; }
  });
});

test("Codex derived status and config paths cannot be supplied through HTTP configuration", async () => {
  await isolated(async () => {
    for (const derived of [{ codexConfig: { homePath: "/untrusted", configPath: "/untrusted/config.toml" } }, { requiresOpenaiAuth: false }]) {
      const response = await providerRoutes.request("http://localhost/providers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ driver: "codex", ...derived }),
      });
      assert.equal(response.status, 400);
    }
    const instance = getStoredInstance("codex")!;
    const response = await providerRoutes.request("http://localhost/providers/codex", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: instance.revision, requiresOpenaiAuth: false }),
    });
    assert.equal(response.status, 400);
    assert.equal(getStoredInstance("codex")!.revision, instance.revision);
  });
});

test("native homes may be shared and overridden without weakening server environment boundaries", async () => {
  await isolated(async directory => {
    const a = createProviderInstance({ driver: "codex" });
    const shared = createProviderInstance({ driver: "codex", config: { homePath: a.homeDirectory } });
    assert.equal(shared.homeDirectory, a.homeDirectory);
    assert.notEqual(shared.stateDirectory, a.stateDirectory);
    const alias = path.join(directory, "native-home-alias");
    await symlink(a.homeDirectory, alias);
    assert.equal(createProviderInstance({ driver: "codex", config: { homePath: alias } }).homeDirectory, alias);
    const home = path.join(directory, "explicit-host-home");
    const explicit = updateProviderInstance(a.instanceId, { environment: [
      { name: "HOME", value: home, sensitive: false }, { name: "CODEX_HOME", value: path.join(home, "codex"), sensitive: false },
      { name: "XDG_CONFIG_HOME", value: path.join(home, "config"), sensitive: false }, { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
    ] });
    const context = providerContext(explicit, path.join(directory, "resolved-project"));
    assert.equal(context.env.HOME, home);
    assert.equal(context.env.CODEX_HOME, path.join(home, "codex"));
    assert.equal(context.env.AGENT_CLI_CREDENTIAL_STORE, "file");
    assert.equal(context.homeDirectory, path.join(home, "codex"));
    assert.throws(() => updateProviderInstance(a.instanceId, { driver: "claude" } as never), /cannot be changed/);
    const serverOnlyNames = ["AGENT_WORKSPACE_ACCESS_TOKEN", "DATABASE_URL", "NODE_OPTIONS", "PM_AUTOMATION_SERVICE_SECRET", "PM_AUTOMATION_INTEGRATION_KEY", "pm_automation_git_key"];
    for (const name of serverOnlyNames) {
      process.env[name] = "server-only-fixture";
      assert.throws(() => updateProviderInstance(a.instanceId, { environment: [{ name, value: "not-provider-config", sensitive: true }] }), /reserved/);
    }
    const isolatedEnvironment = providerEnvironment(explicit);
    for (const name of serverOnlyNames) assert.equal(isolatedEnvironment[name], undefined, `${name} must not reach a native provider process`);
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

test("native environment migration invalidates legacy observations and preserves opaque obsolete rows", async () => {
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
    assert.ok(active.revision > 23);
    assert.equal(active.homeDirectory, legacy.cliHome);
    assert.equal(active.config.homePath, legacy.cliHome);
    assert.equal(active.config.binaryPath, legacy.executable);
    assert.equal(getStoredInstance(opaque.instanceId), null);
    const migrated = JSON.parse(await readFile(target, "utf8"));
    assert.deepEqual(migrated.instances[0], opaque);
    assert.equal(migrated.instances[1].cliHome, legacy.cliHome);
    assert.equal(typeof migrated.instances[1].nativeEnvironmentBinding, "string");
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
    assert.equal(getProviderModels(instance.instanceId).some((model) => model.id === "discovered-native"), true);
    const disabled = updateProviderInstance(instance.instanceId, { enabled: false }, changed.revision);
    assert.equal(getProviderModels(instance.instanceId).some((model) => model.id === "discovered-native"), true);
    assert.throws(() => resolveCatalogModel(instance.instanceId, "discovered-native"), { code: "provider_disabled" });
    assert.throws(() => recordProviderObservations(instance.instanceId, instance.revision, {}), /disabled|changed/);
    deleteProviderInstance(instance.instanceId);
    const replacement = createProviderInstance({ instanceId: instance.instanceId, driver: "codex", label: "Replacement" });
    assert.ok(replacement.revision > disabled.revision);
    assert.throws(() => recordProviderObservations(replacement.instanceId, changed.revision, {}), /changed/);
  });
});

test("a fresh empty original inventory removes stale discovery without selecting another model", async () => {
  await isolated(async () => {
    const adapter = getNativeProviderAdapter("codex")!;
    const originalCheck = adapter.check;
    const instance = createProviderInstance({ instanceId: "fresh-inventory", driver: "codex" });
    recordProviderObservations(instance.instanceId, instance.revision, {
      discoveredModels: [{ id: "removed-native", label: "Removed", temperature: false, isDefault: true }],
    });
    assert.equal(resolveCatalogModel(instance.instanceId, "removed-native").id, "removed-native");
    try {
      adapter.check = async () => ({ installation: { status: "installed" }, authentication: "unknown",
        nativeSessionReady: true, models: [], methods: [], canLogout: false });
      assert.deepEqual((await probeProviderInstance(instance.instanceId)).models, []);
      assert.throws(() => resolveCatalogModel(instance.instanceId, "removed-native"), { code: "invalid_model" });
      assert.throws(() => resolveCatalogModel(instance.instanceId, ""), { code: "invalid_model" });
      await checkProviderConnection(instance.instanceId);
      assert.deepEqual(getStoredInstance(instance.instanceId)?.observations?.discoveredModels, []);
    } finally { adapter.check = originalCheck; }
  });
});
test("legacy environment stays private and redacted entries roundtrip without changing their secret", async () => {
  await isolated(async directory => {
    await writeFile(path.join(directory, "provider-instances.json"), JSON.stringify({ version: 1, instances: [{ instanceId: "9legacy", driver: "codex", label: "", revision: 1, env: { OLD_KEY: "old-secret" } }] }));
    const old = getStoredInstance("9legacy")!;
    const view = publicInstanceConfig(old);
    assert.deepEqual(view.environment, [{ name: "OLD_KEY", value: "", sensitive: true, valueRedacted: true }]);
    assert.notEqual(view.label, "");
    const next = updateProviderInstance(old.instanceId, { environment: view.environment }, old.revision);
    assert.equal(next.env.OLD_KEY, "old-secret");
    assert.throws(() => updateProviderInstance(old.instanceId, { environment: [{ name: "OTHER", value: "", sensitive: true, valueRedacted: true }] }, next.revision), /redacted/);
    assert.throws(() => createProviderInstance({ instanceId: "9new", driver: "codex" }), /start with a letter/);
  });
});

test("custom model options are persisted and validated against descriptors", async () => {
  await isolated(async () => {
    const instance = createProviderInstance({ driver: "codex", customModels: [{ id: "private", label: "Private", capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "high", label: "High" }] }] } }], modelPreferences: { hidden: [], order: ["private"], favorites: ["private"], options: { private: [{ id: "effort", value: "high" }] } } });
    assert.deepEqual(resolveProviderModelOptions(instance.instanceId, "private"), [{ id: "effort", value: "high" }]);
    assert.deepEqual(resolveProviderModelOptions(instance.instanceId, "private", []), []);
    assert.throws(() => resolveProviderModelOptions(instance.instanceId, "private", [{ id: "effort", value: "bad" }]), /Unsupported model option/);
    assert.throws(() => resolveProviderModelOptions(instance.instanceId, "private", [{ id: "unknown", value: true }]), /Unsupported model option/);
  });
});
test("maintenance is revision checked, cancellable and excludes account mutations", async () => {
  await isolated(async () => {
    const instance = createProviderInstance({ driver: "codex" });
    const adapter = getNativeProviderAdapter("codex")!;
    const previous = adapter.prepare;
    adapter.prepare = async (_context, signal, progress) => {
      progress?.({ message: "downloading", bytesDownloaded: 4, bytesTotal: 10 });
      const { promise, reject } = Promise.withResolvers<void>();
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      await promise;
      return { message: "done" };
    };
    try {
      const request = (revision: number) => providerRoutes.request(`http://localhost/providers/${instance.instanceId}/maintenance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, action: "install" }) });
      assert.equal((await request(instance.revision + 1)).status, 409);
      const started = await request(instance.revision);
      assert.equal(started.status, 200);
      assert.equal((await started.json() as { status: string }).status, "running");
      const current = getStoredInstance(instance.instanceId)!;
      const update = await providerRoutes.request(`http://localhost/providers/${instance.instanceId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: current.revision, label: "blocked" }) });
      assert.equal(update.status, 409);
      const cancelled = await providerRoutes.request(`http://localhost/providers/${instance.instanceId}/maintenance`, { method: "DELETE" });
      assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
    } finally { adapter.prepare = previous; }
  });
});

test("health refresh settings are durable and reject stale revisions", async () => {
  await isolated(async () => {
    const initial = await (await providerRoutes.request("http://localhost/providers/settings")).json() as { revision: number; healthRefreshIntervalSeconds: number };
    assert.equal(initial.healthRefreshIntervalSeconds, 300);
    const request = (revision: number) => providerRoutes.request("http://localhost/providers/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, healthRefreshIntervalSeconds: 0 }) });
    const saved = await request(initial.revision);
    assert.equal((await saved.json() as { healthRefreshIntervalSeconds: number }).healthRefreshIntervalSeconds, 0);
    assert.equal((await request(initial.revision)).status, 409);
  });
});

test("native CRUD routes expose only config names for secrets and reject stale revisions", async () => {
  await isolated(async () => {
    const adapter = getNativeProviderAdapter("antigravity")!;
    const oldCheck = adapter.check;
    adapter.check = async () => ({ installation: { status: "unknown" }, authentication: "unknown", models: [], methods: [], canLogout: false });
    try {
      const response = await providerRoutes.request("http://localhost/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ driver: "antigravity", label: "Work", config: { apiKey: "route-secret" }, environment: [{ name: "WORK_KEY", value: "env-route-secret", sensitive: true }] }) });
      assert.equal(response.status, 201);
      const provider = await response.json() as { instanceId: string; revision: number; environment: { name: string; value: string; sensitive: boolean; valueRedacted?: boolean }[]; secretConfigKeys: string[] };
      assert.deepEqual(provider.environment, [{ name: "WORK_KEY", value: "", sensitive: true, valueRedacted: true }]);
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

test("disabled and failed catalog inspections never reuse readiness or disclose native secrets", async () => {
  await isolated(async () => {
    const adapter = getNativeProviderAdapter("opencode")!;
    const originalCheck = adapter.check;
    const instance = createProviderInstance({ instanceId: "readiness-boundary", driver: "opencode",
      config: { serverPassword: "native-inspection-secret" } });
    try {
      adapter.check = async () => ({ installation: { status: "installed" }, authentication: "unknown",
        nativeSessionReady: true, models: [], methods: [], canLogout: false });
      assert.equal((await probeProviderInstance(instance.instanceId)).nativeSessionReady, true);
      const disabled = updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
      adapter.check = async () => assert.fail("Disabled instances must not launch a check");
      const disabledDto = await probeProviderInstance(instance.instanceId);
      assert.equal(disabledDto.nativeSessionReady, false);
      assert.equal(disabledDto.configured, false);
      updateProviderInstance(instance.instanceId, { enabled: true }, disabled.revision);
      adapter.check = async () => { throw new Error("Inspection failed with native-inspection-secret"); };
      const failed = await probeProviderInstance(instance.instanceId);
      assert.equal(failed.nativeSessionReady, false);
      assert.equal(failed.configured, false);
      assert.equal(failed.authStatus, "unknown");
      assert.doesNotMatch(JSON.stringify(failed), /native-inspection-secret/);
    } finally { adapter.check = originalCheck; }
  });
});

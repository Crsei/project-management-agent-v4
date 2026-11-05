import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import * as Schema from "effect/Schema";
import { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import { OmpSettings } from "@t3tools/provider-omp/settings";
import type { StoredProviderInstance } from "../instances.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { canonicalProviderModelId, validateClaudeConfig, validatePiConfig, projectProviderInstance, toT3DriverKind, fromT3DriverKind } from "./config-mapping.ts";
import { resolveProviderNativeHome } from "./native-paths.ts";

const instance: StoredProviderInstance = { instanceId: "account-original", driver: "opencode", label: "Account", enabled: true,
  config: { binaryPath: "bin/opencode", serverUrl: "", serverPassword: "private-test-only" },
  env: { TOKEN: "private-environment" }, envSensitivity: { TOKEN: true }, revision: 9,
  homeDirectory: "/native/home", stateDirectory: "/application/private", customModels: [{ id: "custom-model", label: "Custom" }] };
function context(config = instance.config): ProviderDriverContext {
  return { instanceId: instance.instanceId, driver: instance.driver, revision: instance.revision, config,
    homeDirectory: instance.homeDirectory, stateDirectory: instance.stateDirectory, cwd: "/workspace/project", env: { HOME: "/user" },
    instanceEnvironment: instance.env, customModels: instance.customModels };
}
test("source schema projection normalizes relative executable paths without mutating lease identity", () => {
  const current = context();
  const entry = projectProviderInstance(instance, current);
  const config = Schema.decodeUnknownSync(OpenCodeSettings)(entry.config);
  assert.equal(config.binaryPath, path.resolve(current.cwd, "bin/opencode"));
  assert.equal(current.config.binaryPath, "bin/opencode");
  assert.equal(instance.config.binaryPath, "bin/opencode");
  assert.equal(config.serverPassword, "private-test-only");
  assert.deepEqual(entry.environment, [{ name: "TOKEN", value: "private-environment", sensitive: true }]);
  const custom = config.customModels[0];
  assert.equal(typeof custom === "object" ? custom.slug : custom, "custom-model");
  assert.equal(typeof custom === "object" ? custom.name : undefined, "Custom");
  for (const binaryPath of ["opencode", "~/bin/opencode", "/absolute/opencode"]) {
    const mapped = Schema.decodeUnknownSync(OpenCodeSettings)(projectProviderInstance(instance, context({ ...instance.config, binaryPath })).config);
    assert.equal(mapped.binaryPath, binaryPath);
  }
});
test("Claude changes only driver kind and historical non-slug IDs are not silently rewritten", () => {
  const mapped = projectProviderInstance({ ...instance, driver: "claude" });
  assert.equal(mapped.driver, "claudeAgent");
  assert.equal(instance.instanceId, "account-original");
  assert.equal(fromT3DriverKind(toT3DriverKind("claude")), "claude");
  assert.throws(() => projectProviderInstance({ ...instance, instanceId: "1-historical-id" }));
  assert.equal(projectProviderInstance({ ...instance, enabled: false }).enabled, false);
});

test("managed Codex source config projects the exact existing lease Home without moving installation state", () => {
  const managed: StoredProviderInstance = { ...instance, driver: "codex",
    homeDirectory: "/application/private/managed-original", stateDirectory: "/application/private/managed-original",
    config: { setupMode: "managed", homePath: "/ignored/home", shadowHomePath: "/ignored/shadow" } };
  const current: ProviderDriverContext = { ...context(managed.config), driver: "codex",
    homeDirectory: managed.homeDirectory, stateDirectory: managed.stateDirectory };
  for (const entry of [projectProviderInstance(managed), projectProviderInstance(managed, current)]) {
    const projected = Schema.decodeUnknownSync(CodexSettings)(entry.config);
    assert.equal(projected.homePath, managed.homeDirectory);
    assert.equal(projected.shadowHomePath, "");
    assert.equal(projected.setupMode, "managed");
  }
  assert.equal(current.config.homePath, "/ignored/home");
  assert.equal(current.config.shadowHomePath, "/ignored/shadow");
  assert.equal(path.join(current.stateDirectory, ".managed-codex", "runtime"), "/application/private/managed-original/.managed-codex/runtime");
});

test("Claude explicit Home projection matches the bound lease while inherited literal native configuration stays untouched", () => {
  const claude: StoredProviderInstance = { ...instance, driver: "claude",
    config: { homePath: "~/.claude-profile" }, homeDirectory: "/bound/user/.claude-profile" };
  const current: ProviderDriverContext = { ...context(claude.config), driver: "claude", homeDirectory: claude.homeDirectory,
    env: { HOME: "/bound/user", CLAUDE_CONFIG_DIR: "~/literal-native-home" } };
  const originalEnvironment = { ...current.env };
  assert.equal(Schema.decodeUnknownSync(ClaudeSettings)(projectProviderInstance(claude, current).config).homePath, claude.homeDirectory);
  const inherited = { ...claude, config: { homePath: "" }, homeDirectory: "/workspace/project/~/literal-native-home" };
  const inheritedContext = { ...current, config: inherited.config, homeDirectory: inherited.homeDirectory };
  assert.equal(Schema.decodeUnknownSync(ClaudeSettings)(projectProviderInstance(inherited, inheritedContext).config).homePath, "");
  assert.deepEqual(current.env, originalEnvironment);
  assert.equal(current.config.homePath, "~/.claude-profile");
});

test("OMP keeps its independent native environment and requires no default model migration", () => {
  const omp: StoredProviderInstance = { ...instance, driver: "omp", label: "OMP",
    config: { binaryPath: "bin/omp", launchArgs: "" } };
  const current: ProviderDriverContext = { ...context(omp.config), driver: "omp",
    env: { HOME: "/native/user", PI_CODING_AGENT_DIR: "/pi-native-only", OMP_CWD: "/native/workspace" } };
  const before = { ...current.env };
  const mapped = projectProviderInstance(omp, current);
  const config = Schema.decodeUnknownSync(OmpSettings)(mapped.config);
  assert.equal(mapped.driver, "omp");
  assert.equal(fromT3DriverKind(toT3DriverKind("omp")), "omp");
  assert.equal(config.binaryPath, path.resolve(current.cwd, "bin/omp"));
  assert.equal(config.launchArgs, "");
  assert.equal(config.customModels.length, 1);
  assert.deepEqual(current.env, before);
  assert.equal(current.homeDirectory, omp.homeDirectory);
  assert.equal(Object.hasOwn(mapped.config as object, "model"), false);
  assert.equal(fromT3DriverKind(toT3DriverKind("pi")), "pi");
});

test("host configuration boundary retains pinned aliases and original argument validation", () => {
  assert.equal(canonicalProviderModelId("claude", "SoNnEt"), "claude-sonnet-5-5");
  assert.equal(canonicalProviderModelId("claude", "registered-custom-model"), "registered-custom-model");
  assert.equal(canonicalProviderModelId("codex", "sonnet"), "sonnet");
  assert.equal(validateClaudeConfig({}).binaryPath, "claude");
  for (const validate of [validateClaudeConfig, validatePiConfig]) {
    assert.throws(() => validate({ unknownSetting: "not accepted" }), /Unknown/);
    assert.throws(() => validate({ binaryPath: "bad\0path" }), /NUL/);
  }
});

test("native Home boundary preserves managed, direct and explicit overlay precedence without reading credentials", () => {
  const cwd = path.resolve("/authorized/project"), userHome = path.resolve("/native/user"), managed = path.resolve("/private/managed");
  assert.equal(resolveProviderNativeHome("codex", { setupMode: "managed" }, { CODEX_HOME: "/ignored" }, cwd, userHome, managed), managed);
  assert.equal(resolveProviderNativeHome("codex", {}, { CODEX_HOME: "profiles/codex" }, cwd, userHome, managed), path.resolve(cwd, "profiles/codex"));
  assert.equal(resolveProviderNativeHome("codex", { homePath: "~/shared", shadowHomePath: "overlay" }, { CODEX_HOME: "/ignored" }, cwd, userHome, managed), path.resolve(cwd, "overlay"));
  assert.equal(resolveProviderNativeHome("claude", { homePath: "~/claude-profile" }, { CLAUDE_CONFIG_DIR: "/ignored" }, cwd, userHome, managed), path.join(userHome, "claude-profile"));
  assert.equal(resolveProviderNativeHome("pi", {}, {}, cwd, userHome, managed), userHome);
});

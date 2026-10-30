import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderDriver, ProviderInstance, ProviderModel } from "@agent-workspace/contracts/provider";
import {
  formatProviderUpdateRequiredNotice, getProviderClient, getProviderDriverKind,
  getProviderInstanceDisplayName, getProviderModelShortName, getProviderModelTraits,
  getProviderSecretConfigKeys, getProviderSettingsFields, getTraitSelectChange,
  normalizeProviderAccentColor, providerAccentForegroundColor, providerInstanceInitials,
  resolveProviderModelSelection, shouldShowProviderInstanceBadge, withProviderClientMetadata,
} from "./providers.ts";

const drivers: ProviderDriver[] = ["codex", "claude", "cursor", "grok", "fx", "opencode", "antigravity", "muse", "pi", "acpRegistry"];
const model: ProviderModel = { id: "explicit", label: "Explicit", temperature: false, isDefault: true };
const provider = (patch: Partial<ProviderInstance> = {}): ProviderInstance => ({
  instanceId: "kept-instance", driver: "codex", label: "Codex", enabled: true, config: {}, secretConfigKeys: [],
  authMode: "agent", authStatus: "unknown", nativeSessionReady: false, configured: false, credentialSource: null,
  models: [model], modelsSource: "discovered", canLogin: false, canLogout: false, ...patch,
});

test("every PM family consumes its original client schema and branding metadata", () => {
  for (const driver of drivers) {
    const client = getProviderClient(driver)!;
    assert.ok(client);
    const projected = withProviderClientMetadata({ driver, description: "Host boundary", source: "host" });
    assert.equal(projected.driver, driver);
    assert.equal(projected.clientDriver, client.driverKind);
    assert.equal(projected.label, client.label);
    assert.equal(projected.icon, client.icon);
    assert.deepEqual(projected.modelFamilies, client.modelFamilies ?? []);
    assert.equal(projected.defaultInstance, client.hasDefaultInstance !== false);
    assert.deepEqual(projected.fields, getProviderSettingsFields(driver));
    assert.doesNotThrow(() => JSON.stringify(projected));
  }
  assert.equal(getProviderDriverKind("claude"), "claudeAgent");
  assert.deepEqual(getProviderSettingsFields("cursor"), []);
  assert.equal(getProviderClient("fx")!.featured, false);
  assert.equal(getProviderClient("acpRegistry")!.hasDefaultInstance, false);
});

test("settings preserve original order, secrets, clearing and local ACP visibility", () => {
  assert.deepEqual(getProviderSettingsFields("codex").map(field => field.key), ["binaryPath", "homePath", "shadowHomePath", "launchArgs"]);
  const password = getProviderSettingsFields("opencode").find(field => field.key === "serverPassword")!;
  assert.equal(password.secret, true);
  assert.equal(password.type, "password");
  assert.equal(password.clearWhenEmpty, "omit");
  assert.deepEqual(getProviderSecretConfigKeys("opencode"), ["serverPassword"]);
  assert.deepEqual(getProviderSecretConfigKeys("antigravity"), ["apiKey"]);
  assert.equal(getProviderSettingsFields("claude").find(field => field.key === "idleCompaction")?.control, "select");
  const local = getProviderSettingsFields("acpRegistry", { source: "local" });
  assert.deepEqual(local.map(field => field.key), ["source", "commandPath"]);
  assert.equal(local[1]?.label, "Executable");
  assert.equal(getProviderSettingsFields("acpRegistry").find(field => field.key === "agentId")?.clearWhenEmpty, "persist");
});

test("display translates the Claude family without renaming PM instance IDs", () => {
  const nativeDefault = provider({ instanceId: "claude", driver: "claude", label: "Claude" });
  assert.equal(getProviderInstanceDisplayName(nativeDefault), "Claude");
  assert.equal(nativeDefault.instanceId, "claude");
  assert.equal(getProviderInstanceDisplayName({ ...nativeDefault, instanceId: "claude_work" }), "Claude Work");
  assert.equal(getProviderInstanceDisplayName({ ...nativeDefault, label: "My native account" }), "My native account");
  assert.equal(getProviderModelShortName("claude", { label: "Claude Opus 5.5" }), "Opus 5.5");
  assert.equal(getProviderModelShortName("claude", { label: "Claude Opus 5.5", shortName: "Native label" }), "Native label");
  assert.equal(providerInstanceInitials("Codex (hub)"), "CH");
  assert.equal(normalizeProviderAccentColor("invalid"), undefined);
  assert.equal(providerAccentForegroundColor("#2563eb"), "#ffffff");
  const entry = provider({ driver: "acpRegistry", config: { agentId: "one" } });
  assert.equal(shouldShowProviderInstanceBadge(entry, [entry, provider({ driver: "acpRegistry", config: { agentId: "two" } })]), false);
  assert.equal(shouldShowProviderInstanceBadge(entry, [entry, { ...entry }]), true);
});

test("unselected, removed, disabled and historical model states are never replaced by defaults", () => {
  const entry = provider();
  assert.equal(resolveProviderModelSelection([entry], undefined, undefined).status, "unselected-provider");
  assert.equal(resolveProviderModelSelection([entry], "deleted", "explicit").status, "missing-provider");
  assert.equal(resolveProviderModelSelection([entry], entry.instanceId, undefined).status, "unselected-model");
  assert.equal(resolveProviderModelSelection([entry], entry.instanceId, "removed").status, "missing-model");
  assert.equal(resolveProviderModelSelection([{ ...entry, enabled: false }], entry.instanceId, "explicit").status, "disabled-provider");
  assert.equal(resolveProviderModelSelection([{ ...entry, models: [{ ...model, disabledReason: "Unavailable" }] }], entry.instanceId, "explicit").status, "disabled-model");
  const selected = resolveProviderModelSelection([{ ...entry, models: [{ ...model, aliases: ["historical-native-alias"] }] }], entry.instanceId, "historical-native-alias");
  assert.equal(selected.status, "selected");
  if (selected.status === "selected") assert.equal(selected.model.id, "explicit");
  assert.equal(entry.models[0]?.isDefault, true);
});

test("source traits render native choices and retain explicit invalid option states", () => {
  const capable: ProviderModel = { ...model, capabilities: { optionDescriptors: [
    { id: "reasoningEffort", label: "Reasoning", type: "select", options: [{ id: "low", label: "Low" }, { id: "xhigh", label: "Extra high" }], currentValue: "low" },
    { id: "serviceTier", label: "Speed", type: "select", options: [{ id: "default", label: "Normal" }, { id: "fast", label: "Fast" }], currentValue: "default" },
  ] } };
  const options = [{ id: "reasoningEffort", value: "xhigh" }, { id: "serviceTier", value: "fast" }];
  const traits = getProviderModelTraits({ driver: "codex", model: capable, options });
  assert.equal(traits.label, "Extra high Fast");
  assert.equal(traits.speedLabel, "Fast");
  assert.deepEqual(traits.invalidOptions, []);
  const invalid = [{ id: "reasoningEffort", value: "removed-choice" }, { id: "removed-option", value: true }];
  assert.deepEqual(getProviderModelTraits({ driver: "codex", model: capable, options: invalid }).invalidOptions, invalid);
  assert.equal(capable.capabilities?.optionDescriptors?.[0]?.currentValue, "low");
  const effort = { id: "effort", label: "Effort", type: "select" as const, options: [{ id: "high", label: "High" }, { id: "ultrathink", label: "Ultrathink" }], promptInjectedValues: ["ultrathink"] };
  const claude = getProviderModelTraits({ driver: "claude", model: { ...model, capabilities: { optionDescriptors: [effort] } }, prompt: "Explain" });
  assert.equal(getTraitSelectChange(claude, effort, "Explain", "ultrathink")?.prompt, "Ultrathink:\nExplain");
});

test("source update notices are search-aware and never inject unavailable models into choices", () => {
  const notice = { driver: "claude" as const, updateRequiredModels: [{ id: "new-native-model", label: "Native model", minVersion: "2.1.0" }] };
  assert.equal(formatProviderUpdateRequiredNotice(notice), "Update Claude Code to v2.1.0 or newer to use Native model.");
  assert.equal(formatProviderUpdateRequiredNotice(notice, "unrelated"), null);
  assert.equal(formatProviderUpdateRequiredNotice({ driver: "opencode" }), null);
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionAppIds, extensionBindSchema } from "@agent-workspace/contracts/extensions";
import { makePrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { assertExtensionHostBindingCurrent, listExternalExtensionTargets, refreshExistingExtensionHostBinding, resolveExtensionHostBinding } from "./external-targets.ts";
import { ExtensionHost } from "./service.ts";
import { readExtensionContexts } from "./storage.ts";
import { createProviderInstance } from "../providers/instances.ts";
import { canonicalExtensionProviderPath } from "./provider-bindings.ts";

test("all twelve upstream applications can be explicit external targets without adding a PM Provider", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-external-fixture-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  process.env.HOME = path.join(root, "home");
  process.env.USERPROFILE = process.env.HOME;
  const filename = path.join(root, "targets.json");
  const targets = extensionAppIds.map(app => ({ id: app, label: app, app, homeDir: process.env.HOME, appDir: path.join(root, `native-${app}`) }));
  try {
    await writeFile(filename, JSON.stringify(targets), { mode: 0o600 });
    makePrivatePath(filename);
    process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE = filename;
    assert.deepEqual(listExternalExtensionTargets().map(target => target.app), [...extensionAppIds]);
    const result = resolveExtensionHostBinding({ providerInstanceIds: [], externalTargetIds: [...extensionAppIds], confirmed: true });
    assert.deepEqual(result.binding.apps, [...extensionAppIds]);
    assert.deepEqual(result.binding.providerInstanceIds, []);
    assert.equal(result.binding.claudeMcpFile, path.join(root, "native-claude", ".claude.json"));
    assert.ok(result.binding.physicalRoots.includes(canonicalExtensionProviderPath(path.join(root, "native-claude", ".claude.json"))));
    assert.match(result.binding.warnings.join(" "), /do not add a PM Chat Provider/);
    assertExtensionHostBindingCurrent(result);
    assert.throws(() => refreshExistingExtensionHostBinding({ ...result, binding: { ...result.binding, bindingFingerprint: "" } }), { code: "binding_reconfirmation_required" });
    await writeFile(filename, JSON.stringify(targets.map(target => target.app === "codex" ? { ...target, appDir: path.join(root, "changed-codex") } : target)), { mode: 0o600 });
    assert.throws(() => assertExtensionHostBindingCurrent(result), { code: "external_binding_changed" });
    assert.throws(() => resolveExtensionHostBinding({ providerInstanceIds: [], externalTargetIds: ["unknown"], confirmed: true }), { code: "external_target_unknown" });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
test("external Claude MCP file authority distinguishes default-looking overrides and stays private", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-external-claude-"));
  const home = path.join(root, "home");
  const appDir = path.join(home, ".claude");
  const homeFile = path.join(home, ".claude.json");
  const overrideFile = path.join(appDir, ".claude.json");
  const filename = path.join(root, "targets.json");
  const host = new ExtensionHost();
  const defaults = { id: "default", label: "Claude default", app: "claude", homeDir: home, appDir };
  const override = { ...defaults, id: "override", label: "Claude explicit default-looking override", claudeMcpFile: overrideFile };
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    await writeFile(filename, JSON.stringify([defaults, override]), { mode: 0o600 });
    makePrivatePath(filename);
    process.env.CC_SWITCH_EXTERNAL_TARGETS_FILE = filename;
    const inventory = listExternalExtensionTargets();
    assert.equal(inventory.find(target => target.id === "default")?.claudeMcpFile, homeFile);
    assert.equal(inventory.find(target => target.id === "override")?.claudeMcpFile, overrideFile);
    assert.notEqual(inventory[0]!.fingerprint, inventory[1]!.fingerprint);
    assert.ok(inventory[1]!.physicalRoots.includes(canonicalExtensionProviderPath(overrideFile)));
    assert.throws(() => resolveExtensionHostBinding({ providerInstanceIds: [], externalTargetIds: ["default", "override"], confirmed: true }), { code: "binding_claude_mcp_conflict" });
    createProviderInstance({ instanceId: "claude-default-authority", driver: "claude", environment: [{ name: "HOME", value: home, sensitive: false }, { name: "USERPROFILE", value: home, sensitive: false }] });
    assert.throws(() => resolveExtensionHostBinding({ providerInstanceIds: ["claude-default-authority"], externalTargetIds: ["override"], confirmed: true }), { code: "binding_claude_mcp_conflict" });
    const resolved = resolveExtensionHostBinding({ providerInstanceIds: [], externalTargetIds: ["override"], confirmed: true });
    assert.equal(resolved.binding.claudeMcpFile, overrideFile);
    assert.throws(() => assertExtensionHostBindingCurrent({ ...resolved, binding: { ...resolved.binding, claudeMcpFile: undefined } }), { code: "external_binding_changed" });
    const bound = await host.bind({ providerInstanceIds: [], externalTargetIds: ["override"], confirmed: true });
    const stored = (await readExtensionContexts()).find(context => context.id === bound.context.id)!;
    assert.equal(stored.binding?.claudeMcpFile, overrideFile);
    assert.equal(stored.externalTargets?.[0]?.claudeMcpFile, overrideFile);
    for (const publicValue of [host.targets(), bound, await host.list(new Headers())]) {
      assert.equal(JSON.stringify(publicValue).includes("claudeMcpFile"), false);
      assert.equal(JSON.stringify(publicValue).includes(overrideFile), false);
    }
    assert.throws(() => extensionBindSchema.parse({ providerInstanceIds: [], externalTargetIds: ["override"], confirmed: true, claudeMcpFile: homeFile }));
    await writeFile(filename, JSON.stringify([{ ...override, claudeMcpFile: homeFile }]));
    assert.throws(() => assertExtensionHostBindingCurrent(resolved), { code: "external_binding_changed" });
    for (const invalid of [
      { ...override, app: "codex" },
      { ...override, claudeMcpFile: path.join(root, "unregistered", ".claude.json") },
      { ...override, claudeMcpFile: ".claude.json" },
      { ...override, claudeMcpFile: `${home}${path.sep}.${path.sep}.claude.json` },
    ]) {
      await writeFile(filename, JSON.stringify([invalid]));
      assert.throws(() => listExternalExtensionTargets(), { code: "external_targets_invalid" });
    }
  } finally {
    await host.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

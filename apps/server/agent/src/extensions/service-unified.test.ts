import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExtensionHost } from "./service.ts";
import { readExtensionContexts } from "./storage.ts";
import { createProviderInstance, listStoredInstances, updateProviderInstance } from "../providers/instances.ts";

// No sidecar binary is required: this test only resolves ownership and bindings.
test("enabled Providers from one Home share one unified management context", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-unified-context-"));
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    const environment = [
      { name: "HOME", value: process.env.HOME, sensitive: false },
      { name: "USERPROFILE", value: process.env.HOME, sensitive: false },
    ];
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    createProviderInstance({ instanceId: "unified-codex", driver: "codex", environment });
    createProviderInstance({ instanceId: "unified-opencode", driver: "opencode", environment });
    createProviderInstance({ instanceId: "unified-disabled-claude", driver: "claude", enabled: false, environment });

    const initial = await host.resolveProviderContext("unified-codex");
    assert.deepEqual(initial.context.apps, ["codex"]);
    const unified = await host.resolveEnabledProviderContexts();
    assert.equal(unified.contexts.length, 1);
    const context = unified.contexts[0]!;
    assert.equal(context.id, initial.context.id);
    assert.deepEqual(context.apps, ["codex", "opencode"]);
    assert.deepEqual(context.providerInstanceIds.sort(), ["unified-codex", "unified-opencode"]);
    assert.equal(context.providerInstanceIds.includes("unified-disabled-claude"), false);
    assert.equal((await host.resolveEnabledProviderContexts()).contexts[0]!.id, context.id);
    assert.equal((await readExtensionContexts()).length, 1);
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

async function withEnabledProviders(run: (host: ExtensionHost, root: string, environment: { name: string; value: string; sensitive: boolean }[]) => Promise<void>) {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-owner-regression-"));
  const host = new ExtensionHost();
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CC_SWITCH_EXTERNAL_TARGETS_FILE"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    await run(host, root, [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }]);
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}

test("same-Home profiles retain separate roots and previously saved context libraries", async () => {
  await withEnabledProviders(async (host, root, environment) => {
    createProviderInstance({ instanceId: "profile-one", driver: "codex", config: { homePath: path.join(root, "one") }, environment });
    createProviderInstance({ instanceId: "profile-two", driver: "codex", config: { homePath: path.join(root, "two") }, environment });
    const profiles = await host.resolveEnabledProviderContexts();
    assert.deepEqual(profiles.contexts.map(context => context.providerInstanceIds).sort(), [["profile-one"], ["profile-two"]]);
    createProviderInstance({ instanceId: "separate-opencode", driver: "opencode", environment });
    const separate = await host.resolveProviderContext("separate-opencode");
    const resolved = await host.resolveEnabledProviderContexts();
    assert.deepEqual(resolved.contexts.map(context => context.id).sort(), [...profiles.contexts.map(context => context.id), separate.context.id].sort());
    assert.ok(resolved.contexts.every(context => context.status === "stopped"));
  });
});

test("cross-Home native root overlap fails before publishing any owner", async () => {
  await withEnabledProviders(async (host, root, environment) => {
    const shared = path.join(root, "shared");
    createProviderInstance({ instanceId: "home-one", driver: "codex", config: { homePath: shared }, environment });
    createProviderInstance({ instanceId: "home-two", driver: "codex", config: { homePath: shared }, environment: environment.map(entry => ({ ...entry, value: path.join(root, "other-home") })) });
    const before = await readExtensionContexts();
    await assert.rejects(host.resolveEnabledProviderContexts(), { code: "native_root_owned" });
    assert.deepEqual(await readExtensionContexts(), before);
    const first = await host.resolveProviderContext("home-one");
    const owned = await readExtensionContexts();
    await assert.rejects(host.resolveEnabledProviderContexts(), { code: "native_root_owned" });
    assert.deepEqual(await readExtensionContexts(), owned);
    assert.equal(first.context.status, "stopped");
  });
});

test("partial symlink retargeting cannot rebind a retained multi-app library", async () => {
  await withEnabledProviders(async (host, root, environment) => {
    const one = path.join(root, "one"), two = path.join(root, "two"), alias = path.join(root, "alias");
    await mkdir(one); await mkdir(two); await symlink(one, alias, process.platform === "win32" ? "junction" : "dir");
    createProviderInstance({ instanceId: "linked-codex", driver: "codex", config: { homePath: alias }, environment });
    createProviderInstance({ instanceId: "fixed-opencode", driver: "opencode", environment });
    await host.resolveEnabledProviderContexts();
    const before = await readExtensionContexts();
    await unlink(alias); await symlink(two, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(host.resolveEnabledProviderContexts(), { code: "native_owner_stale" });
    assert.deepEqual(await readExtensionContexts(), before);
  });
});

test("disabling a same-root Provider alias preserves the enabled owner's library", async () => {
  await withEnabledProviders(async (host, _root, environment) => {
    createProviderInstance({ instanceId: "enabled-codex", driver: "codex", environment });
    const alias = createProviderInstance({ instanceId: "disabled-alias", driver: "codex", environment });
    const initial = (await host.resolveEnabledProviderContexts()).contexts[0]!;
    const before = (await readExtensionContexts()).find(context => context.id === initial.id)!;
    updateProviderInstance(alias.instanceId, { enabled: false }, alias.revision);
    const refreshed = (await host.resolveEnabledProviderContexts()).contexts;
    assert.deepEqual(refreshed.map(context => ({ id: context.id, providers: context.providerInstanceIds, apps: context.apps })),
      [{ id: initial.id, providers: ["enabled-codex"], apps: ["codex"] }]);
    const after = (await readExtensionContexts()).find(context => context.id === initial.id)!;
    assert.deepEqual(after.binding!.physicalRoots, before.binding!.physicalRoots);
    assert.deepEqual(after.binding!.appDirs, before.binding!.appDirs);
  });
});

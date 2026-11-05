import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../providers/instances.ts";
import {
  assertExtensionProviderBindingCurrent, canonicalExtensionProviderPath,
  extensionProviderPathsOverlap, invalidateExtensionProviderBindings, listExtensionProviderTargets,
  resolveExtensionProviderBinding,
} from "./provider-bindings.ts";

// All roots are synthetic. These tests never open native account/credential files or start a CLI.
test("native bindings preserve upstream app IDs, explicit homes, sharing, confirmation and current authority", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-provider-bindings-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  process.env.HOME = path.join(root, "server-home");
  process.env.USERPROFILE = process.env.HOME;
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) delete process.env[key];
  const one = path.join(root, "one");
  const two = path.join(root, "two");
  const environment = (home: string) => [
    { name: "HOME", value: home, sensitive: false },
    { name: "USERPROFILE", value: home, sensitive: false },
  ];
  try {
    await mkdir(process.env.HOME, { recursive: true });
    await mkdir(path.join(one, ".codex"), { recursive: true });
    await mkdir(two, { recursive: true });
    const first = createProviderInstance({ instanceId: "codex-one", driver: "codex", config: { homePath: path.join(one, ".codex") }, environment: environment(one) });
    createProviderInstance({ instanceId: "codex-two", driver: "codex", config: { homePath: path.join(two, ".codex") }, environment: environment(two) });
    const a = resolveExtensionProviderBinding({ providerInstanceIds: ["codex-one"], confirmed: true });
    const b = resolveExtensionProviderBinding({ providerInstanceIds: ["codex-two"], confirmed: true });
    assert.equal(a.homeDir, one);
    assert.equal(a.appDirs.codex, path.join(one, ".codex"));
    assert.equal(b.appDirs.codex, path.join(two, ".codex"));
    assert.equal(Object.hasOwn(a, "claudeMcpFile"), false);
    assert.equal(a.physicalRoots.some(left => b.physicalRoots.some(right => extensionProviderPathsOverlap(left, right))), false);
    assert.throws(() => resolveExtensionProviderBinding({ providerInstanceIds: ["codex-one", "codex-two"], confirmed: true }), { code: "extension_provider_home_conflict" });
    assert.throws(() => resolveExtensionProviderBinding({ providerInstanceIds: ["codex-one"], confirmed: false as true }), { code: "extension_provider_confirmation_required" });
    assertExtensionProviderBindingCurrent(a);
    assert.equal(getStoredInstance("codex-one")!.revision, first.revision);
    const alias = path.join(root, "codex-alias");
    await symlink(path.join(one, ".codex"), alias, process.platform === "win32" ? "junction" : "dir");
    createProviderInstance({ instanceId: "codex-shared", driver: "codex", config: { homePath: alias }, environment: environment(one) });
    const shared = listExtensionProviderTargets().find(target => target.providerInstanceId === "codex-one")!;
    assert.ok(shared.sharedProviderInstanceIds.includes("codex-shared"));
    assert.equal(resolveExtensionProviderBinding({ providerInstanceIds: ["codex-one", "codex-shared"], confirmed: true }).apps[0], "codex");
    const mutation = invalidateExtensionProviderBindings(["codex-one"], "install_skill_unified");
    assert.ok(mutation.providerInstanceIds.includes("codex-shared"));
    assert.equal(mutation.providerInstanceIds.includes("codex-two"), false);
    assert.equal(mutation.reloadRequired, true);
    assert.equal(mutation.liveExecutionsPreserved, true);
    assert.equal(getStoredInstance("codex-one")!.revision, first.revision);
    updateProviderInstance("codex-one", { config: { homePath: path.join(one, "changed-codex") } }, first.revision);
    assert.throws(() => assertExtensionProviderBindingCurrent(a), { code: "extension_provider_binding_changed" });

    // An ambient native override must remain distinct even when its root looks exactly like the default.
    process.env.CLAUDE_CONFIG_DIR = path.join(one, ".claude");
    createProviderInstance({ instanceId: "claude-host-inherited", driver: "claude", environment: environment(one) });
    const hostInherited = resolveExtensionProviderBinding({ providerInstanceIds: ["claude-host-inherited"], confirmed: true });
    assert.equal(hostInherited.appDirs.claude, path.join(one, ".claude"));
    assert.equal(hostInherited.claudeMcpFile, path.join(one, ".claude", ".claude.json"));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.throws(() => assertExtensionProviderBindingCurrent(hostInherited), { code: "extension_provider_binding_changed" });
    createProviderInstance({ instanceId: "claude-default", driver: "claude", environment: environment(one) });
    createProviderInstance({ instanceId: "claude-custom", driver: "claude", config: { homePath: path.join(one, "custom-claude") }, environment: environment(one) });
    createProviderInstance({ instanceId: "claude-explicit-default", driver: "claude", config: { homePath: path.join(one, ".claude") }, environment: environment(one) });
    createProviderInstance({ instanceId: "claude-env-default", driver: "claude", environment: [...environment(one), { name: "CLAUDE_CONFIG_DIR", value: path.join(one, ".claude"), sensitive: false }] });
    createProviderInstance({ instanceId: "claude-empty-default", driver: "claude", environment: [...environment(one), { name: "CLAUDE_CONFIG_DIR", value: "", sensitive: false }] });
    createProviderInstance({ instanceId: "native-grok", driver: "grok", environment: [...environment(one), { name: "GROK_HOME", value: path.join(one, "grok-native"), sensitive: false }] });
    createProviderInstance({ instanceId: "native-pi", driver: "pi", environment: [...environment(one), { name: "PI_CODING_AGENT_DIR", value: path.join(one, "pi-native"), sensitive: false }] });
    createProviderInstance({ instanceId: "native-omp", driver: "omp", environment: [...environment(one), { name: "OMP_PROFILE", value: "work", sensitive: false }] });
    createProviderInstance({ instanceId: "native-agy", driver: "antigravity", environment: environment(one) });
    createProviderInstance({ instanceId: "native-opencode", driver: "opencode", environment: [...environment(one), { name: "XDG_CONFIG_HOME", value: path.join(one, "xdg"), sensitive: false }] });
    createProviderInstance({ instanceId: "remote-opencode", driver: "opencode", config: { serverUrl: "http://127.0.0.1:4101" }, environment: environment(one) });
    for (const driver of ["cursor", "muse", "fx", "acpRegistry"] as const)
      createProviderInstance({ instanceId: `not-upstream-${driver}`, driver, environment: environment(one) });
    const targets = listExtensionProviderTargets();
    const defaultClaude = targets.find(target => target.providerInstanceId === "claude-default")!;
    const explicitClaude = targets.find(target => target.providerInstanceId === "claude-explicit-default")!;
    const inheritedClaude = targets.find(target => target.providerInstanceId === "claude-env-default")!;
    const customClaude = targets.find(target => target.providerInstanceId === "claude-custom")!;
    assert.equal(defaultClaude.claudeMcpFile, path.join(one, ".claude.json"));
    assert.equal(customClaude.claudeMcpFile, path.join(one, "custom-claude", ".claude.json"));
    assert.equal(explicitClaude.appDir, defaultClaude.appDir);
    assert.equal(explicitClaude.claudeMcpFile, path.join(one, ".claude", ".claude.json"));
    assert.equal(inheritedClaude.claudeMcpFile, explicitClaude.claudeMcpFile);
    assert.equal(targets.find(target => target.providerInstanceId === "claude-empty-default")!.claudeMcpFile, defaultClaude.claudeMcpFile);
    assert.ok(defaultClaude.physicalRoots.includes(canonicalExtensionProviderPath(defaultClaude.claudeMcpFile!)));
    assert.ok(customClaude.physicalRoots.includes(canonicalExtensionProviderPath(customClaude.claudeMcpFile!)));
    assert.ok(explicitClaude.physicalRoots.includes(canonicalExtensionProviderPath(explicitClaude.claudeMcpFile!)));
    assert.throws(() => resolveExtensionProviderBinding({ providerInstanceIds: ["claude-default", "claude-explicit-default"], confirmed: true }), { code: "extension_provider_claude_mcp_conflict" });
    assert.equal(resolveExtensionProviderBinding({ providerInstanceIds: ["claude-default", "claude-empty-default"], confirmed: true }).claudeMcpFile, defaultClaude.claudeMcpFile);
    assert.equal(resolveExtensionProviderBinding({ providerInstanceIds: ["claude-explicit-default", "claude-env-default"], confirmed: true }).claudeMcpFile, explicitClaude.claudeMcpFile);
    const defaultBinding = resolveExtensionProviderBinding({ providerInstanceIds: ["claude-default"], confirmed: true });
    assertExtensionProviderBindingCurrent(defaultBinding);
    const missingClaudeFile = { ...defaultBinding };
    delete missingClaudeFile.claudeMcpFile;
    assert.throws(() => assertExtensionProviderBindingCurrent(missingClaudeFile), { code: "extension_provider_binding_changed" });
    assert.throws(() => assertExtensionProviderBindingCurrent({ ...defaultBinding, claudeMcpFile: explicitClaude.claudeMcpFile! }), { code: "extension_provider_binding_changed" });
    const homeAlias = path.join(root, "one-home-alias");
    await symlink(one, homeAlias, process.platform === "win32" ? "junction" : "dir");
    createProviderInstance({ instanceId: "aaa-codex-home-alias", driver: "codex", config: { homePath: path.join(homeAlias, ".codex") }, environment: environment(homeAlias) });
    assert.throws(() => resolveExtensionProviderBinding({ providerInstanceIds: ["aaa-codex-home-alias", "claude-default"], confirmed: true }), { code: "extension_provider_claude_mcp_conflict" });
    const storedDefault = getStoredInstance("claude-default")!;
    updateProviderInstance(storedDefault.instanceId, { config: { homePath: defaultClaude.appDir } }, storedDefault.revision);
    assert.throws(() => assertExtensionProviderBindingCurrent(defaultBinding), { code: "extension_provider_binding_changed" });
    const reboundDefault = resolveExtensionProviderBinding({ providerInstanceIds: ["claude-default"], confirmed: true });
    assert.equal(reboundDefault.appDirs.claude, defaultBinding.appDirs.claude);
    assert.equal(reboundDefault.claudeMcpFile, explicitClaude.claudeMcpFile);
    assert.notEqual(reboundDefault.bindingFingerprint, defaultBinding.bindingFingerprint);
    assert.equal(targets.find(target => target.providerInstanceId === "native-grok")!.appDir, path.join(one, "grok-native"));
    assert.equal(targets.find(target => target.providerInstanceId === "native-pi")!.appDir, path.join(one, "pi-native"));
    assert.equal(targets.find(target => target.providerInstanceId === "native-omp")!.appDir, path.join(one, ".omp", "profiles", "work", "agent"));
    assert.equal(targets.find(target => target.providerInstanceId === "native-agy")!.appDir, path.join(one, ".gemini", "config"));
    assert.equal(targets.find(target => target.providerInstanceId === "native-agy")!.nativeMcp, "execution-scoped");
    assert.equal(targets.find(target => target.providerInstanceId === "native-opencode")!.appDir, path.join(one, "xdg", "opencode"));
    assert.equal(targets.some(target => target.providerInstanceId === "remote-opencode" || target.providerInstanceId.startsWith("not-upstream-")), false);
    const oldShared = resolveExtensionProviderBinding({ providerInstanceIds: ["codex-shared"], confirmed: true });
    await rm(alias);
    await symlink(path.join(two, ".codex"), alias, process.platform === "win32" ? "junction" : "dir");
    await mkdir(path.join(two, ".codex"), { recursive: true });
    assert.throws(() => assertExtensionProviderBindingCurrent(oldShared), { code: "extension_provider_binding_changed" });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId, OrchestrationV2ProviderSessionJson, OrchestrationV2ProviderThreadJson, OrchestrationV2ProviderTurnJson } from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { closeStore, readRecord, writeRecord } from "../durable/store.ts";
import { beginProviderExecution, requireAccountIdle } from "./auth.ts";
import {
  acquireProviderSettingsSnapshot, createProviderInstance, getStoredInstance, migrateProviderStartupState,
  providerContext, providerEnvironment, recordProviderObservations, subscribeProviderSettingsChanges,
  updateProviderInstance, updateProviderSettings, type StoredProviderInstance,
} from "./instances.ts";
import { PM_CONTINUATIONS, continuationKey, readPmContinuation, savePmContinuation } from "./t3code/continuation.ts";
import type { PmProviderLease } from "./t3code/contract.ts";

async function isolated(use: (root: string) => Promise<void>) {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-startup-continuity-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  process.env.AGENT_WORKSPACE_PROJECT_ROOT = path.join(root, "project");
  process.env.HOME = path.join(root, "native-user");
  process.env.USERPROFILE = process.env.HOME;
  process.env.CODEX_HOME = path.join(root, "native-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "native-claude");
  try {
    for (const directory of [process.env.AGENT_WORKSPACE_DATA_DIR, process.env.AGENT_WORKSPACE_PROJECT_ROOT, process.env.HOME, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR])
      await mkdir(directory, { recursive: true });
    await use(root);
  } finally {
    closeStore();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}

async function preparedRegistry(instanceId: string, enabled = true) {
  const instance = createProviderInstance({ instanceId, driver: "acpRegistry", enabled,
    config: { agentId: "fixture-agent", commandArgs: ["--profile", "with spaces"], authMethodId: "fixture-auth" },
    environment: [{ name: "FIXTURE_SECRET", value: "disposable-env-only", sensitive: true }],
    customModels: [{ id: "fixture-model", label: "Historical model" }],
    modelPreferences: { hidden: [], order: ["fixture-model"], favorites: ["fixture-model"], options: {} },
  });
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const binary = { archive: "https://downloads.example.invalid/agent.tar.gz", cmd: "bin/fixture-agent", args: ["--acp"], env: { NATIVE_PROFILE: "fixture" } };
  const agent = { id: "fixture-agent", name: "Fixture Agent", description: "Disposable preparation metadata", version: "1.2.3",
    distribution: { binary: { [target]: binary } } };
  const installRoot = path.join(instance.stateDirectory, ".acp-registry", "tools", agent.id, agent.version, target);
  const commandPath = path.join(installRoot, "bin", "fixture-agent");
  await mkdir(path.dirname(commandPath), { recursive: true });
  await writeFile(commandPath, "disposable executable identity; never executed", { mode: 0o700 });
  const previousDistribution = { kind: "binary", binary, target, args: binary.args, env: binary.env };
  const receipt = { agent, distribution: "binary", commandPath, installRoot,
    fingerprint: createHash("sha256").update(JSON.stringify([agent.id, agent.version, previousDistribution])).digest("hex") };
  const key = createHash("sha256").update(JSON.stringify([agent.id, "auto"])).digest("hex").slice(0, 24);
  const receiptPath = path.join(instance.stateDirectory, ".acp-registry", `${key}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  return { instance, commandPath, receipt, receiptPath };
}

function saveHistoricalContinuation(instance: StoredProviderInstance, cwd: string) {
  const driver = ProviderDriverKind.make(instance.driver);
  const instanceId = ProviderInstanceId.make(instance.instanceId);
  const identity = { driverKind: driver, continuationKey: "fixture-original-account-binding" };
  const lease: PmProviderLease = { localDriver: instance.driver, instanceId, revision: instance.revision, cwd,
    nativeHome: instance.homeDirectory, continuationIdentity: identity, assertCurrent: Effect.void,
    instance: { instanceId, driverKind: driver, continuationIdentity: identity, displayName: undefined, enabled: instance.enabled,
      get snapshot(): never { throw new Error("Startup must not probe a native account"); },
      get textGeneration(): never { throw new Error("Startup must not generate text"); },
      get orchestrationAdapter(): never { throw new Error("Startup must not open a native session"); } },
  };
  const now = "2026-10-30T00:00:00.000Z";
  const session = Schema.decodeUnknownSync(OrchestrationV2ProviderSessionJson)({ id: "original-provider-session", driver,
    providerInstanceId: instanceId, status: "ready", cwd, model: "fixture-model", capabilities: AcpProviderCapabilitiesV2,
    createdAt: now, updatedAt: now, lastError: null });
  const thread = Schema.decodeUnknownSync(OrchestrationV2ProviderThreadJson)({ id: "original-provider-thread", driver,
    providerInstanceId: instanceId, providerSessionId: session.id, appThreadId: "original-chat-thread", ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "original-native-session", strength: "strong" }, nativeConversationHeadRef: null,
    status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 2, handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now });
  const turn = Schema.decodeUnknownSync(OrchestrationV2ProviderTurnJson)({ id: "original-provider-turn", providerThreadId: thread.id,
    nodeId: "original-root", runAttemptId: "original-attempt", nativeTurnRef: { driver, nativeId: "original-native-turn", strength: "strong" },
    ordinal: 2, status: "completed", startedAt: now, completedAt: now });
  const protocol = "acp-registry:fixture-original-negotiated-protocol";
  const ref = savePmContinuation({ lease, protocol, ownerThreadId: "original-chat-thread", generationId: "original-generation", session, thread, turns: [turn] })!;
  return { lease, protocol, ref };
}

test("startup Registry metadata cutover retains revisions, exact executable, private settings and historical continuation across restart", async () => {
  await isolated(async root => {
    const fixture = await preparedRegistry("historical-registry");
    recordProviderObservations(fixture.instance.instanceId, fixture.instance.revision, { lastConnectionTest: { ok: true, latencyMs: 3, kind: "agent-status" } });
    const storePath = path.join(process.env.AGENT_WORKSPACE_DATA_DIR!, "provider-instances.json");
    const store = JSON.parse(await readFile(storePath, "utf8"));
    const raw = store.instances.find((row: { instanceId: string }) => row.instanceId === fixture.instance.instanceId);
    raw.futurePrivateExtension = { exact: [1, "preserved"] };
    store.providerSettings = { revision: 7, healthRefreshIntervalSeconds: 0 };
    store.futureTopLevel = { retained: true };
    await writeFile(storePath, JSON.stringify(store, null, 3), { mode: 0o600 });
    const originalText = await readFile(storePath, "utf8");
    const historical = saveHistoricalContinuation(fixture.instance, path.join(root, "project"));
    const key = continuationKey(historical.lease, historical.ref.sessionId);
    const sidecar = readRecord(PM_CONTINUATIONS, key);
    const history = { id: "original-chat-thread", nativeSession: historical.ref, messages: [{ id: "original-message", text: "preserved history" }] };
    const receipt = { operationId: "original-operation", status: "unknown", approvalId: "original-approval" };
    writeRecord("chat:threads", history.id, history);
    writeRecord("fixture:pm-receipts", receipt.operationId, receipt);
    closeStore();
    let notifications = 0;
    const unsubscribe = subscribeProviderSettingsChanges(() => { notifications++; });
    try {
      await migrateProviderStartupState();
      const converted = getStoredInstance(fixture.instance.instanceId)!;
      assert.equal(converted.revision, fixture.instance.revision);
      assert.equal(converted.config.commandPath, fixture.commandPath);
      assert.equal(converted.config.distribution, "binary");
      assert.deepEqual(converted.env, fixture.instance.env);
      assert.deepEqual(converted.envSensitivity, fixture.instance.envSensitivity);
      assert.deepEqual(converted.modelPreferences, fixture.instance.modelPreferences);
      assert.equal(converted.observations?.instanceRevision, fixture.instance.revision);
      const migratedStore = JSON.parse(await readFile(storePath, "utf8"));
      assert.equal(migratedStore.revisionClock, store.revisionClock);
      assert.deepEqual(migratedStore.providerSettings, store.providerSettings);
      assert.deepEqual(migratedStore.futureTopLevel, store.futureTopLevel);
      const convertedRow = migratedStore.instances.find((row: { instanceId: string }) => row.instanceId === converted.instanceId);
      assert.deepEqual(convertedRow, { ...raw, config: { ...raw.config, commandPath: fixture.commandPath, distribution: "binary" } });
      assert.deepEqual(readRecord(PM_CONTINUATIONS, key), sidecar);
      assert.deepEqual(readRecord("chat:threads", history.id), history);
      assert.deepEqual(readRecord("fixture:pm-receipts", receipt.operationId), receipt);
      const retainedLease = { ...historical.lease, revision: converted.revision, nativeHome: converted.homeDirectory };
      assert.equal(readPmContinuation(retainedLease, historical.ref, historical.protocol, history.id)?.thread.nativeThreadRef?.nativeId, historical.ref.sessionId);
      const digest = createHash("sha256").update(originalText).digest("hex");
      const backup = path.join(process.env.AGENT_WORKSPACE_DATA_DIR!, `provider-instances.before-source-startup-v1.${digest}.json`);
      assert.equal(await readFile(backup, "utf8"), originalText);
      assert.equal((await stat(backup)).mode & 0o777, 0o600);
      const convertedText = await readFile(storePath, "utf8");
      closeStore();
      await migrateProviderStartupState();
      assert.equal(await readFile(storePath, "utf8"), convertedText);
      assert.equal(notifications, 1, "idempotent restart must not publish a settings mutation");
      assert.deepEqual(readRecord("chat:threads", history.id), history);
      const updated = updateProviderInstance(converted.instanceId, { label: "Explicit user update" }, converted.revision);
      assert.ok(updated.revision > converted.revision, "the startup exception never applies to user updates");
      assert.throws(() => updateProviderInstance(converted.instanceId, { label: "stale user update" }, converted.revision), { status: 409 });
      assert.deepEqual(readRecord(PM_CONTINUATIONS, key), sidecar);
    } finally { unsubscribe(); }
  });
});

test("partial Registry planning failure persists no rows, releases reservations, and converges after repair", async () => {
  await isolated(async () => {
    const first = await preparedRegistry("first-registry");
    const second = await preparedRegistry("second-registry", false);
    await writeFile(second.receiptPath, JSON.stringify({ ...second.receipt, fingerprint: "divergent" }));
    const storePath = path.join(process.env.AGENT_WORKSPACE_DATA_DIR!, "provider-instances.json");
    const original = await readFile(storePath, "utf8");
    await assert.rejects(migrateProviderStartupState(), /original distribution/);
    assert.equal(await readFile(storePath, "utf8"), original);
    requireAccountIdle(first.instance.instanceId);
    requireAccountIdle(second.instance.instanceId);
    assert.equal((await readdir(process.env.AGENT_WORKSPACE_DATA_DIR!)).some(name => name.startsWith(".instances")), false);
    await writeFile(second.receiptPath, JSON.stringify(second.receipt));
    await migrateProviderStartupState();
    for (const fixture of [first, second]) {
      const current = getStoredInstance(fixture.instance.instanceId)!;
      assert.equal(current.config.commandPath, fixture.commandPath);
      assert.equal(current.revision, fixture.instance.revision);
      assert.equal(current.enabled, fixture.instance.enabled);
    }
    assert.throws(() => providerContext(getStoredInstance(second.instance.instanceId)!), /disabled/);
  });
});

test("startup excludes active work, parallel migrations and settings writers; exact-byte CAS retains a competing winner", async () => {
  await isolated(async () => {
    const fixture = await preparedRegistry("cas-registry");
    const storePath = path.join(process.env.AGENT_WORKSPACE_DATA_DIR!, "provider-instances.json");
    const original = await readFile(storePath, "utf8");
    const snapshot = acquireProviderSettingsSnapshot(() => getStoredInstance(fixture.instance.instanceId));
    try { await assert.rejects(migrateProviderStartupState(), { code: "settings_busy" }); }
    finally { snapshot.release(); }
    const release = beginProviderExecution(fixture.instance.instanceId);
    try { await assert.rejects(migrateProviderStartupState(), { status: 409 }); }
    finally { release(); }
    assert.equal(await readFile(storePath, "utf8"), original);
    const winner = JSON.parse(original);
    winner.providerSettings = { revision: 9, healthRefreshIntervalSeconds: 23 };
    const winnerText = JSON.stringify(winner, null, 4);
    const pending = migrateProviderStartupState();
    assert.throws(() => updateProviderInstance(fixture.instance.instanceId, { label: "must not win" }), { code: "settings_busy" });
    assert.throws(() => updateProviderSettings(1, 42), { code: "settings_busy" });
    const competing = migrateProviderStartupState();
    const rejectedCompeting = assert.rejects(competing, { code: "settings_busy" });
    writeFileSync(storePath, winnerText, { mode: 0o600 });
    await assert.rejects(pending, { code: "settings_changed" });
    await rejectedCompeting;
    assert.equal(await readFile(storePath, "utf8"), winnerText);
    assert.equal(getStoredInstance(fixture.instance.instanceId)!.config.commandPath, "");
    requireAccountIdle(fixture.instance.instanceId);
    await migrateProviderStartupState();
    assert.equal(getStoredInstance(fixture.instance.instanceId)!.config.commandPath, fixture.commandPath);
    assert.deepEqual(JSON.parse(await readFile(storePath, "utf8")).providerSettings, winner.providerSettings);
  });
});

test("divergent immutable backup rejects before commit and leaves no temporary files", async () => {
  await isolated(async () => {
    const fixture = await preparedRegistry("backup-registry");
    const data = process.env.AGENT_WORKSPACE_DATA_DIR!;
    const storePath = path.join(data, "provider-instances.json");
    const original = await readFile(storePath, "utf8");
    const digest = createHash("sha256").update(original).digest("hex");
    const backup = path.join(data, `provider-instances.before-source-startup-v1.${digest}.json`);
    await writeFile(backup, "a divergent backup must never be overwritten", { mode: 0o600 });
    await assert.rejects(migrateProviderStartupState(), /divergent or unsafe.*backup/);
    assert.equal(await readFile(storePath, "utf8"), original);
    assert.equal(await readFile(backup, "utf8"), "a divergent backup must never be overwritten");
    assert.equal((await readdir(data)).some(name => name.startsWith(".instances")), false);
    requireAccountIdle(fixture.instance.instanceId);
    await rm(backup);
    await migrateProviderStartupState();
    assert.equal(await readFile(backup, "utf8"), original);
  });
});

test("PM contexts match original bound native Home rules without mutating inherited environment or owning native homes", async () => {
  await isolated(async root => {
    const boundHome = path.join(root, "bound-user");
    const cwd = path.join(root, "bound-project");
    const beforeEnvironment = { ...process.env };
    const environment = [{ name: "HOME", value: boundHome, sensitive: false }];
    const explicitClaude = createProviderInstance({ instanceId: "explicit-claude", driver: "claude", config: { homePath: "  ~/.claude-profile  " }, environment });
    assert.equal(explicitClaude.config.homePath, "~/.claude-profile");
    const explicitContext = providerContext(explicitClaude, cwd);
    assert.equal(explicitContext.homeDirectory, path.join(boundHome, ".claude-profile"));
    assert.equal(explicitContext.env.CLAUDE_CONFIG_DIR, explicitContext.homeDirectory);
    assert.equal(explicitContext.env.HOME, boundHome);
    const inheritedClaude = createProviderInstance({ instanceId: "inherited-claude", driver: "claude", environment: [
      ...environment, { name: "CLAUDE_CONFIG_DIR", value: "  ~/literal-profile  ", sensitive: false },
    ] });
    const inheritedContext = providerContext(inheritedClaude, cwd);
    assert.equal(inheritedContext.homeDirectory, path.resolve(cwd, "~/literal-profile"));
    assert.equal(inheritedContext.env.CLAUDE_CONFIG_DIR, "  ~/literal-profile  ");
    assert.equal(providerEnvironment(inheritedClaude).CLAUDE_CONFIG_DIR, "  ~/literal-profile  ");
    const inheritedCodex = createProviderInstance({ instanceId: "inherited-codex", driver: "codex", environment: [
      ...environment, { name: "CODEX_HOME", value: "~/native-codex-profile", sensitive: false },
    ] });
    assert.equal(providerContext(inheritedCodex, cwd).homeDirectory, path.join(boundHome, "native-codex-profile"));
    assert.equal(providerContext(inheritedCodex, cwd).env.CODEX_HOME, "~/native-codex-profile");
    const relativeCodex = createProviderInstance({ instanceId: "relative-codex", driver: "codex", config: { homePath: "relative-profile" }, environment });
    assert.equal(providerContext(relativeCodex, cwd).homeDirectory, path.join(cwd, "relative-profile"));
    assert.equal(providerContext(relativeCodex, cwd).env.CODEX_HOME, path.join(cwd, "relative-profile"));
    const overlayCodex = createProviderInstance({ instanceId: "overlay-codex", driver: "codex", config: { shadowHomePath: "~/shadow-profile" }, environment });
    assert.equal(providerContext(overlayCodex, cwd).homeDirectory, path.join(boundHome, "shadow-profile"));
    const managed = createProviderInstance({ instanceId: "managed-home", driver: "codex", config: { setupMode: "managed", homePath: "/ignored-native-home", shadowHomePath: "/ignored-shadow-home" }, environment });
    assert.equal(providerContext(managed, cwd).homeDirectory, managed.stateDirectory);
    assert.equal(providerContext(managed, cwd).env.CODEX_HOME, managed.stateDirectory);
    const userProfileEnvironment = [
      { name: "HOME", value: "", sensitive: false }, { name: "USERPROFILE", value: boundHome, sensitive: false },
      { name: "CODEX_HOME", value: "", sensitive: false }, { name: "CLAUDE_CONFIG_DIR", value: "", sensitive: false },
    ];
    const defaultCodex = createProviderInstance({ instanceId: "default-userprofile-codex", driver: "codex", environment: userProfileEnvironment });
    const defaultClaude = createProviderInstance({ instanceId: "default-userprofile-claude", driver: "claude", environment: userProfileEnvironment });
    assert.equal(providerContext(defaultCodex, cwd).homeDirectory, path.join(boundHome, ".codex"));
    assert.equal(providerContext(defaultClaude, cwd).homeDirectory, path.join(boundHome, ".claude"));
    assert.equal(providerContext(defaultCodex, cwd).env.CODEX_HOME, "");
    assert.equal(providerContext(defaultClaude, cwd).env.CLAUDE_CONFIG_DIR, "");
    assert.deepEqual({ ...process.env }, beforeEnvironment);
    for (const native of [explicitContext.homeDirectory, inheritedContext.homeDirectory, path.join(cwd, "relative-profile"), path.join(boundHome, "shadow-profile")])
      await assert.rejects(stat(native), { code: "ENOENT" });
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, existsSync, statSync, chmodSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createAgentBackup, restoreAgentBackup, verifyAgentBackup } from "./agent-backup.ts";
import { getStoredInstance, listStoredInstances, providerContext } from "../providers/instances.ts";
import { makePmProviderCredentials } from "../providers/t3code/credentials.ts";
import { assertPrivatePath, makePrivatePath } from "../../../../../packages/pm-core/private-path.ts";

type Fixture = {
  root: string; source: string; bundle: string; target: string; home: string; close: () => void;
};
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-backup-test-")));
  const source = path.join(root, "source");
  const bundle = path.join(root, "bundle");
  const target = path.join(root, "restored");
  mkdirSync(source, { mode: 0o700 });
  const db = new DatabaseSync(path.join(source, "workspace.sqlite"));
  db.exec(`CREATE TABLE records(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));
    CREATE TABLE run_events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(run_id,seq));
    CREATE TABLE worker_owner(singleton INTEGER PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);`);
  const put = db.prepare("INSERT INTO records VALUES (?, ?, ?)");
  put.run("chat:threads", "thread-a", JSON.stringify({ remoteId: "thread-a", settings: { providerInstanceId: "api-a", model: "custom-a", systemPrompt: "private prompt", temperature: 0.2 },
    scope: { workspaceId: "workspace-a", projectId: "project-a" }, status: "archived", revision: 7,
    nativeSession: { sessionId: "old-native-session", providerInstanceId: "codex-a", driver: "codex" }, pendingFork: { source: { sessionId: "old-native-session" } } }));
  put.run("chat:history", "history-a", JSON.stringify({ threadId: "thread-a", format: "ai-sdk/v6", messages: [{ id: "message-a", content: { role: "user", parts: [{ type: "text", text: "private history must recover exactly" }] } }], headId: "message-a", authoritativeIds: ["message-a"] }));
  put.run("settings:chat-defaults", "default", JSON.stringify({ revision: 4, selection: { providerInstanceId: "api-a", model: "custom-a" } }));
  put.run("chat:generations", "generation-a", JSON.stringify({ status: "completed", nativeSession: { sessionId: "old-native-session" } }));
  put.run("durable:runs", "run-a", JSON.stringify({ status: "completed", steps: [{ id: "step-a", nativeSession: { sessionId: "old-native-session" }, output: "saved output" }] }));
  db.prepare("INSERT INTO run_events VALUES (?, ?, ?)").run("run-a", 1, JSON.stringify({ type: "completed", output: "private generation output" }));
  db.close();
  chmodSync(path.join(source, "workspace.sqlite"), 0o600);
  const home = path.join(source, "provider-homes", "codex-a");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "auth.json"), '{"access_token":"fake-offline-cli-secret"}', { mode: 0o600 });
  writeFileSync(path.join(home, "history.jsonl"), '{"session":"old-native-session"}\n', { mode: 0o600 });
  writeFileSync(path.join(source, "provider-instances.json"), JSON.stringify({ version: 1, revisionClock: 8, providerSettings: { revision: 3, healthRefreshIntervalSeconds: 0 }, instances: [
    { instanceId: "api-a", driver: "openai", label: "Local API", revision: 8, env: { API_KEY: "fake-inline-secret" }, apiKeyEnv: "API_KEY",
      baseUrl: "https://user:fake-url-secret@provider.invalid/v1?key=fake-query-secret", executable: "/secret-executable-override",
      customModels: [{ id: "custom-a", label: "Custom model" }], observations: { instanceRevision: 8, lastConnectionTest: { error: "fake-observation-secret" } } },
    { instanceId: "codex-a", driver: "codex", label: "Dedicated CLI", revision: 2, env: {}, cliHome: home },
  ] }), { mode: 0o600 });
  writeFileSync(path.join(source, "providers.json"), '{"version":1,"providers":{"api-a":{"apiKey":"fake-stored-secret"}}}', { mode: 0o600 });
  return { root, source, bundle, target, home, close: () => rmSync(root, { recursive: true, force: true }) };
}
function restoredRecords(target: string) {
  const db = new DatabaseSync(path.join(target, "workspace.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT namespace, key, value FROM records ORDER BY namespace, key").all(); }
  finally { db.close(); }
}
const create = (f: Fixture, secrets: "include" | "exclude" = "exclude") => createAgentBackup({ source: f.source, bundle: f.bundle, secrets, stopped: true });

test("credential-excluded backup restores histories/settings/model config with native providers disabled", async () => {
  const f = fixture();
  try {
    const originalDatabase = readFileSync(path.join(f.source, "workspace.sqlite"));
    const originalConfig = readFileSync(path.join(f.source, "provider-instances.json"));
    const manifest = await create(f);
    assert.deepEqual([manifest.coverage.threads, manifest.coverage.histories, manifest.coverage.messages, manifest.coverage.settings, manifest.coverage.events], [1, 1, 1, 1, 1]);
    assert.equal(existsSync(path.join(f.bundle, "providers.json")), false);
    assert.equal(existsSync(path.join(f.bundle, "provider-homes")), false);
    const rawConfig = readFileSync(path.join(f.bundle, "provider-instances.json"), "utf8");
    for (const value of ["fake-inline-secret", "fake-stored-secret", "fake-url-secret", "fake-query-secret", "fake-observation-secret", f.source])
      assert.equal(rawConfig.includes(value), false);
    assertPrivatePath(f.bundle);
    for (const member of [...manifest.files.map((entry) => entry.path), "manifest.json"])
      assertPrivatePath(path.join(f.bundle, member));
    assert.deepEqual(restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true }), manifest.coverage);
    assert.deepEqual(verifyAgentBackup({ bundle: f.bundle, target: f.target, stopped: true }), manifest.coverage);
    const records = restoredRecords(f.target);
    const thread = JSON.parse(String(records.find((row) => row.namespace === "chat:threads")!.value));
    assert.equal(thread.status, "archived");
    assert.equal(thread.revision, 7);
    assert.deepEqual(thread.scope, { workspaceId: "workspace-a", projectId: "project-a" });
    assert.equal(thread.settings.systemPrompt, "private prompt");
    assert.equal(thread.nativeSession, undefined);
    assert.equal(thread.pendingFork, undefined);
    assert.equal(JSON.parse(String(records.find((row) => row.namespace === "chat:generations")!.value)).nativeSession, undefined);
    assert.equal(JSON.parse(String(records.find((row) => row.namespace === "durable:runs")!.value)).steps[0].nativeSession, undefined);
    assert.match(String(records.find((row) => row.namespace === "chat:history")!.value), /private history must recover exactly/);
    assert.deepEqual(JSON.parse(String(records.find((row) => row.namespace === "settings:chat-defaults")!.value)),
      { revision: 4, selection: { providerInstanceId: "api-a", model: "custom-a" } });
    const config = JSON.parse(readFileSync(path.join(f.target, "provider-instances.json"), "utf8"));
    assert.deepEqual(config.instances[0].customModels, [{ id: "custom-a", label: "Custom model" }]);
    assert.deepEqual(config.providerSettings, { revision: 3, healthRefreshIntervalSeconds: 0 });
    assert.deepEqual(config.instances[0].env, {});
    assert.equal(config.instances[0].apiKeyEnv, undefined);
    assert.equal(config.instances[0].baseUrl, undefined);
    assert.equal(config.instances[1].cliHome, undefined);
    assert.equal(config.instances[1].enabled, false);
    assert.equal(existsSync(path.join(f.target, "provider-homes", "codex-a", "auth.json")), false);
    assert.equal(JSON.parse(readFileSync(path.join(f.target, "agent-restore.json"), "utf8")).requiresLogin, true);
    assert.deepEqual(readFileSync(path.join(f.source, "workspace.sqlite")), originalDatabase);
    assert.deepEqual(readFileSync(path.join(f.source, "provider-instances.json")), originalConfig);
    assert.match(readFileSync(path.join(f.home, "auth.json"), "utf8"), /fake-offline-cli-secret/);
    // A recovered store itself can be backed up again; its non-durable provenance marker is classified.
    await createAgentBackup({ source: f.target, bundle: path.join(f.root, "second-backup"), secrets: "exclude", stopped: true });
  } finally { f.close(); }
});

test("explicit secret-inclusive offline bundle recovers credentials and dedicated homes without rebinding to source", async () => {
  const f = fixture();
  try {
    const manifest = await create(f, "include");
    restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
    verifyAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
    assert.equal(manifest.providerInstances, 2);
    assert.match(readFileSync(path.join(f.target, "providers.json"), "utf8"), /fake-stored-secret/);
    const config = JSON.parse(readFileSync(path.join(f.target, "provider-instances.json"), "utf8"));
    assert.deepEqual(config.providerSettings, { revision: 3, healthRefreshIntervalSeconds: 0 });
    assert.equal(config.instances[0].env.API_KEY, "fake-inline-secret");
    assert.match(config.instances[0].baseUrl, /fake-url-secret/);
    assert.equal(config.instances[1].cliHome, path.join(f.target, "provider-homes", "codex-a"));
    assert.match(readFileSync(path.join(config.instances[1].cliHome, "auth.json"), "utf8"), /fake-offline-cli-secret/);
    assert.equal(JSON.parse(String(restoredRecords(f.target).find((row) => row.namespace === "chat:threads")!.value)).nativeSession.sessionId, "old-native-session");
    assert.equal(existsSync(path.join(f.source, "workspace.lock")), false);
  } finally { f.close(); }
});

test("restored backups cannot revive OAuth grants or live App context in either secret mode", async () => {
  for (const secrets of ["include", "exclude"] as const) {
    const f = fixture();
    try {
      const db = new DatabaseSync(path.join(f.source, "workspace.sqlite"));
      const grant = { grantId: "grant-a", actorId: "owner-a", version: 4, revokedAt: null,
        scope: { workspaceId: "workspace-a", projectId: "project-a" }, clientName: "External agent" };
      try {
        const put = db.prepare("INSERT INTO records VALUES (?, ?, ?)");
        put.run("mcp:grants", "grant-a", JSON.stringify(grant));
        for (const namespace of ["mcp:tokens", "mcp:codes", "mcp:consents", "mcp-app-model-context-v1"])
          put.run(namespace, "private-a", JSON.stringify({ grantId: "grant-a", text: "nonportable authority" }));
      } finally { db.close(); }
      const before = readFileSync(path.join(f.source, "workspace.sqlite"));
      await create(f, secrets);
      restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
      const rows = restoredRecords(f.target);
      for (const namespace of ["mcp:tokens", "mcp:codes", "mcp:consents", "mcp-app-model-context-v1"])
        assert.equal(rows.some(row => row.namespace === namespace), false, namespace);
      const restored = JSON.parse(String(rows.find(row => row.namespace === "mcp:grants")!.value));
      assert.equal(restored.version, 5);
      assert.ok(Number.isFinite(Date.parse(restored.revokedAt)));
      assert.deepEqual(restored.scope, grant.scope);
      assert.equal(restored.clientName, grant.clientName);
      assert.deepEqual(readFileSync(path.join(f.source, "workspace.sqlite")), before);
      verifyAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
    } finally { f.close(); }
  }
});

test("migrated private credentials and attachment bytes survive only their declared backup policy", async () => {
  for (const secrets of ["include", "exclude"] as const) {
    const f = fixture();
    try {
      const bytes = Uint8Array.from([17, 29, 43, 71]);
      const credentials = await Effect.runPromise(makePmProviderCredentials(f.source)("backup-test", "instance-a"));
      await Effect.runPromise(credentials.set(bytes));
      for (const [relative, content] of [
        ["provider-attachments/thread-a/document.txt", "retained attachment bytes"],
        ["provider-cache/t3code/probe.json", "discarded observation"],
      ]) {
        const filename = path.join(f.source, relative!);
        mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        writeFileSync(filename, content!, { mode: 0o600 });
      }
      const manifest = await create(f, secrets);
      restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
      verifyAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
      assert.equal(readFileSync(path.join(f.target, "provider-attachments/thread-a/document.txt"), "utf8"), "retained attachment bytes");
      assert.equal(existsSync(path.join(f.target, "provider-cache")), false);
      assert.equal(manifest.files.some(member => member.path.startsWith("provider-private/")), secrets === "include");
      const restored = await Effect.runPromise(makePmProviderCredentials(f.target)("backup-test", "instance-a"));
      const recovered = await Effect.runPromise(restored.get);
      if (secrets === "include") assert.equal(Buffer.compare(Option.getOrThrow(recovered), bytes), 0);
      else assert.equal(Option.isNone(recovered), true);
      assert.equal(Buffer.compare(Option.getOrThrow(await Effect.runPromise(credentials.get)), bytes), 0);
    } finally { f.close(); }
  }
});

test("credential-excluded manifests cannot smuggle a migrated private store into restore", async () => {
  const f = fixture();
  try {
    const manifest = await create(f);
    const relative = "provider-private/secrets/injected.bin";
    const bytes = Buffer.from("synthetic-private-binding");
    mkdirSync(path.join(f.bundle, "provider-private/secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(f.bundle, relative), bytes, { mode: 0o600 });
    manifest.files.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    writeFileSync(path.join(f.bundle, "manifest.json"), JSON.stringify(manifest));
    assert.throws(() => restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true }));
    assert.equal(existsSync(f.target), false);
  } finally { f.close(); }
});

test("excluded recovery refuses implicit execution and external native Homes before writing a target", async () => {
  for (const change of ["implicit-enable", "explicit-enable", "external-home"]) {
    const f = fixture();
    try {
      const manifest = await create(f);
      const configPath = path.join(f.bundle, "provider-instances.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const native = config.instances.find((instance: { driver: string }) => instance.driver === "codex");
      if (change === "implicit-enable") delete native.enabled;
      else if (change === "explicit-enable") native.enabled = true;
      else native.cliHome = "/synthetic-external-native-home";
      const bytes = Buffer.from(JSON.stringify(config));
      writeFileSync(configPath, bytes);
      const member = manifest.files.find(entry => entry.path === "provider-instances.json")!;
      member.bytes = bytes.length;
      member.sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(path.join(f.bundle, "manifest.json"), JSON.stringify(manifest));
      assert.throws(() => restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true }));
      assert.equal(existsSync(f.target), false);
    } finally { f.close(); }
  }
});

test("live PID locks, stale locks, and live database owner all fail closed without signals or source changes", async () => {
  const f = fixture();
  try {
    const lock = path.join(f.source, "workspace.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "other-owner" }), { mode: 0o600 });
    await assert.rejects(create(f), /running/);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "other-owner");
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "stale-owner" }));
    await assert.rejects(create(f), /Stale Agent lock/);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "stale-owner");
    writeFileSync(lock, JSON.stringify({ pid: -1, token: "invalid" }));
    await assert.rejects(create(f), /Invalid recorded owner PID/);
    rmSync(lock);
    const db = new DatabaseSync(path.join(f.source, "workspace.sqlite"));
    db.prepare("INSERT INTO worker_owner VALUES (1, ?, 'live-owner')").run(process.pid);
    db.close();
    await assert.rejects(create(f), /live owner/);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(f.bundle), false);
  } finally { f.close(); }
});

test("maintenance acknowledgements, existing source/target/bundle and nested/traversal paths cannot be bypassed", async () => {
  const f = fixture();
  try {
    await assert.rejects(createAgentBackup({ source: f.source, bundle: f.bundle, secrets: "exclude", stopped: false }), /--stopped/);
    await assert.rejects(createAgentBackup({ source: f.source, bundle: path.join(f.source, "nested"), secrets: "exclude", stopped: true }), /separate/);
    await assert.rejects(createAgentBackup({ source: f.source, bundle: `${f.root}/new/../traversal`, secrets: "exclude", stopped: true }), /Unsafe/);
    await create(f);
    await assert.rejects(create(f), /must not already exist/);
    assert.throws(() => restoreAgentBackup({ bundle: f.bundle, target: f.source, stopped: true }), /empty directory/);
    mkdirSync(f.target);
    writeFileSync(path.join(f.target, "keep.txt"), "original-project-data");
    assert.throws(() => restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true }), /empty directory/);
    assert.equal(readFileSync(path.join(f.target, "keep.txt"), "utf8"), "original-project-data");
    assert.throws(() => restoreAgentBackup({ bundle: f.bundle, target: path.join(f.bundle, "nested"), stopped: true }), /separate/);
    assert.throws(() => verifyAgentBackup({ bundle: f.bundle, stopped: false }), /--stopped/);
  } finally { f.close(); }
});

test("tampered member traversal, corrupted bytes and public backup permissions are rejected before restore", async () => {
  const f = fixture();
  try {
    await create(f);
    const manifestFile = path.join(f.bundle, "manifest.json");
    const original = readFileSync(manifestFile, "utf8");
    const manifest = JSON.parse(original);
    manifest.files[0].path = "provider-homes/../../outside-secret";
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true }), /Unsafe/);
    assert.equal(existsSync(f.target), false);
    for (const unsafe of ["usage-sources.json/../outside-secret", "usage-sources.json.extra", "cursor-usage-cache.json/secret", "cursor-usage-cache.json.bak"]) {
      manifest.files[0].path = unsafe;
      writeFileSync(manifestFile, JSON.stringify(manifest));
      assert.throws(() => restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true }), /Unsafe/);
      assert.equal(existsSync(f.target), false);
    }
    writeFileSync(manifestFile, original);
    if (process.platform === "win32") {
      execFileSync(path.join(process.env.SystemRoot!, "System32", "icacls.exe"), [f.bundle, "/grant", "*S-1-1-0:(OI)(CI)RX"],
        { windowsHide: true, stdio: "ignore", timeout: 30_000 });
    } else chmodSync(f.bundle, 0o755);
    assert.throws(() => verifyAgentBackup({ bundle: f.bundle, stopped: true }), /private/i);
    makePrivatePath(f.bundle);
    writeFileSync(path.join(f.bundle, "provider-instances.json"), "corruption");
    assert.throws(() => verifyAgentBackup({ bundle: f.bundle, stopped: true }), /checksum/);
  } finally { f.close(); }
});

test("unclassified files and symlinked private CLI contents are never silently collected", async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.source, "unknown-settings.json"), "private-unclassified-config");
    await assert.rejects(create(f), /Unclassified/);
    rmSync(path.join(f.source, "unknown-settings.json"));
    symlinkSync(path.join(f.root, "unread-secret"), path.join(f.home, "symlink"));
    await assert.rejects(create(f, "include"), /symbolic links/);
    assert.equal(existsSync(f.bundle), false);
  } finally { f.close(); }
});

test("native private config and homes follow explicit offline include/exclude policy without endpoint fallback", async () => {
  for (const secrets of ["include", "exclude"] as const) {
    const f = fixture();
    const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
    try {
      const configPath = path.join(f.source, "provider-instances.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const openCodeHome = path.join(f.source, "provider-homes", "native-opencode");
      mkdirSync(openCodeHome, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(openCodeHome, "auth.json"), "private-native-login-file", { mode: 0o600 });
      const customHome = path.join(f.source, "provider-homes", "custom-claude-home");
      mkdirSync(customHome, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(customHome, ".credentials.json"), "private-claude-login-file", { mode: 0o600 });
      config.instances.push(
        { instanceId: "native-opencode", driver: "opencode", label: "Native remote", enabled: true, accentColor: "#abcdef",
          revision: 12, config: { serverUrl: "https://dedicated-native.invalid", serverPassword: "private-native-password", binaryPath: "/dedicated/native-binary" },
          env: { NATIVE_TOKEN: "private-native-env", NATIVE_MODE: "standard" }, envSensitivity: { NATIVE_TOKEN: true, NATIVE_MODE: false },
          customModels: [{ id: "native-model", label: "Native model" }],
          modelPreferences: { hidden: ["hidden-model"], order: ["native-model"], favorites: ["native-model"], options: { "native-model": [{ id: "variant", value: "high" }] } } },
        { instanceId: "native-claude", driver: "claude", label: "Modern native home", enabled: true, revision: 13,
          config: { homePath: customHome, binaryPath: "/dedicated/claude", idleCompaction: "off" }, env: {} },
        { instanceId: "native-antigravity", driver: "antigravity", label: "Native key", enabled: true, revision: 14,
          config: { authMethod: "gemini-api-key", apiKey: "private-antigravity-key", gcpProject: "retained-project" }, env: {} },
      );
      config.instances[0].unknownPrivateExtension = { secret: "private-legacy-extension" };
      const original = JSON.stringify(config);
      writeFileSync(configPath, original);
      await create(f, secrets);
      restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
      verifyAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
      assert.equal(readFileSync(configPath, "utf8"), original);
      const restored = JSON.parse(readFileSync(path.join(f.target, "provider-instances.json"), "utf8"));
      const native = restored.instances.find((entry: { instanceId: string }) => entry.instanceId === "native-opencode");
      const claude = restored.instances.find((entry: { instanceId: string }) => entry.instanceId === "native-claude");
      const antigravity = restored.instances.find((entry: { instanceId: string }) => entry.instanceId === "native-antigravity");
      assert.deepEqual(native.customModels, [{ id: "native-model", label: "Native model" }]);
      assert.equal(native.accentColor, "#abcdef");
      assert.deepEqual(native.modelPreferences, { hidden: ["hidden-model"], order: ["native-model"], favorites: ["native-model"], options: { "native-model": [{ id: "variant", value: "high" }] } });
      assert.equal(claude.config.idleCompaction, "off");
      assert.equal(antigravity.config.gcpProject, "retained-project");
      if (secrets === "include") {
        assert.equal(native.config.serverPassword, "private-native-password");
        assert.equal(native.config.serverUrl, "https://dedicated-native.invalid");
        assert.equal(native.env.NATIVE_TOKEN, "private-native-env");
        assert.equal(native.env.NATIVE_MODE, "standard");
        assert.deepEqual(native.envSensitivity, { NATIVE_TOKEN: true, NATIVE_MODE: false });
        assert.equal(antigravity.config.apiKey, "private-antigravity-key");
        assert.equal(native.enabled, true);
        assert.equal(claude.config.homePath, path.join(f.target, "provider-homes", "custom-claude-home"));
        assert.equal(readFileSync(path.join(claude.config.homePath, ".credentials.json"), "utf8"), "private-claude-login-file");
        assert.deepEqual(restored.instances[0].unknownPrivateExtension, { secret: "private-legacy-extension" });
      } else {
        const bytes = readFileSync(path.join(f.bundle, "provider-instances.json"), "utf8");
        for (const value of ["private-native", "private-antigravity", "private-legacy-extension", "dedicated-native.invalid", "/dedicated/", f.source])
          assert.equal(bytes.includes(value), false);
        assert.equal(native.config.serverPassword, undefined);
        assert.equal(native.config.serverUrl, undefined);
        assert.deepEqual(native.env, {});
        assert.deepEqual(native.envSensitivity, {});
        assert.equal(antigravity.config.apiKey, undefined);
        assert.equal(native.enabled, false);
        assert.equal(claude.enabled, false);
        assert.equal(existsSync(path.join(f.target, "provider-homes", "native-opencode", "auth.json")), false);
        assert.equal(existsSync(path.join(f.target, "provider-homes", "native-claude")), true);
      }
      process.env.AGENT_WORKSPACE_DATA_DIR = f.target;
      assert.equal(getStoredInstance("api-a"), null);
      assert.equal(listStoredInstances().some((entry) => entry.driver === ("openai" as string)), false);
      const active = getStoredInstance("native-opencode")!;
      if (secrets === "exclude") assert.throws(() => providerContext(active), /disabled/);
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
      else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
      f.close();
    }
  }
});

test("excluded backups do not read obsolete credentials or native home contents", async () => {
  const f = fixture();
  try {
    rmSync(path.join(f.source, "providers.json"));
    symlinkSync(path.join(f.root, "missing-credential-target"), path.join(f.source, "providers.json"));
    symlinkSync(path.join(f.root, "missing-native-target"), path.join(f.home, "unread-native-secret"));
    await create(f, "exclude");
    assert.equal(existsSync(path.join(f.bundle, "providers.json")), false);
    assert.equal(existsSync(path.join(f.bundle, "provider-homes")), false);
    restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
  } finally { f.close(); }
});

test("native external Home references survive private backup without collecting or creating their contents", async () => {
  const f = fixture();
  try {
    const filename = path.join(f.source, "provider-instances.json");
    const config = JSON.parse(readFileSync(filename, "utf8"));
    const external = path.join(f.root, "external-account");
    mkdirSync(external, { mode: 0o750 });
    writeFileSync(path.join(external, "auth.json"), "external-native-account-not-owned-by-app");
    config.instances[1] = { instanceId: "codex-a", driver: "codex", label: "Modern native", enabled: true, revision: 2,
      config: { homePath: f.home, shadowHomePath: external }, env: {} };
    writeFileSync(filename, JSON.stringify(config));
    const original = readFileSync(path.join(external, "auth.json"));
    const originalMode = statSync(external).mode;
    const manifest = await create(f, "include");
    assert.equal(manifest.files.some(member => readFileSync(path.join(f.bundle, member.path)).includes(original)), false);
    assert.deepEqual(readFileSync(path.join(external, "auth.json")), original);
    assert.equal(statSync(external).mode, originalMode);
    rmSync(external, { recursive: true });
    restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
    assert.equal(existsSync(external), false);
    const restored = JSON.parse(readFileSync(path.join(f.target, "provider-instances.json"), "utf8"));
    assert.equal(restored.instances[1].config.homePath, path.join(f.target, "provider-homes", "codex-a"));
    assert.equal(restored.instances[1].config.shadowHomePath, external);
  } finally { f.close(); }
});

test("usage hub keys and Cursor history follow the explicit backup secret policy", async () => {
  for (const secrets of ["exclude", "include"] as const) {
    const f = fixture();
    try {
      const hub = { version: 1, revisionClock: 7, sources: [{ id: "hub-a", kind: "cliproxy", label: "Hub", url: "https://hub.example", enabled: true, revision: 7, managementKey: "fake-hub-management-key" }] };
      writeFileSync(path.join(f.source, "usage-sources.json"), JSON.stringify(hub), { mode: 0o600 });
      writeFileSync(path.join(f.source, "cursor-usage-cache.json"), "{\"history\":\"private-fixture\"}", { mode: 0o600 });
      await create(f, secrets);
      restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
      const restored = JSON.parse(readFileSync(path.join(f.target, "usage-sources.json"), "utf8"));
      assert.equal(restored.sources[0].enabled, secrets === "include");
      assert.equal(restored.sources[0].managementKey, secrets === "include" ? "fake-hub-management-key" : undefined);
      assert.equal(existsSync(path.join(f.target, "cursor-usage-cache.json")), secrets === "include");
      assert.equal(readFileSync(path.join(f.source, "usage-sources.json"), "utf8").includes("fake-hub-management-key"), true);
      verifyAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
    } finally { f.close(); }
  }
});

test("derived usage caches and interrupted writes are classified but never copied into either backup policy", async () => {
  for (const secrets of ["include", "exclude"] as const) {
    const f = fixture();
    try {
      const names = ["usage-transcript-cache-v1.json", "native-database-usage-cache-v1.json",
        "usage-transcript-cache-v1.json.00000000-0000-0000-0000-000000000000.tmp",
        "native-database-usage-cache-v1.json.00000000-0000-0000-0000-000000000000.tmp"];
      for (const name of names) writeFileSync(path.join(f.source, name), "derived native usage metadata", { mode: 0o600 });
      const manifest = await create(f, secrets);
      assert.ok(manifest.exclusions.some(value => value.includes("usage scan caches")));
      for (const name of names) {
        assert.equal(manifest.files.some(entry => entry.path === name), false);
        assert.equal(existsSync(path.join(f.bundle, name)), false);
        assert.equal(readFileSync(path.join(f.source, name), "utf8"), "derived native usage metadata");
      }
      restoreAgentBackup({ bundle: f.bundle, target: f.target, stopped: true });
      for (const name of names) assert.equal(existsSync(path.join(f.target, name)), false);
    } finally { f.close(); }
  }
});

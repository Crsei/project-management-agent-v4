import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { contextDataDirectory, contextSecretKey, extensionDataDirectory, privateDirectory, projectExtensionContextId, saveExtensionContexts, type StoredExtensionContext } from "./storage.ts";
import { ExtensionHost } from "./service.ts";

const scope = { actorId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", projectId: "PRJ-001" };
test("native keys persist privately, concurrent context initialization is safe, and project keys never fall back", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-key-fixture-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  delete process.env.PM_AUTOMATION_INTEGRATIONS_KEY;
  const native: StoredExtensionContext = { id: "11111111-1111-4111-8111-111111111111", label: "Synthetic native", kind: "native", createdAt: new Date().toISOString() };
  const project: StoredExtensionContext = { id: projectExtensionContextId(scope), label: "Synthetic project", kind: "project", scope, createdAt: new Date().toISOString() };
  try {
    const [a, b] = await Promise.all([contextSecretKey(native), contextSecretKey({ ...native, id: "33333333-3333-4333-8333-333333333333" })]);
    assert.notEqual(a, b);
    assert.equal(await contextSecretKey(native), a);
    if (process.platform !== "win32") assert.equal((await stat(path.join(extensionDataDirectory(), "secret.key"))).mode & 0o077, 0);
    await assert.rejects(contextSecretKey(project), { code: "project_private_storage_unavailable" });
    process.env.PM_AUTOMATION_INTEGRATIONS_KEY = Buffer.alloc(32, 17).toString("base64");
    const first = await contextSecretKey(project);
    assert.notEqual(first, a);
    const otherScope = { ...scope, actorId: "44444444-4444-4444-8444-444444444444" };
    assert.notEqual(await contextSecretKey({ ...project, scope: otherScope, id: projectExtensionContextId(otherScope) }), first);
    if (process.platform !== "win32") {
      await chmod(path.join(extensionDataDirectory(), "secret.key"), 0o644);
      await assert.rejects(contextSecretKey(native));
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
test("migration exclusion persists across manager replacement and only the same reviewed plan can end it", async () => {
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-maintenance-fixture-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  const first = new ExtensionHost();
  const restored = new ExtensionHost();
  const owner = { migrationId: "a".repeat(64) };
  try {
    assert.deepEqual(await first.beginMaintenance(owner), owner);
    assert.deepEqual(await first.beginMaintenance(owner), owner);
    await first.close();
    await assert.rejects(restored.beginMaintenance({ migrationId: "b".repeat(64) }), { code: "migration_owner_conflict" });
    await assert.rejects(restored.endMaintenance({ migrationId: "b".repeat(64) }), { code: "migration_owner_conflict" });
    assert.deepEqual(await restored.endMaintenance(owner), owner);
    assert.deepEqual(await restored.endMaintenance(owner), owner);
  } finally {
    await restored.close();
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test("a missing native master key never regenerates over an existing native database", async () => {
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-key-loss-fixture-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  const native: StoredExtensionContext = {
    id: "55555555-5555-4555-8555-555555555555", label: "Synthetic retained database", kind: "native", createdAt: new Date().toISOString(),
    binding: { label: "Synthetic target", homeDir: root, appDirs: { codex: path.join(root, "native-codex") }, providerInstanceIds: [], apps: ["codex"], physicalRoots: [path.join(root, "native-codex")], unifiedSkillsRoot: path.join(root, ".agents", "skills"), sharedProviderInstanceIds: [], bindingFingerprint: "synthetic-fixture-authority", warnings: [] },
  };
  try {
    await saveExtensionContexts([native]);
    await privateDirectory(contextDataDirectory(native.id));
    const database = new DatabaseSync(path.join(contextDataDirectory(native.id), "cc-switch.db"));
    database.exec("CREATE TABLE retained_fixture(id TEXT PRIMARY KEY)");
    database.close();
    await assert.rejects(contextSecretKey(native), { code: "private_key_restore_required" });
    await assert.rejects(stat(path.join(extensionDataDirectory(), "secret.key")), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

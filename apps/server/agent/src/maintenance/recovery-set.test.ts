import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { blobBackupManifestSchema, blobBackupManifestSha256 } from "../../../../../packages/infrastructure/src/blob-storage-backup.ts";
import { localProjectCheckpointSchema, localProjectCheckpointSha256 } from "../../../../../packages/infrastructure/src/project-storage-checkpoint.ts";
import { snapshotTree } from "../../../../../packages/infrastructure/src/maintenance-tree.ts";
import { captureAgentStoppedState, createAgentBackup, restoreAgentBackup, verifyAgentBackup } from "./agent-backup.ts";
import { createStoppedRecoverySet, recoverySetSchema, verifyStoppedRecoverySet, writeStoppedRecoverySet } from "./recovery-set.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("same-barrier descriptor binds real SQLite/SQL/core/blob/chat components and refuses mixed/future/tampered or missing trees", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "stopped-recovery-set-")));
  const source = path.join(root, "source"), directory = path.join(root, "set");
  mkdirSync(source, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  try {
    const db = new DatabaseSync(path.join(source, "workspace.sqlite"));
    db.exec("CREATE TABLE records(namespace TEXT,key TEXT,value TEXT,PRIMARY KEY(namespace,key)); CREATE TABLE run_events(run_id TEXT,seq INTEGER,event TEXT,PRIMARY KEY(run_id,seq)); CREATE TABLE worker_owner(singleton INTEGER PRIMARY KEY,pid INTEGER,token TEXT)");
    db.prepare("INSERT INTO records VALUES(?,?,?)").run("chat:threads", "thread", JSON.stringify({ remoteId: "thread", status: "regular" }));
    db.prepare("INSERT INTO records VALUES(?,?,?)").run("chat:history", "history", JSON.stringify({ threadId: "thread", format: "ai-sdk/v6", messages: [], headId: null }));
    db.close();
    const sourceState = captureAgentStoppedState(source, true, "exclude");
    const agent = await createAgentBackup({ source, bundle: path.join(directory, "agent"), secrets: "exclude", stopped: true });
    mkdirSync(path.join(directory, "files"), { mode: 0o700 }); mkdirSync(path.join(directory, "blobs"), { mode: 0o700 });
    // These bytes test component binding, not SQL execution; the desktop/PM suite owns real PostgreSQL restore.
    writeFileSync(path.join(directory, "database.dump"), "isolated SQL component bytes", { mode: 0o600 });
    const databaseDumpSha256 = hash(readFileSync(path.join(directory, "database.dump")));
    const core = localProjectCheckpointSchema.parse({ formatVersion: 1, core: [], coreDirectories: [], projects: [] });
    const coreManifestSha256 = localProjectCheckpointSha256(core);
    writeFileSync(path.join(directory, "files/manifest.json"), JSON.stringify(core, null, 2) + "\n", { mode: 0o600 });
    const blobs = blobBackupManifestSchema.parse({ formatVersion: 1, backupSetId: randomUUID(), createdAt: new Date().toISOString(), source: {
      storeId: randomUUID(), provider: "local", locatorSha256: "a".repeat(64), epoch: "1", state: "active", verifiedManifestSha256: null, verifiedAt: null,
    }, databaseDumpSha256, coreManifestSha256, entries: [] });
    writeFileSync(path.join(directory, "blobs/manifest.json"), JSON.stringify(blobs, null, 2) + "\n", { mode: 0o600 });
    const now = new Date().toISOString();
    const set = createStoppedRecoverySet({ applicationVersion: "isolated-contract", quiescence: { barrierId: randomUUID(), startedAt: now, endedAt: now,
      writers: ["pm-api", "pm-worker", "pm-markdown-editors", "agent", "owned-native-processes"], operatorConfirmedStopped: true, sourceRechecked: true },
      components: { databaseDumpSha256, coreManifestSha256, blobManifestSha256: blobBackupManifestSha256(blobs), agentManifestSha256: hash(readFileSync(path.join(directory, "agent/manifest.json"))), chatFilesSha256: null },
      agent: { sourceStoreId: agent.sourceIdentity!.storeId, restoreEpoch: agent.sourceIdentity!.restoreEpoch, sourceFingerprint: sourceState.fingerprint, secrets: "exclude" }, exclusions: agent.exclusions });
    await writeStoppedRecoverySet(directory, set);
    assert.deepEqual(await verifyStoppedRecoverySet(directory, set), set);
    assert.equal(captureAgentStoppedState(source, true, "exclude").fingerprint, sourceState.fingerprint);
    restoreAgentBackup({ bundle: path.join(directory, "agent"), target: path.join(root, "target"), stopped: true });
    verifyAgentBackup({ bundle: path.join(directory, "agent"), target: path.join(root, "target"), stopped: true });
    await assert.rejects(verifyStoppedRecoverySet(directory, { ...set, recoverySetId: randomUUID() }), /identity differs/);
    assert.throws(() => recoverySetSchema.parse({ ...set, version: 99 }));
    assert.throws(() => recoverySetSchema.parse({ ...set, quiescence: { ...set.quiescence, operatorConfirmedStopped: false } }));
    assert.throws(() => recoverySetSchema.parse({ ...set, quiescence: { ...set.quiescence, writers: ["agent", "agent", "agent", "agent", "agent"] } }));
    const chatRoot = path.join(directory, "chat-spaces"), desktopFile = path.join(directory, "desktop-backup.json");
    const recoveryFile = path.join(directory, "recovery-set.json"), chatFile = path.join(chatRoot, "history.txt");
    mkdirSync(chatRoot, { mode: 0o700 }); mkdirSync(path.join(chatRoot, "empty"), { mode: 0o700 });
    writeFileSync(chatFile, "original desktop chat bytes", { mode: 0o600 });
    const chatFiles = await snapshotTree(chatRoot);
    const chatSet = { ...set, components: { ...set.components, chatFilesSha256: hash(JSON.stringify(chatFiles)) } };
    writeFileSync(desktopFile, JSON.stringify({ chatFiles }), { mode: 0o600 });
    writeFileSync(recoveryFile, JSON.stringify(chatSet), { mode: 0o600 });
    assert.deepEqual(await verifyStoppedRecoverySet(directory, chatSet), chatSet);
    writeFileSync(chatFile, "tampered desktop chat bytes", { mode: 0o600 });
    await assert.rejects(verifyStoppedRecoverySet(directory), /manifest differs/);
    writeFileSync(chatFile, "original desktop chat bytes", { mode: 0o600 });
    writeFileSync(path.join(chatRoot, "undeclared.txt"), "extra file", { mode: 0o600 });
    await assert.rejects(verifyStoppedRecoverySet(directory), /manifest differs/);
    rmSync(path.join(chatRoot, "undeclared.txt"));
    rmSync(path.join(chatRoot, "empty"), { recursive: true });
    await assert.rejects(verifyStoppedRecoverySet(directory), /manifest differs/);
    mkdirSync(path.join(chatRoot, "empty"), { mode: 0o700 });
    writeFileSync(recoveryFile, JSON.stringify({ ...chatSet, components: { ...chatSet.components, chatFilesSha256: "0".repeat(64) } }), { mode: 0o600 });
    await assert.rejects(verifyStoppedRecoverySet(directory), /inventory differs/);
    writeFileSync(recoveryFile, JSON.stringify(chatSet), { mode: 0o600 });
    rmSync(chatRoot, { recursive: true });
    await assert.rejects(verifyStoppedRecoverySet(directory), /ENOENT/);
    mkdirSync(chatRoot, { mode: 0o700 }); mkdirSync(path.join(chatRoot, "empty"), { mode: 0o700 });
    writeFileSync(chatFile, "original desktop chat bytes", { mode: 0o600 });
    rmSync(desktopFile);
    await assert.rejects(verifyStoppedRecoverySet(directory));
    writeFileSync(recoveryFile, JSON.stringify(set), { mode: 0o600 });
    await assert.rejects(verifyStoppedRecoverySet(directory), /undeclared desktop chat tree/);
    rmSync(chatRoot, { recursive: true });
    assert.deepEqual(await verifyStoppedRecoverySet(directory, set), set);
    writeFileSync(path.join(directory, "database.dump"), "different SQL checkpoint", { mode: 0o600 });
    await assert.rejects(verifyStoppedRecoverySet(directory), /changed|another checkpoint/);
    const unpublishable = path.join(root, "unpublishable"); mkdirSync(unpublishable, { mode: 0o700 });
    await assert.rejects(writeStoppedRecoverySet(unpublishable, set));
    assert.equal(existsSync(path.join(unpublishable, "recovery-set.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

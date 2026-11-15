import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapLegacyPersistence, getStoreIdentity, initializePersistence, inventoryPersistence, namespacePolicy, preflightPersistence, restorePersistenceIdentity, rollbackLegacyPersistence } from "./persistence-schema.ts";
import { closeStore, getDatabase, readRecord, transaction, writeRecord } from "./store.ts";
import { seedLegacyPersistenceCopy } from "../maintenance/persistence.testkit.ts";
import { ensureThread, saveFormattedMessage, bindMessageTurnContext, getThreadHistory, assertThreadWritable } from "./threads.ts";
import { chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";
import { contextDigest } from "./message-context.ts";
import type { ChatContextInput, AcceptedChatContext } from "@agent-workspace/contracts/message-context";

const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-persistence-contract-"))); process.env.AGENT_WORKSPACE_DATA_DIR = root; });
afterEach(() => { closeStore(); if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory; rmSync(root, { recursive: true, force: true }); });
function schema(db: DatabaseSync): void {
  db.exec("CREATE TABLE records(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)); CREATE TABLE run_events(run_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(run_id,seq)); CREATE TABLE worker_owner(singleton INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL)");
}
function put(db: DatabaseSync, namespace: string, key: string, value: unknown): void { db.prepare("INSERT INTO records VALUES(?,?,?)").run(namespace, key, JSON.stringify(value)); }

test("one physical SQLite writer, nested rollback and async rejection do not admit a second owner", () => {
  const db = getDatabase(), identity = getStoreIdentity(db);
  const child = spawnSync(process.execPath, ["--conditions=development", "--input-type=module", "-e", `import {getDatabase} from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)}; getDatabase();`], { env: { ...process.env, AGENT_WORKSPACE_DATA_DIR: root }, encoding: "utf8" });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /already owned|already active/);
  assert.throws(() => transaction(() => { writeRecord("chat:cancellations", "atomic", { accepted: true }); throw new Error("crash boundary"); }), /crash boundary/);
  assert.equal(readRecord("chat:cancellations", "atomic"), null);
  assert.throws(() => transaction(async () => {}), /must be synchronous/);
  assert.deepEqual(getStoreIdentity(db), identity);
});

test("future metadata, record structures, unknown namespaces and invalid uniqueness reject before owner/schema writes", () => {
  for (const mutation of [
    (db: DatabaseSync) => { const identity = initializePersistence(db); db.prepare("UPDATE records SET value=? WHERE namespace='agent:persistence:v1'").run(JSON.stringify({ ...identity, minimumWriterVersion: 99 })); },
    (db: DatabaseSync) => { initializePersistence(db); put(db, "chat:threads", "future", { remoteId: "future", executionSelection: { version: 99 } }); },
    (db: DatabaseSync) => { initializePersistence(db); put(db, "unknown:future-module", "record", { threadId: "keep" }); },
    (db: DatabaseSync) => { db.exec("PRAGMA user_version=99"); },
  ]) {
    const db = new DatabaseSync(":memory:"); schema(db); mutation(db);
    const before = db.prepare("SELECT namespace,key,value FROM records ORDER BY namespace,key").all();
    assert.throws(() => preflightPersistence(db), /Unsupported|Unregistered|Future/);
    assert.deepEqual(db.prepare("SELECT namespace,key,value FROM records ORDER BY namespace,key").all(), before);
    assert.equal(db.prepare("SELECT count(*) AS count FROM worker_owner").get()!.count, 0); db.close();
  }
  const malformed = new DatabaseSync(":memory:");
  malformed.exec("CREATE TABLE records(namespace TEXT,key TEXT,value TEXT); CREATE TABLE run_events(run_id TEXT,seq INTEGER,event TEXT); CREATE TABLE worker_owner(singleton INTEGER,pid INTEGER,token TEXT)");
  assert.throws(() => preflightPersistence(malformed), /uniqueness/); malformed.close();
});

test("reviewed legacy bootstrap is non-destructive, repeatable and rollback refuses any post-plan write", () => {
  const db = new DatabaseSync(":memory:"); schema(db);
  put(db, "chat:threads", "legacy", { remoteId: "legacy", title: "Legal old title", status: "archived" });
  put(db, "chat:history", "legacy-history", { threadId: "legacy", format: "ai-sdk/v6", headId: "input", messages: [{ id: "input", parent_id: null, content: { role: "user", parts: [{ type: "text", text: "exact historical input" }] } }], authoritativeIds: [] });
  const original = db.prepare("SELECT namespace,key,value FROM records ORDER BY namespace,key").all();
  const plan = inventoryPersistence(db); assert.deepEqual(plan.blockers, []); assert.equal(preflightPersistence(db).legacy, true);
  assert.throws(() => bootstrapLegacyPersistence(db, "0".repeat(64)), /changed/);
  const identity = bootstrapLegacyPersistence(db, plan.fingerprint);
  assert.deepEqual(bootstrapLegacyPersistence(db, plan.fingerprint), identity);
  assert.deepEqual(db.prepare("SELECT namespace,key,value FROM records WHERE namespace<>'agent:persistence:v1' ORDER BY namespace,key").all(), original);
  put(db, "chat:cancellations", "new-write", { cancelledAt: "2026-01-01T00:00:00.000Z" });
  assert.throws(() => rollbackLegacyPersistence(db, plan.fingerprint), /Rollback refused/);
  db.prepare("DELETE FROM records WHERE namespace='chat:cancellations'").run();
  rollbackLegacyPersistence(db, plan.fingerprint); assert.deepEqual(db.prepare("SELECT namespace,key,value FROM records ORDER BY namespace,key").all(), original); db.close();
});

test("inventory checks graph/head/submission/output/queue relations without inventing legacy context", () => {
  const db = new DatabaseSync(":memory:"); schema(db);
  put(db, "chat:threads", "thread", { remoteId: "thread" });
  put(db, "chat:history", "history", { threadId: "thread", headId: "missing", messages: [{ id: "a", parent_id: "b" }, { id: "b", parent_id: "a" }] });
  put(db, "chat:requests", "request", { id: "missing-generation", fingerprint: "original" });
  put(db, "native-output", "missing-generation", { threadId: "thread", generationId: "missing-generation" });
  put(db, "chat:message-queue", "queue", { threadId: "thread", status: "sent", generationId: "missing-generation" });
  const report = inventoryPersistence(db);
  for (const code of ["missing_head", "cyclic_history", "broken_submission", "orphan_native_output", "broken_queue_acceptance"]) assert.ok(report.blockers.some(value => value.startsWith(code)));
  assert.equal(JSON.stringify(db.prepare("SELECT value FROM records WHERE namespace='chat:history'").get()).includes("turnContext"), false);
  for (const namespace of ["chat:message-queue", "chat:draft-stash", "chat:thread-actions", "chat:steering", "chat:execution-grants", "pm-content-provenance", "pm-quote-provenance", "provider:t3code:continuations", "mcp-app-private-assets-v1", "agent:scratch:v1", "collaboration:agent-versions", "collaboration:runs:v1", "collaboration:delegations:v1", "collaboration:output-budgets:v1"]) assert.ok(namespacePolicy(namespace), namespace);
  db.close();
});

test("restored Store allocates a new local identity/epoch and preserves original historical IDs", () => {
  const db = getDatabase(), source = getStoreIdentity(db);
  writeRecord("chat:threads", "original", { remoteId: "original", executionPath: "/external/original", createdAt: "2020-01-01T00:00:00.000Z" });
  const restored = restorePersistenceIdentity(db);
  assert.notEqual(restored.storeId, source.storeId); assert.equal(restored.sourceStoreId, source.storeId); assert.equal(restored.restoreEpoch, source.restoreEpoch + 1);
  assert.equal(readRecord<{ executionPath: string }>("chat:threads", "original")!.executionPath, "/external/original");
});

test("legacy runtime refuses writes while explicit stopped-copy CLI exports legal old history without a migration", () => {
  const db = new DatabaseSync(path.join(root, "workspace.sqlite")); schema(db);
  put(db, "chat:threads", "old", { remoteId: "old", status: "archived" });
  put(db, "chat:history", "history", { threadId: "old", format: "ai-sdk/v6", headId: null, messages: [], authoritativeIds: [] }); db.close();
  const original = readFileSync(path.join(root, "workspace.sqlite"));
  assert.throws(() => getDatabase(), /Legacy Agent Store/);
  const output = path.join(root, "history-export.json");
  const child = spawnSync(process.execPath, ["--conditions=development", fileURLToPath(new URL("../../../../../scripts/agent-persistence.ts", import.meta.url)), "--data", root, "--stopped", "--isolated-copy", "--history-thread", "old", "--output", output], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).histories[0].threadId, "old");
  assert.deepEqual(readFileSync(path.join(root, "workspace.sqlite")), original);
});

test("stopped-copy CLI plan/apply/repeat/rollback preserves every original SQLite record", () => {
  const filename = path.join(root, "workspace.sqlite");
  seedLegacyPersistenceCopy(root, { isolated: true });
  const db = new DatabaseSync(filename, { readOnly: true });
  const original = db.prepare("SELECT namespace,key,value FROM records ORDER BY namespace,key").all(); db.close();
  const entry = fileURLToPath(new URL("../../../../../scripts/agent-persistence.ts", import.meta.url));
  const plan = path.join(root, "private-plan.json");
  const base = ["--conditions=development", entry, "--data", root, "--stopped", "--isolated-copy"];
  const planned = spawnSync(process.execPath, [...base, "--output", plan], { encoding: "utf8" });
  assert.equal(planned.status, 0, planned.stderr);
  const first = spawnSync(process.execPath, [...base, "--apply", "--plan", plan], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const repeated = spawnSync(process.execPath, [...base, "--apply", "--plan", plan], { encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).identity.storeId, JSON.parse(first.stdout).identity.storeId);
  const rollback = spawnSync(process.execPath, [...base, "--rollback", "--plan", plan], { encoding: "utf8" });
  assert.equal(rollback.status, 0, rollback.stderr);
  const restored = new DatabaseSync(filename, { readOnly: true });
  try { assert.deepEqual(restored.prepare("SELECT namespace,key,value FROM records ORDER BY namespace,key").all(), original); }
  finally { restored.close(); }
});

test("an unaware original writer cannot claim the upgraded SQLite owner or write records", () => {
  writeRecord("chat:cancellations", "retained", { original: true });
  const identity = getStoreIdentity(getDatabase()); closeStore();
  const filename = path.join(root, "workspace.sqlite");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(filename)}); db.exec("BEGIN IMMEDIATE; INSERT INTO worker_owner(singleton,pid,token) VALUES(1,999,'old-writer')"); db.prepare("INSERT INTO records VALUES('chat:cancellations','overwritten','{}')").run();`], { encoding: "utf8" });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /agent_persistence_writer_version|writer version/);
  const reopened = getDatabase();
  assert.equal(getStoreIdentity(reopened).storeId, identity.storeId);
  assert.deepEqual(readRecord("chat:cancellations", "retained"), { original: true });
  assert.equal(readRecord("chat:cancellations", "overwritten"), null);
});

test("canonical typed context survives Store restore unchanged and inventory refuses forged snapshot bindings", () => {
  ensureThread("context-thread", undefined, chatOnlyExecutionSelection());
  const input: ChatContextInput = { contextId: "browser-context", kind: "preview-annotation", source: { type: "browser", url: "https://user-snapshot.invalid/" }, text: "EXACT_SELECTED_BROWSER_TEXT", comment: "EXACT_USER_COMMENT" };
  const accepted: AcceptedChatContext = { contextId: input.contextId, kind: input.kind, input, source: input.source, text: input.text,
    digest: contextDigest(input.text), inputDigest: contextDigest(input), truncated: false, acceptedAt: new Date().toISOString(),
    visibility: "available", provenance: "user-browser-snapshot", dependencies: [{ threadId: "context-thread", messageIds: [] }] };
  saveFormattedMessage("context-thread", { id: "input", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Actual input" }] } });
  bindMessageTurnContext("context-thread", { version: 1, threadId: "context-thread", messageId: "input", acceptedAt: new Date().toISOString(), pmReferences: [], contextItems: [accepted] });
  const db = getDatabase(), original = getThreadHistory("context-thread").messages[0]!.turnContext;
  assert.deepEqual(inventoryPersistence(db).blockers, []);
  restorePersistenceIdentity(db);
  assert.deepEqual(getThreadHistory("context-thread").messages[0]!.turnContext, original);
  assert.throws(() => assertThreadWritable("context-thread"), { code: "restored_history_read_only" });
  const row = db.prepare("SELECT key,value FROM records WHERE namespace='chat:history'").get()!;
  const history = JSON.parse(String(row.value));
  history.messages[0].turnContext.contextItems[0].text = "FORGED_REPLACEMENT_BODY";
  db.prepare("UPDATE records SET value=? WHERE namespace='chat:history' AND key=?").run(JSON.stringify(history), String(row.key));
  assert.ok(inventoryPersistence(db).blockers.some(value => value.startsWith("invalid_message_context_binding:")));
});

test("server-owned draft acceptance survives reopen and cannot be rebound by editing an input or its proof", () => {
  const threadId = "draft-snapshot-owner";
  ensureThread(threadId, undefined, chatOnlyExecutionSelection());
  const input: ChatContextInput = { contextId: "saved-browser-context", kind: "element", source: { type: "browser", url: "https://user-selected.invalid/", selector: "button" }, text: "Actual user-selected text" };
  const accepted: AcceptedChatContext = { contextId: input.contextId, kind: input.kind, input, source: input.source, text: input.text,
    digest: contextDigest(input.text), inputDigest: contextDigest(input), truncated: false, acceptedAt: new Date().toISOString(),
    visibility: "available", provenance: "user-browser-snapshot", dependencies: [{ threadId, messageIds: [] }] };
  const row = { id: "saved", threadId, createdAt: new Date().toISOString(), digest: "original-save-fingerprint",
    draft: { message: { id: "draft-input", role: "user", parts: [{ type: "text", text: "Explain the selected element." }] }, contextItems: [input] },
    acceptedContextItems: [accepted] };
  const key = JSON.stringify([threadId, row.id]);
  writeRecord("chat:draft-stash", key, row);
  assert.deepEqual(inventoryPersistence(getDatabase()).blockers, []);
  closeStore();
  assert.deepEqual(readRecord("chat:draft-stash", key), row);
  writeRecord("chat:draft-stash", key, { ...row, acceptedContextItems: [{ ...accepted, input: { ...input, comment: "FORGED_DIFFERENT_INPUT" } }] });
  assert.ok(inventoryPersistence(getDatabase()).blockers.some(value => value.startsWith("invalid_draft_snapshot_binding:")));
});

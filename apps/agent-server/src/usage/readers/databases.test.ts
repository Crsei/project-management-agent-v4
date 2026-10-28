import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import type { UsageReadContext } from "../types.ts";
import { scanDatabaseUsage } from "./databases.ts";

function instance(driver: StoredProviderInstance["driver"], homeDirectory: string, env: Record<string, string> = {}, instanceId = driver): StoredProviderInstance {
  return { instanceId, driver, homeDirectory, label: instanceId, enabled: false, config: {}, env, revision: 1 };
}
function context(instances: StoredProviderInstance[]): UsageReadContext {
  return { instances, sinceMs: 1_000, untilMs: 10_000, awaitRefresh: true, settings: {} as UsageReadContext["settings"] };
}
function message(id: string, sessionID: string, cost: number) {
  return { id, sessionID, role: "assistant", modelID: "open-model", time: { created: 2_000 }, tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }, cost };
}
function museEntry(id: string, session: string, source: string, cost?: number) {
  return { schema_version: 1, record_type: "event", payload_type: "runtime.session", payload_schema_version: 3, id, recorded_at: 3_000_000, stream: { kind: "session", id: session }, payload: { source_run_record_id: source, event: { kind: "automated_review_completed", model: { model_id: "muse-model" }, usage: { input_tokens: 100, cache_read_tokens: 20, cache_write_tokens: 10, output_tokens: 12, reasoning_tokens: 5, ...(cost === undefined ? {} : { cost_usd: cost }) } } } };
}
function varint(value: number): number[] { const result: number[] = []; while (value >= 128) { result.push((value % 128) | 128); value = Math.floor(value / 128); } result.push(value); return result; }
function numberField(key: number, value: number): number[] { return [...varint(key * 8), ...varint(value)]; }
function blobField(key: number, value: number[] | Uint8Array): number[] { return [...varint(key * 8 + 2), ...varint(value.length), ...value]; }
function textField(key: number, value: string): number[] { return blobField(key, Buffer.from(value)); }

test("OpenCode scans actual SQLite and legacy JSON across configured roots without duplicate messages", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "usage-opencode-"));
  try {
    const a = path.join(temp, "data-a"), b = path.join(temp, "data-b"), legacy = path.join(a, "storage", "message", "child");
    await mkdir(legacy, { recursive: true }); await mkdir(b);
    const db = new DatabaseSync(path.join(a, "opencode.db"));
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT)");
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("same", "root", 2000, JSON.stringify(message("same", "root", 0.25)));
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("bad", "root", 2000, "{broken");
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run("sub", "child", "assistant", JSON.stringify(message("sub", "child", 0)));
    db.close();
    await writeFile(path.join(legacy, "same.json"), JSON.stringify(message("same", "root", 0.25)));
    await mkdir(path.join(b, "storage", "message", "child"), { recursive: true });
    await writeFile(path.join(b, "storage", "message", "child", "other.json"), JSON.stringify(message("other", "child", 0)));
    const scans = await scanDatabaseUsage(context([instance("opencode", temp, { OPENCODE_DATA_DIR: `${a},${b},${a}` })]));
    const records = scans.flatMap(scan => scan.records);
    assert.equal(records.length, 3); assert.deepEqual(records.map(record => record.sessionId).sort(), ["child", "child", "root"]);
    assert.equal(records.find(record => record.dedupeKey === "opencode:same")?.reportedCostUsd, 0.25);
    assert.equal(records.find(record => record.dedupeKey === "opencode:sub")?.reportedCostUsd, null);
    assert.equal(records[0]?.totals.outputTokens, 6);
    assert.equal(scans[0]?.source.status, "partial"); assert.equal(scans[0]?.source.malformedRecords, 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("Muse streams native root and child history, deduplicates copied inference and preserves reported cost", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "usage-muse-"));
  try {
    const root = path.join(temp, "native"), sessions = path.join(root, "sessions");
    await mkdir(path.join(sessions, "root"), { recursive: true }); await mkdir(path.join(sessions, "child"));
    await writeFile(path.join(sessions, "root", "session.jsonl"), [JSON.stringify(museEntry("one", "root", "run-a", 0.04)), "{bad", JSON.stringify(museEntry("copy", "root", "run-child"))].join("\n"));
    await writeFile(path.join(sessions, "child", "session.jsonl"), [JSON.stringify(museEntry("two", "child", "run-child")), JSON.stringify(museEntry("three", "child", "run-child-independent"))].join("\n") + "\n");
    const scans = await scanDatabaseUsage(context([instance("muse", temp, { MUSE_HOME: root })]));
    const records = scans.flatMap(scan => scan.records);
    assert.equal(records.length, 3); assert.ok(records.some(record => record.sessionId === "child" && record.dedupeKey === JSON.stringify(["muse", "run-child-independent"]))); assert.equal(records.find(record => record.dedupeKey === JSON.stringify(["muse", "run-a"]))?.reportedCostUsd, 0.04);
    assert.deepEqual(records[0]?.totals, { uncachedInputTokens: 70, cachedInputTokens: 20, cacheCreationTokens: 10, outputTokens: 12, reasoningTokens: 5 });
    assert.equal(scans[0]?.source.status, "partial"); assert.equal(scans[0]?.source.malformedRecords, 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("Antigravity scans managed profiles, merges step and generation IDs, and isolates corrupt metadata", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "usage-antigravity-"));
  try {
    const conversations = path.join(temp, "antigravity-acp", "conversations"); await mkdir(conversations, { recursive: true });
    const db = new DatabaseSync(path.join(conversations, "session.db"));
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)");
    const usage = [...numberField(1, 246), ...numberField(2, 12), ...numberField(3, 5), ...numberField(5, 3), ...numberField(9, 2), ...textField(11, "request-id")];
    const gen = blobField(1, [...blobField(4, usage), ...blobField(9, blobField(4, numberField(1, 2)))]);
    const step = [...blobField(9, [...usage, ...textField(12, "secondary-id")]), ...blobField(8, numberField(1, 3))];
    db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(1, Buffer.from(gen));
    db.prepare("INSERT INTO steps VALUES (?, ?)").run(1, Buffer.from(step));
    db.prepare("INSERT INTO steps VALUES (?, ?)").run(2, Buffer.from([255])); db.close();
    const scans = await scanDatabaseUsage(context([instance("antigravity", temp)]));
    const records = scans.flatMap(scan => scan.records);
    assert.equal(records.length, 1); assert.equal(records[0]?.model, "gemini-2.5-pro"); assert.equal(records[0]?.sessionId, "session");
    assert.equal(records[0]?.totals.uncachedInputTokens, 12); assert.equal(records[0]?.totals.cachedInputTokens, 3); assert.equal(records[0]?.reportedCostUsd, null);
    assert.equal(scans.find(scan => scan.source.scannedFiles)?.source.status, "partial");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("missing, corrupt and linked histories remain unavailable rather than successful zero usage", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "usage-absence-"));
  try {
    const missing = path.join(temp, "missing"), corrupt = path.join(temp, "corrupt"); await mkdir(corrupt);
    await writeFile(path.join(corrupt, "opencode.db"), "not sqlite");
    const scans = await scanDatabaseUsage(context([instance("opencode", temp, { OPENCODE_DATA_DIR: `${missing},${corrupt}` })]));
    assert.equal(scans.find(scan => scan.source.fingerprint.resolvedHomePath === missing)?.source.status, "missing");
    assert.equal(scans.find(scan => scan.source.fingerprint.resolvedHomePath === corrupt)?.source.status, "partial");
    if (process.platform !== "win32") {
      const root = path.join(temp, "muse"), outside = path.join(temp, "outside"); await mkdir(root); await mkdir(path.join(outside, "sessions"), { recursive: true });
      await symlink(path.join(outside, "sessions"), path.join(root, "sessions"));
      const linked = await scanDatabaseUsage(context([instance("muse", temp, { MUSE_HOME: root })]));
      assert.equal(linked[0]?.source.status, "failed"); assert.equal(linked[0]?.records.length, 0);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

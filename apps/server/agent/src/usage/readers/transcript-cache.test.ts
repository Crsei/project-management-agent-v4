import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexUsageReader } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/codexUsage.ts";
import { TranscriptCache } from "./transcript-cache.ts";
import { scanOriginalTranscripts } from "./transcripts.ts";
import type { UsageReadContext } from "../types.ts";

const timestamp = "2026-10-20T10:00:00.000Z";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const meta = { type: "session_meta", timestamp, payload: { id: "native-session", model_provider: "openai" } };
const turn = { type: "turn_context", payload: { model: "gpt-test", turn_id: "native-turn" } };
const usage = (input: number, cumulative = input) => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: {
  last_token_usage: { input_tokens: input, output_tokens: 2 }, total_token_usage: { input_tokens: cumulative, output_tokens: cumulative / input * 2 },
} } });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "original-usage-cache-"));
  const sessions = path.join(root, "sessions"), file = path.join(sessions, "rollout.jsonl"), saved = path.join(root, "private", "cache.json");
  await mkdir(sessions);
  const instance = { driver: "codex" as const, instanceId: "fixture", label: "Fixture", enabled: false,
    config: {}, env: {}, revision: 1, homeDirectory: root, stateDirectory: path.join(root, "state") };
  const context: UsageReadContext = { instances: [instance], sinceMs: Date.parse("2026-10-20"), untilMs: Date.parse("2026-10-21"), awaitRefresh: true,
    settings: { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false } };
  const read = async (cache = new TranscriptCache(saved), binding = "a".repeat(64)) => {
    if (codexUsageReader.kind !== "transcripts") throw new Error("Original Codex transcript contract changed.");
    const result = await scanOriginalTranscripts(context, { instance, provider: "codex", format: codexUsageReader.format, dir: sessions, binding }, cache);
    await cache.flush(); return result;
  };
  return { root, sessions, file, saved, read };
}

test("native append and provisional tails survive restart without double billing or losing original reducer state", async () => {
  const f = await fixture();
  try {
    const tail = JSON.stringify(usage(10, 20));
    await writeFile(f.file, line(meta) + line(turn) + line(usage(10)) + tail.slice(0, -3));
    const incomplete = await f.read();
    assert.equal(incomplete.records.length, 1); assert.equal(incomplete.source.status, "partial");
    await appendFile(f.file, tail.slice(-3));
    const provisional = await f.read(); assert.equal(provisional.records.length, 2);
    assert.equal((await f.read()).records.length, 2);
    await appendFile(f.file, "\n" + line(usage(10, 30)));
    const committed = await f.read(); assert.equal(committed.records.length, 3); assert.equal(committed.source.status, "ok");
    assert.equal((await f.read()).records.length, 3);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("same-size rewrite, truncation and inode replacement invalidate original parser state and counters", async () => {
  const f = await fixture();
  try {
    const body = (input: number) => line(meta) + line(turn) + line(usage(input));
    await writeFile(f.file, body(10)); await f.read();
    const before = await stat(f.file);
    await writeFile(f.file, body(20)); await utimes(f.file, before.atime, before.mtime);
    assert.equal((await f.read()).records[0]?.totals.uncachedInputTokens, 20);
    await writeFile(`${f.file}.replacement`, body(30)); await rename(`${f.file}.replacement`, f.file);
    assert.equal((await f.read()).records[0]?.totals.uncachedInputTokens, 30);
    await writeFile(f.file, ""); assert.equal((await f.read()).records.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("removed-file history remains partial only within the exact source and instance/revision/environment binding", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, line(meta) + line(turn) + line(usage(10))); await f.read(); await rm(f.file);
    const retained = await f.read(); assert.equal(retained.records.length, 1); assert.equal(retained.source.status, "partial");
    assert.match(retained.source.message!, /retained usage/);
    assert.equal((await f.read(new TranscriptCache(f.saved), "b".repeat(64))).records.length, 0);
    await rename(f.sessions, `${f.sessions}.old`); await mkdir(f.sessions);
    assert.equal((await f.read()).records.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit unknown native tiers persist as uncertainty, never as launch-recoverable standard usage", async () => {
  const f = await fixture();
  try {
    const tier = { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "private-future-tier" } } };
    await writeFile(f.file, line(meta) + line(turn) + line(tier) + line(usage(10)));
    for (let restart = 0; restart < 2; restart++) {
      const record = (await f.read()).records[0]!;
      assert.equal(record.unrecognizedServiceTier, true); assert.equal(record.unresolvedServiceTierTurnId, undefined);
    }
    const saved = await readFile(f.saved, "utf8"); assert.equal(saved.includes("private-future-tier"), false);
    assert.equal((await stat(f.saved)).mode & 0o777, 0o600);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("corrupt and unbound legacy metadata reparse live history and disclose unrecoverable removed history", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, line(meta) + line(turn) + line(usage(10))); await f.read();
    for (const bytes of ["{", '{"version":1,"files":[]}']) {
      await writeFile(f.saved, bytes);
      const restored = await f.read(); assert.equal(restored.records.length, 1); assert.equal(restored.source.status, "partial");
      assert.match(restored.source.message!, /removed historical files cannot be reconstructed/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

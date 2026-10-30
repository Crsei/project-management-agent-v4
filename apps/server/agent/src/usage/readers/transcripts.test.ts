import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeUsageReader } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/claudeUsage.ts";
import { codexUsageReader } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/codexUsage.ts";
import { TranscriptCache } from "./transcript-cache.ts";
import { readTranscriptFile } from "./transcript-stream.ts";
import { scanOriginalTranscripts } from "./transcripts.ts";
import type { UsageReadContext } from "../types.ts";
const timestamp = "2026-10-20T10:00:00.000Z";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
function context(root: string, driver: "claude" | "codex"): UsageReadContext {
  return { instances: [{ instanceId: "fixture", driver, label: "Fixture", enabled: false, revision: 1, config: {}, env: {}, homeDirectory: root, stateDirectory: root }],
    sinceMs: Date.parse("2026-10-20"), untilMs: Date.parse("2026-10-21"), awaitRefresh: true,
    settings: { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false } };
}

test("original Claude dedupe and selected-field projection survive large message bodies without persisting content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "original-transcript-"));
  try {
    if (claudeUsageReader.kind !== "transcripts") throw new Error("Original Claude transcript contract changed.");
    const entry = { type: "assistant", sessionId: "session", timestamp, requestId: "request",
      message: { id: "message", model: "claude-test", content: [{ text: "private-message".repeat(700_000) }], usage: { input_tokens: 11, output_tokens: 4 } } };
    await writeFile(path.join(root, "one.jsonl"), line(entry));
    await writeFile(path.join(root, "copy.jsonl"), line(entry));
    await link(path.join(root, "one.jsonl"), path.join(root, "hardlink.jsonl"));
    const input = context(root, "claude"), cache = new TranscriptCache(path.join(root, "private", "cache.json"));
    const result = await scanOriginalTranscripts(input, { instance: input.instances[0]!, dir: root, provider: "claude", format: claudeUsageReader.format, binding: "a".repeat(64) }, cache);
    assert.equal(result.source.status, "ok"); assert.equal(result.records.length, 1); assert.equal(result.source.distinctSessions, 1);
    assert.equal(result.records[0]?.totals.uncachedInputTokens, 11);
    await cache.flush(); const saved = await readFile(cache.file, "utf8");
    assert.equal(saved.includes("private-message"), false); assert.equal(saved.includes('"content"'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("original shared-session formats dedupe copied files but retain equal independent occurrences within a file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "original-shared-sessions-"));
  try {
    if (codexUsageReader.kind !== "transcripts") throw new Error("Original Codex transcript contract changed.");
    const meta = { type: "session_meta", timestamp, payload: { id: "session", model_provider: "openai" } };
    const turn = { type: "turn_context", payload: { model: "gpt-test", turn_id: "turn" } };
    const event = (total: number) => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 10, output_tokens: 2 }, total_token_usage: { input_tokens: total, output_tokens: total / 5 },
    } } });
    const bytes = [meta, turn, event(10), event(20)].map(line).join("");
    await writeFile(path.join(root, "one.jsonl"), bytes); await writeFile(path.join(root, "two.jsonl"), bytes);
    const input = context(root, "codex");
    const result = await scanOriginalTranscripts(input, { instance: input.instances[0]!, dir: root, provider: "codex", format: codexUsageReader.format, binding: "b".repeat(64) }, new TranscriptCache(path.join(root, "cache.json")));
    assert.equal(result.records.length, 2); assert.notEqual(result.records[0]?.dedupeKey, result.records[1]?.dedupeKey);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a departing transcript waiter cannot cancel shared native reads for other summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "original-usage-cancel-"));
  const release = Promise.withResolvers<void>();
  try {
    if (claudeUsageReader.kind !== "transcripts") throw new Error("Original Claude transcript contract changed.");
    const file = path.join(root, "one.jsonl");
    await writeFile(file, line({ type: "assistant", sessionId: "session", timestamp, message: { id: "message", model: "claude-test", usage: { input_tokens: 3, output_tokens: 2 } } }));
    await mkdir(path.join(root, "private"));
    const info = await stat(root), source = { path: root, volumeId: `${info.dev}:${info.ino}`, binding: "a".repeat(64) };
    const cache = new TranscriptCache(path.join(root, "private", "cache.json"), { concurrency: 1 });
    const entered = Promise.withResolvers<void>();
    const blocker = cache.run("fixture-blocker", async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const controller = new AbortController();
    const leaving = readTranscriptFile(file, "claude", claudeUsageReader.format, controller.signal, { source, cache });
    const staying = readTranscriptFile(file, "claude", claudeUsageReader.format, undefined, { source, cache });
    const rejected = assert.rejects(leaving, /consumer left/); controller.abort(new Error("consumer left")); await rejected;
    release.resolve(); await blocker;
    assert.equal((await staying).records[0]?.totals.uncachedInputTokens, 3);
  } finally { release.resolve(); await rm(root, { recursive: true, force: true }); }
});

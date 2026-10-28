// Fixtures use the native JSONL shapes documented by t3code's MIT usage readers.
import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import type { UsageReadContext } from "../types.ts";
import { scanTranscriptUsage } from "./transcripts.ts";
import { readTranscriptFile } from "./transcript-stream.ts";

const time = "2026-08-01T10:00:00Z";
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
function instance(driver: "codex" | "claude" | "grok" | "pi", homeDirectory: string, id: string = driver): StoredProviderInstance {
  return { driver, instanceId: id, label: id, enabled: false, revision: 1, config: {}, env: {}, homeDirectory };
}
function context(instances: StoredProviderInstance[]): UsageReadContext {
  return { instances, sinceMs: Date.parse("2026-08-01T00:00:00Z"), untilMs: Date.parse("2026-08-02T00:00:00Z"), awaitRefresh: true, settings: { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false } };
}
function counters(input: number, cached: number, write: number, output: number, reasoning: number) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
}
const codexMeta = { type: "session_meta", timestamp: time, payload: { id: "session-1", model_provider: "openai" } };
const codexTurn = { type: "turn_context", timestamp: time, payload: { model: "gpt-test", turn_id: "turn-1" } };
const codexTier = (tier: string) => ({ type: "event_msg", timestamp: time, payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } } });
const codexUsage = (last: unknown, total: unknown, timestamp = time) => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } } });

test("Codex validates cumulative counters, keeps speed and deduplicates moved copies and hard links", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usage-codex-"));
  try {
    const dir = path.join(home, "sessions", "2026"); await mkdir(dir, { recursive: true });
    const first = counters(100, 30, 10, 20, 7), second = counters(50, 5, 0, 10, 3), sum = counters(150, 35, 10, 30, 10);
    const content = [codexMeta, codexTurn, codexTier("priority"), codexUsage(first, first), codexUsage(first, first), codexTier("ultrafast"), codexUsage(second, sum, "2026-08-01T10:01:00Z")].map(line).join("");
    await writeFile(path.join(dir, "first.jsonl"), content); await writeFile(path.join(dir, "moved.jsonl"), content);
    await link(path.join(dir, "first.jsonl"), path.join(dir, "hardlink.jsonl"));
    const [scan] = await scanTranscriptUsage(context([instance("codex", home), instance("codex", home, "disabled-copy")]));
    assert.equal(scan!.source.status, "ok"); assert.deepEqual(scan!.source.instanceIds, ["codex", "disabled-copy"]);
    assert.equal(scan!.records.length, 2);
    assert.deepEqual(scan!.records.map((r) => r.speed), ["fast", "ultrafast"]);
    assert.deepEqual(scan!.records[0]!.totals, { uncachedInputTokens: 60, cachedInputTokens: 30, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 7 });
    assert.equal(scan!.records[0]!.nativeTurnId, "turn-1");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Claude, Grok and Pi read actual usage shapes without counting content or duplicates", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "usage-providers-"));
  try {
    const claude = path.join(base, "claude"), grok = path.join(base, "grok"), pi = path.join(base, "pi");
    await mkdir(path.join(claude, "projects", "work"), { recursive: true }); await mkdir(path.join(grok, "sessions", "one"), { recursive: true }); await mkdir(path.join(pi, ".pi", "agent", "sessions", "work"), { recursive: true });
    const c = { type: "assistant", timestamp: time, sessionId: "claude-session", requestId: "request", message: { id: "message", model: "claude-test", usage: { input_tokens: 8, cache_read_input_tokens: 12, cache_creation_input_tokens: 4, output_tokens: 5, speed: "fast" }, content: [{ type: "text", text: "usage is not a second record" }] } };
    await writeFile(path.join(claude, "projects", "work", "conversation.jsonl"), line(c) + line(c) + line({ ...c, message: { ...c.message, model: "<synthetic>" } }));
    const g = { timestamp: 1785578400, params: { sessionId: "grok-session", _meta: { agentTimestampMs: Date.parse(time) }, update: { sessionUpdate: "turn_completed", prompt_id: "prompt", usage: { costUsdTicks: 10_000_000_000, modelUsage: { "grok-a": { inputTokens: 100, cachedReadTokens: 20, cacheCreationTokens: 10, outputTokens: 10, reasoningTokens: 99, costUsdTicks: 2_000_000_000 }, "grok-b": { inputTokens: 60, outputTokens: 20 } } } } } };
    await writeFile(path.join(grok, "sessions", "one", "updates.jsonl"), line(g) + line(g));
    await writeFile(path.join(grok, "sessions", "one", "events.jsonl"), line(g));
    const p = { type: "message", id: "abc123", timestamp: time, message: { role: "assistant", provider: "openai", model: "requested", responseModel: "actual", usage: { input: 10, cacheRead: 4, cacheWrite: 3, output: 5, reasoning: 9, cost: { total: 0 } }, content: [{ type: "text", text: "private" }] } };
    const piFile = line({ type: "session", id: "pi-session" }) + line(p) + line({ type: "compaction", id: "compact", timestamp: time, usage: { input: 2, output: 1, cost: { total: 0.1 } } });
    await writeFile(path.join(pi, ".pi", "agent", "sessions", "work", "one.jsonl"), piFile);
    await writeFile(path.join(pi, ".pi", "agent", "sessions", "work", "fork.jsonl"), piFile);
    const scans = await scanTranscriptUsage(context([instance("claude", claude), instance("grok", grok), instance("pi", pi)]));
    const cScan = scans.find((s) => s.source.fingerprint.provider === "claude")!, gScan = scans.find((s) => s.source.fingerprint.provider === "grok")!, pScan = scans.find((s) => s.source.fingerprint.provider === "pi")!;
    assert.equal(cScan.records.length, 1); assert.deepEqual(cScan.records[0]!.totals, { uncachedInputTokens: 8, cachedInputTokens: 12, cacheCreationTokens: 4, outputTokens: 5, reasoningTokens: 0 }); assert.equal(cScan.records[0]!.speed, "fast");
    assert.equal(gScan.records.length, 2); assert.equal(gScan.records[0]!.totals.uncachedInputTokens, 70); assert.equal(gScan.records[0]!.totals.reasoningTokens, 10); assert.equal(gScan.records[0]!.reportedCostUsd, 0.2); assert.equal(gScan.records[1]!.reportedCostUsd, 0.8);
    assert.equal(pScan.records.length, 2); const response = pScan.records.find((r) => r.model === "openai/actual")!; assert.equal(response.rateModel, "actual"); assert.equal(response.totals.reasoningTokens, 5); assert.equal(response.reportedCostUsd, null); assert.equal(pScan.records.find((r) => r.model === "Tools/summaries")!.reportedCostUsd, 0.1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("incremental cache replays partial tails and invalidates truncations and rewrites", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usage-incremental-"));
  try {
    const dir = path.join(home, "sessions"); await mkdir(dir); const file = path.join(dir, "rollout.jsonl");
    const first = counters(10, 2, 0, 4, 1), second = counters(20, 5, 0, 6, 2), total = counters(30, 7, 0, 10, 3);
    const secondLine = line(codexUsage(second, total, "2026-08-01T10:01:00Z"));
    await writeFile(file, [codexMeta, codexTurn, codexUsage(first, first)].map(line).join("") + secondLine.slice(0, -5));
    let scan = (await scanTranscriptUsage(context([instance("codex", home)])))[0]!;
    assert.equal(scan.records.length, 1); assert.equal(scan.source.status, "partial"); assert.equal(scan.records[0]!.unresolvedServiceTierTurnId, "turn-1");
    await appendFile(file, secondLine.slice(-5)); scan = (await scanTranscriptUsage(context([instance("codex", home)])))[0]!;
    assert.equal(scan.records.length, 2); assert.equal(scan.source.status, "ok");
    await writeFile(file, [codexMeta, codexTurn, codexUsage(second, second)].map(line).join(""));
    scan = (await scanTranscriptUsage(context([instance("codex", home)])))[0]!; assert.equal(scan.records.length, 1); assert.equal(scan.records[0]!.totals.uncachedInputTokens, 15);
    const rewritten = [codexMeta, codexTurn, codexUsage(counters(30, 5, 0, 6, 2), counters(30, 5, 0, 6, 2))].map(line).join("");
    await writeFile(file, rewritten); scan = (await scanTranscriptUsage(context([instance("codex", home)])))[0]!; assert.equal(scan.records[0]!.totals.uncachedInputTokens, 25);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("corruption, oversized lines, and missing directories are reported without inventing usage", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "usage-partial-"));
  try {
    const root = path.join(base, "claude"); const dir = path.join(root, "projects"); await mkdir(dir, { recursive: true });
    const file = path.join(dir, "bad.jsonl");
    await writeFile(file, '{"type":"assistant","usage":bad}\n' + JSON.stringify({ type: "assistant", message: { usage: { oversized: "x".repeat(8 * 1024 * 1024 + 1) } } }) + "\n");
    const direct = await readTranscriptFile(file, "claude"); assert.equal(direct.malformed, 1); assert.equal(direct.oversized, 1); assert.equal(direct.records.length, 0);
    const scans = await scanTranscriptUsage(context([instance("claude", root), instance("grok", path.join(base, "missing"))]));
    assert.equal(scans[0]!.source.status, "partial"); assert.equal(scans[0]!.source.malformedRecords, 1); assert.equal(scans[1]!.source.status, "missing");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("large native messages project usage without retaining conversation bodies", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usage-projection-"));
  try {
    const dir = path.join(home, "projects"); await mkdir(dir);
    const record = { type: "assistant", timestamp: time, sessionId: "s", requestId: "r", message: { id: "m", model: "claude-projected", content: [{ text: "🙂".repeat(2_100_000) }], usage: { input_tokens: 11, cache_read_input_tokens: 5, output_tokens: 4 } } };
    await writeFile(path.join(dir, "large.jsonl"), line(record));
    const scan = (await scanTranscriptUsage(context([instance("claude", home)])))[0]!;
    assert.equal(scan.source.status, "ok");
    assert.equal(scan.records.length, 1);
    assert.equal(scan.records[0]!.totals.uncachedInputTokens, 11);
    assert.equal(scan.records[0]!.totals.cachedInputTokens, 5);
  } finally { await rm(home, { recursive: true, force: true }); }
});

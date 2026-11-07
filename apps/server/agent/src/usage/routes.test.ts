import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { app } from "../app.ts";
import { closeStore } from "../durable/store.ts";
import { createProviderInstance } from "../providers/instances.ts";
import { ensureThread } from "../durable/threads.ts";
import { recordNativeUsage } from "./ledger.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../providers/t3code/application.ts";
import { makePmProviderFamily } from "../providers/t3code/registration.ts";
import { codexDriver, makeCodexDriverLayer } from "../providers/t3code/families/codex.ts";
import { chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";

test("usage API enforces Agent access without PM connectivity, persists snapshots and validates revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-api-"));
  const oldDir = process.env.AGENT_WORKSPACE_DATA_DIR, oldPm = process.env.PM_API_URL, oldFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_API_URL = "http://127.0.0.1:1";
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("github")) return Response.json({ "fixture-model": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } });
    throw new Error("Unexpected network request");
  };
  const json = (method: string, body: unknown) => ({ method, headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await writeFile(join(directory, "provider-instances.json"), JSON.stringify({ version: 1, instances: [] }));
    ensureThread("usage-thread", undefined, chatOnlyExecutionSelection());
    recordNativeUsage({ generationId: "gen", threadId: "usage-thread", instanceId: "instance", provider: "codex", model: "fixture-model", update: { turn: { totals: { uncachedInputTokens: 7, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 4, reasoningTokens: 1 } }, context: { usedTokens: 11, updatedAt: new Date().toISOString() } } });
    const instance = createProviderInstance({ instanceId: "fixture", driver: "codex", label: "Fixture", enabled: false,
      config: { homePath: join(directory, "native-home"), binaryPath: join(directory, "must-not-start") },
      environment: [{ name: "HOME", value: directory, sensitive: false }] });
    await startPmProviderApplication({ families: new Map([[codexDriver.driverKind, makePmProviderFamily(codexDriver, makeCodexDriverLayer)]]), protocols: new Map() });
    await mkdir(join(instance.homeDirectory, "sessions"), { recursive: true });
    const timestamp = "2026-01-03T12:00:00.000Z";
    const records = [
      { type: "session_meta", timestamp, payload: { id: "native-session" } },
      { type: "turn_context", timestamp, payload: { model: "fixture-model", turn_id: "native-turn" } },
      { type: "event_msg", timestamp, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 15 }, total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 15 } } } },
    ];
    await writeFile(join(instance.homeDirectory, "sessions", "fixture.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const deniedOrigin = await app.request("http://localhost/api/usage/settings", { headers: { host: "localhost", origin: "https://evil.invalid" } });
    assert.equal(deniedOrigin.status, 403);
    const thread = await app.request("http://localhost/api/usage/threads/usage-thread", { headers: { host: "localhost", cookie: "fixture=ok" } });
    assert.equal(thread.status, 200);
    const body = await thread.json() as { totals: { outputTokens: number }; context: { usedTokens: number } };
    assert.equal(body.totals.outputTokens, 4); assert.equal(body.context.usedTokens, 11);
    assert.equal(calls.some((call) => call.includes("/api/v1/")), false);
    assert.equal((await app.request("http://localhost/api/usage/threads/missing-thread", { headers: { host: "localhost" } })).status, 404);
    const updated = await app.request("http://localhost/api/usage/settings", json("PATCH", { revision: 0, usageModelAliases: { alias: "fixture-model" } }));
    assert.equal(updated.status, 200);
    const conflict = await app.request("http://localhost/api/usage/settings", json("PATCH", { revision: 0, usageModelAliases: { other: "model" } }));
    assert.equal(conflict.status, 409);
    const cycle = await app.request("http://localhost/api/usage/settings", json("PATCH", { revision: 1, usageModelAliases: { "fixture-model": "alias" } }));
    assert.equal(cycle.status, 400);
    const summary = await app.request("http://localhost/api/usage/refresh", json("POST", { sinceDay: "2026-01-01", untilDay: "2026-01-07", timeZone: "UTC" }));
    assert.equal(summary.status, 200);
    const usage = await summary.json() as { contractVersion: number; buckets: { totals: { uncachedInputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }; costUsd: number }[] };
    assert.equal(usage.contractVersion, 6);
    assert.equal(usage.buckets.length, 1);
    assert.deepEqual(usage.buckets[0]!.totals, { uncachedInputTokens: 6, cachedInputTokens: 4, cacheCreationTokens: 0, outputTokens: 5, reasoningTokens: 2 });
    assert.ok(usage.buckets[0]!.costUsd > 0);
    const reread = await app.request("http://localhost/api/usage/summary", json("POST", { sinceDay: "2026-01-01", untilDay: "2026-01-07", timeZone: "UTC", instanceIds: [instance.instanceId] }));
    const current = await reread.json() as { sources: { status: string; instanceIds: string[] }[]; buckets: unknown[] };
    assert.equal(current.sources[0]?.status, "ok"); assert.deepEqual(current.sources[0]?.instanceIds, [instance.instanceId]);
    assert.deepEqual(current.buckets, usage.buckets);
    const invalid = await app.request("http://localhost/api/usage/summary", json("POST", { sinceDay: "2026-01-01", untilDay: "2026-01-07", timeZone: "Not/AZone" }));
    assert.equal(invalid.status, 400);
  } finally {
    await stopPmProviderApplication();
    closeStore(); globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldDir;
    if (oldPm === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = oldPm;
    await rm(directory, { recursive: true, force: true });
  }
});

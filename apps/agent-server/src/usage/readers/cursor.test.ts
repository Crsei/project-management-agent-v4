// Cursor Dashboard fixtures adapted from t3code, MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import type { UsageReadContext } from "../types.ts";
import { scanCursorUsage } from "./cursor.ts";

const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;
function instance(id: string, sub: string): StoredProviderInstance { return { instanceId: id, label: id, driver: "cursor", enabled: true, config: {}, env: { CURSOR_AUTH_TOKEN: token(sub) }, revision: 1, homeDirectory: `/fixture/${id}` }; }
function context(instances: StoredProviderInstance[], sinceMs = 0): UsageReadContext { return { instances, sinceMs, untilMs: 1000, awaitRefresh: true, settings: { revision: 0, cursorKeychainUsageEnabled: false, usagePriceOverrides: {}, usageModelAliases: {} } }; }

test("Cursor account events retain actual billed costs and duplicate rows while deduplicating accounts", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cursor-history-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = home;
  t.after(async () => { if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(home, { recursive: true, force: true }); });
  const original = globalThis.fetch; let calls = 0; const secret = token("auth0|history-account");
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(String(url), "https://cursor.com/api/dashboard/get-filtered-usage-events");
    assert.equal(init?.redirect, "error"); assert.match(new Headers(init?.headers).get("cookie") ?? "", /WorkosCursorSessionToken=/);
    const event = { timestamp: "500", model: "cursor-grok-4-fast", conversationId: "conversation", tokenUsage: { inputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2, outputTokens: 3, totalCents: 1.5 } };
    return Response.json({ totalUsageEventsCount: 3, usageEventsDisplay: [event, event, { timestamp: "501", model: "x", conversationId: "ignored" }] });
  };
  try {
    const result = await scanCursorUsage(context([instance("one", "auth0|history-account"), instance("two", "auth0|history-account")]));
    assert.equal(calls, 1); assert.equal(result.length, 1); assert.deepEqual(result[0]!.source.instanceIds, ["one", "two"]);
    assert.equal(result[0]!.records.length, 2); assert.notEqual(result[0]!.records[0]!.dedupeKey, result[0]!.records[1]!.dedupeKey);
    assert.equal(result[0]!.records[0]!.reportedCostUsd, 0.015); assert.equal(result[0]!.records[0]!.rateModel, "xai/grok-4");
    assert.deepEqual(result[0]!.records[0]!.totals, { uncachedInputTokens: 10, cachedInputTokens: 4, cacheCreationTokens: 2, outputTokens: 3, reasoningTokens: 0 });
    assert.ok(!JSON.stringify(result).includes(secret));
    const persisted = await readFile(path.join(home, "cursor-usage-cache.json"), "utf8");
    assert.ok(!persisted.includes(secret)); assert.ok(!persisted.includes("auth0|history-account"));
  } finally { globalThis.fetch = original; }
});

test("Cursor identity rotation cannot reuse another account and stale failed refresh keeps prior data", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cursor-cache-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = home;
  t.after(async () => { if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(home, { recursive: true, force: true }); });
  const original = globalThis.fetch, now = Date.now; let clock = 1_000_000, fail = false;
  Date.now = () => clock;
  globalThis.fetch = async () => fail ? new Response("failure secret", { status: 500 }) : Response.json({ totalUsageEventsCount: 1, usageEventsDisplay: [{ timestamp: 200, model: "fixture", tokenUsage: { outputTokens: 7, totalCents: 3 } }] });
  try {
    const first = await scanCursorUsage(context([instance("rotation", "auth0|old-cache-account")], 1));
    assert.equal(first[0]!.records.length, 1);
    clock += 301_000; fail = true;
    const stale = await scanCursorUsage(context([instance("rotation", "auth0|old-cache-account")], 1));
    assert.equal(stale[0]!.source.status, "partial"); assert.equal(stale[0]!.records.length, 1); assert.ok(!JSON.stringify(stale).includes("failure secret"));
    const rotated = await scanCursorUsage(context([instance("rotation", "auth0|new-cache-account")], 1));
    assert.equal(rotated[0]!.source.status, "failed"); assert.equal(rotated[0]!.records.length, 0);
  } finally { globalThis.fetch = original; Date.now = now; }
});

test("Cursor does not estimate local tokens or expose API-key identities", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cursor-missing-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = home;
  t.after(async () => { if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(home, { recursive: true, force: true }); });
  const api = instance("api", "unused"); api.env = { CURSOR_API_KEY: "secret-api-key" };
  const result = await scanCursorUsage(context([api], 2));
  assert.equal(result[0]!.source.status, "missing"); assert.deepEqual(result[0]!.records, []); assert.ok(!JSON.stringify(result).includes("secret-api-key"));
});

test("Cursor reconciles overlapping page boundaries without dropping identical billed events", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cursor-pages-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR, original = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = home;
  t.after(async () => { globalThis.fetch = original; if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(home, { recursive: true, force: true }); });
  const event = (id: number) => ({ timestamp: id, model: "fixture", conversationId: String(id), tokenUsage: { inputTokens: 1, totalCents: 1 } });
  globalThis.fetch = async (_url, init) => {
    const page = JSON.parse(String(init?.body)).page;
    return Response.json({ totalUsageEventsCount: 1001, usageEventsDisplay: page === 1 ? Array.from({ length: 1000 }, (_, index) => event(index)) : [event(999), event(1000)] });
  };
  const input = context([instance("paged", "auth0|paged-account")], 0); input.untilMs = 2000;
  const result = await scanCursorUsage(input);
  assert.equal(result[0]!.records.length, 1001);
  assert.equal(result[0]!.records.filter((record) => record.timestampMs === 999).length, 1);
});

test("Cursor does not send custom-endpoint credentials to the public Dashboard", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cursor-custom-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR, original = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = home;
  t.after(async () => { globalThis.fetch = original; if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(home, { recursive: true, force: true }); });
  globalThis.fetch = async () => { throw new Error("Unexpected request"); };
  const provider = instance("custom", "auth0|custom-account"); provider.config.apiEndpoint = "https://custom.example";
  const result = await scanCursorUsage(context([provider], 0));
  assert.equal(result[0]!.source.status, "missing"); assert.deepEqual(result[0]!.records, []);
});

test("Linux Cursor login is read only from each explicitly configured home", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-homes-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR, original = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  t.after(async () => { globalThis.fetch = original; if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(root, { recursive: true, force: true }); });
  const signedIn = instance("signed-in", "unused"), missing = instance("missing", "unused");
  signedIn.homeDirectory = path.join(root, "signed-in"); signedIn.env = {};
  missing.homeDirectory = path.join(root, "missing"); missing.env = {};
  await mkdir(path.join(signedIn.homeDirectory, ".config/cursor"), { recursive: true });
  await writeFile(path.join(signedIn.homeDirectory, ".config/cursor/auth.json"), JSON.stringify({ accessToken: token("auth0|isolated-account") }));
  globalThis.fetch = async () => Response.json({ totalUsageEventsCount: 1, usageEventsDisplay: [{ timestamp: 1, model: "fixture", tokenUsage: { inputTokens: 2 } }] });
  const result = await scanCursorUsage(context([signedIn, missing], 0));
  assert.equal(result[0]!.records.length, 1); assert.equal(result[1]!.source.status, "missing"); assert.equal(result[1]!.records.length, 0);
});

test("Cursor rejects credential symlinks escaping an instance home", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-escape-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR, original = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  t.after(async () => { globalThis.fetch = original; if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(root, { recursive: true, force: true }); });
  const provider = instance("escape", "unused"); provider.homeDirectory = path.join(root, "home"); provider.env = { AGENT_CLI_CREDENTIAL_STORE: "file" };
  const directory = process.platform === "darwin" ? path.join(provider.homeDirectory, ".cursor") : path.join(provider.homeDirectory, ".config/cursor");
  await mkdir(directory, { recursive: true }); await writeFile(path.join(root, "outside.json"), JSON.stringify({ accessToken: token("auth0|outside") }));
  await symlink(path.join(root, "outside.json"), path.join(directory, "auth.json"));
  globalThis.fetch = async () => { throw new Error("External credential was used"); };
  const result = await scanCursorUsage(context([provider], 0));
  assert.equal(result[0]!.source.status, "failed"); assert.equal(result[0]!.records.length, 0);
});

test("Another login for the same account can recover when the first credential fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-retry-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR, original = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  t.after(async () => { globalThis.fetch = original; if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(root, { recursive: true, force: true }); });
  const first = instance("expired", "auth0|shared-account"), second = instance("valid", "auth0|shared-account");
  first.env.CURSOR_AUTH_TOKEN += "-expired"; let attempts = 0;
  globalThis.fetch = async () => ++attempts === 1 ? new Response("", { status: 401 }) : Response.json({ totalUsageEventsCount: 1, usageEventsDisplay: [{ timestamp: 1, model: "fixture", tokenUsage: { outputTokens: 1 } }] });
  const result = await scanCursorUsage(context([first, second], 0));
  assert.equal(attempts, 2); assert.equal(result.length, 1); assert.deepEqual(result[0]!.source.instanceIds, ["expired", "valid"]); assert.equal(result[0]!.records.length, 1);
});

test("A persisted stale account snapshot survives a failed refresh without leaking credentials", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-persisted-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR, original = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  t.after(async () => { globalThis.fetch = original; if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(root, { recursive: true, force: true }); });
  const sub = "auth0|persisted-account", account = createHash("sha256").update(sub).digest("hex");
  await writeFile(path.join(root, "cursor-usage-cache.json"), JSON.stringify([{ key: `${account}:0:1000`, fetchedAt: Date.now() - 301_000, records: [{ provider: "cursor", timestampMs: 1, model: "fixture", sessionId: "session", totals: { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 }, reportedCostUsd: 0.02, speed: "standard", dedupeKey: `cursor-account:${account}:row:0` }] }]));
  globalThis.fetch = async () => new Response("", { status: 503 });
  const result = await scanCursorUsage(context([instance("persisted", sub)]));
  assert.equal(result[0]!.source.status, "partial"); assert.equal(result[0]!.records[0]!.reportedCostUsd, 0.02);
  assert.ok(!JSON.stringify(result).includes(token(sub)));
});

// Provider quota fixtures adapted from t3code, MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { StoredProviderInstance } from "../../providers/instances.ts";
import { probeOtherUsageLimits } from "./other.ts";

function instance(driver: StoredProviderInstance["driver"], home: string): StoredProviderInstance { return { instanceId: driver, label: driver, driver, enabled: true, config: {}, env: {}, revision: 1, homeDirectory: home }; }
const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;

test("Cursor quota uses Dashboard percentages and never returns auth secrets", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cursor-quota-")), oldData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = home;
  t.after(async () => { if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(home, { recursive: true, force: true }); });
  const original = globalThis.fetch, access = token("auth0|cursor-quota-fixture");
  const cursor = instance("cursor", home); cursor.env.CURSOR_AUTH_TOKEN = access;
  globalThis.fetch = async (url, init) => { assert.equal(String(url), "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"); assert.equal(init?.redirect, "error"); return Response.json({ billingCycleEnd: "1791763200000", planUsage: { totalPercentUsed: 75, autoPercentUsed: 110, apiPercentUsed: -1 } }); };
  try {
    const result = await probeOtherUsageLimits(cursor);
    assert.deepEqual(result.windows.map((w) => w.usedPercent), [75, 100, 0]); assert.ok(result.windows.every((w) => w.resetsAt));
    assert.ok(result.credentialFingerprint); assert.ok(!JSON.stringify(result).includes(access));
    assert.deepEqual(result.account, { id: "cursor-quota-fixture" });
    cursor.env = { CURSOR_API_KEY: "private-key" }; assert.equal((await probeOtherUsageLimits(cursor)).unavailable?.reason, "unsupported");
  } finally { globalThis.fetch = original; }
});

test("OpenCode Go reads its isolated auth and distinguishes remote, forbidden and failure", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-opencode-")); const original = globalThis.fetch;
  const provider = instance("opencode", home); const secret = "fixture-go-secret";
  try {
    await mkdir(path.join(home, ".local/share/opencode"), { recursive: true });
    await writeFile(path.join(home, ".local/share/opencode/auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: secret } }));
    globalThis.fetch = async (url, init) => { assert.equal(String(url), "https://opencode.ai/zen/go/v1/usage"); assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`); return Response.json({ usage: { rolling: { percent: 20, resetsAt: "2026-01-01T00:00:00Z" }, weekly: { percent: 40, resetsAt: "2026-01-02T00:00:00Z" }, monthly: { percent: 60, resetsAt: "2026-01-03T00:00:00Z" } } }); };
    const result = await probeOtherUsageLimits(provider); assert.deepEqual(result.windows.map((w) => w.id), ["go_rolling", "go_weekly", "go_monthly"]); assert.ok(!JSON.stringify(result).includes(secret));
    provider.config.serverUrl = "http://127.0.0.1:1"; assert.equal((await probeOtherUsageLimits(provider)).unavailable?.reason, "unsupported");
    provider.config.serverUrl = ""; globalThis.fetch = async () => new Response("private upstream", { status: 403 }); assert.equal((await probeOtherUsageLimits(provider)).unavailable?.reason, "unsupported");
    globalThis.fetch = async () => new Response("private upstream", { status: 500 }); const failure = await probeOtherUsageLimits(provider); assert.equal(failure.unavailable?.reason, "probeFailed"); assert.ok(!JSON.stringify(failure).includes("private upstream"));
  } finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }); }
});

test("OpenCode selects the active Console identity before fallback to Go", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-console-")), original = globalThis.fetch;
  const root = path.join(home, ".local/share/opencode"), requests: string[] = [];
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "go-fixture" } }));
    const db = new DatabaseSync(path.join(root, "opencode.db"));
    try {
      db.exec("CREATE TABLE credential (id TEXT, integration_id TEXT, active INTEGER, time_created INTEGER, value TEXT)");
      const insert = db.prepare("INSERT INTO credential VALUES (?, 'opencode', ?, ?, ?)");
      insert.run("old", 0, 2, JSON.stringify({ type: "key", key: "inactive-fixture" }));
      insert.run("selected", 1, 1, JSON.stringify({ type: "key", key: "console-fixture", metadata: { server: "https://opencode.ai/console" } }));
    } finally { db.close(); }
    globalThis.fetch = async (_url, init) => {
      const key = new Headers(init?.headers).get("authorization") ?? ""; requests.push(key);
      if (key === "Bearer console-fixture") return new Response("", { status: 403 });
      const window = { percent: 10, resetsAt: "2026-01-01T00:00:00Z" };
      return Response.json({ usage: { rolling: window, weekly: window, monthly: window } });
    };
    const result = await probeOtherUsageLimits(instance("opencode", home));
    assert.deepEqual(requests, ["Bearer console-fixture", "Bearer go-fixture"]); assert.equal(result.windows.length, 3);
    assert.ok(!JSON.stringify(result).includes("fixture"));
  } finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }); }
});

test("Antigravity OAuth merges real endpoint quota buckets and account identity", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-antigravity-")); const original = globalThis.fetch;
  try {
    await mkdir(path.join(home, "antigravity-acp"), { recursive: true });
    await writeFile(path.join(home, "antigravity-acp/acp_token.json"), JSON.stringify({ client_id: "client", client_secret: "fixture-secret", refresh_token: "fixture-refresh", project_id: "project" }));
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.redirect, "error"); const value = String(url);
      if (value.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-access", expires_in: 3600 });
      if (value.includes("userinfo")) return Response.json({ id: "account", email: "person@example.test" });
      if (value.includes("retrieveUserQuotaSummary")) return Response.json({ groups: [{ buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: value.includes("daily-") ? 0.8 : 0.3, resetTime: "2026-01-01T00:00:00Z" }, { bucketId: "3p-5h", window: "5h", remainingFraction: 0.5 }] }] });
      throw new Error("Unexpected fixture request");
    };
    const provider = instance("antigravity", home), result = await probeOtherUsageLimits(provider);
    assert.equal(result.windows.length, 2); assert.equal(result.windows.find((w) => w.id === "gemini-weekly")!.usedPercent, 70); assert.equal(result.windows.find((w) => w.id === "3p-5h")!.windowDurationMins, 300);
    assert.ok(result.credentialFingerprint); assert.ok(!JSON.stringify(result).includes("fixture-"));
    assert.deepEqual(result.account, { id: "account", email: "person@example.test" });
    provider.config.authMethod = "gemini-api-key"; assert.equal((await probeOtherUsageLimits(provider)).unavailable?.reason, "unsupported");
  } finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }); }
});

test("Antigravity falls back to legacy model quotas without inventing reset cadence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-model-quota-")), original = globalThis.fetch;
  try {
    await mkdir(path.join(home, "antigravity-acp"), { recursive: true });
    await writeFile(path.join(home, "antigravity-acp/acp_token.json"), JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh" }));
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("/token")) return Response.json({ access_token: "access", expires_in: 3600 });
      if (value.includes("userinfo")) return Response.json({ id: "account" });
      if (value.includes("retrieveUserQuotaSummary")) return Response.json({ groups: [] });
      if (value.includes("fetchAvailableModels")) return Response.json({ models: { "gemini-one": { quotaInfo: { remainingFraction: 0.8 } }, "gemini-two": { quotaInfo: { remainingFraction: 0.2 }, weeklyQuotaInfo: { remainingFraction: 0.7 } } } });
      throw new Error("Unexpected fixture request");
    };
    const result = await probeOtherUsageLimits(instance("antigravity", home));
    const quota = result.windows.find((window) => window.id === "gemini-quota")!;
    assert.equal(quota.usedPercent, 80); assert.equal(quota.kind, "other"); assert.equal(quota.windowDurationMins, undefined);
    assert.equal(result.windows.find((window) => window.id === "gemini-weekly")!.windowDurationMins, 10080);
  } finally { globalThis.fetch = original; await rm(home, { recursive: true, force: true }); }
});

test("Muse and unsupported providers do not fabricate probe windows", async () => {
  for (const driver of ["muse", "pi", "acpRegistry"] as const) { const result = await probeOtherUsageLimits(instance(driver, "/fixture")); assert.equal(result.unavailable?.reason, "unsupported"); assert.deepEqual(result.windows, []); }
});

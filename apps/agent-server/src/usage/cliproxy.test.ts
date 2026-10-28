// Adapted from t3code cliproxyApi.test.ts; Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import test from "node:test";
import { readHubAccounts, consumeHubCredit } from "./cliproxy.ts";
import type { StoredUsageSource } from "./hubs.ts";

test("Claude OAuth windows and failed hub accounts use the built-in management protocol", async () => {
  const source: StoredUsageSource = { id: "hub", kind: "cliproxy", label: "Hub", url: "https://hub.test/prefix", enabled: true, revision: 1, managementKey: "secret" };
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    if (String(url).endsWith("auth-files")) return Response.json({ files: [{ id: "claude", auth_index: "c", provider: "claude", email: "person@example.test" }, { id: "broken", auth_index: "b", provider: "codex" }] });
    const body = JSON.parse(String(init?.body)) as { auth_index: string; url: string; header: Record<string, string> };
    assert.equal(body.header.Authorization, "Bearer $TOKEN$");
    if (body.auth_index === "b") return Response.json({ status_code: 401, body: '{"credential":"private-error"}' });
    assert.equal(body.url, "https://api.anthropic.com/api/oauth/usage"); assert.match(body.header["User-Agent"]!, /^claude-code\//);
    return Response.json({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" }, limits: [{ kind: "weekly_scoped", percent: 80, scope: { model: { display_name: "Fable" } } }] }) });
  };
  try {
    const accounts = await readHubAccounts(source);
    assert.deepEqual(accounts[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]), [["five_hour", 10], ["seven_day", 50], ["seven_day_fable", 80]]);
    assert.equal(accounts[1]?.usageLimits.unavailable?.reason, "probeFailed");
    assert.equal(JSON.stringify(accounts).includes("private-error"), false);
    const before = calls; await assert.rejects(consumeHubCredit(source, "claude", "credit"), /missing or disabled/); assert.equal(calls, before + 1);
  } finally { globalThis.fetch = original; }
});

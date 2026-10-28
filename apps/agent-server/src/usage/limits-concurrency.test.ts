import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUsageSource } from "./hubs.ts";
import { consumeUsageReset, refreshUsageLimits } from "./limits.ts";

test("refreshes serialize and a concurrent duplicate credit reset cannot issue a second request", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-concurrency-"));
  const oldRoot = process.env.AGENT_WORKSPACE_DATA_DIR; const oldFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  writeFileSync(path.join(root, "provider-instances.json"), JSON.stringify({ version: 1, instances: [] }));
  const refreshEntered = Promise.withResolvers<void>(), releaseRefresh = Promise.withResolvers<void>(), resetEntered = Promise.withResolvers<void>(), releaseReset = Promise.withResolvers<void>();
  let firstAuth = true, authCalls = 0, redemptions = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url); const body = init?.body ? JSON.parse(String(init.body)) as { url?: string } : undefined;
    if (target.endsWith("auth-files")) {
      authCalls++;
      if (firstAuth) { firstAuth = false; refreshEntered.resolve(); await releaseRefresh.promise; }
      return Response.json({ files: [{ id: "one", auth_index: "a", provider: "codex", id_token: { chatgpt_account_id: "account" } }] });
    }
    if (target.endsWith("reset-quota")) return Response.json({});
    if (body?.url?.endsWith("/consume")) { redemptions++; resetEntered.resolve(); await releaseReset.promise; return Response.json({ status_code: 200, body: '{"code":"reset"}' }); }
    if (body?.url?.endsWith("rate-limit-reset-credits")) return Response.json({ status_code: 200, body: JSON.stringify({ credits: [{ id: "credit", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" }] }) });
    return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 } } }) });
  };
  try {
    createUsageSource({ kind: "cliproxy", label: "Hub", url: "http://localhost:1234", enabled: true, managementKey: "fixture" });
    const first = refreshUsageLimits(); await refreshEntered.promise;
    const second = refreshUsageLimits(); assert.equal(authCalls, 1);
    releaseRefresh.resolve(); await first; const report = await second; assert.equal(authCalls, 2);
    const input = report.accounts[0]!.resetCreditInput!; assert.ok("sourceId" in input);
    const reset = consumeUsageReset(input); await resetEntered.promise;
    await assert.rejects(consumeUsageReset(input), /already in progress/);
    assert.equal(redemptions, 1); releaseReset.resolve(); assert.deepEqual(await reset, { outcome: "reset" });
  } finally { globalThis.fetch = oldFetch; if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot; rmSync(root, { recursive: true, force: true }); }
});

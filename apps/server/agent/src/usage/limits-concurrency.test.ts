import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUsageSource, updateUsageSource } from "./hubs.ts";
import { consumeUsageReset, getUsageLimitsReport, refreshUsageLimits } from "./limits.ts";
import { closeStore } from "../durable/store.ts";

test("concurrent refreshes share work, caller cancellation is independent, and duplicate credit resets cannot dispatch twice", async () => {
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
    const controller = new AbortController();
    const first = refreshUsageLimits(undefined, controller.signal); await refreshEntered.promise;
    const second = refreshUsageLimits(); assert.equal(authCalls, 1);
    const departed = assert.rejects(first, /consumer left/); controller.abort(new Error("consumer left")); await departed;
    releaseRefresh.resolve(); const report = await second; assert.equal(authCalls, 1);
    const input = report.accounts[0]!.resetCreditInput!; assert.ok("sourceId" in input);
    const reset = consumeUsageReset(input); await resetEntered.promise;
    await assert.rejects(consumeUsageReset(input), /already in progress/);
    assert.equal(redemptions, 1); releaseReset.resolve(); assert.deepEqual(await reset, { outcome: "reset" });
  } finally { releaseRefresh.resolve(); releaseReset.resolve(); closeStore(); globalThis.fetch = oldFetch; if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot; rmSync(root, { recursive: true, force: true }); }
});

test("a paused hub refresh and reset share one queue, and reset publishes its post-action reread", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-hub-order-"));
  const oldRoot = process.env.AGENT_WORKSPACE_DATA_DIR, oldFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  writeFileSync(path.join(root, "provider-instances.json"), JSON.stringify({ version: 1, instances: [] }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let pause = false, redeemed = false, redemptions = 0, readsAfterReset = 0;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { url?: string } : undefined;
    if (String(url).endsWith("auth-files")) {
      if (pause) { pause = false; entered.resolve(); await release.promise; }
      if (redeemed) readsAfterReset++;
      return Response.json({ files: [{ id: "one", auth_index: "a", provider: "codex", id_token: { chatgpt_account_id: "account" } }] });
    }
    if (String(url).endsWith("reset-quota")) return Response.json({});
    if (body?.url?.endsWith("/consume")) { redemptions++; redeemed = true; return Response.json({ status_code: 200, body: '{"code":"reset"}' }); }
    if (body?.url?.endsWith("rate-limit-reset-credits")) return Response.json({ status_code: 200, body: JSON.stringify({ credits: redeemed ? [] : [{ id: "credit", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" }] }) });
    return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: redeemed ? 0 : 80 } } }) });
  };
  try {
    createUsageSource({ kind: "cliproxy", label: "Hub", url: "http://localhost:1234", enabled: true, managementKey: "fixture" });
    const baseline = await refreshUsageLimits(), input = baseline.accounts[0]!.resetCreditInput!;
    pause = true;
    const staleRefresh = refreshUsageLimits(); await entered.promise;
    const reset = consumeUsageReset(input);
    assert.equal(redemptions, 0);
    release.resolve(); await staleRefresh;
    assert.deepEqual(await reset, { outcome: "reset" });
    assert.equal(redemptions, 1); assert.equal(readsAfterReset, 1);
    const latest = getUsageLimitsReport().accounts[0]!;
    assert.equal(latest.limits.windows[0]?.usedPercent, 0);
    assert.equal(latest.limits.resetCredits?.availableCount, 0);
    assert.equal(latest.resetCreditInput, undefined);
  } finally { release.resolve(); closeStore(); globalThis.fetch = oldFetch; if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot; rmSync(root, { recursive: true, force: true }); }
});

test("confirmed redemption with a failed reread is not an unknown action and cannot silently reuse a credit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-hub-confirmed-"));
  const oldRoot = process.env.AGENT_WORKSPACE_DATA_DIR, oldFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  writeFileSync(path.join(root, "provider-instances.json"), JSON.stringify({ version: 1, instances: [] }));
  let redeemed = false, redemptions = 0;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { url?: string } : undefined;
    if (String(url).endsWith("auth-files")) return redeemed ? new Response("", { status: 503 }) : Response.json({ files: [{ id: "one", auth_index: "a", provider: "codex", id_token: { chatgpt_account_id: "account" } }] });
    if (String(url).endsWith("reset-quota")) return Response.json({});
    if (body?.url?.endsWith("/consume")) { redemptions++; redeemed = true; return Response.json({ status_code: 200, body: '{"code":"reset"}' }); }
    if (body?.url?.endsWith("rate-limit-reset-credits")) return Response.json({ status_code: 200, body: JSON.stringify({ credits: [{ id: "credit", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" }] }) });
    return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 80 } } }) });
  };
  try {
    createUsageSource({ kind: "cliproxy", label: "Hub", url: "http://localhost:1234", enabled: true, managementKey: "fixture" });
    const baseline = await refreshUsageLimits(), input = baseline.accounts[0]!.resetCreditInput!;
    const result = await consumeUsageReset(input);
    assert.equal(result.outcome, "reset"); assert.match(result.warning!, /action confirmed.*snapshot could not be confirmed/i);
    const latest = getUsageLimitsReport().accounts[0]!;
    assert.equal(latest.limits.checkedAt, baseline.accounts[0]!.limits.checkedAt);
    assert.equal(latest.limits.unavailable?.reason, "probeFailed");
    assert.equal(latest.limits.windows[0]?.usedPercent, 80);
    assert.equal(latest.resetCreditInput, undefined);
    await assert.rejects(consumeUsageReset(input), /no longer current/);
    assert.equal(redemptions, 1);
  } finally { closeStore(); globalThis.fetch = oldFetch; if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot; rmSync(root, { recursive: true, force: true }); }
});


test("hub account changes before a redemption and source revisions during a refresh are fenced", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-hub-fence-"));
  const oldRoot = process.env.AGENT_WORKSPACE_DATA_DIR, oldFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  writeFileSync(path.join(root, "provider-instances.json"), JSON.stringify({ version: 1, instances: [] }));
  let workspace = "original", pause = false, redemptions = 0;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { url?: string } : undefined;
    if (String(url).endsWith("auth-files")) {
      if (pause) { entered.resolve(); await release.promise; }
      return Response.json({ files: [{ id: "one", auth_index: "a", provider: "codex", id_token: { chatgpt_account_id: workspace } }] });
    }
    if (body?.url?.endsWith("/consume")) { redemptions++; return Response.json({ status_code: 200, body: '{"code":"reset"}' }); }
    if (body?.url?.endsWith("rate-limit-reset-credits")) return Response.json({ status_code: 200, body: JSON.stringify({ credits: [{ id: "credit", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" }] }) });
    return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 80 } } }) });
  };
  try {
    const config = { kind: "cliproxy" as const, label: "Hub", url: "http://localhost:1234", enabled: true, managementKey: "fixture" };
    const source = createUsageSource(config), baseline = await refreshUsageLimits();
    workspace = "different";
    await assert.rejects(consumeUsageReset(baseline.accounts[0]!.resetCreditInput!), /account changed/);
    assert.equal(redemptions, 0);
    pause = true;
    const refresh = refreshUsageLimits(); await entered.promise;
    updateUsageSource(source.id, { ...config, label: "Changed Hub", revision: source.revision });
    release.resolve(); await refresh;
    assert.deepEqual(getUsageLimitsReport().accounts, []);
  } finally { release.resolve(); closeStore(); globalThis.fetch = oldFetch; if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot; rmSync(root, { recursive: true, force: true }); }
});

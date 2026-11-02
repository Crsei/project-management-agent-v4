// Adapted from t3code cliproxyApi.test.ts; Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUsageSource, deleteUsageSource, listUsageSources, updateUsageSource } from "./hubs.ts";
import { consumeUsageReset, getUsageLimitsReport, ingestUsageLimits, refreshUsageLimits } from "./limits.ts";
import { creditRedeemRequestId } from "./cliproxy.ts";
import { closeStore } from "../durable/store.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../providers/t3code/application.ts";
import { makePmProviderFamily } from "../providers/t3code/registration.ts";
import { piDriver, makePiDriverLayer } from "../providers/t3code/families/pi.ts";
import { museDriver, makeMuseDriverLayer } from "../providers/t3code/families/muse.ts";
import { ompDriver, makeOmpDriverLayer } from "../providers/t3code/families/omp.ts";

test("hub configuration, account snapshots, sparse windows, failed probes and pinned credit redemption", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-hub-"));
  const oldRoot = process.env.AGENT_WORKSPACE_DATA_DIR; const originalFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  writeFileSync(path.join(root, "provider-instances.json"), JSON.stringify({ version: 1, instances: [] }));
  let mode: "normal" | "sparse" | "failure" | "consume-failure" = "normal";
  const calls: { path: string; body?: { url?: string; data?: string; auth_index?: string } }[] = [];
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url)); const body = init?.body ? JSON.parse(String(init.body)) as { url?: string; data?: string; auth_index?: string } : undefined;
    assert.equal(target.hostname, "localhost"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
    calls.push({ path: target.pathname, body });
    if (target.pathname.endsWith("auth-files")) {
      if (mode === "failure") return Response.json({ secret: "must-not-publish" }, { status: 503 });
      return Response.json({ files: [{ id: "a.json", auth_index: "a", provider: "codex", email: "user@example.com", id_token: { chatgpt_account_id: "account-a" } }, { id: "b.json", auth_index: "b", provider: "codex", id_token: { chatgpt_account_id: "account-a" } }, { id: "disabled", auth_index: "c", provider: "codex", disabled: true }] });
    }
    if (target.pathname.endsWith("reset-quota")) return Response.json({});
    if (body?.url?.endsWith("/consume")) return Response.json({ status_code: mode === "consume-failure" ? 503 : 200, body: JSON.stringify({ code: "reset" }) });
    if (body?.url?.endsWith("rate-limit-reset-credits")) return Response.json({ status_code: 200, body: JSON.stringify({ credits: [{ id: "late", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-02-01T00:00:00Z" }, { id: "first", status: "available", reset_type: "codex_rate_limits", expires_at: "2099-01-01T00:00:00Z" }, { id: "expired", status: "available", reset_type: "codex_rate_limits", expires_at: "2000-01-01T00:00:00Z" }] }) });
    const rate_limit = mode === "sparse" ? { secondary_window: { used_percent: 78, limit_window_seconds: 604800 } } : { primary_window: { used_percent: 12, reset_at: 4070908800 }, secondary_window: { used_percent: 44, reset_at: 1 } };
    return Response.json({ status_code: 200, body: JSON.stringify({ plan_type: "pro", rate_limit }) });
  };
  try {
    assert.throws(() => createUsageSource({ kind: "cliproxy", label: "bad", url: "http://example.com", enabled: true, managementKey: "x" }));
    assert.throws(() => createUsageSource({ kind: "cliproxy", label: "bad", url: "https://user:pass@example.com", enabled: true, managementKey: "x" }));
    const input = { kind: "cliproxy" as const, label: "Fixture", url: "http://localhost:8317/prefix", enabled: true, managementKey: "fixture-key" };
    let source = createUsageSource(input);
    assert.equal(statSync(path.join(root, "usage-sources.json")).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(listUsageSources()).includes("fixture-key"), false);
    assert.equal(source.managementKeyConfigured, true);
    assert.throws(() => updateUsageSource(source.id, { ...input, revision: 0 }), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    source = updateUsageSource(source.id, { ...input, managementKey: undefined, revision: source.revision });
    assert.equal(JSON.parse(readFileSync(path.join(root, "usage-sources.json"), "utf8")).sources[0].managementKey, "fixture-key");
    assert.equal(getUsageLimitsReport().accounts.length, 0); assert.equal(calls.length, 0);
    let report = await refreshUsageLimits();
    assert.equal(report.accounts.length, 1); // Same account ID, not two subscriptions.
    assert.deepEqual(report.accounts[0]?.limits.windows.map((window) => window.id), ["primary", "secondary"]);
    assert.equal(report.accounts[0]?.limits.resetCredits?.nextCreditId, "first");
    assert.equal(report.accounts[0]?.limits.account?.workspaceId, "account-a");
    assert.equal(report.accounts[0]?.plan, "ChatGPT Pro Subscription");
    assert.ok(calls.every((call) => call.path.startsWith("/prefix/v0/management/")));
    mode = "sparse"; report = await refreshUsageLimits();
    assert.deepEqual(report.accounts[0]?.limits.windows.map((window) => [window.id, window.usedPercent]), [["secondary", 78]]); // A complete probe replaces omitted windows.
    const inputReset = report.accounts[0]!.resetCreditInput!;
    assert.ok("creditId" in inputReset && inputReset.creditId === "first");
    assert.equal(creditRedeemRequestId("account-b", "credit-b"), "519d5243-011a-5b7b-91f3-44d85f095705");
    if (!("creditId" in inputReset)) throw new Error("missing pinned hub credit");
    await assert.rejects(consumeUsageReset({ ...inputReset, creditId: "other" }), /no longer current/);
    mode = "consume-failure"; const before = calls.length;
    await assert.rejects(consumeUsageReset(inputReset));
    assert.equal(calls.slice(before).filter((call) => call.body?.url?.endsWith("/consume")).length, 1);
    mode = "normal"; assert.deepEqual(await consumeUsageReset(inputReset), { outcome: "reset" });
    const redemptions = calls.filter((call) => call.body?.url?.endsWith("/consume"));
    assert.equal(redemptions[0]?.body?.data, redemptions[1]?.body?.data);
    assert.equal(JSON.parse(redemptions[0]!.body!.data!).credit_id, "first");
    mode = "failure"; report = await refreshUsageLimits();
    assert.equal(report.accounts[0]?.limits.unavailable?.reason, "probeFailed");
    assert.equal(report.accounts[0]?.limits.lastProbeAt !== undefined, true);
    assert.deepEqual(report.accounts[0]?.limits.windows.map((window) => window.id), ["primary"]); // expired secondary is not reused
    assert.equal(JSON.stringify(report).includes("must-not-publish"), false);
    assert.equal(report.notices.length, 1);
    source = updateUsageSource(source.id, { ...input, enabled: false, clearManagementKey: true, managementKey: undefined, revision: source.revision });
    assert.equal(source.managementKeyConfigured, false);
    assert.equal(getUsageLimitsReport().accounts.length, 0);
    assert.throws(() => deleteUsageSource(source.id, source.revision - 1));
    deleteUsageSource(source.id, source.revision); assert.deepEqual(listUsageSources(), []);
  } finally { closeStore(); globalThis.fetch = originalFetch; if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot; rmSync(root, { recursive: true, force: true }); }
});

test("runtime sparse updates merge per instance and an unsupported probe clears old windows", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-ingest-")); const oldRoot = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  writeFileSync(path.join(root, "provider-instances.json"), JSON.stringify({ version: 1, instances: [
    { instanceId: "pi-a", driver: "pi", label: "Pi", enabled: true, revision: 1 },
    { instanceId: "muse-a", driver: "muse", label: "Muse", enabled: true, revision: 1 },
    { instanceId: "omp-a", driver: "omp", label: "OMP", enabled: true, revision: 1 },
    { instanceId: "pi-disabled", driver: "pi", label: "Disabled Pi", enabled: false, revision: 1 },
  ].map(instance => ({ ...instance, env: { HOME: root }, config: { binaryPath: path.join(root, "missing-native-binary") } })) }));
  try {
    await startPmProviderApplication({ families: new Map([
      [piDriver.driverKind, makePmProviderFamily(piDriver, makePiDriverLayer)],
      [museDriver.driverKind, makePmProviderFamily(museDriver, makeMuseDriverLayer)],
      [ompDriver.driverKind, makePmProviderFamily(ompDriver, makeOmpDriverLayer)],
    ]), protocols: new Map() });
    const unprobed = getUsageLimitsReport();
    assert.deepEqual(unprobed.accounts, []);
    assert.ok(unprobed.notices.some((notice) => notice.includes("Pi: usage limits have not yet been checked")));
    assert.ok(unprobed.notices.some((notice) => notice.includes("Disabled Pi: disabled; usage limits have not yet been checked")));
    assert.equal(JSON.stringify(unprobed).includes("1970-01-01"), false);
    ingestUsageLimits("pi-a", { windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 10, resetsAt: "2099-01-01T00:00:00Z" }] });
    ingestUsageLimits("pi-a", { windows: [{ id: "week", kind: "weekly", label: "Weekly", usedPercent: 20 }, { id: "session", kind: "session", label: "Session", usedPercent: 30 }] });
    let limits = getUsageLimitsReport().accounts.find((a) => a.instanceId === "pi-a")!.limits;
    assert.equal(limits.windows.length, 2); assert.equal(limits.windows[0]?.resetsAt, "2099-01-01T00:00:00Z");
    assert.equal(limits.unavailable?.reason, "probeFailed"); // Sparse telemetry does not independently verify the account.
    limits = (await refreshUsageLimits(["pi-a"])).accounts.find((a) => a.instanceId === "pi-a")!.limits;
    assert.equal(limits.unavailable?.reason, "unsupported"); assert.deepEqual(limits.windows, []);
    ingestUsageLimits("pi-a", { windows: [{ id: "new", kind: "other", label: "Native", usedPercent: 17 }] });
    limits = getUsageLimitsReport().accounts.find((a) => a.instanceId === "pi-a")!.limits;
    assert.equal(limits.unavailable?.reason, "unsupported"); assert.deepEqual(limits.windows, []);
    const omp = (await refreshUsageLimits(["omp-a"])).accounts.find(account => account.instanceId === "omp-a")!;
    assert.equal(omp.driver, "omp");
    assert.equal(omp.limits.unavailable?.reason, "unsupported");
    assert.deepEqual(omp.limits.windows, []);
    assert.equal(omp.resetCreditInput, undefined);
    ingestUsageLimits("omp-a", { windows: [{ id: "invented-quota", kind: "weekly", label: "Unavailable", usedPercent: 42 }] });
    assert.deepEqual(getUsageLimitsReport().accounts.find(account => account.instanceId === "omp-a")!.limits.windows, []);
    await refreshUsageLimits(["muse-a"]);
    ingestUsageLimits("muse-a", { windows: [{ id: "week", kind: "weekly", label: "Weekly", usedPercent: 42 }] });
    const muse = (await refreshUsageLimits(["muse-a"])).accounts.find((a) => a.instanceId === "muse-a")!.limits;
    assert.equal(muse.unavailable, undefined); assert.equal(muse.windows[0]?.usedPercent, 42);
  } finally { await stopPmProviderApplication(); closeStore(); if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot; rmSync(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkProviderConnection } from "./checks.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "./instances.ts";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import type { ProviderDriverStatus } from "./driver-adapter.ts";

async function isolated(use: (id: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "provider-check-boundary-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try { createProviderInstance({ instanceId: "external-open-code", driver: "opencode" }); await use("external-open-code"); }
  finally { if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous; await rm(directory, { recursive: true, force: true }); }
}
const ready: ProviderDriverStatus = { installation: { status: "installed" }, authentication: "unknown", nativeSessionReady: true, models: [], methods: [], canLogout: false };
test("external native readiness does not manufacture authenticated identity", async () => isolated(async id => {
  const adapter = getNativeProviderAdapter("opencode")!;
  const previous = adapter.check;
  adapter.check = async () => ready;
  try {
    const result = await checkProviderConnection(id);
    assert.equal(result.ok, true); assert.equal(result.authentication, "unknown");
    assert.equal(result.nativeSessionReady, true);
  } finally { adapter.check = previous; }
}));
test("native readiness failure is not overridden by an authenticated account", async () => isolated(async id => {
  const adapter = getNativeProviderAdapter("opencode")!;
  const previous = adapter.check;
  adapter.check = async () => ({ ...ready, authentication: "authenticated", nativeSessionReady: false });
  try {
    const result = await checkProviderConnection(id);
    assert.equal(result.ok, false);
    assert.equal(result.authentication, "authenticated");
    assert.equal(result.nativeSessionReady, false);
  } finally { adapter.check = previous; }
}));
test("an authenticated identity without a runtime observation remains unchecked", async () => isolated(async id => {
  const adapter = getNativeProviderAdapter("opencode")!;
  const previous = adapter.check;
  adapter.check = async () => ({ installation: { status: "installed" }, authentication: "authenticated", models: [], methods: [], canLogout: false });
  try {
    const result = await checkProviderConnection(id);
    assert.equal(result.ok, false);
    assert.equal(result.nativeSessionReady, false);
    assert.equal(result.authentication, "authenticated");
  } finally { adapter.check = previous; }
}));
test("a status result losing the instance CAS race cannot overwrite the winning revision", async () => isolated(async id => {
  const adapter = getNativeProviderAdapter("opencode")!;
  const previous = adapter.check;
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  adapter.check = async () => { entered.resolve(); await complete.promise; return ready; };
  try {
    const pending = checkProviderConnection(id);
    await entered.promise;
    const before = getStoredInstance(id)!;
    const winner = updateProviderInstance(id, { label: "winner" }, before.revision);
    complete.resolve();
    await assert.rejects(pending, { status: 409 });
    assert.equal(getStoredInstance(id)!.revision, winner.revision);
    assert.equal(getStoredInstance(id)!.observations, undefined);
  } finally { complete.resolve(); adapter.check = previous; }
}));

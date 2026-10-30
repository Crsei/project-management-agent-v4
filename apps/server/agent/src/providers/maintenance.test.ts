import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "./instances.ts";
import { cancelProviderMaintenance, getProviderMaintenance, startProviderMaintenance } from "./maintenance.ts";
import { requireAccountIdle } from "./auth.ts";

test("maintenance losing the config CAS rejects late progress/success and releases account exclusion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-maintenance-cas-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  const adapter = getNativeProviderAdapter("opencode")!;
  const original = adapter.update;
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  adapter.update = async (_context, _signal, progress) => {
    entered.resolve();
    await finish.promise;
    progress?.({ message: "must not publish stale completion" });
    returned.resolve();
    return { message: "must not succeed" };
  };
  try {
    const instance = createProviderInstance({ instanceId: "maintenance-account", driver: "opencode" });
    startProviderMaintenance(instance.instanceId, "update", instance.revision);
    await entered.promise;
    const running = getStoredInstance(instance.instanceId)!;
    updateProviderInstance(instance.instanceId, { label: "winning configuration" }, running.revision);
    finish.resolve();
    await returned.promise;
    const final = await cancelProviderMaintenance(instance.instanceId);
    assert.equal(final.status, "failed");
    assert.notEqual(final.message, "must not publish stale completion");
    assert.equal(getProviderMaintenance(instance.instanceId).status, "failed");
    requireAccountIdle(instance.instanceId);
  } finally {
    finish.resolve(); adapter.update = original;
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

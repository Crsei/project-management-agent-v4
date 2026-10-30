import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "./instances.ts";
import { cancelProviderMaintenance, getProviderMaintenance, startProviderMaintenance, startProviderMaintenanceRuntime, stopProviderMaintenanceRuntime } from "./maintenance.ts";
import { requireAccountIdle } from "./auth.ts";
import { controlledInstallation } from "./t3code/testing/maintenance-lifecycle.testkit.ts";

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

test("maintenance shutdown fences and drains only the captured data root, then reopens only after cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-maintenance-lifetime-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "provider-maintenance-other-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  const adapter = getNativeProviderAdapter("opencode")!;
  const original = adapter.update;
  const own = controlledInstallation();
  const other = controlledInstallation();
  let stopping: Promise<void> | undefined;
  adapter.update = (context, signal, progress) =>
    (context.stateDirectory.startsWith(root + path.sep) ? own : other).prepare(context, signal, progress);
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = root;
    const instance = createProviderInstance({ instanceId: "same-id", driver: "opencode" });
    startProviderMaintenance(instance.instanceId, "update", instance.revision);
    await own.entered.promise;
    process.env.AGENT_WORKSPACE_DATA_DIR = otherRoot;
    const otherInstance = createProviderInstance({ instanceId: "same-id", driver: "opencode" });
    startProviderMaintenance(otherInstance.instanceId, "update", otherInstance.revision);
    await other.entered.promise;
    stopping = stopProviderMaintenanceRuntime(root);
    await nextTurn();
    assert.equal(own.signal()?.aborted, true);
    assert.equal(other.signal()?.aborted, false, "the same instance ID in another root is not owned by this shutdown");
    process.env.AGENT_WORKSPACE_DATA_DIR = root;
    assert.throws(() => startProviderMaintenance(instance.instanceId, "update", getStoredInstance(instance.instanceId)!.revision), { status: 503 });
    assert.throws(() => startProviderMaintenanceRuntime(root), { status: 503 }, "restart cannot reopen admission while old cleanup is held");
    assert.throws(() => requireAccountIdle(instance.instanceId), { status: 409 });
    own.cleanupRelease.resolve();
    await stopping;
    assert.equal(getProviderMaintenance(instance.instanceId).status, "cancelled");
    requireAccountIdle(instance.instanceId);
    startProviderMaintenanceRuntime(root);
    process.env.AGENT_WORKSPACE_DATA_DIR = otherRoot;
    assert.equal(getProviderMaintenance(otherInstance.instanceId).status, "running");
    const otherStopping = stopProviderMaintenanceRuntime(otherRoot);
    await nextTurn();
    assert.equal(other.signal()?.aborted, true);
    other.cleanupRelease.resolve();
    await otherStopping;
    assert.equal(getProviderMaintenance(otherInstance.instanceId).status, "cancelled");
    requireAccountIdle(otherInstance.instanceId);
  } finally {
    own.download.resolve(); own.cleanupRelease.resolve();
    other.download.resolve(); other.cleanupRelease.resolve();
    await stopping;
    await stopProviderMaintenanceRuntime(root);
    await stopProviderMaintenanceRuntime(otherRoot);
    adapter.update = original;
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getDatabase } from "./durable/store.ts";
import { requireAccountIdle } from "./providers/auth.ts";
import { getProviderMaintenance, startProviderMaintenance } from "./providers/maintenance.ts";
import { getPmProviderApplication } from "./providers/t3code/application-access.ts";
import { startPmProviderApplication } from "./providers/t3code/application.ts";
import { controlledInstallation, maintenanceLifecycleFixture } from "./providers/t3code/testing/maintenance-lifecycle.testkit.ts";
import { startRuntime, stopRuntime } from "./runtime.ts";

test("runtime stop fences maintenance immediately, cancels HTTP and direct installs, and retains the store and exclusion until cleanup", async () => {
  const f = await maintenanceLifecycleFixture();
  const http = f.account("runtime-http");
  const direct = f.account("runtime-direct");
  const late = f.account("runtime-late");
  let stopping: Promise<void> | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    await startPmProviderApplication(f.options);
    await startRuntime();
    const database = getDatabase();
    const management = getPmProviderApplication().management;
    startProviderMaintenance(http.instance.instanceId, "install", http.instance.revision);
    pending = management.prepare!(direct.context()).catch(error => error);
    await Promise.all([http.installation.entered.promise, direct.installation.entered.promise]);
    stopping = stopRuntime();
    let closed = false;
    void stopping.then(() => { closed = true; });
    assert.throws(() => startProviderMaintenance(late.instance.instanceId, "install", late.instance.revision), { status: 503 },
      "new maintenance must be rejected synchronously when shutdown begins");
    await nextTurn();
    assert.equal(http.installation.signal()?.aborted, true);
    assert.equal(direct.installation.signal()?.aborted, true);
    await Promise.all([http.installation.cleanupEntered.promise, direct.installation.cleanupEntered.promise]);
    assert.equal(closed, false);
    assert.equal(database.prepare("SELECT 1 AS alive").get()?.alive, 1);
    await access(path.join(f.root, "workspace.lock"));
    assert.equal(getProviderMaintenance(http.instance.instanceId).status, "running");
    assert.throws(() => requireAccountIdle(http.instance.instanceId), { status: 409 });
    assert.throws(() => requireAccountIdle(direct.instance.instanceId), { status: 409 });
    assert.deepEqual(f.closed, []);
    http.installation.cleanupRelease.resolve();
    await http.installation.cleanupFinished.promise;
    await nextTurn();
    assert.equal(closed, false);
    assert.equal(database.prepare("SELECT 1 AS alive").get()?.alive, 1);
    direct.installation.cleanupRelease.resolve();
    await stopping;
    await pending;
    assert.equal(getProviderMaintenance(http.instance.instanceId).status, "cancelled");
    requireAccountIdle(http.instance.instanceId);
    requireAccountIdle(direct.instance.instanceId);
    await assert.rejects(access(path.join(f.root, "workspace.lock")), { code: "ENOENT" });
    assert.throws(() => database.prepare("SELECT 1"), /closed|not open/i);

    // The stopped root remains fenced, then a fresh runtime reopens admission.
    assert.throws(() => startProviderMaintenance(late.instance.instanceId, "install", late.instance.revision), { status: 503 });
    await startPmProviderApplication(f.options);
    await startRuntime();
    const restarted = controlledInstallation();
    restarted.download.resolve(); restarted.cleanupRelease.resolve();
    f.installations.set(late.instance.instanceId, restarted);
    startProviderMaintenance(late.instance.instanceId, "install", late.context().revision);
    await restarted.cleanupFinished.promise;
    await nextTurn();
    assert.equal(getProviderMaintenance(late.instance.instanceId).status, "succeeded");
    assert.equal(restarted.signal()?.aborted, false);
  } finally {
    for (const installation of f.installations.values()) { installation.download.resolve(); installation.cleanupRelease.resolve(); }
    await pending;
    await stopping;
    await stopRuntime();
    await f.close();
  }
});

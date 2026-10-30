import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { requireAccountIdle } from "../auth.ts";
import { startProviderMaintenance } from "../maintenance.ts";
import { getPmProviderApplication } from "./application-access.ts";
import { makePmProviderApplication, startPmProviderApplication, stopPmProviderApplication, type PmProviderApplication } from "./application.ts";
import { controlledInstallation, maintenanceLifecycleFixture } from "./testing/maintenance-lifecycle.testkit.ts";

// Avoid a hanging failing-before test: assertions inspect cancellation after a scheduler turn,
// and fixture teardown independently releases the controlled download and cleanup.
test("application stop cancels every direct preparation before awaiting any cleanup and retains all leases", async () => {
  const f = await maintenanceLifecycleFixture();
  const first = f.account("shutdown-first");
  const second = f.account("shutdown-second");
  let stopping: Promise<void> | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    await startPmProviderApplication(f.options);
    const management = getPmProviderApplication().management;
    for (const account of [first, second]) pending.push(management.prepare!(account.context()).catch(error => error));
    await Promise.all([first.installation.entered.promise, second.installation.entered.promise]);
    stopping = stopPmProviderApplication();
    let closed = false;
    void stopping.then(() => { closed = true; });
    await nextTurn();
    assert.equal(first.installation.signal()?.aborted, true, "stop must cancel no-signal direct callers");
    assert.equal(second.installation.signal()?.aborted, true, "all admissions must abort before the first cleanup is awaited");
    await Promise.all([first.installation.cleanupEntered.promise, second.installation.cleanupEntered.promise]);
    assert.equal(closed, false);
    assert.deepEqual(f.closed, [], "retained provider scopes must outlive installer cleanup");
    assert.throws(() => requireAccountIdle(first.instance.instanceId), { status: 409 });
    assert.throws(() => requireAccountIdle(second.instance.instanceId), { status: 409 });
    await assert.rejects(management.prepare!(f.provisional("shutdown-late")), { status: 503 });
    assert.throws(() => startProviderMaintenance(first.instance.instanceId, "install", first.context().revision), { status: 503 });
    first.installation.cleanupRelease.resolve();
    await first.installation.cleanupFinished.promise;
    await nextTurn();
    assert.equal(closed, false, "shutdown must still retain the second admitted installation");
    second.installation.cleanupRelease.resolve();
    await stopping;
    await Promise.all(pending);
    assert.deepEqual([...f.closed].sort(), [first.instance.instanceId, second.instance.instanceId].sort());
    requireAccountIdle(first.instance.instanceId);
    requireAccountIdle(second.instance.instanceId);
  } finally {
    for (const account of [first, second]) { account.installation.download.resolve(); account.installation.cleanupRelease.resolve(); }
    await Promise.all(pending);
    await stopping;
    await f.close();
  }
});

test("provisional direct installation shares the owning application lifetime and cannot escape a same-turn shutdown", async () => {
  const f = await maintenanceLifecycleFixture();
  const provisional = controlledInstallation();
  f.installations.set("provisional", provisional);
  const application = await makePmProviderApplication(f.options);
  let stopping: Promise<void> | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    pending = application.management.prepare!(f.provisional("provisional")).catch(error => error);
    await provisional.entered.promise;
    stopping = application.shutdown();
    await nextTurn();
    assert.equal(provisional.signal()?.aborted, true);
    let closed = false;
    void stopping.then(() => { closed = true; });
    await provisional.cleanupEntered.promise;
    await nextTurn();
    assert.equal(closed, false, "a provisional installation has no lease but still owns source cleanup");
    await assert.rejects(application.management.prepare!(f.provisional("late-provisional")), { status: 503 });
    provisional.cleanupRelease.resolve();
    await stopping;
    await pending;
  } finally {
    provisional.download.resolve(); provisional.cleanupRelease.resolve();
    await pending;
    await application.shutdown();
    await f.close();
  }
});

test("application shutdown fences a preparation admitted in the same turn and restart creates a fresh lifetime", async () => {
  const f = await maintenanceLifecycleFixture();
  const first = f.account("same-turn");
  let pending: Promise<unknown> | undefined;
  try {
    await startPmProviderApplication(f.options);
    const old = getPmProviderApplication();
    pending = old.management.prepare!(first.context()).catch(error => error);
    const stopping = stopPmProviderApplication();
    await nextTurn();
    assert.equal(first.installation.calls(), 0, "an admitted but not dispatched installer must not start after stop");
    await stopping;
    await pending;
    await assert.rejects(old.management.prepare!(f.provisional("stale-reference")), { status: 503 });
    await startPmProviderApplication(f.options);
    const restarted = getPmProviderApplication();
    assert.notEqual(restarted, old);
    const next = controlledInstallation();
    next.download.resolve(); next.cleanupRelease.resolve();
    f.installations.set(first.instance.instanceId, next);
    assert.equal((await restarted.management.prepare!(first.context())).message, "Controlled installation completed.");
    assert.equal(next.signal()?.aborted, false);
  } finally {
    first.installation.download.resolve(); first.installation.cleanupRelease.resolve();
    await pending;
    await f.close();
  }
});

test("application installation admission and cancellation stay bound to the exact data root and application", async () => {
  const f = await maintenanceLifecycleFixture();
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "pm-maintenance-other-root-"));
  const first = await makePmProviderApplication(f.options);
  const own = controlledInstallation();
  f.installations.set("root-owner", own);
  const other = controlledInstallation();
  let second: PmProviderApplication | undefined;
  let pending: Promise<unknown> | undefined;
  let ownPending: Promise<unknown> | undefined;
  try {
    ownPending = first.management.prepare!(f.provisional("root-owner")).catch(error => error);
    await own.entered.promise;
    process.env.AGENT_WORKSPACE_DATA_DIR = otherRoot;
    second = await makePmProviderApplication({ families: new Map(), protocols: new Map(),
      installations: new Map([["codex", { prepare: other.prepare }]]) });
    const foreignContext = { ...f.provisional("root-provisional"), cwd: otherRoot, stateDirectory: path.join(otherRoot, "root-provisional") };
    await assert.rejects(first.management.prepare!(foreignContext), { status: 409 });
    pending = second.management.prepare!(foreignContext).catch(error => error);
    await other.entered.promise;
    const closingFirst = first.shutdown();
    await nextTurn();
    assert.equal(own.signal()?.aborted, true, "shutdown must retain its original root even after the ambient root changes");
    own.cleanupRelease.resolve();
    await closingFirst;
    await ownPending;
    assert.equal(other.signal()?.aborted, false, "closing another application must not abort this root's installer");
    const stopping = second.shutdown();
    await nextTurn();
    assert.equal(other.signal()?.aborted, true);
    other.cleanupRelease.resolve();
    await stopping;
    await pending;
  } finally {
    own.download.resolve(); own.cleanupRelease.resolve();
    await ownPending;
    other.download.resolve(); other.cleanupRelease.resolve();
    await pending;
    await second?.shutdown();
    await first.shutdown();
    process.env.AGENT_WORKSPACE_DATA_DIR = f.root;
    await rm(otherRoot, { recursive: true, force: true });
    await f.close();
  }
});

test("request cancellation keeps its original reason and cleanup while application shutdown joins the same admission", async () => {
  const f = await maintenanceLifecycleFixture();
  const account = f.account("request-signal");
  const controller = new AbortController();
  const reason = new Error("Original request cancellation.");
  const application = await makePmProviderApplication(f.options);
  let pending: Promise<unknown> | undefined;
  try {
    pending = application.management.prepare!(account.context(), controller.signal).catch(error => error);
    await account.installation.entered.promise;
    controller.abort(reason);
    await account.installation.cleanupEntered.promise;
    assert.equal(account.installation.signal()?.reason, reason);
    const stopping = application.shutdown();
    await nextTurn();
    assert.equal(account.installation.signal()?.reason, reason, "shutdown must not replace a request that already won cancellation");
    assert.throws(() => requireAccountIdle(account.instance.instanceId), { status: 409 });
    account.installation.cleanupRelease.resolve();
    await pending;
    await stopping;
    requireAccountIdle(account.instance.instanceId);
  } finally {
    account.installation.download.resolve(); account.installation.cleanupRelease.resolve();
    await pending;
    await application.shutdown();
    await f.close();
  }
});

for (const published of [false, true]) {
  test(`${published ? "published" : "standalone"} application refuses a data-root change during asynchronous construction`, async () => {
    const f = await maintenanceLifecycleFixture();
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "pm-maintenance-construction-root-"));
    let unpublished: PmProviderApplication | undefined;
    try {
      const constructing = published
        ? startPmProviderApplication(f.options)
        : makePmProviderApplication(f.options).then(application => { unpublished = application; });
      process.env.AGENT_WORKSPACE_DATA_DIR = otherRoot;
      await assert.rejects(constructing, { status: 409 });
      process.env.AGENT_WORKSPACE_DATA_DIR = f.root;
      await startPmProviderApplication(f.options);
      const fresh = controlledInstallation();
      fresh.download.resolve(); fresh.cleanupRelease.resolve();
      f.installations.set("construction-restart", fresh);
      await getPmProviderApplication().management.prepare!(f.provisional("construction-restart"));
      assert.equal(fresh.calls(), 1);
      assert.equal(fresh.signal()?.aborted, false);
    } finally {
      await unpublished?.shutdown();
      process.env.AGENT_WORKSPACE_DATA_DIR = f.root;
      await f.close();
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
}

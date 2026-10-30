import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ProviderMaintenanceState } from "@agent-workspace/contracts/provider";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as CodexInstallation from "../../../../../../../vendor/t3code/apps/server/src/provider/CodexInstallation.ts";
import * as ModelManifest from "../../../../../../../vendor/t3code/apps/server/src/provider/ModelManifest.ts";
import { closeStore } from "../../../durable/store.ts";
import { requireAccountIdle } from "../../auth.ts";
import { createProviderInstance, getStoredInstance, providerContext } from "../../instances.ts";
import { cancelProviderMaintenance, startProviderMaintenance } from "../../maintenance.ts";
import { getPmProviderApplication } from "../application-access.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../application.ts";
import { makePmProviderFamily } from "../registration.ts";
import { codexDriver, codexInstallationMethods, makeCodexDriverLayer } from "./codex.ts";

type Installation = CodexInstallation.CodexInstallation["Service"];
async function fixture(options: { local?: boolean; holdChanges?: boolean; pauseCancel?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-retained-installation-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  const entered = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>();
  const cleanupRelease = Promise.withResolvers<void>();
  const cleanupFinished = Promise.withResolvers<void>();
  const changesRelease = Promise.withResolvers<void>();
  const cancelEntered = Promise.withResolvers<void>();
  const cancelRelease = Promise.withResolvers<void>();
  const localDirectory = path.join(root, "local");
  if (options.local) {
    await mkdir(localDirectory);
    await writeFile(path.join(localDirectory, "codex"), `#!${process.execPath}
if (process.argv.includes('--version')) console.log('codex-cli 0.156.1');
`, { mode: 0o700 });
  }
  const cancelCalls: string[] = [];
  let original: Installation | undefined;
  let retained: Installation | undefined;
  let failRelease = false;
  const driver = { ...codexDriver,
    create: (...args: Parameters<typeof codexDriver.create>) => Effect.gen(function* () {
      original = yield* CodexInstallation.makeCodexInstallation({
        baseDir: root, managedDirectory: path.join(root, "runtime"),
        releaseAsset: { version: "0.156.1", target: "x86_64-unknown-linux-musl",
          url: "https://controlled.invalid/codex.tar.gz", archiveBytes: 1, sha256: "0".repeat(64) },
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: options.local ? localDirectory : "" }),
        Effect.provideService(ModelManifest.ModelManifest, {
          current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
          refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
          forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST), refreshInBackground: Effect.void,
        }),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(request => Effect.sync(() =>
          Object.defineProperty(HttpClientResponse.fromWeb(request, new Response(null)), "stream", {
            value: Stream.fromEffect(Effect.acquireRelease(Effect.sync(() => entered.resolve()), () =>
              Effect.promise(async () => {
                cleanupEntered.resolve();
                await cleanupRelease.promise;
                cleanupFinished.resolve();
              }))).pipe(Stream.flatMap(() => failRelease
                ? Stream.die(new Error("Controlled source download failure")) : Stream.never)),
          })))),
      );
      const source = original;
      retained = { ...source,
        changes: options.holdChanges ? Stream.fromEffect(Effect.promise(() => changesRelease.promise)).pipe(
          Stream.flatMap(() => source.changes),
        ) : source.changes,
        cancel: operationId => Effect.promise(async () => {
          cancelCalls.push(operationId);
          cancelEntered.resolve();
          if (options.pauseCancel) await cancelRelease.promise;
        }).pipe(Effect.andThen(source.cancel(operationId))),
      };
      return yield* codexDriver.create(...args).pipe(Effect.provideService(CodexInstallation.CodexInstallation, retained));
    }),
  };
  const instance = createProviderInstance({ instanceId: "retained-codex", driver: "codex", config: { setupMode: "managed" },
    environment: [{ name: "HOME", value: path.join(root, "user-home"), sensitive: false },
      { name: "PATH", value: "", sensitive: false }] });
  await startPmProviderApplication({ families: new Map([[codexDriver.driverKind, makePmProviderFamily(driver, makeCodexDriverLayer)]]),
    protocols: new Map(), installations: new Map([["codex", codexInstallationMethods]]) });
  return { root, instance, entered, cleanupEntered, cleanupRelease, cleanupFinished, cancelCalls, cancelEntered, cancelRelease,
    original: () => { assert.ok(original); return original; },
    failDownload: () => { failRelease = true; },
    close: async () => {
      cleanupRelease.resolve();
      changesRelease.resolve();
      cancelRelease.resolve();
      await stopPmProviderApplication();
      closeStore();
      if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Codex maintenance cancellation reaches the captured original installer and waits for release-stream cleanup before unlocking", async () => {
  const f = await fixture();
  let cancellation: Promise<ProviderMaintenanceState> | undefined;
  try {
    startProviderMaintenance(f.instance.instanceId, "install", f.instance.revision);
    await f.entered.promise;
    const started = await Effect.runPromise(f.original().state);
    assert.equal(started.phase, "downloading");
    assert.ok(started.operationId);
    cancellation = cancelProviderMaintenance(f.instance.instanceId);
    const first = await Promise.race([
      f.cleanupEntered.promise.then(() => "original-cleanup"), cancellation.then(() => "maintenance-returned"),
    ]);
    assert.equal(first, "original-cleanup", "maintenance must cancel the original installer, not just its waiter");
    assert.deepEqual(f.cancelCalls, [started.operationId]);
    assert.throws(() => requireAccountIdle(f.instance.instanceId), { status: 409 });
    let returned = false;
    void cancellation.then(() => { returned = true; });
    await nextTurn();
    assert.equal(returned, false, "cleanup acknowledgement must precede maintenance completion");
    f.cleanupRelease.resolve();
    const state = await cancellation;
    await f.cleanupFinished.promise;
    assert.equal(state.status, "cancelled");
    assert.equal((await Effect.runPromise(f.original().state)).phase, "cancelled");
    requireAccountIdle(f.instance.instanceId);
    await assert.rejects(access(path.join(f.root, "runtime", "active.json")), { code: "ENOENT" });
    assert.deepEqual((await readdir(path.join(f.root, "runtime"))).filter(name => name.startsWith(".install-")), []);
  } finally { f.cleanupRelease.resolve(); await cancellation; await f.close(); }
});

test("Codex prepare preserves an original installer failure instead of returning success or cancelling a completed operation", async () => {
  const f = await fixture();
  f.failDownload();
  f.cleanupRelease.resolve();
  try {
    const context = providerContext(getStoredInstance(f.instance.instanceId)!, f.root);
    await assert.rejects(getPmProviderApplication().management.prepare!(context), error =>
      error instanceof Error && /Could not finish the Codex installation/.test(error.message));
    assert.equal((await Effect.runPromise(f.original().state)).phase, "failed");
    assert.deepEqual(f.cancelCalls, []);
    requireAccountIdle(f.instance.instanceId);
  } finally { await f.close(); }
});

test("an already aborted Codex prepare cannot start or cancel another retained operation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("Already cancelled"));
  try {
    const context = providerContext(getStoredInstance(f.instance.instanceId)!, f.root);
    await assert.rejects(getPmProviderApplication().management.prepare!(context, controller.signal));
    assert.deepEqual(f.cancelCalls, []);
    // Acquisition is itself cancelled: no retained original installer should be created.
    requireAccountIdle(f.instance.instanceId);
  } finally { await f.close(); }
});

test("cancelling an old Codex prepare never cancels a newer original installer operation", async () => {
  const f = await fixture({ holdChanges: true });
  const controller = new AbortController();
  let pending: Promise<{ message: string }> | undefined;
  let newerId: string | null = null;
  try {
    const context = providerContext(getStoredInstance(f.instance.instanceId)!, f.root);
    pending = getPmProviderApplication().management.prepare!(context, controller.signal);
    const rejected = assert.rejects(pending);
    await f.entered.promise;
    const first = await Effect.runPromise(f.original().state);
    assert.ok(first.operationId);
    f.cleanupRelease.resolve();
    await Effect.runPromise(f.original().cancel(first.operationId));
    const newer = await Effect.runPromise(f.original().start);
    newerId = newer.operationId;
    assert.ok(newerId);
    assert.notEqual(newerId, first.operationId);
    controller.abort(new Error("Cancel only the captured operation"));
    await rejected;
    assert.deepEqual(f.cancelCalls, []);
    assert.equal((await Effect.runPromise(f.original().state)).operationId, newerId);
    assert.equal((await Effect.runPromise(f.original().state)).phase, "downloading");
  } finally {
    controller.abort();
    f.cleanupRelease.resolve();
    if (newerId) await Effect.runPromise(f.original().cancel(newerId));
    await pending?.catch(() => undefined);
    await f.close();
  }
});

test("completed-before-cancel Codex prepare preserves the original reusable runtime without cancelling it", async () => {
  const f = await fixture({ local: true });
  const controller = new AbortController();
  try {
    const context = providerContext(getStoredInstance(f.instance.instanceId)!, f.root);
    const result = await getPmProviderApplication().management.prepare!(context, controller.signal);
    controller.abort(new Error("Completion already won"));
    assert.equal(typeof result.message, "string");
    const state = await Effect.runPromise(f.original().state);
    assert.equal(state.phase, "succeeded");
    assert.equal(state.source, "local");
    assert.equal(state.operationId, null);
    assert.deepEqual(f.cancelCalls, []);
    requireAccountIdle(f.instance.instanceId);
  } finally { await f.close(); }
});

test("Codex prepare surfaces the original cancel failure if operation ownership changes during cancellation", async () => {
  const f = await fixture({ pauseCancel: true, holdChanges: true });
  const controller = new AbortController();
  let pending: Promise<{ message: string }> | undefined;
  let newerId: string | null = null;
  try {
    const context = providerContext(getStoredInstance(f.instance.instanceId)!, f.root);
    pending = getPmProviderApplication().management.prepare!(context, controller.signal);
    const rejected = assert.rejects(pending, /installation is no longer current/);
    await f.entered.promise;
    const first = await Effect.runPromise(f.original().state);
    assert.ok(first.operationId);
    controller.abort(new Error("Cancel the captured operation"));
    await f.cancelEntered.promise;
    f.cleanupRelease.resolve();
    await Effect.runPromise(f.original().cancel(first.operationId));
    newerId = (await Effect.runPromise(f.original().start)).operationId;
    assert.ok(newerId);
    f.cancelRelease.resolve();
    await rejected;
    assert.deepEqual(f.cancelCalls, [first.operationId]);
    const current = await Effect.runPromise(f.original().state);
    assert.equal(current.operationId, newerId);
    assert.equal(current.phase, "downloading");
  } finally {
    controller.abort();
    f.cleanupRelease.resolve();
    f.cancelRelease.resolve();
    if (newerId) await Effect.runPromise(f.original().cancel(newerId));
    await pending?.catch(() => undefined);
    await f.close();
  }
});

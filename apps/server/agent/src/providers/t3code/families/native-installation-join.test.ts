import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ProviderMaintenanceState } from "@agent-workspace/contracts/provider";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as CodexInstallation from "../../../../../../../vendor/t3code/apps/server/src/provider/CodexInstallation.ts";
import * as AntigravityInstallation from "../../../../../../../vendor/t3code/apps/server/src/provider/AntigravityInstallation.ts";
import * as ModelManifest from "../../../../../../../vendor/t3code/apps/server/src/provider/ModelManifest.ts";
import { closeStore } from "../../../durable/store.ts";
import { requireAccountIdle } from "../../auth.ts";
import { createProviderInstance, getStoredInstance, providerContext } from "../../instances.ts";
import { cancelProviderMaintenance, startProviderMaintenance } from "../../maintenance.ts";
import { getPmProviderApplication } from "../application-access.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../application.ts";
import { makePmProviderFamily } from "../registration.ts";
import { codexDriver, codexInstallationMethods, makeCodexDriverLayer } from "./codex.ts";
import { antigravityDriver, antigravityInstallationMethods, makeAntigravityDriverLayer } from "./antigravity.ts";

// The same small archives used by the original installer suites. Downloads, hashing,
// unpacking, publication and scoped cleanup still run through the real installers.
const archives = {
  codex: Buffer.from("H4sIAAAAAAAC/+3W0W6DIBQGYB/FcD0sKNSkD7J7aom6tmAQtzXL3n3QZM3qdWVt+n8XoCckJp78wLY3q8bu9Ge2HBbUUp7nYD4H8s9zrNdSsCxnWQLT6JULn8ye09K9h/u2/c0/jSM9xqGzo0+bf3Gdf15WQiD/Kdy61/CA+z8dlO9Wrv2387+c5Z9VZY38p7BY0+Gh8t/sVauLt9Ga9Pnnop7ln1e4/6fxRQ7qZCf/qt3YW0M2OX/JyfvljbCCy3XBSaiGH9VqH4tKuaZbC6qG4aDpTrmP3sQV2nh3Gmxvzqsud0vyjaABAAAAAAAAAAAAAAAk8gOq19rvACgAAA==", "base64"),
  antigravity: Buffer.from("UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA", "base64"),
};
type Family = keyof typeof archives;
type Installation = CodexInstallation.CodexInstallation["Service"] | AntigravityInstallation.AntigravityInstallation["Service"];

async function fixture(family: Family, signal: AbortSignal, options: { holdChanges?: boolean; cleanupFailure?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${family}-exact-native-join-`));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await symlink("/bin/tar", path.join(bin, "tar"));
  await symlink("/bin/gzip", path.join(bin, "gzip"));
  const pointerEntered = Promise.withResolvers<void>();
  const pointerRelease = Promise.withResolvers<void>();
  const stagingEntered = Promise.withResolvers<void>();
  const stagingRelease = Promise.withResolvers<void>();
  const stagingFinished = Promise.withResolvers<void>();
  const changesRelease = Promise.withResolvers<void>();
  const newerEntered = Promise.withResolvers<void>();
  const newerRelease = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  let waitingFor = "fixture creation";
  const releaseAll = () => {
    pointerRelease.resolve(); stagingRelease.resolve(); changesRelease.resolve(); newerRelease.resolve();
  };
  const aborted = () => {
    releaseAll();
    failed.reject(new Error(`${family} test aborted while awaiting ${waitingFor}`));
  };
  signal.addEventListener("abort", aborted, { once: true });
  const cancelCalls: string[] = [];
  const archive = archives[family];
  const sha256 = createHash("sha256").update(archive).digest("hex");
  let original: Installation | undefined;
  let firstPointer = true;
  let validations = 0;
  const validate = () => ++validations === 2
    ? Effect.promise(async () => { newerEntered.resolve(); await newerRelease.promise; })
    : Effect.void;
  const makeInstallation = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const trackedFs = FileSystem.FileSystem.of({ ...fs,
        makeTempDirectoryScoped: settings => {
          const pointer = settings?.prefix === (family === "codex" ? ".active-" : "active.json.");
          const staging = settings?.prefix === ".install-";
          if ((!pointer || !firstPointer) && !staging) return fs.makeTempDirectoryScoped(settings);
          if (pointer) firstPointer = false;
          return Effect.acquireRelease(fs.makeTempDirectory(settings), directory => Effect.gen(function* () {
            yield* Effect.promise(async () => {
              if (pointer) { pointerEntered.resolve(); await pointerRelease.promise; }
              else { stagingEntered.resolve(); await stagingRelease.promise; }
            });
            yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie);
            if (staging) yield* Effect.sync(() => stagingFinished.resolve());
            if (pointer && options.cleanupFailure) yield* Effect.die(new Error("Controlled native pointer cleanup failure"));
          }));
        },
      });
      const source = yield* Effect.gen(function* () {
        if (family === "codex") return yield* CodexInstallation.makeCodexInstallation({
          baseDir: root, managedDirectory: path.join(root, "runtime"), validate,
          releaseAsset: { version: "0.156.1", target: "aarch64-apple-darwin", url: "https://controlled.invalid/codex.tar.gz", archiveBytes: archive.length, sha256 },
        });
        return yield* AntigravityInstallation.makeAntigravityInstallation({ baseDir: root, validate,
          releaseAsset: { version: "fixture-new", url: "https://controlled.invalid/antigravity.zip", archiveBytes: archive.length, sha256,
            executable: { name: "agy_acp_server.par", bytes: Buffer.byteLength("antigravity runtime\n") },
            harness: { name: "localharness_external", bytes: Buffer.byteLength("local harness\n") } } });
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFs),
        Effect.provideService(HostProcess.Platform, family === "codex" ? "darwin" : "linux"),
        Effect.provideService(HostProcess.Architecture, family === "codex" ? "arm64" : "x64"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(ModelManifest.ModelManifest, {
          current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST), refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
          forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST), refreshInBackground: Effect.void,
        }),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(request => Effect.sync(() =>
          Object.defineProperty(HttpClientResponse.fromWeb(request, new Response(null)), "stream", { value: Stream.succeed(archive) })))),
      );
      original = source;
      yield* Effect.forkIn(Stream.runForEach(source.changes, state => Effect.sync(() => {
        if (state.phase === "failed" || state.phase === "cancelled")
          failed.reject(new Error(`${family} original installer ${state.phase} before ${waitingFor}: ${state.message}`));
      })), yield* Effect.scope);
      return { ...source,
        changes: options.holdChanges ? Stream.fromEffect(Effect.promise(() => changesRelease.promise)).pipe(Stream.flatMap(() => source.changes)) : source.changes,
        cancel: (operationId: string) => Effect.gen(function* () {
          cancelCalls.push(operationId);
          return yield* source.cancel(operationId);
        }),
      };
  });
  const providerFamily = family === "codex"
    ? makePmProviderFamily({ ...codexDriver, create: (...args: Parameters<typeof codexDriver.create>) => Effect.gen(function* () {
      const installation = yield* makeInstallation;
      return yield* codexDriver.create(...args).pipe(Effect.provideService(CodexInstallation.CodexInstallation,
        installation as CodexInstallation.CodexInstallation["Service"]));
    }) }, makeCodexDriverLayer)
    : makePmProviderFamily({ ...antigravityDriver, create: (...args: Parameters<typeof antigravityDriver.create>) => Effect.gen(function* () {
      const installation = yield* makeInstallation;
      return yield* antigravityDriver.create(...args).pipe(Effect.provideService(AntigravityInstallation.AntigravityInstallation,
        installation as AntigravityInstallation.AntigravityInstallation["Service"]));
    }) }, makeAntigravityDriverLayer);
  const instance = createProviderInstance({ instanceId: `retained-${family}`, driver: family,
    config: family === "codex" ? { setupMode: "managed" } : {},
    environment: [{ name: "HOME", value: path.join(root, "user-home"), sensitive: false }, { name: "PATH", value: bin, sensitive: false }] });
  const methods = family === "codex" ? codexInstallationMethods : antigravityInstallationMethods;
  await startPmProviderApplication({
    families: new Map([[providerFamily.driverKind, providerFamily]]),
    protocols: new Map(), installations: new Map([[family, { ...methods,
      prepare: async (...args: Parameters<NonNullable<typeof methods.prepare>>) => {
        try { return await methods.prepare!(...args); }
        catch (error) { failed.reject(error); throw error; }
      },
    }]]),
  });
  return { instance, root, pointerEntered, pointerRelease, stagingEntered, stagingRelease, stagingFinished, newerEntered, newerRelease, cancelCalls,
    releaseAll,
    waitFor: <A>(promise: Promise<A>, phase: string) => {
      waitingFor = phase;
      return Promise.race([promise, failed.promise]);
    },
    original: () => { assert.ok(original); return original; },
    close: async () => {
      releaseAll();
      await stopPmProviderApplication(); closeStore();
      if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
      await rm(root, { recursive: true, force: true });
      signal.removeEventListener("abort", aborted);
    },
  };
}

for (const family of ["codex", "antigravity"] as const) {
  for (const restart of [false, true]) {
    test(`${family} cancellation after native success retains exclusion through exact old pointer and staging cleanup${restart ? " with a newer operation" : ""}`, { timeout: 20_000 }, async t => {
      const f = await fixture(family, t.signal, { holdChanges: true });
      let cancellation: Promise<ProviderMaintenanceState> | undefined;
      let newerId: string | null = null;
      try {
        startProviderMaintenance(f.instance.instanceId, "install", f.instance.revision);
        await f.waitFor(f.pointerEntered.promise, "committed pointer cleanup");
        const first = await Effect.runPromise(f.original().state);
        assert.equal(first.phase, "succeeded");
        assert.ok(first.operationId);
        if (restart) {
          newerId = (await Effect.runPromise<Effect.Success<Installation["start"]>, unknown>(f.original().start)).operationId;
          await f.waitFor(f.newerEntered.promise, "newer operation validation");
          assert.notEqual(newerId, first.operationId);
        }
        cancellation = cancelProviderMaintenance(f.instance.instanceId);
        let returned = false;
        void cancellation.then(() => { returned = true; });
        await nextTurn();
        assert.equal(returned, false, "terminal publication is not worker cleanup acknowledgement");
        assert.throws(() => requireAccountIdle(f.instance.instanceId), { status: 409 });
        f.pointerRelease.resolve();
        await f.waitFor(f.stagingEntered.promise, "old staging cleanup");
        await nextTurn();
        assert.equal(returned, false, "pointer cleanup alone must not release the enclosing staging scope");
        assert.throws(() => requireAccountIdle(f.instance.instanceId), { status: 409 });
        f.stagingRelease.resolve();
        assert.equal((await cancellation).status, "cancelled");
        await f.stagingFinished.promise;
        assert.deepEqual(f.cancelCalls, [], "a committed operation and a replacement must never be cancelled");
        const current = await Effect.runPromise(f.original().state);
        assert.equal(current.operationId, restart ? newerId : first.operationId);
        if (restart) assert.ok(["downloading", "extracting", "verifying"].includes(current.phase), "the newer operation remains active");
        else assert.equal(current.phase, "succeeded");
        requireAccountIdle(f.instance.instanceId);
      } finally {
        f.releaseAll();
        await cancellation;
        if (newerId) await Effect.runPromise<unknown, unknown>(f.original().cancel(newerId));
        await f.close();
      }
    });
  }

  for (const cleanupFailure of [false, true]) {
    test(`${family} ordinary prepare joins native pointer and staging cleanup${cleanupFailure ? " and surfaces cleanup failure without relabeling committed runtime" : ""}`, { timeout: 20_000 }, async t => {
      const f = await fixture(family, t.signal, { cleanupFailure });
      let pending: Promise<unknown> | undefined;
      try {
        const context = providerContext(getStoredInstance(f.instance.instanceId)!, f.root);
        let returned = false;
        pending = getPmProviderApplication().management.prepare!(context).finally(() => { returned = true; });
        void pending.catch(() => undefined);
        await f.waitFor(f.pointerEntered.promise, "committed pointer cleanup");
        await nextTurn();
        assert.equal(returned, false, "ordinary success must also join pointer cleanup");
        assert.throws(() => requireAccountIdle(f.instance.instanceId), { status: 409 });
        f.pointerRelease.resolve();
        await f.waitFor(f.stagingEntered.promise, "old staging cleanup");
        await nextTurn();
        assert.equal(returned, false, "ordinary success must also join staging cleanup");
        f.stagingRelease.resolve();
        if (cleanupFailure) await assert.rejects(pending);
        else await pending;
        assert.equal((await Effect.runPromise(f.original().state)).phase, "succeeded");
        assert.deepEqual(f.cancelCalls, []);
        requireAccountIdle(f.instance.instanceId);
      } finally {
        f.releaseAll();
        await pending?.catch(() => undefined); await f.close();
      }
    });
  }
}

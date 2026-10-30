import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { ChildProcess } from "effect/process";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { getStoredInstance, providerContext } from "../../instances.ts";
import { makePmProviderProcessPlatformLayer } from "../upstream-services/process-platform.ts";
import { makePmNativeTestHost, PmNativeTestHost } from "./native-test-host.testkit.ts";

function restoreEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (!Object.hasOwn(environment, name)) delete process.env[name];
  }
  Object.assign(process.env, environment);
}

async function withAmbientEnvironment(use: (ambient: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const previous = { ...process.env };
  Object.assign(process.env, {
    PM_NATIVE_TEST_AMBIENT_SECRET: "controlled-not-a-real-secret",
    XAI_API_KEY: "controlled-foreign-account",
    HTTPS_PROXY: "http://controlled-foreign-proxy.invalid",
    CODEX_HOME: "/controlled-foreign-codex-home",
    CLAUDE_CONFIG_DIR: "/controlled-foreign-claude-home",
    XDG_CONFIG_HOME: "/controlled-foreign-xdg-home",
    T3CODE_CODEX_LAUNCH_ARGS: "controlled-foreign-config",
    NODE_ENV: "test",
    VITEST_WORKER_ID: "controlled-test-worker",
    LC_CTYPE: "C.UTF-8",
    TMPDIR: os.tmpdir(),
  });
  try { await use({ ...process.env }); }
  finally { restoreEnvironment(previous); }
}

test("native fixtures retain authoritative instance/revision/Home/cwd and isolate actual native child environments", { timeout: 20_000 }, async () =>
  withAmbientEnvironment(async ambient => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      let sharedRoot: string | undefined;
      for (const driver of ["grok", "fx", "acpRegistry"] as const) {
        const fixture = yield* makePmNativeTestHost({ driver, instanceId: `authoritative-${driver}`,
          environment: { PM_NATIVE_TEST_BOUND: "explicit-fixture-value" } });
        sharedRoot ??= fixture.root;
        assert.equal(fixture.root, sharedRoot, "Multiple fixtures in one Scope must reuse its root without reacquiring the gate.");
        const stored = getStoredInstance(fixture.context.instanceId);
        assert.ok(stored);
        assert.deepEqual(fixture.context, providerContext(stored, fixture.context.cwd));
        assert.equal(fixture.context.driver, driver);
        assert.equal(fixture.context.revision, stored.revision);
        assert.equal(fixture.context.homeDirectory, fixture.context.env.HOME);
        assert.equal(fixture.context.cwd, path.join(fixture.root, "workspace"));
        assert.notEqual(fixture.context.homeDirectory, fixture.context.stateDirectory);
        for (const name of ["PM_NATIVE_TEST_AMBIENT_SECRET", "XAI_API_KEY", "HTTPS_PROXY", "T3CODE_CODEX_LAUNCH_ARGS"]) {
          assert.equal(process.env[name], undefined);
          assert.equal(fixture.context.env[name], undefined);
        }
        assert.notEqual(fixture.context.env.CODEX_HOME, ambient.CODEX_HOME);
        assert.notEqual(fixture.context.env.CLAUDE_CONFIG_DIR, ambient.CLAUDE_CONFIG_DIR);
        assert.notEqual(fixture.context.env.XDG_CONFIG_HOME, ambient.XDG_CONFIG_HOME);
        const child = yield* spawnAndCollect(process.execPath, ChildProcess.make(process.execPath, ["-e", `
          console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME,
            explicit: process.env.PM_NATIVE_TEST_BOUND, nodeEnv: process.env.NODE_ENV,
            worker: process.env.VITEST_WORKER_ID, path: process.env.PATH,
            locale: process.env.LC_CTYPE, temporary: process.env.TMPDIR,
            inheritedSecret: Object.hasOwn(process.env, 'PM_NATIVE_TEST_AMBIENT_SECRET'),
            inheritedAccount: Object.hasOwn(process.env, 'XAI_API_KEY'),
            inheritedProxy: Object.hasOwn(process.env, 'HTTPS_PROXY') }));
        `])).pipe(Effect.provide(makePmProviderProcessPlatformLayer(fixture.context)));
        assert.equal(child.code, 0);
        assert.deepEqual(JSON.parse(child.stdout), { cwd: fixture.context.cwd, home: fixture.context.homeDirectory,
          explicit: "explicit-fixture-value", nodeEnv: ambient.NODE_ENV, worker: ambient.VITEST_WORKER_ID,
          ...(ambient.PATH === undefined ? {} : { path: ambient.PATH }), locale: ambient.LC_CTYPE, temporary: ambient.TMPDIR,
          inheritedSecret: false, inheritedAccount: false, inheritedProxy: false });
        const updated = yield* fixture.updateInstance({ label: "CAS-updated native fixture" });
        assert.ok(updated.revision > fixture.context.revision);
        assert.deepEqual(updated, providerContext(getStoredInstance(updated.instanceId)!, updated.cwd));
      }
    })));
    assert.deepEqual({ ...process.env }, ambient);
  }));

test("native fixture restores the exact ambient environment after acquisition or consumer failure", { timeout: 10_000 }, async () =>
  withAmbientEnvironment(async ambient => {
    await assert.rejects(Effect.runPromise(Effect.scoped(makePmNativeTestHost({ driver: "grok", config: { apiKey: "not-a-native-setting" } }))));
    assert.deepEqual({ ...process.env }, ambient);
    await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* makePmNativeTestHost({ driver: "grok" });
      process.env.PM_NATIVE_TEST_ADDED_DURING_SCOPE = "must-be-removed";
      delete process.env.PATH;
      return yield* Effect.fail(new Error("controlled fixture consumer failure"));
    }))));
    assert.deepEqual({ ...process.env }, ambient);
  }));

test("native fixture cancellation restores the ambient environment and releases the shared gate", { timeout: 10_000 }, async () =>
  withAmbientEnvironment(async ambient => {
    const entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    const operation = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* makePmNativeTestHost({ driver: "grok" });
      entered.resolve();
      yield* Effect.never;
    })), { signal: abort.signal });
    try {
      await Promise.race([entered.promise, operation]);
      assert.equal(process.env.PM_NATIVE_TEST_AMBIENT_SECRET, undefined);
      abort.abort();
      await assert.rejects(operation);
      assert.deepEqual({ ...process.env }, ambient);
      await Effect.runPromise(Effect.scoped(makePmNativeTestHost({ driver: "fx" })));
      assert.deepEqual({ ...process.env }, ambient);
    } finally {
      abort.abort();
      await operation.catch(() => {});
    }
  }));

test("provided fixture roots and cancelled gate waiters cannot release an active fixture's isolation", { timeout: 10_000 }, async () =>
  withAmbientEnvironment(async ambient => {
    const scope = await Effect.runPromise(Scope.make());
    try {
      const first = await Effect.runPromise(makePmNativeTestHost({ driver: "grok" }).pipe(Effect.provideService(Scope.Scope, scope)));
      const isolated = { ...process.env };
      await Effect.runPromise(Effect.scoped(makePmNativeTestHost({ driver: "fx" }).pipe(
        Effect.provideService(PmNativeTestHost, first),
        Effect.tap(nested => Effect.sync(() => assert.equal(nested.root, first.root))),
      )));
      assert.deepEqual({ ...process.env }, isolated);
      const abort = new AbortController();
      const waiting = Effect.runPromise(Effect.scoped(makePmNativeTestHost({ driver: "acpRegistry" })), { signal: abort.signal });
      abort.abort();
      await assert.rejects(waiting);
      assert.deepEqual({ ...process.env }, isolated);
      assert.deepEqual(first.context, providerContext(getStoredInstance(first.context.instanceId)!, first.context.cwd));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    assert.deepEqual({ ...process.env }, ambient);
  }));

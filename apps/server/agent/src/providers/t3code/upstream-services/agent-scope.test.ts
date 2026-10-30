import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ProcessRunner from "../../../../../../../vendor/t3code/apps/server/src/processRunner.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { makePmProviderAgentScopeLayer, pmProviderAgentScopeStateDirectory } from "./agent-scope.ts";
import { makePmProviderProcessPlatformLayer } from "./process-platform.ts";

function context(root: string): ProviderDriverContext {
  return { instanceId: "native-scope", driver: "pi", config: {}, revision: 1,
    cwd: root, stateDirectory: path.join(root, "private"), homeDirectory: path.join(root, "native-home"),
    env: { HOME: path.join(root, "user-home"), PATH: path.dirname(process.execPath), PM_SCOPE_BOUNDARY: "bound" } };
}

async function isolated(use: (bound: ProviderDriverContext) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-native-agent-scope-"));
  try { await use(context(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("process cleanup identity is stable only for the same complete PM context", async () => isolated(async bound => {
  const current = pmProviderAgentScopeStateDirectory(bound);
  assert.ok(current.startsWith(path.join(bound.stateDirectory, "t3code", "process-scopes") + path.sep));
  assert.equal(pmProviderAgentScopeStateDirectory({ ...bound, env: Object.fromEntries(Object.entries(bound.env).reverse()) }), current);
  assert.equal(pmProviderAgentScopeStateDirectory({ ...bound, env: { ...bound.env, CLAUDE_AGENT_SDK_VERSION: "source-added" } }), current);
  for (const different of [
    { ...bound, instanceId: "other-instance" },
    { ...bound, driver: "muse" as const },
    { ...bound, revision: 2 },
    { ...bound, cwd: path.join(bound.cwd, "other-project") },
    { ...bound, homeDirectory: path.join(bound.cwd, "other-native-home") },
    { ...bound, stateDirectory: path.join(bound.cwd, "other-application") },
    { ...bound, env: { ...bound.env, ACCOUNT: "other" } },
    { ...bound, instanceEnvironment: { ACCOUNT: "explicit-binding" } },
    { ...bound, config: { binaryPath: "/other/native" } },
  ]) assert.notEqual(pmProviderAgentScopeStateDirectory(different), current);
}));

test("the closed source layer does not advertise systemd cleanup without its bound runtime directory", async () => isolated(async bound => {
  const before = { ...bound.env };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const scope = yield* AgentScope;
    const launch = yield* scope.wrap({ command: process.execPath, args: ["--version"], name: "pm-test" });
    assert.equal(launch.unit, undefined);
    assert.equal(launch.args.some(argument => argument.startsWith("--unit=")), false);
    yield* scope.stop("t3code-foreign-project.scope");
    assert.equal(yield* scope.oomKilled("not-owned"), false);
  }).pipe(Effect.provide(makePmProviderAgentScopeLayer(bound)))));
  assert.deepEqual(bound.env, before);
}));

test("the real source runner uses only the PM-bound environment and working directory", async () => isolated(async bound => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner.run({ command: process.execPath, args: ["-e", `
      process.stdout.write(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME,
        marker: process.env.PM_SCOPE_BOUNDARY, keys: Object.keys(process.env).sort() }));
    `] });
  }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(makePmProviderProcessPlatformLayer(bound))))));
  assert.equal(result.code, 0);
  const observed = JSON.parse(result.stdout) as { cwd: string; home: string; marker: string; keys: string[] };
  assert.equal(observed.cwd, bound.cwd);
  assert.equal(observed.home, bound.env.HOME);
  assert.equal(observed.marker, "bound");
  assert.deepEqual(observed.keys, Object.keys(bound.env).sort());
}));

test("source runner timeout reaps its SIGTERM-ignoring child without killing another owned child", async () => isolated(async bound => {
  // Integration boundary: the real kernel child and Node spawner's TERM/KILL deadline
  // cannot be exercised with a virtual Effect clock. The child's timer is a leak guard.
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sibling = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"]));
    const runner = yield* ProcessRunner.ProcessRunner;
    let output = "";
    const result = yield* runner.run({ command: process.execPath, args: ["-e", `
      process.on("SIGTERM", () => {});
      process.stdout.write(String(process.pid) + "\\n");
      setTimeout(() => process.exit(0), 15000);
    `], timeout: "2 seconds", onStdoutChunk: chunk => { output += Buffer.from(chunk).toString("utf8"); } }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure._tag, "ProcessTimeoutError");
    const pid = Number(output.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "the real child must have started");
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    assert.equal(yield* sibling.isRunning, true);
    yield* sibling.kill();
    // The original Node spawner reports a signal exit as a typed error, not an exit code.
    const siblingExit = yield* sibling.exitCode.pipe(Effect.result);
    assert.equal(siblingExit._tag, "Failure");
    if (siblingExit._tag === "Failure") {
      const error = siblingExit.failure;
      assert.equal(error._tag, "PlatformError");
      assert.equal(error.reason._tag, "Unknown");
      assert.equal(error.reason.module, "ChildProcess");
      assert.equal(error.reason.method, "exitCode");
      assert.ok(error.reason.cause instanceof Error);
      assert.match(error.reason.cause.message, /signal: 'SIGTERM'$/);
    }
    assert.equal(yield* sibling.isRunning, false);
    assert.throws(() => process.kill(Number(sibling.pid), 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    yield* sibling.stdout.pipe(Stream.runDrain);
    yield* sibling.stderr.pipe(Stream.runDrain);
  }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(makePmProviderProcessPlatformLayer(bound)))))));
}));

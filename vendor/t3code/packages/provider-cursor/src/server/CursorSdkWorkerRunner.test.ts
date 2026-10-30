import { EventEmitter } from "node:events";
import * as ChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { afterEach, vi } from "vite-plus/test";
import type { CursorAgentSdkOpenInput } from "./CursorAgentSdk.ts";
import { makeCursorSdkWorkerRunner } from "./CursorSdkWorkerRunner.ts";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(), spawn: vi.fn(), execFile: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

const input: CursorAgentSdkOpenInput = {
  operation: "resume", agentId: "native-agent", threadId: ThreadId.make("worker-thread"),
  providerSessionId: ProviderSessionId.make("worker-session"),
  options: { model: { id: "composer-2.5" }, local: { cwd: "/workspace" } },
};
const runtimeHost: ProviderRuntimeHostService = {
  bind: () => Effect.void, read: () => Effect.succeed(undefined),
  authorize: () => Effect.fail(new Error("No PM authority in worker transport tests.")),
};

function harness(options: { holdOpen?: boolean; holdWait?: boolean; closeFailure?: boolean; scopeFailure?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const opened = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<Record<string, unknown>>();
  const stopped: string[] = [];
  let waitId: unknown;
  const child = Object.assign(new EventEmitter(), {
    pid: 999_999_999, connected: true, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    send: vi.fn((message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
      sent.push(message);
      callback?.(null);
      const reply = (result?: unknown) => queueMicrotask(() => child.emit("message", { type: "result", id: message.id, result }));
      switch (message.operation) {
        case "open": opened.resolve(); if (!options.holdOpen) reply({ agentId: "native-agent" }); break;
        case "send": reply({ agentId: "native-agent", runId: "native-run" }); break;
        case "wait":
          waitId = message.id;
          waiting.resolve();
          if (!options.holdWait) reply({ id: "native-run", status: "finished" });
          break;
        case "cancel":
          reply();
          queueMicrotask(() => child.emit("message", { type: "result", id: waitId, result: { id: "native-run", status: "cancelled" } }));
          break;
        case "close":
          if (options.closeFailure) queueMicrotask(() => child.emit("message", { type: "failure", id: message.id, error: { name: "CleanupError" } }));
          else reply();
          break;
        default: if (message.type === "delta.ack") acknowledged.resolve(message);
      }
      return true;
    }),
  });
  const exit = () => { child.connected = false; child.signalCode = "SIGKILL"; child.emit("exit", null, "SIGKILL"); };
  vi.mocked(ChildProcess.spawn).mockReturnValue(child as unknown as ChildProcess.ChildProcess);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { exit(); return true; });
  vi.mocked(ChildProcess.execFile).mockImplementation((...args: unknown[]) => {
    exit();
    const callback = args.at(-1);
    if (typeof callback === "function") callback(null, "", "");
    return child as unknown as ChildProcess.ChildProcess;
  });
  const scope: AgentScopeShape = {
    wrap: launch => Effect.succeed({ ...launch, unit: "owned-cursor-scope" }),
    stop: unit => Effect.sync(() => stopped.push(unit)).pipe(Effect.andThen(options.scopeFailure ? Effect.die(new Error("scope cleanup failed")) : Effect.void)),
    clear: () => Effect.void, oomKilled: () => Effect.succeed(false),
  };
  const runner = makeCursorSdkWorkerRunner({ HOME: "/native-home" }, "/private/cursor-state", runtimeHost, scope);
  return { runner, child, sent, opened, waiting, acknowledged, stopped, kill };
}

describe("Cursor SDK worker ownership", () => {
  it.effect.each([{ closeFailure: true }, { scopeFailure: true }])("attempts every cleanup boundary and retains failure %j", options =>
    Effect.gen(function* () {
      const h = harness(options);
      const session = yield* h.runner.open(input);
      assert.equal((yield* h.runner.assertComplete.pipe(Effect.result))._tag, "Failure");
      const closed = yield* session.close.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(closed));
      assert.deepEqual(h.stopped, ["owned-cursor-scope"]);
      assert.equal((yield* h.runner.assertComplete.pipe(Effect.result))._tag, "Success");
      assert.isTrue(Exit.isFailure(yield* session.close.pipe(Effect.exit)));
      assert.equal(h.sent.filter(message => message.operation === "close").length, 1);
      assert.equal(h.child.signalCode, "SIGKILL");
    }),
  );
  it.effect("releases the exact scope when spawning fails synchronously", () =>
    Effect.gen(function* () {
      const h = harness();
      vi.mocked(ChildProcess.spawn).mockImplementationOnce(() => { throw new Error("spawn failed"); });
      const result = yield* h.runner.open(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.method, "open");
      assert.deepEqual(h.stopped, ["owned-cursor-scope"]);
      assert.equal(h.kill.mock.calls.length, 0);
      yield* h.runner.assertComplete;
    }),
  );


  it.effect("cleans the exact worker scope when opening is interrupted", () =>
    Effect.gen(function* () {
      const h = harness({ holdOpen: true });
      const opening = yield* h.runner.open(input).pipe(Effect.forkScoped);
      yield* Effect.promise(() => h.opened.promise);
      yield* Fiber.interrupt(opening);
      assert.deepEqual(h.stopped, ["owned-cursor-scope"]);
      assert.equal(h.sent.filter(message => message.operation === "close").length, 1);
      yield* h.runner.assertComplete;
    }).pipe(Effect.scoped),
  );

  it.effect("keeps native cancellation distinct from successful completion", () =>
    Effect.gen(function* () {
      const h = harness({ holdWait: true });
      const session = yield* h.runner.open(input);
      const run = yield* session.send({ message: "native message" });
      const pending = yield* run.wait.pipe(Effect.forkScoped);
      yield* Effect.promise(() => h.waiting.promise);
      yield* run.cancel;
      assert.equal((yield* Fiber.join(pending)).status, "cancelled");
      yield* session.close;
      yield* h.runner.assertComplete;
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])("retains a %s synchronous callback failure even if the peer reports finished", synchronous =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* h.runner.open(input);
      const failure = new Error("consumer callback failed");
      const run = yield* session.send({ message: "native message", onDelta: () => {
        if (synchronous) throw failure;
        return Effect.fail(failure);
      } });
      h.child.emit("message", { type: "delta", sequence: 1, update: { type: "assistant-message-chunk", text: "partial" } });
      assert.equal((yield* Effect.promise(() => h.acknowledged.promise)).ok, false);
      const result = yield* run.wait.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.cause, failure);
      yield* session.close;
      yield* h.runner.assertComplete;
    }),
  );

  it.effect("does not treat disconnected IPC as native completion or worker exit", () =>
    Effect.gen(function* () {
      const h = harness({ holdWait: true });
      const session = yield* h.runner.open(input);
      const run = yield* session.send({ message: "native message" });
      const pending = yield* run.wait.pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => h.waiting.promise);
      h.child.connected = false;
      h.child.emit("disconnect");
      assert.equal((yield* Fiber.join(pending))._tag, "Failure");
      assert.equal((yield* h.runner.assertComplete.pipe(Effect.result))._tag, "Failure");
      assert.isTrue(Exit.isFailure(yield* session.close.pipe(Effect.exit)));
      assert.deepEqual(h.stopped, ["owned-cursor-scope"]);
      yield* h.runner.assertComplete;
    }).pipe(Effect.scoped),
  );
});

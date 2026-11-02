import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeOmpRpcConnection, type OmpRpcRecord } from "./rpc.ts";
import { makeOmpTestProcess } from "./transportTestHelpers.ts";

const connect = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], startupTimeoutMs?: number) => makeOmpRpcConnection({
  command: "omp", args: ["--mode", "rpc-ui"], env: {}, cwd: undefined,
  ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
}).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

 describe("OMP RPC connection", () => {
  it.effect("negotiates v2 before returning, preserves explicit IDs and returns only response.data", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ onRequest: (request, controls) => controls.reply(request, { answer: 42 }) });
    const connection = yield* connect(process.spawner);
    assert.equal(process.received[0]?.type, "negotiate_protocol");
    const data = yield* connection.request({ id: "host-owned-id", type: "get_state" });
    assert.deepEqual(data, { answer: 42 });
    assert.equal(process.received[1]?.id, "host-owned-id");
  }).pipe(Effect.scoped));

  it.effect("matches concurrent responses by id, not by emission order", () => Effect.gen(function* () {
    const held: OmpRpcRecord[] = [];
    const process = yield* makeOmpTestProcess({ onRequest: (request, controls) => Effect.gen(function* () {
      held.push(request);
      if (held.length === 2) {
        yield* controls.reply(held[1]!, { id: held[1]!.id });
        yield* controls.reply(held[0]!, { id: held[0]!.id });
      }
    }) });
    const connection = yield* connect(process.spawner);
    const values = yield* Effect.all([
      connection.request({ id: "first", type: "get_state" }),
      connection.request({ id: "second", type: "get_entries" }),
    ], { concurrency: "unbounded" });
    assert.deepEqual(values, [{ id: "first" }, { id: "second" }]);
  }).pipe(Effect.scoped));

  it.effect("rejects duplicate pending ids without replacing the original deferred", () => Effect.gen(function* () {
    const seen = yield* Deferred.make<void>();
    const process = yield* makeOmpTestProcess({ onRequest: () => Deferred.succeed(seen, undefined).pipe(Effect.asVoid) });
    const connection = yield* connect(process.spawner);
    const first = yield* connection.request({ id: "same", type: "get_state" }).pipe(Effect.forkScoped);
    yield* Deferred.await(seen);
    const error = yield* connection.request({ id: "same", type: "get_state" }).pipe(Effect.flip);
    assert.equal(error._tag, "OmpRpcError");
    yield* process.controls.reply({ id: "same", type: "get_state" }, { original: true });
    assert.deepEqual(yield* Fiber.join(first), { original: true });
    assert.equal(process.received.filter((record) => record.id === "same").length, 1);
  }).pipe(Effect.scoped));

  it.effect("keeps prompt_result and post-admission failures on events after normal response", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ onRequest: (request, controls) => Effect.gen(function* () {
      yield* controls.reply(request, { agentInvoked: true });
      yield* controls.emit({ type: "prompt_result", id: request.id, agentInvoked: true, status: "error", error: { message: "provider failed" }, sessionSettled: true });
      yield* controls.emit({ type: "response", id: request.id, command: "prompt", success: false, error: "late failure" });
    }) });
    const connection = yield* connect(process.spawner);
    assert.deepEqual(yield* connection.request({ id: "prompt-1", type: "prompt", message: "hello" }), { agentInvoked: true });
    const result = yield* Queue.take(connection.events);
    assert.equal(result.type, "prompt_result");
    assert.equal(result.id, "prompt-1");
    assert.equal(result.status, "error");
    assert.equal((yield* Queue.take(connection.events)).success, false);
  }).pipe(Effect.scoped));

  it.effect("fails closed when a response id is paired with the wrong command", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ onRequest: (request, controls) => controls.emit({ type: "response", id: request.id, command: "other", success: true, data: {} }) });
    const connection = yield* connect(process.spawner);
    const error = yield* connection.request({ type: "get_state" }).pipe(Effect.flip);
    assert.equal(error._tag, "OmpRpcError");
  }).pipe(Effect.scoped));

  it.effect("fails outstanding commands on exit while retaining already delivered events", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ onRequest: (_request, controls) => Effect.gen(function* () {
      yield* controls.emit({ type: "notice", message: "last native event" });
      yield* controls.exit(7);
    }) });
    const connection = yield* connect(process.spawner);
    const error = yield* connection.request({ type: "get_state" }).pipe(Effect.flip);
    assert.equal(error._tag, "OmpRpcError");
    assert.equal((yield* Queue.take(connection.events)).type, "notice");
    assert.equal(yield* connection.exited, 7);
  }).pipe(Effect.scoped));

  it.effect("continues draining stdout after closing stdin during terminate", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ onEof: (controls) => controls.emit({ type: "session_settled", final: true }) });
    const connection = yield* connect(process.spawner);
    yield* connection.terminate;
    assert.isTrue(process.didCloseStdin());
    assert.equal(yield* connection.exited, 0);
    assert.deepEqual(yield* Queue.take(connection.events), { type: "session_settled", final: true });
  }).pipe(Effect.scoped));

  it.effect("uses a distinct startup deadline and reaps a never-ready child", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ ready: false });
    const fiber = yield* connect(process.spawner, 20).pipe(Effect.flip, Effect.forkScoped);
    yield* TestClock.adjust(21);
    const error = yield* Fiber.join(fiber);
    assert.equal(error._tag, "OmpRpcTimeoutError");
    assert.isTrue(process.didCloseStdin());
  }).pipe(Effect.scoped));

  it.effect("times out a command without swallowing its later unsolicited response", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ onRequest: () => Effect.void });
    const connection = yield* connect(process.spawner);
    const fiber = yield* connection.request({ id: "slow", type: "get_state" }, 10).pipe(Effect.flip, Effect.forkScoped);
    yield* TestClock.adjust(11);
    assert.equal((yield* Fiber.join(fiber))._tag, "OmpRpcTimeoutError");
    yield* process.controls.reply({ id: "slow", type: "get_state" }, { late: true });
    assert.equal((yield* Queue.take(connection.events)).id, "slow");
  }).pipe(Effect.scoped));
  it.effect("refuses ready without lossless v2 and never submits ordinary commands", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess({ ready: {
      type: "ready", protocolVersion: 1, supportedProtocolVersions: [1],
      maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
    } });
    const error = yield* connect(process.spawner).pipe(Effect.flip);
    assert.equal(error._tag, "OmpRpcError");
    assert.lengthOf(process.received, 0);
    assert.isTrue(process.didCloseStdin());
  }).pipe(Effect.scoped));

  it.effect("refuses oversized unchunked stdin before writing and leaves valid requests usable", () => Effect.gen(function* () {
    const process = yield* makeOmpTestProcess();
    const connection = yield* connect(process.spawner);
    const error = yield* connection.send({ type: "host_tool_result", result: "x".repeat(1048576) }).pipe(Effect.flip);
    assert.equal(error._tag, "OmpRpcError");
    assert.isUndefined(process.received.find((request) => request.type === "host_tool_result"));
    assert.deepEqual(yield* connection.request({ type: "get_state" }), {});
  }).pipe(Effect.scoped));
});

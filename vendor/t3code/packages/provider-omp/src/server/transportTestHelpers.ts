// Controlled native-process boundary for behavior tests; never launches an external CLI.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { OmpRpcRecord } from "./rpc.ts";

export interface OmpTestControls {
  readonly emit: (record: OmpRpcRecord) => Effect.Effect<void>;
  readonly emitBytes: (bytes: Uint8Array) => Effect.Effect<void>;
  readonly reply: (request: OmpRpcRecord, data?: unknown) => Effect.Effect<void>;
  readonly exit: (code?: number) => Effect.Effect<void>;
}

export const makeOmpTestProcess = Effect.fnUntraced(function* (input: {
  readonly ready?: OmpRpcRecord | false;
  readonly onRequest?: (request: OmpRpcRecord, controls: OmpTestControls) => Effect.Effect<void>;
  readonly onEof?: (controls: OmpTestControls) => Effect.Effect<void>;
} = {}) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const received: OmpRpcRecord[] = [];
  const launches: ReadonlyArray<string>[] = [];
  let eof = false;
  let didExit = false;
  const emitBytes = (bytes: Uint8Array) => Queue.offer(stdout, bytes).pipe(Effect.asVoid);
  const emit = (record: OmpRpcRecord) => emitBytes(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
  const controls: OmpTestControls = {
    emit, emitBytes,
    reply: (request, data) => emit({ type: "response", id: request.id, command: request.type, success: true, data }),
    exit: (code = 0) => Effect.gen(function* () {
      didExit = true;
      yield* Queue.end(stdout);
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(code));
    }),
  };
  const spawner = ChildProcessSpawner.make((command) => Effect.gen(function* () {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    launches.push(args);
    if (args.includes("--version")) return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(999_999_998), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false), kill: () => Effect.void, unref: Effect.succeed(Effect.void),
      stdin: Sink.drain, stdout: Stream.succeed(new TextEncoder().encode("omp 18.13.2\n")), stderr: Stream.empty, all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty,
    });
    if (input.ready !== false) yield* emit(input.ready ?? {
      type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
    });
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(999_999_999),
      exitCode: Deferred.await(exitDeferred), isRunning: Effect.sync(() => !didExit),
      kill: () => controls.exit(143), unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((bytes: Uint8Array) => Effect.gen(function* () {
        const request = JSON.parse(new TextDecoder().decode(bytes)) as OmpRpcRecord;
        received.push(request);
        if (request.type === "negotiate_protocol") return yield* controls.reply(request, { protocolVersion: 2 });
        if (input.onRequest !== undefined) return yield* input.onRequest(request, controls);
        yield* controls.reply(request, {});
      })).pipe(Sink.ensuring(Effect.gen(function* () {
        eof = true;
        if (input.onEof !== undefined) yield* input.onEof(controls);
        yield* controls.exit();
      }))),
      stdout: Stream.fromQueue(stdout), stderr: Stream.empty, all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty,
    });
  }));
  return { spawner, received, launches, controls, didCloseStdin: () => eof };
});

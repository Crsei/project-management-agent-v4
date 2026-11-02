import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { OmpFrameDecoder, encodeOmpStdinFrame, OMP_MAX_FRAME_BYTES } from "./frame.ts";

export class OmpRpcError extends Schema.TaggedError<OmpRpcError>()("OmpRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `OMP RPC ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class OmpRpcTimeoutError extends Schema.TaggedError<OmpRpcTimeoutError>()("OmpRpcTimeoutError", {
  operation: Schema.String,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}) {
  override get message(): string {
    return `OMP RPC ${this.operation} timed out after ${this.timeoutMs}ms.`;
  }
}

export type OmpRpcRecord = Record<string, unknown>;
export function ompRecordField(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as OmpRpcRecord)[key] : undefined;
}
export function ompRecordString(input: unknown, key: string): string | undefined {
  const value = ompRecordField(input, key);
  return typeof value === "string" ? value : undefined;
}
export function ompRecordNumber(input: unknown, key: string): number | undefined {
  const value = ompRecordField(input, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function parseOmpModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1 || slug.trim() !== slug) return null;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

export interface OmpRpcSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** Ready + negotiation have a separate budget from command round trips. */
  readonly startupTimeoutMs?: number;
}
export interface OmpRpcConnection {
  readonly send: (record: OmpRpcRecord) => Effect.Effect<void, OmpRpcError>;
  readonly request: (record: OmpRpcRecord, timeoutMs?: number) => Effect.Effect<unknown, OmpRpcError | OmpRpcTimeoutError>;
  readonly events: Queue.Queue<OmpRpcRecord, OmpRpcError>;
  /** Resolves only after stdout has been drained, including terminal records. */
  readonly exited: Effect.Effect<number, OmpRpcError>;
  readonly terminate: Effect.Effect<void>;
}
export const OMP_STARTUP_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, OmpRpcError>;
}
function errorSummary(value: unknown): string {
  const text = typeof value === "string" ? value : ompRecordString(value, "message") ?? "command rejected";
  return text.slice(0, 500);
}

/** One native child per scope. No credential discovery, installation or global process management. */
export const makeOmpRpcConnection = Effect.fnUntraced(function* (options: OmpRpcSpawnOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;
  const startupTimeoutMs = options.startupTimeoutMs ?? OMP_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
    return yield* new OmpRpcError({ operation: "startup", detail: "Invalid startup timeout" });
  }
  const spawn = yield* resolveSpawnCommand(options.command, [...options.args], { env: options.env }).pipe(
    Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })),
  );
  const child = yield* spawner.spawn(ChildProcess.make(spawn.command, spawn.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    extendEnv: false,
    shell: spawn.shell,
    detached: platform !== "win32",
  })).pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));
  let stopped = false;
  let childExited = false;
  let transportError: OmpRpcError | undefined;
  const signalOwnedProcess = (signal: "SIGTERM" | "SIGKILL") => Effect.gen(function* () {
    if (childExited) return;
    const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false));
    if (!running) { childExited = true; return; }
    if (platform === "win32") {
      yield* Effect.gen(function* () {
        if (childExited) return;
        const taskkill = yield* spawner.spawn(ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]));
        yield* taskkill.exitCode;
      }).pipe(Effect.scoped, Effect.ignore);
      return;
    }
    // No intervening await between the identity guard and signalling our detached group.
    if (!childExited) {
      try { signalProcessGroup(Number(child.pid), signal); } catch { /* Already exited. */ }
    }
  });
  // Covers interruption during setup, before reader/writer fibers and graceful teardown exist.
  yield* Scope.addFinalizer(scope, Effect.suspend(() => stopped ? Effect.void : signalOwnedProcess("SIGKILL")));

  const events = yield* Queue.unbounded<OmpRpcRecord, OmpRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, OmpRpcError | Cause.Done>();
  const down = yield* Deferred.make<never, OmpRpcError>();
  const exit = yield* Deferred.make<number, OmpRpcError>();
  const drained = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<void, OmpRpcError>();
  const pending = new Map<string, PendingRequest>();
  const decoder = new OmpFrameDecoder();
  const prefix = `omp-${crypto.randomUUID()}-`;
  const negotiationId = `${prefix}protocol`;
  let nextId = 0;
  let didReady = false;
  let didNegotiate = false;
  let physicalLimit = OMP_MAX_FRAME_BYTES;

  const fail = Effect.fnUntraced(function* (error: OmpRpcError) {
    if (transportError !== undefined) return;
    transportError = error;
    yield* Deferred.fail(down, error);
    yield* Deferred.fail(ready, error);
    for (const request of pending.values()) yield* Deferred.fail(request.deferred, error);
    pending.clear();
    yield* Queue.shutdown(outgoing);
    // Queue.fail preserves buffered records; consumers can drain the last terminal before failure.
    yield* Queue.fail(events, error);
  });
  const exited = Deferred.await(drained).pipe(Effect.andThen(Deferred.await(exit)));
  const liveWait = (effect: Effect.Effect<unknown, unknown>, milliseconds: number) => effect.pipe(
    Effect.timeoutOption(milliseconds),
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
    Effect.ignore,
  );
  const terminate = Effect.gen(function* () {
    if (stopped) return;
    stopped = true;
    // Finish stdin first; the stdout fiber remains alive throughout graceful shutdown.
    yield* Queue.end(outgoing);
    yield* liveWait(exited, 1_000);
    if (!childExited) {
      yield* signalOwnedProcess("SIGTERM");
      yield* liveWait(exited, 1_000);
    }
    // The handle owns this child; never signal a recycled PID/process group after exit.
    if (!childExited) {
      yield* signalOwnedProcess("SIGKILL");
      yield* liveWait(exited, 1_000);
    }
    yield* fail(new OmpRpcError({ operation: "terminate", detail: "OMP process was stopped" }));
  }).pipe(Effect.uninterruptible);
  yield* Scope.addFinalizer(scope, terminate);

  const route = Effect.fnUntraced(function* (record: OmpRpcRecord) {
    if (record.type === "ready") {
      yield* Deferred.succeed(ready, undefined);
      return;
    }
    if (record.type === "response" && typeof record.id === "string") {
      const request = pending.get(record.id);
      if (request !== undefined) {
        if (record.command !== request.operation || typeof record.success !== "boolean") {
          return yield* new OmpRpcError({ operation: "read", detail: "Mismatched OMP response command" });
        }
        pending.delete(record.id);
        if (record.success) yield* Deferred.succeed(request.deferred, record.data);
        else yield* Deferred.fail(request.deferred, new OmpRpcError({
          operation: request.operation,
          detail: errorSummary(record.error),
          cause: record.error,
        }));
        return;
      }
    }
    // prompt_result and late post-admission response failures belong to the adapter.
    yield* Queue.offer(events, record);
  });

  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        const error = new OmpRpcError({ operation: "exit", cause });
        return Deferred.fail(exit, error).pipe(Effect.andThen(fail(error)));
      },
      onSuccess: (code) => Effect.sync(() => { childExited = true; }).pipe(
        Effect.andThen(Deferred.succeed(exit, Number(code))),
      ),
    }),
    Effect.forkIn(scope),
  );
  yield* child.stdout.pipe(
    Stream.runForEach((bytes) => Effect.gen(function* () {
      const records = yield* Effect.try({
        try: () => {
          const decoded: OmpRpcRecord[] = [];
          decoder.push(bytes, (record) => {
            if (!didReady) {
              if (record.type !== "ready" || record.protocolVersion !== 1 ||
                !Array.isArray(record.supportedProtocolVersions) || !record.supportedProtocolVersions.includes(2)) {
                throw new Error("OMP must advertise ready with protocol v2 support");
              }
              decoder.setLimits(record.maxFrameBytes as number, record.maxReassembledFrameBytes as number);
              physicalLimit = record.maxFrameBytes as number;
              didReady = true;
            } else if (record.type === "ready") throw new Error("Duplicate OMP ready frame");
            if (record.type === "rpc_frame_error") throw new Error("OMP could not deliver a lossless RPC frame");
            if (record.type === "response" && record.id === negotiationId && record.command === "negotiate_protocol" &&
              record.success === true && ompRecordField(record.data, "protocolVersion") === 2) {
              decoder.enableV2();
              didNegotiate = true;
            }
            decoded.push(record);
          });
          return decoded;
        },
        catch: (cause) => new OmpRpcError({ operation: "read", detail: "Invalid OMP RPC framing", cause }),
      });
      for (const record of records) yield* route(record);
    })),
    Effect.andThen(Effect.try({
      try: () => decoder.finish(),
      catch: (cause) => new OmpRpcError({ operation: "read", detail: "Truncated OMP RPC output", cause }),
    })),
    Effect.matchCauseEffect({
      onFailure: (cause) => signalOwnedProcess("SIGTERM").pipe(Effect.andThen(fail(new OmpRpcError({ operation: "read", cause })))),
      onSuccess: () => fail(new OmpRpcError({ operation: "read", detail: "OMP stdout closed" })),
    }),
    Effect.ensuring(Deferred.succeed(drained, undefined)),
    Effect.forkIn(scope),
  );
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) => signalOwnedProcess("SIGTERM").pipe(Effect.andThen(fail(new OmpRpcError({ operation: "write", cause }))))),
    Effect.forkIn(scope),
  );
  // Installed after reader fibers so scope teardown closes stdin while stdout is still being drained.
  yield* Scope.addFinalizer(scope, terminate);

  const send = Effect.fnUntraced(function* (record: OmpRpcRecord): Effect.fn.Return<void, OmpRpcError> {
    if (transportError !== undefined) return yield* transportError;
    if (stopped) return yield* new OmpRpcError({ operation: "write", detail: "OMP stdin is closed" });
    const bytes = yield* Effect.try({
      try: () => encodeOmpStdinFrame(record, physicalLimit),
      catch: (cause) => new OmpRpcError({ operation: "write", detail: "Invalid or oversized OMP input", cause }),
    });
    const accepted = yield* Queue.offer(outgoing, bytes);
    if (!accepted) return yield* Deferred.await(down);
  });
  const request = Effect.fnUntraced(function* (
    record: OmpRpcRecord,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Effect.fn.Return<unknown, OmpRpcError | OmpRpcTimeoutError> {
    const operation = ompRecordString(record, "type");
    if (operation === undefined || operation.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return yield* new OmpRpcError({ operation: operation ?? "request", detail: "Invalid request or timeout" });
    }
    if (record.id !== undefined && typeof record.id !== "string") {
      return yield* new OmpRpcError({ operation, detail: "OMP request id must be a string" });
    }
    const id = typeof record.id === "string" ? record.id : `${prefix}${nextId++}`;
    if (pending.has(id)) return yield* new OmpRpcError({ operation, detail: "Duplicate pending OMP request id" });
    // Reserve without an Effect yield between duplicate detection and insertion.
    const deferred = Deferred.makeUnsafe<unknown, OmpRpcError>();
    pending.set(id, { operation, deferred });
    return yield* send({ ...record, id }).pipe(
      Effect.andThen(Effect.raceFirst(Deferred.await(deferred), Deferred.await(down))),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new OmpRpcTimeoutError({ operation, timeoutMs })),
      }),
      Effect.ensuring(Effect.sync(() => { if (pending.get(id)?.deferred === deferred) pending.delete(id); })),
    );
  });
  yield* Deferred.await(ready).pipe(
    Effect.andThen(request({ id: negotiationId, type: "negotiate_protocol", protocolVersion: 2 }, startupTimeoutMs)),
    Effect.flatMap((data) => didNegotiate && ompRecordField(data, "protocolVersion") === 2
      ? Effect.void
      : Effect.fail(new OmpRpcError({ operation: "negotiate_protocol", detail: "OMP did not negotiate protocol v2" }))),
    Effect.timeoutOrElse({
      duration: startupTimeoutMs,
      orElse: () => Effect.fail(new OmpRpcTimeoutError({ operation: "startup", timeoutMs: startupTimeoutMs })),
    }),
    Effect.onError(() => terminate),
  );
  return { request, send, events, exited, terminate } satisfies OmpRpcConnection;
});

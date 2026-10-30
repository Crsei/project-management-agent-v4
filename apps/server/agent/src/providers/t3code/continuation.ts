import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { ProviderContinuationRequests, type ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { emitNativeNotification, getNativeOutput } from "../../durable/native-output.ts";
import { z } from "zod";
import {
  ProviderInstanceId, type ProviderDriverKind,
  OrchestrationV2ProviderSessionJson, OrchestrationV2ProviderThreadJson, OrchestrationV2ProviderTurnJson,
  type OrchestrationV2ProviderSession, type OrchestrationV2ProviderThread, type OrchestrationV2ProviderTurn, type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { NativeSessionRef, ProviderDriver } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2TurnInput, ProviderAdapterV2EnsureThreadInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderNativeHistoryBoundary } from "@t3tools/provider-core/server/ProviderAdapter";
import { readRecord, transaction, writeRecord } from "../../durable/store.ts";
import type { PmProviderBoundaryError, PmProviderLease } from "./contract.ts";

export const PM_CONTINUATIONS = "provider:t3code:continuations";
export const PM_UPSTREAM_COMMIT = "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c";
const recordSchema = z.object({
  version: z.literal(1), upstreamCommit: z.literal(PM_UPSTREAM_COMMIT), protocol: z.string().min(1),
  providerInstanceId: z.string().min(1), localDriver: z.custom<ProviderDriver>((value) => typeof value === "string"), instanceRevision: z.number().int().nonnegative(),
  cwd: z.string().min(1), nativeHome: z.string().min(1), continuationKey: z.string().min(1), nativeSessionId: z.string().min(1),
  ownerThreadId: z.string().min(1), lastGenerationId: z.string().min(1), providerSessionJson: z.unknown(),
  providerThreadJson: z.unknown(), providerTurnsJson: z.array(z.unknown()),
  nativeHistory: z.unknown().optional(),
});
export type PmContinuationRecord = z.infer<typeof recordSchema>;
export type PmContinuation = {
  record: PmContinuationRecord; session: OrchestrationV2ProviderSession;
  thread: OrchestrationV2ProviderThread; turns: readonly OrchestrationV2ProviderTurn[];
  nativeHistory?: ProviderNativeHistoryBoundary;
};
export type PmProtocolOperation = {
  readonly context: ProviderDriverContext;
  readonly lease: PmProviderLease;
  readonly runtime: ProviderAdapterV2SessionRuntime;
};
export interface PmProviderProtocolProbe {
  /** Exact dialect from THIS operation's original runtime probe/handshake. */
  readonly protocol: string;
  /** Original family helper only: drain/adopt existing native work, never send a prompt or create a generation. */
  readonly adoptBuffered?: (input: PmProtocolOperation & {
    readonly request: ProviderContinuationRequest;
    readonly turn: Omit<ProviderAdapterV2TurnInput, "message">;
    readonly isCurrent: Effect.Effect<boolean, PmProviderBoundaryError>;
  }) => Effect.Effect<boolean, PmProviderBoundaryError>;
  readonly adoptLegacy?: (input: PmProtocolOperation & {
    readonly source: NativeSessionRef;
    readonly ensure: ProviderAdapterV2EnsureThreadInput;
  }) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, PmProviderBoundaryError>;
  /** Retrieves a withheld original item through the family's original full-payload API. */
  readonly readFullItem?: (input: PmProtocolOperation & {
    readonly thread: OrchestrationV2ProviderThread;
    readonly item: OrchestrationV2TurnItem;
  }) => Effect.Effect<OrchestrationV2TurnItem, PmProviderBoundaryError>;
}
export type PmProviderProtocolResolver = (input: PmProtocolOperation) => Effect.Effect<PmProviderProtocolProbe, PmProviderBoundaryError>;
const protocolResolvers = new Map<ProviderDriver, PmProviderProtocolResolver>();

/** Registers behavior, NOT a cached dialect. The resolver executes for every run and fork. */
export function registerPmProviderProtocolResolver(driver: ProviderDriver, resolver: PmProviderProtocolResolver): () => void {
  protocolResolvers.set(driver, resolver);
  return () => { if (protocolResolvers.get(driver) === resolver) protocolResolvers.delete(driver); };
}
export function resolvePmProviderProtocol(input: PmProtocolOperation): Effect.Effect<PmProviderProtocolProbe, PmProviderBoundaryError> {
  const resolver = protocolResolvers.get(input.lease.localDriver);
  if (!resolver) return Effect.fail(pmExecutionError(409, "session_mismatch", "The provider family has no operation-scoped native protocol probe."));
  return resolver(input).pipe(Effect.flatMap((probe) => probe.protocol.trim() ? Effect.succeed(probe)
    : Effect.fail(pmExecutionError(409, "session_mismatch", "The native runtime did not confirm its protocol dialect."))));
}

export function pmExecutionError(status: number, code: string, message: string, terminalStatus?: PmProviderBoundaryError["terminalStatus"]): PmProviderBoundaryError {
  return Object.assign(new Error(message), { status, statusCode: status, code, errorClass: "provider_error" as const,
    ...(terminalStatus ? { terminalStatus } : {}) });
}
export function continuationKey(lease: Pick<PmProviderLease, "instanceId" | "revision" | "cwd">, nativeSessionId: string): string {
  return JSON.stringify([lease.instanceId, lease.revision, lease.cwd, nativeSessionId]);
}
/** Native-only evidence is scoped to the actual native session; it is not an application turn graph. */
export function decodePmNativeHistory(value: unknown, driver: ProviderDriverKind, nativeSessionId: string): ProviderNativeHistoryBoundary | undefined {
  if (value === undefined) return undefined;
  try {
    const history = Schema.decodeUnknownSync(ProviderNativeHistoryBoundary)(value);
    if (history.nativeSessionId !== nativeSessionId || !nativeSessionId.trim() || !history.completedTurnRefs.length
      || history.completedTurnRefs.some(ref => ref.driver !== driver || !ref.nativeId.trim())
      || (history.latestCompletedTurnRef !== undefined && (history.latestCompletedTurnRef.driver !== driver
        || !history.completedTurnRefs.some(ref => ref.nativeId === history.latestCompletedTurnRef?.nativeId))))
      throw new Error("Native history identity mismatch.");
    return history;
  } catch {
    throw pmExecutionError(409, "session_mismatch", "Native history does not prove a completed boundary for this session and provider.");
  }
}

/** A historical completed cursor can fork, but must not silently resume an advanced native head. */
export function assertPmContinuationCursor(
  source: NativeSessionRef,
  thread: OrchestrationV2ProviderThread,
  turns: Iterable<OrchestrationV2ProviderTurn>,
  nativeHistory?: ProviderNativeHistoryBoundary,
  forFork = false,
): void {
  const cursor = source.turnId ?? source.messageId;
  let completedCursor = Boolean(cursor?.trim() && nativeHistory?.completedTurnRefs.some(ref => ref.nativeId === cursor));
  let latest: OrchestrationV2ProviderTurn | undefined;
  for (const turn of turns) {
    if (!latest || turn.ordinal > latest.ordinal) latest = turn;
    if (turn.status === "completed" && cursor?.trim() && turn.nativeTurnRef?.nativeId === cursor
      && turn.nativeTurnRef.driver === thread.driver && turn.nativeTurnRef.strength === "strong") completedCursor = true;
  }
  const head = latest?.status === "completed" ? latest.nativeTurnRef : undefined;
  const currentTurnId = head?.driver === thread.driver && head.strength === "strong"
    ? head.nativeId : nativeHistory?.latestCompletedTurnRef?.nativeId;
  const conversationHead = thread.nativeConversationHeadRef;
  const matchesHead = conversationHead?.driver === thread.driver && conversationHead.strength === "strong"
    && source.messageId === conversationHead.nativeId;
  if ((source.turnId && !completedCursor)
    || (!source.turnId && source.messageId && !completedCursor && !matchesHead && thread.nativeMetadata?.forkHeadMessageId !== source.messageId))
    throw pmExecutionError(409, "session_mismatch", "Native metadata cannot prove the saved stable boundary; use an explicit portable handoff.");
  if (!forFork && cursor && completedCursor
    && cursor !== currentTurnId && !(source.turnId === undefined && matchesHead))
    throw pmExecutionError(409, "session_mismatch", "Native resume cursor is stale or has no current-tip proof; use an explicit fork or portable handoff.");
  // Forks may carry an older conversation-head hint alongside their exact completed turn.
  if (!forFork && source.messageId && conversationHead?.driver === thread.driver
    && conversationHead.strength === "strong" && !matchesHead)
    throw pmExecutionError(409, "session_mismatch", "Native resume conversation cursor is stale; use an explicit portable handoff.");
}
export function readPmContinuation(lease: PmProviderLease, source: NativeSessionRef, protocol: string | undefined, ownerThreadId?: string, forFork = false): PmContinuation | undefined {
  if (source.providerInstanceId !== lease.instanceId || source.driver !== lease.localDriver || source.instanceRevision !== lease.revision
    || (source.cwd !== undefined && source.cwd !== lease.cwd))
    throw pmExecutionError(409, "session_mismatch", "Native session belongs to another instance, revision or working directory.");
  const raw = readRecord<unknown>(PM_CONTINUATIONS, continuationKey(lease, source.sessionId));
  if (!raw) return undefined;
  try {
    const record = recordSchema.parse(raw);
    if (record.providerInstanceId !== lease.instanceId || record.localDriver !== lease.localDriver || record.instanceRevision !== lease.revision
      || record.cwd !== lease.cwd || record.nativeHome !== lease.nativeHome || record.continuationKey !== lease.continuationIdentity.continuationKey
      || (protocol !== undefined && record.protocol !== protocol) || record.nativeSessionId !== source.sessionId || (ownerThreadId && record.ownerThreadId !== ownerThreadId))
      throw new Error("Continuation identity mismatch.");
    const session = Schema.decodeUnknownSync(OrchestrationV2ProviderSessionJson)(record.providerSessionJson);
    const thread = Schema.decodeUnknownSync(OrchestrationV2ProviderThreadJson)(record.providerThreadJson);
    const turns = record.providerTurnsJson.map((value) => Schema.decodeUnknownSync(OrchestrationV2ProviderTurnJson)(value));
    const nativeHistory = decodePmNativeHistory(record.nativeHistory, lease.instance.driverKind, source.sessionId);
    if (session.providerInstanceId !== lease.instance.instanceId || thread.providerInstanceId !== lease.instance.instanceId
      || session.driver !== lease.instance.driverKind || thread.driver !== lease.instance.driverKind
      || session.cwd !== lease.cwd || thread.providerSessionId !== session.id || thread.appThreadId !== record.ownerThreadId
      || thread.nativeThreadRef?.nativeId !== source.sessionId || thread.nativeThreadRef.driver !== lease.instance.driverKind
      || thread.nativeThreadRef.strength !== "strong"
      || (!forFork && (thread.status === "error" || thread.status === "closed")) || turns.some((turn) => turn.providerThreadId !== thread.id))
      throw new Error("Invalid native continuation metadata.");
    assertPmContinuationCursor(source, thread, turns, nativeHistory, forFork);
    return { record, session, thread, turns, ...(nativeHistory ? { nativeHistory } : {}) };
  } catch {
    throw pmExecutionError(409, "session_mismatch", "Stored native continuation is incompatible; use an explicit portable handoff.");
  }
}

/** Stores schema-encoded identities only, without messages, tools, environment or transport URLs. */
export function savePmContinuation(input: {
  lease: PmProviderLease; protocol: string; ownerThreadId: string; generationId: string;
  session: OrchestrationV2ProviderSession; thread: OrchestrationV2ProviderThread; turns: readonly OrchestrationV2ProviderTurn[];
  nativeHistory?: ProviderNativeHistoryBoundary;
}): NativeSessionRef | undefined {
  const { lease, thread, session } = input;
  const nativeId = thread.nativeThreadRef?.nativeId;
  if (thread.nativeThreadRef == null) return undefined;
  if (typeof nativeId !== "string" || !nativeId.trim() || thread.nativeThreadRef.driver !== lease.instance.driverKind || thread.nativeThreadRef.strength !== "strong"
    || thread.providerInstanceId !== lease.instance.instanceId || thread.driver !== lease.instance.driverKind
    || session.providerInstanceId !== lease.instance.instanceId || session.driver !== lease.instance.driverKind || session.cwd !== lease.cwd
    || thread.providerSessionId !== session.id || thread.appThreadId !== input.ownerThreadId)
    throw pmExecutionError(409, "session_mismatch", "Native continuation metadata does not match its instance, session and owner.");
  const key = continuationKey(lease, nativeId);
  const turns = input.turns.filter((turn) => turn.providerThreadId === thread.id);
  const nativeHistory = decodePmNativeHistory(input.nativeHistory, lease.instance.driverKind, nativeId);
  const record = recordSchema.parse({ version: 1, upstreamCommit: PM_UPSTREAM_COMMIT, protocol: input.protocol,
    providerInstanceId: lease.instanceId, localDriver: lease.localDriver, instanceRevision: lease.revision, cwd: lease.cwd,
    nativeHome: lease.nativeHome, continuationKey: lease.continuationIdentity.continuationKey, nativeSessionId: nativeId,
    ownerThreadId: input.ownerThreadId, lastGenerationId: input.generationId,
    providerSessionJson: Schema.encodeSync(OrchestrationV2ProviderSessionJson)({ ...session, lastError: null }),
    providerThreadJson: Schema.encodeSync(OrchestrationV2ProviderThreadJson)({ ...thread,
      pendingBackgroundTasks: thread.pendingBackgroundTasks?.map((task) => ({ ...task, description: undefined })) }),
    providerTurnsJson: turns.map((turn) => Schema.encodeSync(OrchestrationV2ProviderTurnJson)(turn)),
    ...(nativeHistory ? { nativeHistory: Schema.encodeSync(ProviderNativeHistoryBoundary)(nativeHistory) } : {}),
  });
  transaction(() => {
    const current = readRecord<PmContinuationRecord>(PM_CONTINUATIONS, key);
    if (current && current.ownerThreadId !== input.ownerThreadId)
      throw pmExecutionError(409, "session_mismatch", "Native continuation belongs to another Chat thread.");
    const generation = readRecord<{ threadId: string; status: string }>("chat:generations", input.generationId);
    if (generation && (generation.threadId !== input.ownerThreadId || !["queued", "running"].includes(generation.status)))
      throw pmExecutionError(409, "session_mismatch", "The Chat generation no longer owns this continuation.");
    writeRecord(PM_CONTINUATIONS, key, record);
  });
  let lastTurn: OrchestrationV2ProviderTurn | undefined;
  for (const turn of turns) if (!lastTurn || turn.ordinal > lastTurn.ordinal) lastTurn = turn;
  const nativeTurn = lastTurn?.status === "completed" ? lastTurn.nativeTurnRef : undefined;
  const turnId = nativeTurn?.driver === lease.instance.driverKind && nativeTurn.strength === "strong" && nativeTurn.nativeId?.trim()
    ? nativeTurn.nativeId : nativeHistory?.latestCompletedTurnRef?.nativeId;
  const messageId = lease.localDriver === "claude"
    ? turnId ?? thread.nativeMetadata?.forkHeadMessageId
    : thread.nativeConversationHeadRef?.driver === lease.instance.driverKind && thread.nativeConversationHeadRef.strength === "strong"
      ? thread.nativeConversationHeadRef.nativeId : undefined;
  return { providerInstanceId: lease.instanceId, driver: lease.localDriver, sessionId: nativeId, instanceRevision: lease.revision,
    cwd: lease.cwd, ...(session.model ? { modelId: session.model } : {}),
    ...(turnId ? { turnId } : {}), ...(messageId ? { messageId } : {}) };
}

export function nextPmOrdinal(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw pmExecutionError(409, "session_mismatch", "Native continuation ordinal is invalid or exhausted.");
  return value + 1;
}

export function nextPmProviderTurnOrdinal(turns: Iterable<Pick<OrchestrationV2ProviderTurn, "ordinal">>): number {
  let ordinal = 0;
  for (const turn of turns) {
    if (!Number.isSafeInteger(turn.ordinal) || turn.ordinal <= 0)
      throw pmExecutionError(409, "session_mismatch", "Native turn metadata contains an invalid ordinal.");
    if (turn.ordinal > ordinal) ordinal = turn.ordinal;
  }
  return nextPmOrdinal(ordinal);
}

type ContinuationSink = { executionId: string; accept: (request: ProviderContinuationRequest) => Promise<boolean>; fail: (error: unknown) => void };
const continuationSinks = new Map<string, ContinuationSink>();
export function bindPmContinuationSink(threadId: string, sink: ContinuationSink): () => void {
  if (continuationSinks.has(threadId)) throw pmExecutionError(409, "provider_busy", "This technical thread already has a live native execution.");
  continuationSinks.set(threadId, sink);
  return () => { if (continuationSinks.get(threadId) === sink) continuationSinks.delete(threadId); };
}

/** A retained driver service routes only requests carrying their original live host owner. */
export function makePmProviderContinuationRequests(context: ProviderDriverContext, runtimeHost: ProviderRuntimeHostService) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    let inFlight: ProviderContinuationRequest | undefined;
    const failures: unknown[] = [];
    const causeFailures = (cause: Cause.Cause<unknown>) => cause.reasons.flatMap(reason =>
      Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : []);
    const handle = (request: ProviderContinuationRequest, finalizing: boolean) => Effect.gen(function* () {
      const owner = request.hostExecution;
      const generation = owner
        ? readRecord<{ threadId: string; status: string; providerInstanceId: string }>("chat:generations", owner.executionId)
        : undefined;
      const trusted = owner && generation?.threadId === owner.threadId && generation.providerInstanceId === context.instanceId
        ? { threadId: owner.threadId, generationId: owner.executionId } : undefined;
      const binding = trusted
        ? yield* runtimeHost.read({ providerInstanceId: ProviderInstanceId.make(context.instanceId), threadId: trusted.threadId })
        : undefined;
      const output = trusted ? getNativeOutput(trusted.generationId) : null;
      const child = output?.items.find((item) => item.id === `native-child:${request.threadId}`);
      const childInput = child?.input;
      const knownChild = child !== undefined && (childInput === null || typeof childInput !== "object"
        || !("providerThreadId" in childInput) || childInput.providerThreadId === null || childInput.providerThreadId === request.providerThreadId);
      const permittedNotice = trusted && output?.threadId === trusted.threadId && (request.threadId === trusted.threadId || knownChild);
      const sink = continuationSinks.get(request.threadId);
      const live = !finalizing && trusted && permittedNotice && binding?.executionId === trusted.generationId
        && sink?.executionId === trusted.generationId && (generation?.status === "running" || generation?.status === "queued");
      const noticeId = `native-continuation:${createHash("sha256").update(JSON.stringify([request.providerThreadId, request.messageId, request.notification?.summary])).digest("hex")}`;
      const closeRequest = Effect.sync(() => {
        if (trusted && permittedNotice) emitNativeNotification(trusted.generationId, trusted.threadId, {
          id: noticeId, type: "notification",
          status: request.notification?.outcome === "completed" ? "completed" : request.notification?.outcome === "failed" ? "failed"
            : request.notification?.outcome === "cancelled" ? "cancelled" : "interrupted",
          title: "Native background notification",
          text: request.notification?.detail ?? request.notification?.summary ?? request.detail ?? "Native background work was not adopted. No new generation or original prompt was automatically dispatched.",
        });
      }).pipe(Effect.ensuring(Effect.suspend(() => request.clearIfCurrent ? request.clearIfCurrent() : Effect.void)));
      const handled = yield* Effect.exit(live && sink && binding
        ? runtimeHost.authorize({ providerInstanceId: binding.providerInstanceId, threadId: binding.threadId,
          executionId: binding.executionId, action: "tool" }).pipe(
          Effect.andThen(Effect.promise(() => sink.accept(request))),
          Effect.flatMap((adopted) => adopted ? Effect.void : closeRequest),
        )
        : closeRequest);
      if (handled._tag === "Failure") {
        if (Cause.hasInterruptsOnly(handled.cause)) return yield* Effect.failCause(handled.cause);
        const errors = causeFailures(handled.cause);
        const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, "Native buffered continuation failed.");
        if (!finalizing && !live) failures.push(...errors);
        const reported = yield* Effect.exit(Effect.gen(function* () {
          if (live && sink) sink.fail(Object.assign(pmExecutionError(502, "provider_continuation_failed", "Native buffered continuation failed."), { cause }));
          else if (trusted && permittedNotice) emitNativeNotification(trusted.generationId, trusted.threadId, {
            id: noticeId, type: "notification", status: "failed", title: "Native continuation cleanup failed",
            text: "Native continuation cleanup failed; no new generation was started.",
          });
          else yield* Effect.logError("Native continuation cleanup failed; no new generation was started.");
        }));
        if (finalizing) return yield* Effect.failCause(reported._tag === "Failure" ? Cause.combine(handled.cause, reported.cause) : handled.cause);
        if (reported._tag === "Failure") return yield* Effect.failCause(reported.cause);
      }
    });
    const worker = yield* Effect.forever(Effect.gen(function* () {
      const request = yield* Queue.take(queue);
      inFlight = request;
      yield* handle(request, false);
      inFlight = undefined;
    })).pipe(Effect.onExit(exit => Effect.sync(() => {
      if (exit._tag === "Failure") failures.push(...causeFailures(exit.cause));
    })), Effect.forkScoped({ startImmediately: true }));
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      const cleanup = (request: ProviderContinuationRequest) => handle(request, true).pipe(Effect.exit, Effect.tap(result => Effect.sync(() => {
        if (result._tag === "Failure") failures.push(...causeFailures(result.cause));
      })));
      yield* Queue.interrupt(queue);
      yield* Fiber.interrupt(worker);
      if (inFlight) yield* cleanup(inFlight);
      for (;;) {
        const pending = yield* Queue.poll(queue);
        if (Option.isNone(pending)) break;
        yield* cleanup(pending.value);
      }
      yield* Queue.shutdown(queue);
      if (failures.length) return yield* Effect.die(new AggregateError(failures, "Native continuation cleanup failed."));
    }));
    return ProviderContinuationRequests.of({ offer: (request) => Queue.offer(queue, request).pipe(Effect.asVoid), take: Queue.take(queue) });
  });
}

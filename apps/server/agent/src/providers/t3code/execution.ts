import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import {
  ThreadId, RunId, MessageId, ProjectId, ProviderInstanceId, ModelSelection, OrchestrationV2AppThread,
  OrchestrationV2ProviderThreadJson, OrchestrationV2ProviderTurnJson,
  type OrchestrationV2ProviderThread, type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event, ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { CliChatResult } from "../../agents/cli-chat.ts";
import type { ProviderDriverContext, ProviderDriverRunOptions } from "../driver-adapter.ts";
import { sanitizeErrorText } from "../verify.ts";
import { classifyProviderError } from "../errors.ts";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import { readRecord } from "../../durable/store.ts";
import type { PmProviderExecutionService, PmProviderHostService } from "./contract.ts";
import { makePmEventAdapter, pmAdapterBoundaryError, pmEventTime } from "./events.ts";
import { pmRuntimeBinding } from "./runtime-host.ts";
import { makePmUsageUpdates, pmThreadUsage, pmTurnUsage } from "./usage.ts";
import { assertPmContinuationCursor, bindPmContinuationSink, decodePmNativeHistory, nextPmOrdinal, nextPmProviderTurnOrdinal, pmExecutionError, readPmContinuation, resolvePmProviderProtocol, savePmContinuation,
  type PmProviderProtocolProbe } from "./continuation.ts";

/** Single application instance, configured by parent lifecycle assembly. No driver or protocol registry here. */
export function makePmProviderExecutionService(host: PmProviderHostService, runtimeHost: ProviderRuntimeHostService): PmProviderExecutionService {
  const execute = async (context: ProviderDriverContext, options: ProviderDriverRunOptions,
    fork?: { source: NativeSessionRef; boundary?: { readonly turnId?: string; readonly messageId?: string } }): Promise<CliChatResult> => {
    if (context.pmToolBridge && (!context.execution || !context.authorizeExecution)) throw pmExecutionError(412, "scope_required", "PM tools require a trusted live Chat authorization.");
    if (!options.model.trim()) throw pmExecutionError(400, "invalid_model", "Select an explicit native model.");
    const technicalId = `host-thread:${randomUUID()}`;
    let threadId = ThreadId.make(context.execution?.threadId ?? technicalId);
    const runId = RunId.make(context.execution?.generationId ?? randomUUID());
    const messageId = MessageId.make(context.execution?.messageId ?? randomUUID());
    const preOpenAbort = new AbortController();
    let abortAction = () => preOpenAbort.abort();
    const abortListener = () => abortAction();
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted) preOpenAbort.abort();
    try {
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const lease = yield* host.acquire(context, "execution");
      yield* lease.assertCurrent;
      const source = fork?.source ?? options.resume;
      const saved = source ? readPmContinuation(lease, source, undefined, fork ? undefined : context.execution?.threadId, Boolean(fork)) : undefined;
      if (!context.execution && !fork && saved) {
        if (readRecord("chat:threads", saved.record.ownerThreadId) || readRecord("chat:generations", saved.record.lastGenerationId))
          throw pmExecutionError(409, "session_mismatch", "A no-tool technical caller cannot take ownership of a Chat continuation.");
        threadId = ThreadId.make(saved.record.ownerThreadId);
      }
      const authorizeExecution = context.execution ? context.authorizeExecution : undefined;
      yield* runtimeHost.bind(pmRuntimeBinding(context, threadId, runId), authorizeExecution ? (action) => Effect.gen(function* () {
        yield* lease.assertCurrent;
        if (options.signal?.aborted) return yield* Effect.fail(pmExecutionError(409, "stale_execution", "Native execution is no longer live."));
        yield* Effect.tryPromise({ try: () => authorizeExecution(action), catch: (error) => error instanceof Error ? error : new Error("Chat authorization failed.") });
        yield* lease.assertCurrent;
        if (options.signal?.aborted) return yield* Effect.fail(pmExecutionError(409, "stale_execution", "Native execution is no longer live."));
      }) : undefined);
      const allocator = yield* IdAllocatorV2;
      const providerSessionId = yield* allocator.allocate.providerSession({ providerInstanceId: lease.instance.instanceId, threadId });
      const rootNodeId = allocator.derive.rootNode({ runId });
      const attemptId = allocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const modelSelection = yield* Schema.decodeUnknownEffect(ModelSelection)({ instanceId: context.instanceId, model: options.model, options: options.modelOptions });
      const runtimePolicy = { runtimeMode: "approval-required" as const, interactionMode: options.interactionMode ?? "default",
        cwd: lease.cwd, approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } };
      const usageUpdates = yield* makePmUsageUpdates(lease);
      const runtime = yield* lease.instance.orchestrationAdapter.openSession({ threadId, providerSessionId, modelSelection, runtimePolicy,
        ...(saved ? { resumeFromSession: saved.session } : {}), ...(source ? { initialNativeThreadId: source.sessionId } : {}) }).pipe(
          Effect.mapError((error) => pmAdapterBoundaryError(error)),
        );
      if (runtime.instanceId !== lease.instance.instanceId || runtime.driver !== lease.instance.driverKind
        || runtime.providerSessionId !== providerSessionId || runtime.providerSession.id !== providerSessionId
        || runtime.providerSession.driver !== runtime.driver
        || runtime.providerSession.providerInstanceId !== lease.instance.instanceId || runtime.providerSession.cwd !== lease.cwd)
        return yield* Effect.fail(pmExecutionError(409, "session_mismatch", "The original runtime does not match the leased instance and working directory."));
      const subscription = runtime.subscribeEvents ? yield* runtime.subscribeEvents : undefined;
      if (subscription) yield* Effect.addFinalizer(() => subscription.close);
      return yield* Effect.tryPromise({ try: async () => {
        const operationAbort = new AbortController();
        const runOperation = <A, E>(operation: Effect.Effect<A, E>, fallbackCode = "provider_error", fallbackStatus = 502): Promise<A> =>
          Effect.runPromise(operation.pipe(Effect.mapError((error) => error instanceof Error && "_tag" in error
            && typeof error._tag === "string" && error._tag.startsWith("ProviderAdapter")
            ? pmAdapterBoundaryError(error, fallbackCode, fallbackStatus) : error)), { signal: operationAbort.signal });
        let startTask: Promise<void> | undefined;
        const startFailures: unknown[] = [];
        let thread: OrchestrationV2ProviderThread | undefined;
        let session = runtime.providerSession;
        let probe: PmProviderProtocolProbe | undefined;
        const turns = new Map<string, OrchestrationV2ProviderTurn>(saved?.turns.map((turn) => [turn.id, turn]));
        let nativeHistory = saved?.nativeHistory;
        const observed: { root?: OrchestrationV2ProviderTurn; end?: Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> } = {};
        let nativeSession: NativeSessionRef | undefined;
        let runOrdinal = 0;
        let stopped = false;
        let canPersist = false;
        let startInput: ProviderAdapterV2TurnInput | undefined;
        let firstFailure: unknown;
        let callbackFailure: unknown;
        const backgroundFailures: unknown[] = [];
        const causeFailures = (cause: Cause.Cause<unknown>) => cause.reasons.flatMap(reason =>
          Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : []);
        const outcome = Promise.withResolvers<void>();
        let currentEventWork: Promise<void> | undefined;
        const consumerAbort = new AbortController();
        const pendingRequests = new Map<string, { token: symbol; close: () => void }>();
        const responses = new Set<Promise<void>>();
        const childThreads = new Set<string>();
        const childProviderThreads = new Map<string, string>();
        const knownNodes = new Set<string>([rootNodeId]);
        const assertCurrent = () => Effect.runPromise(lease.assertCurrent);
        const fail = (error: unknown) => {
          backgroundFailures.push(error);
          firstFailure ??= error;
          if (!observed.root) operationAbort.abort();
          outcome.resolve();
        };
        const persist = async () => {
          if (!thread || !probe || stopped || !canPersist) return;
          await assertCurrent();
          const ref = savePmContinuation({ lease, protocol: probe.protocol, ownerThreadId: fork ? threadId : context.execution?.threadId ?? saved?.record.ownerThreadId ?? threadId,
            generationId: runId, session, thread, turns: [...turns.values()], ...(nativeHistory ? { nativeHistory } : {}) });
          if (ref) {
            const next: NativeSessionRef = { ...ref, modelId: options.model };
            if (!fork && (!observed.root || observed.root.status !== "completed")) {
              delete next.turnId;
              if (lease.localDriver === "claude") delete next.messageId;
            }
            nativeSession = next;
            try { options.onSession?.(next); } catch (error) { callbackFailure ??= error; throw error; }
          }
        };
        const usageState: { value?: NativeUsageUpdate } = {};
        const publishUsage = (update: NativeUsageUpdate) => {
          usageState.value = { ...usageState.value, ...update,
            ...(update.turn ? { reportedTurn: update.reportedTurn } : {}),
            ...(update.reportedTurn ? { turn: update.turn } : {}) };
          try { options.onUsage?.(update); } catch (error) { callbackFailure ??= error; throw error; }
        };
        const mapper = makePmEventAdapter({
          onText: (text) => { try { options.onText?.(text); } catch (error) { callbackFailure ??= error; throw error; } },
          onEvent: (event) => { try { options.onEvent?.(event); } catch (error) { callbackFailure ??= error; throw error; } },
          canRespond: Boolean(options.onRequest),
          rootThreadId: threadId,
          isRootItem: (item) => item.threadId === threadId && (item.providerThreadId === null || item.providerThreadId === thread?.id),
          isLiveRequest: (request) => request.responseCapability.type === "live" && request.responseCapability.providerSessionId === runtime.providerSessionId,
          onRequestClosed: (id) => { const current = pendingRequests.get(id); pendingRequests.delete(id); current?.close(); },
          onRequest: (request, sourceRequest) => {
            const closed = Promise.withResolvers<void>();
            const token = Symbol();
            pendingRequests.set(request.id, { token, close: () => closed.resolve() });
            const work = (async () => {
              if (sourceRequest.responseCapability.type !== "live" || sourceRequest.responseCapability.providerSessionId !== runtime.providerSessionId) return;
              if (request.kind === "approval") {
                await assertCurrent();
                await runOperation(runtime.respondToRuntimeRequest({ requestId: sourceRequest.id, decision: "decline" }));
                return;
              }
              const answered = Promise.resolve().then(() => options.onRequest!(request)).catch((error) => {
                if (!stopped && !options.signal?.aborted && pendingRequests.get(request.id)?.token === token) callbackFailure ??= error;
                throw error;
              });
              const response = await Promise.race([answered, closed.promise.then(() => undefined)]);
              if (!response || stopped || observed.end || firstFailure || pendingRequests.get(request.id)?.token !== token) return;
              await assertCurrent();
              const liveBinding = await Effect.runPromise(runtimeHost.read({ threadId, providerInstanceId: lease.instance.instanceId }));
              if (stopped || observed.end || firstFailure || pendingRequests.get(request.id)?.token !== token
                || liveBinding?.executionId !== runId || mapper.requests.get(request.id)?.status !== "pending") return;
              if (response.cancelled) {
                await runOperation(runtime.respondToRuntimeRequest({ requestId: sourceRequest.id, decision: "cancel" }));
              } else {
                if (!response.answers || response.optionId !== undefined)
                  throw pmExecutionError(400, "invalid_native_response", "An information question requires answers, not a permission decision.");
                await runOperation(runtime.respondToRuntimeRequest({ requestId: sourceRequest.id, answers: response.answers }));
              }
              if (pendingRequests.get(request.id)?.token === token) pendingRequests.delete(request.id);
            })().catch((error) => {
              if (!stopped && pendingRequests.get(request.id)?.token === token) fail(error);
            }).finally(() => { if (pendingRequests.get(request.id)?.token === token) pendingRequests.delete(request.id); });
            responses.add(work);
            void work.finally(() => responses.delete(work));
          },
        });
        const unbindContinuation = bindPmContinuationSink(threadId, {
          executionId: runId, fail,
          accept: async (request) => {
            if (stopped || observed.end || firstFailure || !thread || request.providerThreadId !== thread.id
              || !startInput || !probe?.adoptBuffered || (request.delivery ?? "adapter_buffered") !== "adapter_buffered"
              || !context.execution) return false;
            const adoptBuffered = probe.adoptBuffered;
            const currentThread = thread;
            await assertCurrent();
            const ordinal = nextPmProviderTurnOrdinal(turns.values());
            const { message: _message, ...turn } = startInput;
            const isCurrent = lease.assertCurrent.pipe(
              Effect.andThen(runtimeHost.read({ threadId, providerInstanceId: lease.instance.instanceId })),
              Effect.map((binding) => !stopped && !observed.end && !firstFailure && binding?.executionId === runId),
            );
            const adopt = Effect.flatMap(isCurrent, (current) => current
              ? adoptBuffered({ context, lease, runtime, request,
                turn: { ...turn, providerThread: currentThread, providerTurnOrdinal: ordinal }, isCurrent })
              : Effect.succeed(false));
            if (request.dispatchIfCurrent) {
              const result = await runOperation(request.dispatchIfCurrent(adopt));
              return Option.isSome(result) && result.value;
            }
            return runOperation(adopt);
          },
        });
        const accepts = (event: ProviderAdapterV2Event): boolean => {
          switch (event.type) {
            case "provider_session.updated": return event.providerSession.id === runtime.providerSessionId;
            case "provider_thread.updated": return event.providerThread.id === thread?.id || event.providerThread.appThreadId === threadId
              || (event.providerThread.appThreadId !== null && childThreads.has(event.providerThread.appThreadId));
            case "provider_turn.updated": return event.providerTurn.providerThreadId === thread?.id || knownNodes.has(event.providerTurn.nodeId);
            case "node.updated": return event.node.id === rootNodeId || (event.node.parentNodeId !== null && knownNodes.has(event.node.parentNodeId))
              || (event.node.kind === "root_turn" && event.node.parentNodeId === null && event.node.rootNodeId === event.node.id
                && event.node.providerThreadId !== null && childProviderThreads.get(event.node.threadId) === event.node.providerThreadId);
            case "subagent.updated": return knownNodes.has(event.subagent.parentNodeId);
            case "turn_item.updated": return event.turnItem.runId === runId || (event.turnItem.nodeId !== null && knownNodes.has(event.turnItem.nodeId));
            case "runtime_request.updated": return knownNodes.has(event.runtimeRequest.nodeId)
              || (event.runtimeRequest.providerTurnId !== null && turns.has(event.runtimeRequest.providerTurnId))
              || event.threadId === threadId || (event.threadId !== undefined && childThreads.has(event.threadId));
            case "message.updated": return event.message.threadId === threadId || childThreads.has(event.message.threadId);
            case "command_output.delta": return event.threadId === threadId || childThreads.has(event.threadId);
            case "plan.updated": return event.plan.runId === runId || knownNodes.has(event.plan.nodeId);
            case "app_thread.created": return event.appThread.lineage.parentThreadId === threadId || event.appThread.lineage.rootThreadId === threadId;
            case "turn.terminal": {
              const nativeTurn = turns.get(event.providerTurnId);
              return event.runOrdinal === runOrdinal && ((event.providerThreadId === thread?.id && event.providerTurnId === observed.root?.id)
                || (nativeTurn !== undefined && nativeTurn.providerThreadId === event.providerThreadId && knownNodes.has(nativeTurn.nodeId)));
            }
          }
        };
        const limitsConsumer = Effect.runPromiseExit(Stream.runForEach(usageUpdates, (update) => lease.assertCurrent.pipe(
          Effect.andThen(Effect.sync(() => { if (!stopped) publishUsage(update); })),
        )), { signal: consumerAbort.signal }).then(exit => {
          if (exit._tag !== "Failure" || (stopped && Cause.hasInterruptsOnly(exit.cause))) return;
          const errors = causeFailures(exit.cause);
          if (stopped) backgroundFailures.push(...errors);
          else for (const error of errors.length ? errors : [Cause.squash(exit.cause)]) fail(error);
        });
        const consume = Stream.runForEach(subscription?.events ?? runtime.events, (event) => Effect.tryPromise({ try: () => {
          const work = (async () => {
          if (stopped || !accepts(event)) return;
          await assertCurrent();
          if (stopped) return;
          switch (event.type) {
            case "provider_session.updated":
              if (event.providerSession.driver !== runtime.driver || event.providerSession.providerInstanceId !== lease.instance.instanceId
                || event.providerSession.cwd !== lease.cwd)
                throw pmExecutionError(409, "session_mismatch", "Native session metadata changed its instance or working directory.");
              session = event.providerSession;
              break;
            case "provider_thread.updated":
              if (!thread || event.providerThread.id === thread.id) {
                if (event.providerThread.driver !== runtime.driver || event.providerThread.providerInstanceId !== lease.instance.instanceId
                  || event.providerThread.providerSessionId !== runtime.providerSessionId || event.providerThread.appThreadId !== threadId
                  || (thread && event.providerThread.nativeThreadRef?.nativeId !== thread.nativeThreadRef?.nativeId))
                  throw pmExecutionError(409, "session_mismatch", "Native thread metadata changed its session or application owner.");
                thread = event.providerThread;
                if (event.retainedNativeTurnIds) {
                  const retained = new Set(event.retainedNativeTurnIds);
                  for (const [id, turn] of turns) if (turn.nativeTurnRef?.nativeId != null && !retained.has(turn.nativeTurnRef.nativeId)) turns.delete(id);
                  if (nativeHistory) {
                    const completedTurnRefs = nativeHistory.completedTurnRefs.filter(ref => retained.has(ref.nativeId));
                    nativeHistory = completedTurnRefs.length ? {
                      nativeSessionId: nativeHistory.nativeSessionId,
                      completedTurnRefs,
                      ...(nativeHistory.latestCompletedTurnRef && retained.has(nativeHistory.latestCompletedTurnRef.nativeId)
                        ? { latestCompletedTurnRef: nativeHistory.latestCompletedTurnRef } : {}),
                    } : undefined;
                  }
                }
                const usage = pmThreadUsage(thread, pmEventTime(thread.updatedAt)!, options.model);
                if (usage) publishUsage(usage);
              }
              else if (event.providerThread.appThreadId !== null && childThreads.has(event.providerThread.appThreadId))
                childProviderThreads.set(event.providerThread.appThreadId, event.providerThread.id);
              break;
            case "provider_turn.updated": {
              const turn = event.providerTurn;
              turns.set(turn.id, turn);
              if (turn.nodeId === rootNodeId && turn.runAttemptId === attemptId && turn.providerThreadId === thread?.id) {
                if (observed.root && turn.ordinal < observed.root.ordinal) break;
                if (observed.root && turn.ordinal === observed.root.ordinal && turn.id !== observed.root.id)
                  throw pmExecutionError(502, "provider_protocol_error", "The original runtime reported conflicting root turn identities.");
                if (nativeHistory?.latestCompletedTurnRef && observed.root?.id !== turn.id) {
                  // A retained snapshot described the previous native head. A new graph
                  // root cannot reuse its tip, even when the new native ref is weak.
                  const { latestCompletedTurnRef: _previousTip, ...history } = nativeHistory;
                  nativeHistory = history;
                }
                observed.root = turn;
                await persist();
                const usage = pmTurnUsage(turn, options.model);
                if (usage) publishUsage(usage);
              }
              break;
            }
            case "node.updated": knownNodes.add(event.node.id); break;
            case "subagent.updated": knownNodes.add(event.subagent.id); if (event.subagent.childThreadId) childThreads.add(event.subagent.childThreadId); break;
            case "app_thread.created": childThreads.add(event.appThread.id); break;
            case "runtime_request.updated": knownNodes.add(event.runtimeRequest.nodeId); break;
            case "turn.terminal":
              if (event.providerThreadId === thread?.id && event.providerTurnId === observed.root?.id && event.runOrdinal === runOrdinal) {
                observed.end = event;
                if (event.threadDisposition === "broken" && thread) thread = { ...thread, status: "error" };
              }
              break;
          }
          mapper.handle(event);
          if (event.type === "provider_session.updated" || (event.type === "turn.terminal" && observed.end === event)
            || (event.type === "provider_thread.updated" && event.providerThread.id === thread?.id)) await persist();
          if (event.type === "turn.terminal" && observed.end === event) outcome.resolve();
          })();
          currentEventWork = work;
          return work;
        }, catch: (error) => error })).pipe(Effect.provideService(IdAllocatorV2, allocator));
        const consumer = Effect.runPromiseExit(consume, { signal: consumerAbort.signal }).then(exit => {
          if (exit._tag === "Success") {
            if (!stopped && !observed.end) fail(pmExecutionError(502, "provider_stream_closed", "Native event stream ended without a matching root terminal."));
            return;
          }
          if (stopped && Cause.hasInterruptsOnly(exit.cause)) return;
          const errors = causeFailures(exit.cause);
          backgroundFailures.push(...errors);
          if (!stopped) for (const error of errors.length ? errors : [Cause.squash(exit.cause)])
            fail(callbackFailure ?? (error instanceof Error && "code" in error && "status" in error ? error : pmAdapterBoundaryError(error)));
        });
        const abort = () => fail(pmExecutionError(499, "aborted", "Native execution was cancelled.", options.signal?.reason === "server-shutdown" ? "interrupted" : "cancelled"));
        abortAction = abort;
        let result: CliChatResult | undefined;
        try {
          if (options.signal?.aborted) abort();
          if (firstFailure) throw firstFailure;
          probe = await runOperation(resolvePmProviderProtocol({ context, lease, runtime }));
          if (saved && saved.record.protocol !== probe.protocol) throw pmExecutionError(409, "session_mismatch", "Native runtime protocol changed; use an explicit portable handoff.");
          if (saved) {
            thread = saved.thread;
            if (!fork) {
              const transition = await runOperation(lease.instance.orchestrationAdapter.planSelectionTransition({
                current: saved.thread.nativeMetadata?.modelSelection ?? Schema.decodeUnknownSync(ModelSelection)({ instanceId: lease.instanceId, model: source?.modelId ?? saved.session.model }),
                target: modelSelection, sessionCapabilities: saved.session.capabilities,
              }));
              if (transition.type === "reject" || transition.type === "create_with_handoff")
                throw pmExecutionError(409, "session_mismatch", transition.type === "reject" ? transition.reason : "This model change requires an explicit portable handoff.");
              await assertCurrent();
              thread = await runOperation(runtime.resumeThread({ providerThread: saved.thread, threadId, modelSelection, runtimePolicy }), "session_mismatch", 409);
            }
          } else if (!source) {
            await assertCurrent();
            thread = await runOperation(runtime.ensureThread({ threadId, modelSelection, runtimePolicy, providerSessionId, forceNewNativeThread: false }));
          }
          if (source && saved && thread?.nativeThreadRef?.nativeId !== source.sessionId)
            throw pmExecutionError(409, "session_mismatch", "The native provider did not resume the requested session; a replacement session was not adopted.");
          if (source && !saved) {
            if (!probe.adoptLegacy)
              throw pmExecutionError(412, "provider_not_configured", "This provider's metadata-only legacy adoption boundary has not been assembled.");
            const snapshot = await runOperation(probe.adoptLegacy({ context, lease, runtime, source,
              ensure: { threadId, modelSelection, runtimePolicy, providerSessionId, forceNewNativeThread: false } }));
            let legacyTurns: readonly OrchestrationV2ProviderTurn[];
            try {
              thread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThreadJson))(snapshot.providerThread);
              legacyTurns = snapshot.providerTurns.map((value) => Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderTurnJson))(value));
              nativeHistory = decodePmNativeHistory(snapshot.nativeHistory, runtime.driver, source.sessionId);
            } catch {
              throw pmExecutionError(409, "session_mismatch", "Legacy native metadata is incompatible with the original continuation schema.");
            }
            if (thread.nativeThreadRef?.nativeId !== source.sessionId || thread.nativeThreadRef.driver !== runtime.driver
              || thread.nativeThreadRef.strength !== "strong" || thread.providerInstanceId !== lease.instance.instanceId || thread.driver !== runtime.driver
              || thread.providerSessionId !== runtime.providerSessionId || thread.appThreadId !== threadId)
              throw pmExecutionError(409, "session_mismatch", "Legacy metadata did not confirm the requested native session and instance.");
            for (const turn of legacyTurns) {
              if (turn.providerThreadId !== thread.id) throw pmExecutionError(409, "session_mismatch", "Legacy native turn belongs to another thread.");
              turns.set(turn.id, turn);
            }
            assertPmContinuationCursor(source, thread, turns.values(), nativeHistory, Boolean(fork));
            if (!fork) {
              if (thread.status === "error" || thread.status === "closed")
                throw pmExecutionError(409, "session_mismatch", "The native thread is broken and cannot be resumed.");
              const previousSelection = thread.nativeMetadata?.modelSelection ?? (source.modelId
                ? Schema.decodeUnknownSync(ModelSelection)({ instanceId: lease.instanceId, model: source.modelId }) : undefined);
              if (!previousSelection) throw pmExecutionError(409, "session_mismatch", "Legacy metadata has no verified native model selection.");
              const transition = await runOperation(lease.instance.orchestrationAdapter.planSelectionTransition({
                current: previousSelection, target: modelSelection, sessionCapabilities: runtime.providerSession.capabilities,
              }));
              if (transition.type === "reject" || transition.type === "create_with_handoff")
                throw pmExecutionError(409, "session_mismatch", transition.type === "reject" ? transition.reason : "This legacy model change requires an explicit portable handoff.");
              await assertCurrent();
              thread = await runOperation(runtime.resumeThread({ providerThread: thread, threadId, modelSelection, runtimePolicy }), "session_mismatch", 409);
              if (thread.nativeThreadRef?.nativeId !== source.sessionId) throw pmExecutionError(409, "session_mismatch", "Legacy resume changed the native session identity.");
            }
          }
          if (!thread) throw pmExecutionError(409, "session_mismatch", "The native provider did not establish verified thread metadata.");
          if (thread.providerInstanceId !== lease.instance.instanceId || thread.driver !== runtime.driver
            || (!fork && (thread.providerSessionId !== runtime.providerSessionId || thread.appThreadId !== threadId
              || thread.status === "error" || thread.status === "closed")))
            throw pmExecutionError(409, "session_mismatch", "The original thread no longer matches this executable continuation.");
          if (fork) {
            await assertCurrent();
            if (!runtime.providerSession.capabilities.threads.canForkThread
              || (fork.boundary && !runtime.providerSession.capabilities.threads.canForkFromTurn))
              throw pmExecutionError(409, "unsupported_fork", "The native provider does not support this fork boundary.");
            const boundary = fork.boundary;
            if (boundary && ((lease.localDriver === "codex" && !boundary.turnId) || (lease.localDriver === "claude" && !boundary.messageId)))
              throw pmExecutionError(409, "unsupported_fork", lease.localDriver === "claude" ? "Claude exact fork requires a native assistant message UUID." : "Codex exact fork requires a native completed turn ID.");
            const boundaryId = boundary?.turnId ?? boundary?.messageId;
            const boundaryTurn = boundaryId ? [...turns.values()].find((turn) => turn.status === "completed" && turn.nativeTurnRef?.nativeId === boundaryId
              && turn.nativeTurnRef.driver === runtime.driver && turn.nativeTurnRef.strength === "strong" && boundaryId.trim()) : undefined;
            const nativeBoundary = boundaryId && !boundaryTurn ? nativeHistory?.completedTurnRefs.find(ref => ref.nativeId === boundaryId) : undefined;
            if (boundaryId && !boundaryTurn && !nativeBoundary)
              throw pmExecutionError(409, "unsupported_fork", "The saved successful native fork boundary is unavailable.");
            try {
              const forked = await runOperation(runtime.forkThread({ sourceProviderThread: thread, sourceProviderTurns: [...turns.values()],
                ...(boundaryTurn ? { providerTurnId: boundaryTurn.id } : nativeBoundary ? { nativeCompletedTurnRef: nativeBoundary } : {}),
                targetThreadId: threadId, modelSelection, runtimePolicy }));
              const nativeId = forked.nativeThreadRef?.nativeId;
              if (!nativeId?.trim() || nativeId === source?.sessionId || forked.nativeThreadRef?.driver !== runtime.driver
                || forked.nativeThreadRef.strength !== "strong" || forked.providerInstanceId !== lease.instance.instanceId
                || forked.driver !== runtime.driver || forked.providerSessionId !== runtime.providerSessionId || forked.appThreadId !== threadId)
                throw new Error("Native fork did not confirm a distinct target bound to this instance, session and application thread.");
              // Re-read the actual target; source proof cannot be relabelled to a new native session.
              const target = await runOperation(runtime.readThreadSnapshot({ providerThread: forked }));
              const targetThread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderThreadJson))(target.providerThread);
              const targetTurns = target.providerTurns.map(value => Schema.decodeUnknownSync(Schema.toType(OrchestrationV2ProviderTurnJson))(value));
              if (targetThread.id !== forked.id || targetThread.providerInstanceId !== lease.instance.instanceId || targetThread.driver !== runtime.driver
                || targetThread.providerSessionId !== runtime.providerSessionId || targetThread.appThreadId !== threadId
                || targetThread.nativeThreadRef?.nativeId !== nativeId || targetThread.nativeThreadRef.driver !== runtime.driver
                || targetThread.nativeThreadRef.strength !== "strong" || targetThread.status === "error" || targetThread.status === "closed"
                || targetTurns.some(turn => turn.providerThreadId !== targetThread.id))
                throw new Error("Native fork target snapshot changed its verified binding.");
              const targetHistory = decodePmNativeHistory(target.nativeHistory, runtime.driver, nativeId);
              if (nativeHistory && !targetHistory && !targetTurns.some(turn => turn.status === "completed"
                && turn.nativeTurnRef?.driver === runtime.driver && turn.nativeTurnRef.strength === "strong" && turn.nativeTurnRef.nativeId?.trim()))
                throw new Error("Native fork target has no completed history evidence.");
              await assertCurrent();
              const binding = await Effect.runPromise(runtimeHost.read({ threadId, providerInstanceId: lease.instance.instanceId }));
              if (firstFailure) throw firstFailure;
              if (binding?.executionId !== runId) throw new Error("Native fork target lost its live host binding.");
              thread = targetThread;
              nativeHistory = targetHistory;
              turns.clear();
              for (const turn of targetTurns) turns.set(turn.id, turn);
              canPersist = true;
              await persist();
              result = { text: "", ...(nativeSession ? { nativeSession } : {}) };
            } catch (cause) {
              canPersist = false;
              if (firstFailure !== undefined) backgroundFailures.push(firstFailure);
              firstFailure = Object.assign(pmExecutionError(502, "provider_fork_unconfirmed",
                "The native fork may have been created, but its target could not be confirmed. No additional fork was attempted."), { cause });
              throw firstFailure;
            }
          } else {
            runOrdinal = nextPmOrdinal(thread.lastRunOrdinal ?? 0);
            canPersist = true;
            if (firstFailure) throw firstFailure;
            const providerTurnOrdinal = nextPmProviderTurnOrdinal(turns.values());
            await persist();
            await assertCurrent();
            const binding = await Effect.runPromise(runtimeHost.read({ threadId, providerInstanceId: ProviderInstanceId.make(context.instanceId) }));
            if (binding?.executionId !== runId || (context.pmToolBridge && !binding.mcpServers.length))
              throw pmExecutionError(412, "scope_required", "The generation-scoped provider binding is unavailable.");
            const savedGeneration = context.execution ? readRecord<{ createdAt: string }>("chat:generations", runId) : null;
            const savedThread = context.execution ? readRecord<{ title: string; createdAt: string }>("chat:threads", threadId) : null;
            const now = DateTime.makeUnsafe(savedGeneration?.createdAt ?? savedThread?.createdAt ?? new Date());
            const scope = context.execution?.scope;
            const appThread = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2AppThread))({ id: threadId,
              projectId: ProjectId.make(scope?.projectId ?? (scope ? `pm-workspace:${scope.workspaceId}` : threadId)),
              title: typeof savedThread?.title === "string" ? savedThread.title.trim() || threadId : threadId, providerInstanceId: lease.instance.instanceId, modelSelection,
              runtimeMode: runtimePolicy.runtimeMode, interactionMode: runtimePolicy.interactionMode, branch: null, worktreePath: null,
              activeProviderThreadId: thread.id, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
              createdBy: "user", creationSource: "server", createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null,
              settledOverride: null, settledAt: null, lastVisitedAt: null });
            startInput = { appThread, threadId, runId, runOrdinal, providerTurnOrdinal,
              nativeThreadHasTurns: Boolean(source), attemptId, rootNodeId, providerThread: thread,
              message: { messageId, text: options.prompt, attachments: [], createdBy: "user", creationSource: "server" }, modelSelection, runtimePolicy };
            startTask = runOperation(runtime.startTurn(startInput).pipe(
              Effect.mapError(error => pmAdapterBoundaryError(error)),
              Effect.onExit(exit => Effect.sync(() => {
                if (exit._tag === "Failure") startFailures.push(...causeFailures(exit.cause));
              })),
            ));
            await Promise.race([startTask, outcome.promise]);
            // A matching terminal is sufficient even when startTurn remains open until its Scope is interrupted.
            if (!firstFailure && !observed.end) await outcome.promise;
            if (firstFailure) throw firstFailure;
            if (!observed.end) throw pmExecutionError(502, "provider_terminal_missing", "Native execution did not produce a matching root terminal.");
            const omitted = mapper.pendingBodies();
            const needsBodies = omitted.some((item) => item.type === "assistant_message");
            const needsNativeHistory = observed.end.status === "completed" && observed.root?.nativeTurnRef?.strength !== "strong";
            if (needsBodies || needsNativeHistory) {
              const snapshot = await runOperation(runtime.readThreadSnapshot({ providerThread: thread }));
              if (needsNativeHistory) {
                const captured = snapshot.providerThread;
                const nativeId = thread.nativeThreadRef?.nativeId;
                if (!nativeId || captured.id !== thread.id || captured.providerInstanceId !== lease.instance.instanceId
                  || captured.driver !== runtime.driver || captured.providerSessionId !== runtime.providerSessionId
                  || captured.appThreadId !== threadId || captured.nativeThreadRef?.nativeId !== nativeId
                  || captured.nativeThreadRef.driver !== runtime.driver || captured.nativeThreadRef.strength !== "strong")
                  throw pmExecutionError(409, "session_mismatch", "Completed native history changed its verified thread binding.");
                nativeHistory = decodePmNativeHistory(snapshot.nativeHistory, runtime.driver, nativeId);
              }
              if (needsBodies) for (const message of snapshot.messages) mapper.handle({ type: "message.updated", driver: runtime.driver, message });
            }
            for (const item of mapper.pendingBodies()) {
              if (!probe.readFullItem) throw pmExecutionError(502, "provider_payload_missing", "The native runtime withheld a final body without a full-payload reader.");
              const full = await runOperation(probe.readFullItem({ context, lease, runtime, thread, item }));
              if (full.id !== item.id) throw pmExecutionError(502, "provider_payload_mismatch", "Native full payload returned another item.");
              mapper.handle({ type: "turn_item.updated", driver: runtime.driver, turnItem: full });
            }
            if (mapper.pendingBodies().length) throw pmExecutionError(502, "provider_payload_missing", "Native final output is incomplete.");
            await persist();
            mapper.flushPlans();
            mapper.flushSubagents();
            if (callbackFailure) throw callbackFailure;
            if (observed.end.status !== "completed") {
              if (observed.end.status === "failed") {
                const code = observed.end.failure.code ?? "provider_error";
                const status = ["401", "402", "403", "429"].includes(code) ? Number(code) : observed.end.failure.class === "usage_limit" ? 429 : 502;
                const failure = pmExecutionError(status, code, sanitizeErrorText(observed.end.failure.message), "failed");
                const classified = classifyProviderError({ message: failure.message, code, statusCode: status,
                  errorClass: observed.end.failure.class === "usage_limit" ? "usage_limit" : undefined, resetAt: observed.end.failure.resetAt });
                throw Object.assign(failure, { errorClass: classified.errorClass, ...(classified.resetAt ? { resetAt: classified.resetAt } : {}) });
              }
              throw pmExecutionError(499, "aborted", `Native execution was ${observed.end.status}.`, observed.end.status);
            }
            const turnUsage = usageState.value?.turn;
            const reported = usageState.value?.reportedTurn;
            result = { text: mapper.finalText(), ...(nativeSession ? { nativeSession } : {}),
              ...(usageState.value ? { nativeUsage: usageState.value } : {}),
              ...(turnUsage ? { usage: { inputTokens: turnUsage.totals.uncachedInputTokens + turnUsage.totals.cachedInputTokens + turnUsage.totals.cacheCreationTokens,
                outputTokens: turnUsage.totals.outputTokens } } : reported ? { usage: { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens } } : {}) };
          }
        } catch (error) {
          firstFailure ??= error;
        }
        const cleanupErrors: unknown[] = [];
        unbindContinuation();
        for (const pending of pendingRequests.values()) pending.close();
        pendingRequests.clear();
        if (!observed.end && thread && observed.root && (observed.root.status === "pending" || observed.root.status === "running")) {
          try {
            const interrupted = await Effect.runPromiseExit(runtime.interruptTurn({ providerThread: thread, providerTurnId: observed.root.id }));
            if (interrupted._tag === "Failure") {
              const errors = causeFailures(interrupted.cause);
              cleanupErrors.push(...(errors.length ? errors : [Cause.squash(interrupted.cause)]));
            }
          }
          catch (error) { cleanupErrors.push(error); }
          // interruptTurn is the native acknowledgement. Do not wait indefinitely for an optional terminal event.
        }
        stopped = true;
        operationAbort.abort();
        consumerAbort.abort();
        if (startTask) {
          try { await startTask; } catch { cleanupErrors.push(...startFailures); }
        }
        await consumer;
        await limitsConsumer;
        if (currentEventWork) {
          try { await currentEventWork; } catch (error) { cleanupErrors.push(error); }
        }
        const responseResults = await Promise.allSettled(responses);
        for (const response of responseResults) if (response.status === "rejected") cleanupErrors.push(response.reason);
        try { mapper.flushPlans(); } catch (error) { cleanupErrors.push(error); }
        try { mapper.flushSubagents(); } catch (error) { cleanupErrors.push(error); }
        try { mapper.close(); } catch (error) { cleanupErrors.push(error); }
        const failures = [...new Set([callbackFailure, firstFailure, ...backgroundFailures, ...cleanupErrors].filter(error => error !== undefined))];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          const primary = failures[0];
          throw Object.assign(new AggregateError(failures, primary instanceof Error ? primary.message : "Native execution and cleanup failed."),
            primary instanceof Error ? primary : {}, { cause: primary });
        }
        if (!result) throw pmExecutionError(502, "provider_result_missing", "Native execution produced no result.");
        return result;
      }, catch: (error) => error });
    }).pipe(Effect.provide(idAllocatorLayer))), { signal: preOpenAbort.signal });
      if (exit._tag === "Success") return exit.value;
      const errors = exit.cause.reasons.flatMap(reason =>
        Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : []);
      if (preOpenAbort.signal.aborted) errors.unshift(pmExecutionError(499, "aborted", "Native session preparation was cancelled.",
        options.signal?.reason === "server-shutdown" ? "interrupted" : "cancelled"));
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        const primary = errors[0];
        const failures = errors.flatMap(error => error instanceof AggregateError ? error.errors : [error]);
        throw Object.assign(new AggregateError(failures, primary instanceof Error ? primary.message : "Native execution Scope cleanup failed."),
          primary instanceof Error ? primary : {}, { cause: primary });
      }
      throw Cause.squash(exit.cause);
    } finally {
      options.signal?.removeEventListener("abort", abortListener);
    }
  };
  return {
    run: (context, options) => execute(context, options),
    fork: async (context, source, boundary, signal) => {
      if (!source.modelId) throw pmExecutionError(409, "session_mismatch", "Native fork requires the saved explicit model.");
      const result = await execute(context, { model: source.modelId, prompt: "", ...(signal ? { signal } : {}) }, { source, ...(boundary ? { boundary } : {}) });
      if (!result.nativeSession) throw pmExecutionError(409, "unsupported_fork", "Provider did not return a native fork identity.");
      return result.nativeSession;
    },
  };
}

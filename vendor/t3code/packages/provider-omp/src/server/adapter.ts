import * as NodePath from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  ProviderDriverKind, type ProviderInstanceId, type ModelSelection,
  type OrchestrationV2ProviderCapabilities, type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread, type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderFailure, type OrchestrationV2TurnItem,
  type OrchestrationV2RuntimeRequest, type OrchestrationV2ExecutionNode,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderRuntimeHost } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import { makeProviderFailure, makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { ProviderAdapterDriverCreateError, type ProviderAdapterDriver, type ProviderAdapterDriverCreateInput } from "@t3tools/provider-core/server/adapterDriver";
import { OmpSettings } from "../settings.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs, resolveOmpNativeHome } from "./launch.ts";
import { makeOmpRpcConnection, parseOmpModelSlug, ompRecordField as field, ompRecordString as string,
  ompRecordNumber as number, type OmpRpcRecord } from "./rpc.ts";
import { materializeOmpPermissionGate, parseOmpGateCall, ompPermissionKind, OMP_GATE_VERSION } from "./permissions.ts";
import { authorizeOmpPrompt, makeOmpHostTools, type OmpHostTools } from "./hostTools.ts";
import { bindOmpSessionEvidence, readOmpSessionHeader, readOmpActiveBranch, ompBranchPreservesConversationHead } from "./sessionEvidence.ts";

const OMP = ProviderDriverKind.make("omp");
const capabilities = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: { supportsMultipleProviderThreadsPerSession: false, supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true, supportsRuntimeModeSwitchInSession: false, pendingRequestsSurviveRestart: false },
  threads: { canCreateEmptyThread: true, canReadThreadSnapshot: true, canRollbackThread: false,
    canForkThread: false, canForkFromTurn: false, canForkFromSubagentThread: false, exposesNativeThreadId: true },
  turns: { exposesNativeTurnId: false, emitsTurnStarted: true, emitsTurnCompleted: true, supportsInterrupt: true,
    supportsActiveSteering: true, supportsSteeringByInterruptRestart: false, supportsQueuedMessages: false, terminalStatusQuality: "strong" },
  streaming: { streamsAssistantText: true, streamsReasoning: true, streamsToolOutput: true, streamsPlanText: false, emitsMessageCompleted: true },
  tools: { exposesToolItemIds: true, emitsToolStarted: true, emitsToolCompleted: true, emitsToolOutput: true,
    supportsMcpTools: true, supportsDynamicToolCallbacks: false },
  approvals: { supportsCommandApproval: true, supportsFileReadApproval: true, supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false, approvalsHaveNativeRequestIds: true, approvalCallbacksAreLiveOnly: true, approvalsCanOriginateFromSubagents: false },
  planning: { emitsPlanUpdated: false, emitsTodoList: false, emitsProposedPlan: false, supportsStructuredQuestions: true, planDeltasHaveItemIds: false },
  subagents: { supportsSubagents: false, exposesSubagentThreadIds: false, emitsSubagentLifecycle: false,
    canWaitForSubagents: false, canCloseSubagents: false, canForkSubagentThread: false },
  context: { acceptsSystemContext: false, acceptsDeveloperContext: false, acceptsSyntheticUserContext: true,
    canGenerateSummaries: false, canConsumeHandoffSummaries: true, supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true, maxRecommendedHandoffChars: null },
  checkpointing: { appCanCheckpointFilesystem: false, supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false, providerRollbackReturnsSnapshot: false, providerCanReadConversationSnapshot: true },
  identity: { nativeThreadIds: "strong", nativeTurnIds: "weak", nativeItemIds: "weak", nativeRequestIds: "strong" },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OmpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly continuationRequests?: { readonly offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) => Effect.Effect<void> };
}
interface Block {
  readonly nativeId: string;
  readonly type: "assistant_message" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
  completed: boolean;
}
interface Turn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  entity: OrchestrationV2ProviderTurn;
  readonly promptId: string;
  readonly hostTools: OmpHostTools;
  readonly blocks: Map<string, Block>;
  readonly tools: Map<string, { name: string; args: unknown; startedAt: DateTime.Utc; result?: unknown; done: boolean }>;
  readonly ordinals: Map<string, number>;
  readonly usages: Map<number, unknown>;
  readonly baselineLeaf: string | null;
  readonly hostAdmissions: Map<string, { readonly name: string; readonly args: unknown }>;
  readonly nativePmApprovals: Map<string, string>;
  nextOrdinal: number;
  messageOrdinal: number;
  result: "completed" | "aborted" | "error" | null;
  failure: OrchestrationV2ProviderFailure | null;
  latestAssistantFailure: OrchestrationV2ProviderFailure | null;
  awaitingSettlement: boolean;
  stopping: boolean;
  retiring: boolean;
}
interface PendingUi {
  readonly nativeId: string;
  readonly turn: Turn;
  readonly method: string;
  readonly record: OmpRpcRecord;
  readonly approval: boolean;
  readonly expiresAt: number | null;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly item: OrchestrationV2TurnItem;
}
const ref = (nativeId: string, strength: "weak" | "strong" = "strong") => ({ driver: OMP, nativeId, strength });
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(block => field(block, "type") === "text").map(block => string(block, "text") ?? "").join("") : "";
}

/** Native slash commands execute outside tool_call. Keep host-controlled identity,
 * credentials, permissions and background modes out of that separate path. */
export function assertOmpPromptIsSafe(text: string): void {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!")) throw new Error("Direct OMP shell execution is unsupported; use an approved tool call");
  if (!trimmed.startsWith("/")) return;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match || match[1] !== "session" || match[2]?.trim())
    throw new Error("This OMP slash command is unsupported at the PM host boundary; change models, sessions and settings through the host");
}

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (options: OmpAdapterV2Options) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const fs = yield* FileSystem.FileSystem;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const runtimeHost = yield* ProviderRuntimeHost;
  const userHome = yield* HostProcess.HomeDirectory;
  const protocolError = (detail: string, payload?: unknown) => new ProviderAdapter.ProviderAdapterProtocolError({ driver: OMP, detail, ...(payload === undefined ? {} : { payload }) });
  const protect = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ProviderAdapter.ProviderAdapterV2Error, R> =>
    effect.pipe(Effect.mapError(cause => protocolError(cause instanceof Error ? cause.message : "OMP operation failed", cause)));

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId, driver: OMP,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: input => protect(Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      if (input.runtimePolicy.runtimeMode !== "approval-required" && input.runtimePolicy.runtimeMode !== "auto")
        return yield* protocolError("OMP currently supports only host-supervised runtime policies");
      const openingBinding = yield* runtimeHost.read({ threadId: input.threadId, providerInstanceId: options.instanceId });
      const technicalNoTools = openingBinding?.promptAuthorization === "technical-no-tools";
      if (technicalNoTools) {
        if (!openingBinding || openingBinding.cwd !== cwd || openingBinding.threadId !== input.threadId || openingBinding.providerInstanceId !== options.instanceId)
          return yield* protocolError("OMP technical session does not match the bound host lease");
        yield* authorizeOmpPrompt(openingBinding, runtimeHost);
      }
      const nativeHome = yield* Effect.try(() => resolveOmpNativeHome({ environment: options.environment, homeDirectory: userHome, cwd }));
      const gate = yield* materializeOmpPermissionGate().pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const args = resolveOmpLaunchArgs(options.settings.launchArgs);
      if (!args.ok) return yield* protocolError(args.message);
      const launch = yield* Effect.try(() => buildOmpRpcLaunch({ launchArgs: args.args, environment: options.environment,
        extensionPath: gate.extensionPath, cwd, homeDirectory: userHome, ...(technicalNoTools ? { disableTools: true } : {}) }));
      const wrapped = yield* agentScope.wrap({ command: options.settings.binaryPath || "omp", args: launch.args,
        name: "omp", threadId: input.threadId, env: launch.env });
      const stopScope = wrapped.unit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(wrapped.unit));
      yield* Effect.addFinalizer(() => stopScope);
      const connection = yield* makeOmpRpcConnection({ command: wrapped.command, args: wrapped.args, cwd, env: launch.env })
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      yield* connection.exited.pipe(Effect.matchEffect({ onSuccess: () => stopScope, onFailure: () => stopScope }), Effect.forkIn(scope));
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, ProviderAdapter.ProviderAdapterV2Error | Cause.Done>();
      const permit = yield* Semaphore.make(1);
      const ready = yield* Deferred.make<OmpRpcRecord, ProviderAdapter.ProviderAdapterProtocolError>();
      const pending = new Map<string, PendingUi>();
      const hostCalls = new Map<string, Fiber.Fiber<void, never>>();
      let session: OrchestrationV2ProviderSession = { id: input.providerSessionId, driver: OMP, providerInstanceId: options.instanceId,
        status: "starting", cwd, model: input.modelSelection.model, capabilities, createdAt: yield* DateTime.now, updatedAt: yield* DateTime.now, lastError: null };
      let thread: OrchestrationV2ProviderThread | null = null;
      let turn: Turn | null = null;
      let starting = false;
      let closed = false;
      let registered = false;
      let nativeSessionId: string | null = null;
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      let contextWindow: number | undefined;
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(events, event).pipe(Effect.asVoid);
      const request = (record: OmpRpcRecord, timeout = 60_000) => connection.request(record, timeout).pipe(
        Effect.flatMap(data => data === undefined || data === null
          // Void command ACKs carry no data in the native protocol.
          ? Effect.succeed({} as OmpRpcRecord)
          : typeof data === "object" && !Array.isArray(data) ? Effect.succeed(data as OmpRpcRecord)
          : Effect.fail(protocolError("OMP command returned an unexpected payload", { command: record.type }))),
      );
      const status = Effect.fnUntraced(function* (value: OrchestrationV2ProviderSession["status"], error: string | null = null) {
        session = { ...session, status: value, lastError: error, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver: OMP, providerSession: session });
      });
      const publishThread = Effect.fnUntraced(function* (patch: Partial<OrchestrationV2ProviderThread>) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_thread.updated", driver: OMP, providerThread: thread });
      });
      const ordinal = (active: Turn, key: string) => {
        const existing = active.ordinals.get(key);
        if (existing !== undefined) return existing;
        const next = active.nextOrdinal++;
        active.ordinals.set(key, next);
        return next;
      };
      const base = (active: Turn, nativeId: string, startedAt: DateTime.Utc, updatedAt: DateTime.Utc) => ({
        id: ids.derive.turnItemFromProviderItem({ driver: OMP, nativeItemId: nativeId }), threadId: active.input.threadId,
        runId: active.input.runId, nodeId: ids.derive.nodeFromProviderItem({ driver: OMP, nativeItemId: nativeId }),
        providerThreadId: active.input.providerThread.id, providerTurnId: active.entity.id, nativeItemRef: ref(nativeId, "weak"),
        parentItemId: null, ordinal: ordinal(active, nativeId), startedAt, updatedAt,
      });
      const node = (active: Turn, nativeId: string, kind: OrchestrationV2ExecutionNode["kind"],
        value: OrchestrationV2ExecutionNode["status"], startedAt: DateTime.Utc, completedAt: DateTime.Utc | null) => emit({
          type: "node.updated", driver: OMP, node: { id: ids.derive.nodeFromProviderItem({ driver: OMP, nativeItemId: nativeId }),
            threadId: active.input.threadId, runId: active.input.runId, parentNodeId: active.input.rootNodeId, rootNodeId: active.input.rootNodeId,
            kind, status: value, countsForRun: false, providerThreadId: active.input.providerThread.id, providerTurnId: active.entity.id,
            nativeItemRef: ref(nativeId, "weak"), runtimeRequestId: null, checkpointScopeId: null, startedAt, completedAt } });
      const emitBlock = Effect.fnUntraced(function* (active: Turn, block: Block) {
        const now = yield* DateTime.now;
        const streaming = !block.completed;
        yield* node(active, block.nativeId, block.type === "reasoning" ? "reasoning" : "assistant_message", streaming ? "running" : "completed", block.startedAt, streaming ? null : now);
        const shared = { ...base(active, block.nativeId, block.startedAt, now), status: streaming ? "running" as const : "completed" as const,
          title: null, completedAt: streaming ? null : now, streaming, text: block.text };
        if (block.type === "reasoning") {
          yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: { ...shared, type: "reasoning" } });
        } else {
          const messageId = ids.derive.messageFromProviderItem({ driver: OMP, nativeItemId: block.nativeId });
          yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: { ...shared, type: "assistant_message", messageId } });
          yield* emit({ type: "message.updated", driver: OMP, message: { id: messageId, threadId: active.input.threadId, runId: active.input.runId,
            nodeId: shared.nodeId, role: "assistant", text: block.text, attachments: [], streaming,
            createdBy: "agent", creationSource: "provider", createdAt: block.startedAt, updatedAt: now } });
        }
      });
      const projectMessage = Effect.fnUntraced(function* (active: Turn, message: unknown, completed: boolean) {
        if (field(message, "role") !== "assistant") return;
        const content = field(message, "content");
        if (Array.isArray(content)) for (let index = 0; index < content.length; index++) {
          const part = content[index];
          const kind = field(part, "type");
          if (kind !== "text" && kind !== "thinking") continue;
          const nativeId = `${active.entity.id}:message:${active.messageOrdinal}:content:${index}`;
          const text = string(part, kind === "text" ? "text" : "thinking") ?? "";
          let block = active.blocks.get(nativeId);
          if (block && block.text === text && block.completed === completed) continue;
          if (!block) {
            block = { nativeId, type: kind === "text" ? "assistant_message" : "reasoning", text, completed, startedAt: yield* DateTime.now };
            active.blocks.set(nativeId, block);
          } else { block.text = text; block.completed = completed; }
          yield* emitBlock(active, block);
        }
        // A failed attempt may be retried successfully by OMP. Root status
        // belongs to prompt_result, not an intermediate assistant message.
        if (completed) active.latestAssistantFailure = field(message, "stopReason") === "error"
          ? makeProviderFailure({ message: string(message, "errorMessage") ?? "OMP provider request failed" }) : null;
        const usage = field(message, "usage");
        if (usage !== undefined) active.usages.set(active.messageOrdinal, usage);
      });
      const emitTool = Effect.fnUntraced(function* (active: Turn, event: OmpRpcRecord, phase: "start" | "update" | "end") {
        const callId = string(event, "toolCallId");
        if (!callId) return yield* protocolError("OMP tool event has no call identity");
        const nativeId = `${active.input.providerThread.nativeThreadRef?.nativeId}:tool:${callId}`;
        const now = yield* DateTime.now;
        let tool = active.tools.get(callId);
        if (!tool) { tool = { name: string(event, "toolName") ?? "tool", args: event.args ?? {}, startedAt: now, done: false }; active.tools.set(callId, tool); }
        tool.result = phase === "end" ? event.result : event.partialResult;
        tool.done = phase === "end";
        if (tool.done) { active.hostAdmissions.delete(callId); active.nativePmApprovals.delete(callId); }
        const value = !tool.done ? "running" as const : event.isError !== true ? "completed" as const
          : active.stopping || active.result === "aborted" ? "interrupted" as const : "failed" as const;
        yield* node(active, nativeId, "tool_call", value, tool.startedAt, tool.done ? now : null);
        const shared = { ...base(active, nativeId, tool.startedAt, now), status: value, title: tool.name, completedAt: tool.done ? now : null };
        const output = textContent(field(tool.result, "content"));
        if (tool.name === "bash") {
          const exitCode = number(field(tool.result, "details"), "exitCode");
          yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: { ...shared, type: "command_execution",
            input: string(tool.args, "command") ?? "", output, ...(exitCode === undefined ? {} : { exitCode }) } });
        } else if ((tool.name === "write" || tool.name === "edit") && string(tool.args, "path")) {
          yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: { ...shared, type: "file_change", fileName: string(tool.args, "path")!,
            ...(string(field(tool.result, "details"), "patch") ? { diffStr: string(field(tool.result, "details"), "patch")! } : {}),
            ...(tool.name === "write" ? { newStr: string(tool.args, "content") ?? "" } : {}) } });
        } else {
          yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: { ...shared, type: "dynamic_tool", toolName: tool.name,
            ...mcpToolPresentation({ toolName: tool.name }), input: tool.args,
            ...(tool.result === undefined ? {} : { output: tool.result }) } });
        }
      });
      const resolveUi = Effect.fnUntraced(function* (entry: PendingUi, state: "resolved" | "expired" | "cancelled",
        response?: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) {
        if (pending.get(String(entry.request.id)) !== entry) return;
        pending.delete(String(entry.request.id));
        const now = yield* DateTime.now;
        yield* emit({ type: "runtime_request.updated", driver: OMP, threadId: entry.turn.input.threadId,
          runtimeRequest: { ...entry.request, status: state, resolvedAt: now,
            ...(response?.decision === undefined ? {} : { decision: response.decision }),
            ...(response?.answers === undefined ? {} : { answers: response.answers }),
            ...(response?.feedback === undefined ? {} : { feedback: response.feedback }) } });
        yield* emit({ type: "node.updated", driver: OMP, node: { ...entry.node, status: state === "resolved" ? "completed" : "cancelled", completedAt: now } });
        yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: { ...entry.item, status: state === "resolved" ? "completed" : "cancelled", updatedAt: now, completedAt: now } });
      });
      const cancelUi = Effect.fnUntraced(function* () {
        for (const entry of Array.from(pending.values())) {
          yield* connection.send({ type: "extension_ui_response", id: entry.nativeId, cancelled: true }).pipe(Effect.ignore);
          yield* resolveUi(entry, "cancelled");
        }
      });
      const cancelHostCalls = Effect.fnUntraced(function* () {
        for (const fiber of hostCalls.values()) yield* Fiber.interrupt(fiber);
        hostCalls.clear();
      });
      const finish = Effect.fnUntraced(function* (active: Turn, broken = false) {
        if (turn !== active) return;
        broken ||= active.retiring;
        yield* gate.update({ active: false });
        yield* cancelUi();
        yield* cancelHostCalls();
        for (const block of active.blocks.values()) if (!block.completed) { block.completed = true; yield* emitBlock(active, block); }
        for (const [callId, tool] of active.tools) if (!tool.done) {
          yield* emitTool(active, { toolCallId: callId, toolName: tool.name, result: tool.result, isError: true }, "end");
        }
        const completedAt = yield* DateTime.now;
        const interrupted = active.stopping || active.result === "aborted";
        const failure = active.failure ?? (!interrupted && active.awaitingSettlement ? active.latestAssistantFailure : null);
        let nativeTurnRef = active.entity.nativeTurnRef;
        let leafId: string | null | undefined;
        if (!broken) {
          const native = yield* request({ type: "get_state" });
          if (native.sessionFile !== thread?.nativeThreadRef?.nativeId || native.sessionId !== nativeSessionId ||
            native.isSettled !== true || native.isStreaming !== false || native.isCompacting !== false ||
            native.hasPendingAsyncWork !== false || native.queuedMessageCount !== 0)
            return yield* protocolError("OMP completion did not prove root session quiescence");
          const listing = readOmpActiveBranch(yield* request({ type: "get_entries" }));
          if (!listing) return yield* protocolError("OMP returned an invalid active branch at completion");
          leafId = listing.leafId;
          const baselineIndex = active.baselineLeaf === null ? -1 : listing.entries.findIndex(entry => string(entry, "id") === active.baselineLeaf);
          if (active.baselineLeaf !== null && baselineIndex < 0) return yield* protocolError("OMP changed the native branch during an active root turn");
          const newEntries = listing.entries.slice(baselineIndex + 1);
          const latest = listing.completedTurnRefs.at(-1);
          if (!failure && !interrupted && latest && newEntries.some(entry => string(entry, "id") === latest.nativeId))
            nativeTurnRef = ref(latest.nativeId);
        }
        let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0, usedTokens = 0;
        let hasUsage = active.usages.size > 0;
        for (const usage of active.usages.values()) {
          const input = number(usage, "input"), output = number(usage, "output"), read = number(usage, "cacheRead"), write = number(usage, "cacheWrite");
          if ([input, output, read, write].some(value => value === undefined || !Number.isSafeInteger(value) || value < 0)) { hasUsage = false; break; }
          inputTokens += input! + read! + write!; outputTokens += output!; cacheRead += read!; cacheWrite += write!;
          usedTokens = number(usage, "totalTokens") ?? input! + read! + write! + output!;
        }
        active.entity = { ...active.entity, nativeTurnRef, status: failure ? "failed" : interrupted ? "interrupted" : "completed", completedAt,
          ...(hasUsage ? { tokenUsage: { usedTokens, ...(contextWindow === undefined ? {} : { maxTokens: contextWindow }), inputTokens,
            cachedInputTokens: cacheRead, outputTokens, updatedAt: DateTime.formatIso(completedAt) },
          turnTokenUsage: { usageScope: "main_agent" as const, usageStatus: "partial" as const, inputTokens, outputTokens, cachedInputTokens: cacheRead, cacheCreationTokens: cacheWrite, hasSubagents: false } } : {}) };
        yield* emit({ type: "provider_turn.updated", driver: OMP, threadId: active.input.threadId, providerTurn: active.entity });
        yield* publishThread({ status: broken ? "error" : "idle", ...(leafId === undefined ? {} : { nativeConversationHeadRef: leafId ? ref(leafId) : null }) });
        yield* status(broken || failure ? "error" : "ready", failure?.message ?? null);
        if (failure) {
          const failureItemOrdinal = ordinal(active, `failure:${active.entity.id}`);
          yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: makeProviderFailureTurnItem({ driver: OMP, threadId: active.input.threadId,
            runId: active.input.runId, nodeId: active.input.rootNodeId, providerThreadId: active.input.providerThread.id,
            providerTurnId: active.entity.id, itemOrdinal: failureItemOrdinal, failure, occurredAt: completedAt }) });
          yield* emit({ type: "turn.terminal", driver: OMP, providerThreadId: active.input.providerThread.id, providerTurnId: active.entity.id,
            runOrdinal: active.input.runOrdinal, failureItemOrdinal, status: "failed", failure, threadDisposition: broken ? "broken" : "reusable" });
        } else yield* emit({ type: "turn.terminal", driver: OMP, providerThreadId: active.input.providerThread.id, providerTurnId: active.entity.id,
          runOrdinal: active.input.runOrdinal, status: interrupted ? "interrupted" : "completed", failure: null, threadDisposition: broken ? "broken" : "reusable" });
        turn = null;
      });
      const assertHosted = (wanted: OrchestrationV2ProviderThread): string => {
        const nativeId = wanted.nativeThreadRef?.nativeId;
        if (!thread || typeof nativeId !== "string" || !nativeId || wanted.driver !== OMP ||
          wanted.providerInstanceId !== options.instanceId || wanted.nativeThreadRef?.driver !== OMP ||
          wanted.id !== thread.id || wanted.appThreadId !== thread.appThreadId || nativeId !== thread.nativeThreadRef?.nativeId)
          throw new Error("OMP operation requested for a thread this runtime does not own");
        return nativeId;
      };
      const authorize = (active: Turn) => active.hostTools.authorize.pipe(Effect.andThen(Effect.suspend(() =>
        turn === active && !closed && !active.stopping ? Effect.void : Effect.fail(new Error("OMP execution is no longer live")))));
      const authorizePrompt = (active: Turn) => authorizeOmpPrompt(active.hostTools.binding, runtimeHost).pipe(Effect.andThen(Effect.suspend(() =>
        turn === active && !closed && !active.stopping ? Effect.void : Effect.fail(new Error("OMP execution is no longer live")))));
      const handleUi = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        const method = string(event, "method"), nativeId = string(event, "id");
        if (method === "notify") {
          const message = string(event, "message");
          if (message?.startsWith(gate.ready)) {
            const proof = yield* Effect.try(() => JSON.parse(message.slice(gate.ready.length)) as OmpRpcRecord);
            yield* Deferred.succeed(ready, proof);
          }
          if (message?.startsWith(gate.nativeApproval)) {
            const proof = yield* Effect.try(() => JSON.parse(message.slice(gate.nativeApproval.length)) as OmpRpcRecord);
            const active = turn;
            const callId = string(proof, "toolCallId"), name = string(proof, "toolName");
            const admission = callId ? active?.hostAdmissions.get(callId) : undefined;
            if (active && !active.stopping && callId && name && admission?.name === name &&
              active.hostTools.names.has(name) && proof.agentKind === "main" && proof.sessionId === nativeSessionId &&
              proof.sessionFile === thread?.nativeThreadRef?.nativeId && proof.approvalMode === "always-ask" && proof.reason === undefined)
              active.nativePmApprovals.set(callId, name);
          }
          return;
        }
        if (method === "cancel") {
          const target = string(event, "targetId");
          const entry = Array.from(pending.values()).find(value => value.nativeId === target);
          if (entry) yield* resolveUi(entry, "cancelled");
          return;
        }
        if (!nativeId || ["setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"].includes(method ?? "")) return;
        const active = turn;
        if (!active || active.stopping || event.secret === true || !["confirm", "select", "input", "editor", "ask"].includes(method ?? "")) {
          yield* connection.send({ type: "extension_ui_response", id: nativeId, cancelled: true }); return;
        }
        const duplicate = Array.from(pending.values()).find(entry => entry.nativeId === nativeId);
        if (duplicate) {
          yield* connection.send({ type: "extension_ui_response", id: nativeId, cancelled: true });
          yield* resolveUi(duplicate, "cancelled");
          return;
        }
        const needsToolAuthority = event.title === gate.title ||
          (method === "select" && /^Allow tool: [^\r\n]+(?:\r?\n|$)/.test(string(event, "title") ?? ""));
        yield* (needsToolAuthority ? authorize(active) : authorizePrompt(active));
        const gateCall = parseOmpGateCall(event, gate.title);
        if (event.title === gate.title && !gateCall) {
          yield* connection.send({ type: "extension_ui_response", id: nativeId, confirmed: false }); return;
        }
        if (gateCall) {
          if (gateCall.sessionFile !== thread?.nativeThreadRef?.nativeId || gateCall.sessionId !== nativeSessionId) {
            yield* connection.send({ type: "extension_ui_response", id: nativeId, confirmed: false }); return;
          }
          // Only exact registered host tools are exempt from native approval:
          // they still authorize here and again at the PM bridge invocation.
          if (active.hostTools.names.has(gateCall.toolName)) {
            active.hostAdmissions.set(gateCall.toolCallId, { name: gateCall.toolName, args: gateCall.input });
            yield* connection.send({ type: "extension_ui_response", id: nativeId, confirmed: true }); return;
          }
        }
        const title = gateCall ? `Allow ${gateCall.toolName}?` : string(event, "title") ?? "OMP question";
        // requestApproval() uses the complete "Allow tool:" prompt as the
        // select title in RPC, not a separate Tool approval label.
        const stockTool = method === "select" ? /^Allow tool: ([^\r\n]+)(?:\r?\n|$)/.exec(title)?.[1] : undefined;
        const nativeApproval = stockTool !== undefined;
        if (stockTool && active.hostTools.names.has(stockTool) && Array.isArray(event.options) &&
          event.options.includes("Approve") && event.options.includes("Deny")) {
          const admitted = Array.from(active.nativePmApprovals).find(([callId, name]) =>
            name === stockTool && active.hostAdmissions.get(callId)?.name === name);
          if (admitted) {
            // This is only the stock wrapper's redundant tier prompt. Native
            // tools still use host approval; PM business authorization stays
            // in the bridge, and host_tool_call must consume exact args below.
            yield* authorize(active);
            active.nativePmApprovals.delete(admitted[0]);
            yield* connection.send({ type: "extension_ui_response", id: nativeId, value: "Approve" });
            return;
          }
        }
        const approval = gateCall !== undefined || nativeApproval;
        const requestId = yield* ids.allocate.runtimeRequest({ driver: OMP, providerTurnId: active.entity.id, nativeRequestId: nativeId });
        const at = yield* DateTime.now;
        const nodeId = ids.derive.approvalNode({ requestId });
        const requestKind = approval ? gateCall ? ompPermissionKind(gateCall.toolName) : "permission" : "user_input";
        const runtimeRequest: OrchestrationV2RuntimeRequest = { id: requestId, nodeId, providerTurnId: active.entity.id, nativeRequestRef: ref(nativeId),
          kind: requestKind, status: "pending", responseCapability: { type: "live", providerSessionId: input.providerSessionId }, createdAt: at, resolvedAt: null };
        const requestNode: OrchestrationV2ExecutionNode = { id: nodeId, threadId: active.input.threadId, runId: active.input.runId,
          parentNodeId: active.input.rootNodeId, rootNodeId: active.input.rootNodeId, kind: approval ? "approval_request" : "user_input_request", status: "waiting",
          countsForRun: false, providerThreadId: active.input.providerThread.id, providerTurnId: active.entity.id, nativeItemRef: ref(nativeId),
          runtimeRequestId: requestId, checkpointScopeId: null, startedAt: at, completedAt: null };
        const itemBase = { ...base(active, `ui:${nativeId}`, at, at), id: ids.derive.approvalTurnItem({ requestId }), nodeId,
          nativeItemRef: ref(nativeId), status: "waiting" as const, title, completedAt: null };
        let questions: OrchestrationV2UserInputQuestion[] = [];
        if (!approval) {
          const rawQuestions = method === "ask" ? event.questions : [{ id: nativeId, question: string(event, "message") ?? title,
            header: title, options: method === "confirm" ? [{ label: "Yes" }, { label: "No" }] : event.options ?? [] }];
          if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
            yield* connection.send({ type: "extension_ui_response", id: nativeId, cancelled: true }); return;
          }
          questions = rawQuestions.map((question, index) => ({ id: string(question, "id") ?? `${nativeId}:${index}`,
            header: string(question, "header") || title, question: string(question, "question") || title,
            options: (Array.isArray(field(question, "options")) ? field(question, "options") as unknown[] : []).map((option, optionIndex) => ({
              label: typeof option === "string" ? option : string(option, "label") ?? "",
              description: string(option, "description") || (method === "select" && Array.isArray(event.optionDetails)
                ? string(event.optionDetails[optionIndex], "description") : undefined) || "Select this option",
              ...(string(option, "preview") ? { preview: string(option, "preview")! } : {}) })),
            multiSelect: field(question, "multi") === true, allowCustomAnswer: method !== "confirm" && method !== "select",
            ...(method === "editor" && typeof event.prefill === "string" ? { initialAnswer: event.prefill } : {}) }));
          if (new Set(questions.map(question => question.id)).size !== questions.length ||
            questions.some(question => !question.id || question.options.some(option => !option.label) ||
              new Set(question.options.map(option => option.label)).size !== question.options.length)) {
            yield* connection.send({ type: "extension_ui_response", id: nativeId, cancelled: true }); return;
          }
        }
        const item: OrchestrationV2TurnItem = approval ? { ...itemBase, type: "approval_request", requestId,
          requestKind: requestKind as "permission" | "file-read" | "file-change" | "command",
          options: [{ decision: "accept", label: "Allow once" }, { decision: "decline", label: "Deny" }, { decision: "cancel", label: "Cancel" }],
          prompt: gateCall ? JSON.stringify(gateCall.input, null, 2) : title }
          : { ...itemBase, type: "user_input_request", requestId, questions };
        const timeout = number(event, "timeout");
        const entry: PendingUi = { nativeId, turn: active, method: method!, record: event, approval,
          expiresAt: timeout === undefined || timeout === 0 ? null : DateTime.toEpochMillis(at) + Math.max(0, timeout), request: runtimeRequest, node: requestNode, item };
        pending.set(String(requestId), entry);
        yield* emit({ type: "runtime_request.updated", driver: OMP, threadId: active.input.threadId, runtimeRequest });
        yield* emit({ type: "node.updated", driver: OMP, node: requestNode });
        yield* emit({ type: "turn_item.updated", driver: OMP, turnItem: item });
        if (entry.expiresAt !== null) yield* Effect.sleep(Duration.millis(Math.max(0, entry.expiresAt - Date.now()))).pipe(
          Effect.andThen(Queue.offer(connection.events, { type: "pm.ui_expired", requestId: String(requestId), promptId: active.promptId })), Effect.forkIn(scope));
      });
      const handle = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        const type = string(event, "type");
        if (type === "extension_ui_request") return yield* handleUi(event);
        if (type === "host_tool_cancel") {
          const id = string(event, "targetId"); const fiber = id ? hostCalls.get(id) : undefined;
          if (fiber) { hostCalls.delete(id!); yield* Fiber.interrupt(fiber); } return;
        }
        if (type === "host_tool_call") {
          const active = turn, id = string(event, "id");
          if (!id) return yield* protocolError("OMP host tool request has no identity");
          const toolCallId = string(event, "toolCallId");
          const admission = toolCallId ? active?.hostAdmissions.get(toolCallId) : undefined;
          if (!active || active.stopping || hostCalls.has(id) || !admission || admission.name !== event.toolName ||
            !isDeepStrictEqual(admission.args, event.arguments)) {
            yield* connection.send({ type: "host_tool_result", id, isError: true,
              result: { content: [{ type: "text", text: "No live host execution admits this tool request" }] } }); return;
          }
          active.hostAdmissions.delete(toolCallId!);
          active.nativePmApprovals.delete(toolCallId!);
          const fiber = yield* authorize(active).pipe(Effect.andThen(active.hostTools.call(event)), Effect.matchEffect({
            onFailure: error => connection.send({ type: "host_tool_result", id, isError: true,
              result: { content: [{ type: "text", text: error.message }] } }).pipe(Effect.ignore),
            onSuccess: result => turn === active && !active.stopping
              ? connection.send({ type: "host_tool_result", id, result }).pipe(Effect.ignore) : Effect.void,
          }), Effect.ensuring(Effect.sync(() => hostCalls.delete(id))), Effect.forkIn(scope));
          hostCalls.set(id, fiber); return;
        }
        if (type === "host_uri_request") {
          if (typeof event.id === "string") yield* connection.send({ type: "host_uri_result", id: event.id, error: "Host URI schemes are unsupported" });
          return;
        }
        const active = turn;
        if (type === "pm.ui_expired") {
          const entry = pending.get(String(event.requestId));
          if (entry && active === entry.turn && entry.turn.promptId === event.promptId) {
            yield* connection.send({ type: "extension_ui_response", id: entry.nativeId, cancelled: true });
            yield* resolveUi(entry, "expired");
          }
          return;
        }
        if (!active) {
          if (["agent_start", "message_start", "tool_execution_start"].includes(type ?? "")) {
            closed = true; yield* gate.update({ active: false }); yield* connection.terminate;
            return yield* protocolError("OMP started work outside an active PM generation");
          }
          return;
        }
        if (type?.startsWith("pm.") && event.promptId !== active.promptId) return;
        switch (type) {
          case "message_start":
            if (field(event.message, "role") === "assistant") { active.messageOrdinal++; yield* projectMessage(active, event.message, false); } return;
          case "command_output": {
            const text = string(event, "text");
            if (text === undefined) return;
            const nativeId = `${active.entity.id}:command-output`;
            let block = active.blocks.get(nativeId);
            if (!block) {
              block = { nativeId, type: "assistant_message", text: "", completed: false, startedAt: yield* DateTime.now };
              active.blocks.set(nativeId, block);
            }
            block.text += (block.text ? "\n" : "") + text;
            yield* emitBlock(active, block);
            return;
          }
          case "message_update": yield* projectMessage(active, event.message ?? field(event.assistantMessageEvent, "partial"), false); return;
          case "message_end": yield* projectMessage(active, event.message, true); return;
          case "tool_execution_start": yield* emitTool(active, event, "start"); return;
          case "tool_execution_update": yield* emitTool(active, event, "update"); return;
          case "tool_execution_end": yield* emitTool(active, event, "end"); return;
          case "agent_end":
            if (!active.stopping && active.result && event.isTerminal === true && event.yielded === true && active.latestAssistantFailure)
              active.failure ??= active.latestAssistantFailure;
            return;
          case "prompt_result": {
            if (event.id !== active.promptId) return;
            if (!["completed", "aborted", "error"].includes(String(event.status)) || typeof event.sessionSettled !== "boolean")
              return yield* protocolError("Malformed OMP prompt completion");
            active.result = event.status as Turn["result"];
            active.awaitingSettlement = event.sessionSettled === false;
            if (event.status === "error") active.failure ??= makeProviderFailure({ message: string(event.error, "message") ?? "OMP prompt failed",
              retryable: field(event.error, "retryable") === true, code: string(event.error, "code") });
            if (event.sessionSettled === true) yield* finish(active);
            return;
          }
          case "session_settled": {
            if (!active.result) return;
            const state = yield* request({ type: "get_state" });
            if (state.sessionFile !== thread?.nativeThreadRef?.nativeId || state.sessionId !== nativeSessionId)
              return yield* protocolError("OMP session identity changed before settling");
            if (state.isSettled === true && state.isStreaming === false && state.isCompacting === false && state.queuedMessageCount === 0 && state.hasPendingAsyncWork === false)
              yield* finish(active);
            return;
          }
          case "pm.prompt_ack":
            if (field(event.data, "agentInvoked") === false) { active.result = "completed"; yield* finish(active); } return;
          case "pm.prompt_error":
            active.failure ??= makeProviderFailure({ message: "OMP rejected the prompt", cause: event.error });
            active.result = "error";
            yield* connection.terminate; yield* finish(active, true); closed = true; return;
          case "pm.stop_deadline":
            if (active.stopping) { closed = true; yield* connection.terminate; yield* finish(active, true); } return;
          case "extension_error": case "rpc_frame_error":
            active.failure ??= makeProviderFailure({ message: string(event, "error") ?? "OMP native execution boundary failed" });
            closed = true; yield* connection.terminate; yield* finish(active, true); return;
          case "notice":
            if (event.source === "session-persistence" && event.level === "error") {
              active.failure ??= makeProviderFailure({ message: "OMP native session persistence failed" });
              closed = true; yield* connection.terminate; yield* finish(active, true);
            } return;
        }
      });
      yield* Effect.gen(function* () {
        for (;;) yield* permit.withPermits(1)(handle(yield* Queue.take(connection.events)));
      }).pipe(Effect.catchCause(cause => permit.withPermits(1)(Effect.gen(function* () {
        const active = turn;
        closed = true;
        yield* Deferred.fail(ready, protocolError("OMP permission boundary did not start", cause));
        yield* gate.update({ active: false }).pipe(Effect.ignore);
        if (active) {
          if (!active.stopping) active.failure ??= makeProviderFailure({ message: "OMP stream closed without a settled prompt result", cause, class: "transport_error" });
          yield* finish(active, true).pipe(Effect.ignore);
        }
        yield* cancelUi(); yield* cancelHostCalls();
        yield* status("error", "OMP process is no longer available");
        yield* Queue.fail(events, new ProviderAdapter.ProviderAdapterEventStreamError({ driver: OMP, providerSessionId: input.providerSessionId, cause }));
      }))), Effect.forkIn(scope));
      const proof = yield* Deferred.await(ready).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(30), orElse: () => Effect.fail(protocolError("OMP permission gate startup was not acknowledged")) }));
      if (proof.version !== OMP_GATE_VERSION || typeof proof.cwd !== "string" || typeof proof.homeDirectory !== "string" ||
        (string(proof, "profile")?.trim() || "default") !== (nativeHome.profile ?? "default") || typeof proof.sessionDirectory !== "string")
        return yield* protocolError("OMP native permission gate identity does not match the host lease");
      if ((yield* fs.realPath(proof.cwd)) !== (yield* fs.realPath(cwd)) ||
        (yield* fs.realPath(proof.homeDirectory)) !== (yield* fs.realPath(nativeHome.homeDirectory)))
        return yield* protocolError("OMP native cwd/Home differs from the bound host lease");
      const expectedRoot = yield* fs.realPath(nativeHome.sessionsDirectory);
      const actualDirectory = yield* fs.realPath(proof.sessionDirectory);
      const relative = NodePath.relative(expectedRoot, actualDirectory);
      if (NodePath.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${NodePath.sep}`))
        return yield* protocolError("OMP native session directory does not match its Home/Profile");
      yield* request({ type: "set_event_filter", events: null, messageUpdates: "full" });
      yield* request({ type: "set_ask_dialog", enabled: true });
      yield* request({ type: "set_subagent_subscription", level: "off" });
      yield* request({ type: "set_cache_warming", mode: "off" });
      yield* status("ready");

      const verifyNative = Effect.fnUntraced(function* (expected?: string, stable = false) {
        const state = yield* request({ type: "get_state" });
        const file = string(state, "sessionFile"), id = string(state, "sessionId");
        if (!file || !id || typeof state.isStreaming !== "boolean" || typeof state.isSettled !== "boolean" || (expected && file !== expected))
          return yield* protocolError("OMP did not confirm the requested native RPC identity");
        if (stable && (state.isSettled !== true || state.isStreaming !== false || state.isCompacting !== false || state.hasPendingAsyncWork !== false || state.queuedMessageCount !== 0))
          return yield* protocolError("OMP native session is not at an exact settled boundary");
        if (yield* fs.exists(file)) {
          const header = yield* readOmpSessionHeader({ sessionFile: file, sessionsDirectory: nativeHome.sessionsDirectory, cwd }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          if (header.id !== id) return yield* protocolError("OMP state and durable session header disagree");
        } else {
          // Empty sessions are lazy-persisted. Verify the existing parent rather
          // than manufacturing a header or claiming durable history.
          const parent = yield* fs.realPath(NodePath.dirname(file));
          const rel = NodePath.relative(expectedRoot, parent);
          if (rel === ".." || rel.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(rel))
            return yield* protocolError("OMP lazy session path is outside its native Home");
        }
        nativeSessionId = id;
        return state;
      });
      const selection = Effect.fnUntraced(function* (model: ModelSelection) {
        if (model.instanceId !== options.instanceId) return yield* protocolError("OMP model selection belongs to another instance");
        const previous = yield* verifyNative(thread?.nativeThreadRef?.nativeId ?? undefined, true);
        const initial = field(previous, "model");
        if (!baselineModel && string(initial, "provider") && string(initial, "id")) baselineModel = { provider: string(initial, "provider")!, modelId: string(initial, "id")! };
        baselineThinking ??= string(previous, "thinkingLevel") ?? "inherit";
        const parsed = model.model === "default" ? baselineModel : parseOmpModelSlug(model.model);
        if (!parsed) return yield* protocolError("OMP model must use provider/model format (or a confirmed native default)");
        const selected = yield* request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId });
        if (string(selected, "provider") !== parsed.provider || string(selected, "id") !== parsed.modelId)
          return yield* protocolError("OMP did not select the requested model");
        contextWindow = number(selected, "contextWindow");
        const thinking = getModelSelectionStringOptionValue(model, "thinking") ?? baselineThinking;
        if (!["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) return yield* protocolError("Unsupported OMP thinking level");
        const applied = yield* request({ type: "set_thinking_level", level: thinking });
        if (thinking !== "inherit" && string(applied, "level") !== thinking) {
          const state = yield* request({ type: "get_state" });
          if (state.thinkingLevel !== thinking) return yield* protocolError("OMP did not retain the requested thinking level");
        }
        session = { ...session, model: model.model, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver: OMP, providerSession: session });
      });
      const register = Effect.fnUntraced(function* (ensure: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) {
        if (closed || turn || starting) return yield* protocolError("Cannot change an active or closed OMP session");
        if (ensure.threadId !== input.threadId || (ensure.runtimePolicy.cwd ?? cwd) !== cwd || ensure.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode)
          return yield* protocolError("OMP thread policy or owner differs from the scoped session");
        const existing = ensure.forceNewNativeThread ? undefined : ensure.existingProviderThread;
        const wanted = existing?.nativeThreadRef?.nativeId ?? (!registered ? input.initialNativeThreadId : undefined);
        if (existing && (existing.driver !== OMP || existing.providerInstanceId !== options.instanceId ||
          existing.appThreadId !== ensure.threadId || existing.nativeThreadRef?.driver !== OMP ||
          typeof existing.nativeThreadRef.nativeId !== "string" || !existing.nativeThreadRef.nativeId))
          return yield* protocolError("Cannot import a non-OMP or foreign provider thread");
        if (wanted) {
          const header = yield* readOmpSessionHeader({ sessionFile: wanted, sessionsDirectory: nativeHome.sessionsDirectory, cwd }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          const changed = yield* request({ type: "switch_session", sessionPath: wanted });
          if (changed.cancelled === true) return yield* protocolError("OMP cancelled native session restoration");
          const native = yield* verifyNative(wanted, true);
          if (native.sessionId !== header.id) return yield* protocolError("OMP restored a different native session");
          const restoredBranch = readOmpActiveBranch(yield* request({ type: "get_entries" }));
          if (!restoredBranch || restoredBranch.entries.some(entry => field(entry, "type") === "message" &&
            string(field(entry, "runtime"), "version") !== "18.13.2"))
            return yield* protocolError("OMP restore requires native writer evidence from the supported OMP revision; Pi history is not adopted");
          const savedHead = existing?.nativeConversationHeadRef;
          if (savedHead?.strength === "strong" && (savedHead.driver !== OMP || typeof savedHead.nativeId !== "string" ||
            !ompBranchPreservesConversationHead(restoredBranch.entries, savedHead.nativeId)))
            return yield* protocolError("OMP native conversation advanced beyond the exact saved cursor");
        } else if (registered) {
          const prior = thread?.nativeThreadRef?.nativeId;
          const changed = yield* request({ type: "new_session" });
          if (changed.cancelled === true) return yield* protocolError("OMP cancelled native session creation");
          const state = yield* verifyNative(undefined, true);
          if (state.sessionFile === prior) return yield* protocolError("OMP did not create a distinct native session");
        }
        const native = yield* verifyNative(wanted, true);
        registered = true;
        baselineModel = null; baselineThinking = null;
        const nativeId = string(native, "sessionFile")!;
        const now = yield* DateTime.now;
        const created: OrchestrationV2ProviderThread = existing ? { ...existing, providerSessionId: input.providerSessionId, status: "idle", updatedAt: now } : {
          id: ids.derive.providerThread({ driver: OMP, nativeThreadId: nativeId, providerInstanceId: options.instanceId }), driver: OMP, providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId, appThreadId: ensure.threadId, ownerNodeId: null, nativeThreadRef: ref(nativeId), nativeConversationHeadRef: null,
          status: "idle", firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [], forkedFrom: null, pendingBackgroundTasks: [], createdAt: now, updatedAt: now };
        thread = created;
        yield* selection(ensure.modelSelection);
        yield* emit({ type: "provider_thread.updated", driver: OMP, providerThread: created });
        return created;
      });
      const snapshot = Effect.fnUntraced(function* (wanted: OrchestrationV2ProviderThread) {
        const nativeId = yield* Effect.try(() => assertHosted(wanted));
        const native = yield* verifyNative(nativeId, !turn);
        const branch = readOmpActiveBranch(yield* request({ type: "get_entries" }));
        if (!branch) return yield* protocolError("OMP snapshot has an invalid active branch");
        let messages: unknown[] = [];
        if (turn) {
          const data = yield* request({ type: "get_messages" });
          if (!Array.isArray(data.messages)) return yield* protocolError("OMP did not return its active transcript");
          messages = data.messages;
        } else {
          const cursors = new Set<string>();
          let cursor: string | undefined;
          let total: number | undefined;
          do {
            const page = yield* request({ type: "get_messages_page", limit: 128, ...(cursor ? { cursor } : {}) });
            if (!Array.isArray(page.messages) || !Number.isSafeInteger(page.totalMessages) || (page.totalMessages as number) < 0 ||
              (total !== undefined && page.totalMessages !== total))
              return yield* protocolError("OMP transcript pagination changed its snapshot identity");
            total = page.totalMessages as number;
            messages.push(...page.messages);
            const next = page.nextCursor;
            if (next !== undefined && next !== null && (typeof next !== "string" || !next || cursors.has(next)))
              return yield* protocolError("OMP transcript returned an invalid or repeated cursor");
            cursor = typeof next === "string" ? next : undefined;
            if (cursor) cursors.add(cursor);
          } while (cursor);
          if (messages.length !== total) return yield* protocolError("OMP transcript pagination was incomplete");
          const after = yield* verifyNative(nativeId, true);
          const afterBranch = readOmpActiveBranch(yield* request({ type: "get_entries" }));
          if (after.sessionId !== native.sessionId || !afterBranch || afterBranch.leafId !== branch.leafId)
            return yield* protocolError("OMP native history changed during snapshot capture");
        }
        const lastMessageEntry = branch.entries.filter(entry => field(entry, "type") === "message").at(-1);
        const latestCompleted = branch.completedTurnRefs.at(-1);
        const hasCompletedTip = latestCompleted !== undefined && string(lastMessageEntry, "id") === latestCompleted.nativeId;
        const now = yield* DateTime.now;
        const current = { ...thread!, nativeConversationHeadRef: branch.leafId ? ref(branch.leafId) : null,
          nativeMetadata: { ...thread!.nativeMetadata, modelSelection: { instanceId: options.instanceId,
            model: `${string(native.model, "provider")}/${string(native.model, "id")}` } } };
        if (!turn) thread = current;
        return { providerThread: current, providerTurns: [], runtimeRequests: Array.from(pending.values()).map(entry => entry.request),
          messages: messages.flatMap((message, index) => {
            const role = string(message, "role");
            if (role !== "user" && role !== "assistant") return [];
            const text = textContent(field(message, "content"));
            if (!text) return [];
            const timestamp = number(message, "timestamp");
            const at = timestamp !== undefined && Number.isFinite(timestamp) ? DateTime.makeUnsafe(timestamp) : now;
            return [{ id: ids.derive.messageFromProviderItem({ driver: OMP, nativeItemId: `${nativeId}:message:${index}` }),
              threadId: wanted.appThreadId ?? input.threadId, runId: null, nodeId: null, role, text, attachments: [], streaming: false,
              createdBy: role === "user" ? "user" as const : "agent" as const, creationSource: "provider" as const, createdAt: at, updatedAt: at }];
          }), ...(turn ? {} : { nativeHistory: { nativeSessionId: nativeId, completedTurnRefs: branch.completedTurnRefs,
            ...(hasCompletedTip ? { latestCompletedTurnRef: latestCompleted! } : {}) } }) } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
      });
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId, driver: OMP, providerSessionId: input.providerSessionId,
        get providerSession() { return session; }, events: Stream.fromQueue(events),
        hasPendingBackgroundWork: Effect.sync(() => turn !== null && turn.result !== null),
        hasPendingBackgroundWorkForThread: wanted => Effect.sync(() => thread?.id === wanted.id && turn !== null && turn.result !== null),
        // Native async processes can outlive OMP on platforms without AgentScope;
        // do not make backgroundTasksEndWithProcess=true promises here.
        ensureThread: ensure => protect(register(ensure)),
        resumeThread: resume => protect(register({ threadId: resume.threadId ?? input.threadId, existingProviderThread: resume.providerThread,
          modelSelection: resume.modelSelection ?? input.modelSelection, runtimePolicy: resume.runtimePolicy ?? input.runtimePolicy })),
        startTurn: turnInput => protect(Effect.gen(function* () {
          yield* Effect.try(() => { assertHosted(turnInput.providerThread); assertOmpPromptIsSafe(turnInput.message.text); });
          if (turn || starting || closed) return yield* protocolError("OMP previous turn is still active or the process is unavailable");
          if (turnInput.threadId !== input.threadId || (turnInput.runtimePolicy.cwd ?? cwd) !== cwd || turnInput.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode)
            return yield* protocolError("OMP turn policy differs from its scoped session");
          starting = true;
          yield* Effect.gen(function* () {
            const binding = yield* runtimeHost.read({ threadId: turnInput.threadId, providerInstanceId: options.instanceId });
            if (!binding || binding.cwd !== cwd || binding.threadId !== turnInput.threadId || binding.providerInstanceId !== options.instanceId)
              return yield* protocolError("OMP requires a live generation-local RuntimeHost binding");
            if ((binding.promptAuthorization === "technical-no-tools") !== technicalNoTools)
              return yield* protocolError("OMP prompt authorization mode changed; reopen the scoped native session");
            const hostTools = yield* makeOmpHostTools(binding, runtimeHost);
            const registeredTools = yield* request({ type: "set_host_tools", tools: hostTools.tools });
            if (!Array.isArray(registeredTools.toolNames) || registeredTools.toolNames.length !== hostTools.names.size ||
              registeredTools.toolNames.some(name => typeof name !== "string" || !hostTools.names.has(name)))
              return yield* protocolError("OMP did not register the exact host PM tool schemas");
            yield* selection(turnInput.modelSelection);
            const message = yield* providerMessageTextWithAttachmentPaths({ text: turnInput.message.text, attachments: turnInput.message.attachments,
              resolveAttachmentPath: host.resolveAttachmentPath, resolveExtractedTextPath: host.resolveExtractedTextPath });
            const images: OmpRpcRecord[] = [];
            for (const attachment of turnInput.message.attachments) if (attachment.mimeType.startsWith("image/")) {
              const path = host.resolveAttachmentPath(attachment);
              if (!path) return yield* protocolError("OMP image attachment has no host path");
              images.push({ type: "image", data: Buffer.from(yield* fs.readFile(path)).toString("base64"), mimeType: attachment.mimeType });
            }
            yield* authorizeOmpPrompt(binding, runtimeHost);
            const baseline = readOmpActiveBranch(yield* request({ type: "get_entries" }));
            if (!baseline) return yield* protocolError("OMP has no valid active branch before prompt admission");
            const startedAt = yield* DateTime.now;
            const promptId = `omp:${input.providerSessionId}:${turnInput.attemptId}:${turnInput.providerTurnOrdinal}`;
            const entity: OrchestrationV2ProviderTurn = { id: ids.derive.providerTurn({ driver: OMP, nativeTurnId: promptId }),
              providerThreadId: turnInput.providerThread.id, nodeId: turnInput.rootNodeId, runAttemptId: turnInput.attemptId,
              nativeTurnRef: ref(promptId, "weak"), ordinal: turnInput.providerTurnOrdinal, status: "running", startedAt, completedAt: null };
            const active: Turn = { input: turnInput, entity, promptId, hostTools, blocks: new Map(), tools: new Map(), ordinals: new Map(),
              usages: new Map(), hostAdmissions: new Map(), nativePmApprovals: new Map(), baselineLeaf: baseline.leafId, nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1, messageOrdinal: 0,
              result: null, failure: null, latestAssistantFailure: null, awaitingSettlement: false, stopping: false, retiring: false };
            yield* permit.withPermits(1)(Effect.gen(function* () {
              if (closed || turn) return yield* protocolError("OMP turn admission changed before dispatch");
              yield* gate.update({ active: true, instructionText: binding.instructionText,
                ...(turnInput.appContext === undefined ? {} : { appContext: turnInput.appContext }) });
              turn = active; thread = turnInput.providerThread;
              yield* emit({ type: "provider_turn.updated", driver: OMP, threadId: turnInput.threadId, providerTurn: entity });
              yield* publishThread({ status: "active", firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal, lastRunOrdinal: turnInput.runOrdinal });
              yield* status("running");
            }));
            yield* request({ id: promptId, type: "prompt", message, ...(images.length ? { images } : {}) }).pipe(
              Effect.matchEffect({ onFailure: error => Queue.offer(connection.events, { type: "pm.prompt_error", promptId, error }),
                onSuccess: data => Queue.offer(connection.events, { type: "pm.prompt_ack", promptId, data }) }), Effect.forkIn(scope));
          }).pipe(Effect.ensuring(Effect.sync(() => { starting = false; })));
        })),
        steerTurn: steer => protect(Effect.gen(function* () {
          yield* Effect.try(() => { assertHosted(steer.providerThread); assertOmpPromptIsSafe(steer.message.text); });
          const active = turn;
          if (!active || active.entity.id !== steer.providerTurnId || active.input.runId !== steer.runId || active.stopping || active.result)
            return yield* protocolError("OMP steering requires the current live root turn");
          if (steer.message.attachments.length) return yield* protocolError("OMP active steering attachments are unsupported");
          yield* authorizePrompt(active);
          yield* request({ type: "steer", message: steer.message.text });
        })),
        interruptTurn: interrupt => protect(Effect.gen(function* () {
          yield* Effect.try(() => assertHosted(interrupt.providerThread));
          const active = turn;
          if (!active && interrupt.requestRuntimeRestart === true) {
            closed = true;
            yield* gate.update({ active: false }); yield* cancelUi(); yield* cancelHostCalls();
            yield* connection.terminate;
            return;
          }
          if (!active || active.entity.id !== interrupt.providerTurnId) return yield* protocolError("OMP stop request does not own the active root turn");
          yield* permit.withPermits(1)(Effect.gen(function* () {
            active.stopping = true; active.retiring = interrupt.requestRuntimeRestart === true;
            yield* gate.update({ active: false }); yield* cancelUi(); yield* cancelHostCalls();
          }));
          // ACK is not terminal. Keep the root generation alive through native
          // result + session_settled; a bounded force-stop retires the process.
          yield* Effect.sleep(Duration.seconds(15)).pipe(Effect.andThen(Queue.offer(connection.events,
            { type: "pm.stop_deadline", promptId: active.promptId })), Effect.forkIn(scope));
          yield* request({ type: "abort" }, active.retiring ? 2_000 : 10_000).pipe(Effect.catch(() => connection.terminate));
          if (active.retiring) { closed = true; yield* connection.terminate; }
        })),
        respondToRuntimeRequest: response => protect(permit.withPermits(1)(Effect.gen(function* () {
          const entry = pending.get(String(response.requestId));
          if (!entry || turn !== entry.turn || entry.turn.stopping || closed || (entry.expiresAt !== null && Date.now() >= entry.expiresAt))
            return yield* protocolError("OMP request is expired, cancelled, or belongs to another generation");
          yield* (entry.approval ? authorize(entry.turn) : authorizePrompt(entry.turn));
          let payload: OmpRpcRecord;
          if (response.decision === "cancel") {
            if (response.answers) return yield* protocolError("OMP cancellation cannot also submit an answer");
            payload = { cancelled: true };
          } else if (entry.approval) {
            if (!response.decision || response.answers || !["accept", "decline"].includes(response.decision))
              return yield* protocolError("OMP permissions require an explicit per-call accept/decline/cancel decision");
            const accepted = response.decision === "accept";
            if (entry.method === "select") {
              const labels = Array.isArray(entry.record.options) ? entry.record.options : [];
              const value = accepted ? labels.find(value => value === "Approve" || value === "Approve Once") : labels.find(value => value === "Deny");
              if (typeof value !== "string") return yield* protocolError("OMP native approval choices are unsupported");
              payload = { value };
            } else payload = { confirmed: accepted };
          } else {
            if (response.decision || !response.answers || entry.item.type !== "user_input_request")
              return yield* protocolError("OMP questions require answers, not a permission decision");
            const answers = response.answers;
            if (entry.method === "ask") {
              const nativeAnswers: OmpRpcRecord[] = [];
              for (const question of entry.item.questions) {
                const answer = answers[question.id];
                const values = typeof answer === "string" ? [answer] : Array.isArray(answer) && answer.every(value => typeof value === "string") ? answer as string[] : undefined;
                if (!values || (!question.multiSelect && values.length !== 1)) return yield* protocolError("Invalid OMP question answer");
                const labels = new Set(question.options.map(option => option.label));
                const selectedOptions = values.filter(value => labels.has(value));
                const custom = values.filter(value => !labels.has(value));
                if (new Set(values).size !== values.length || custom.length > 1 || (!question.multiSelect && selectedOptions.length && custom.length))
                  return yield* protocolError("Invalid OMP question choice combination");
                nativeAnswers.push({ id: question.id, selectedOptions, ...(custom.length ? { customInput: custom[0] } : {}) });
              }
              payload = { answers: nativeAnswers };
            } else {
              const question = entry.item.questions[0]!;
              const answer = answers[question.id];
              if (typeof answer !== "string") return yield* protocolError("OMP dialog requires a string answer");
              if (entry.method === "confirm") {
                if (answer !== "Yes" && answer !== "No") return yield* protocolError("OMP confirmation requires Yes or No");
                payload = { confirmed: answer === "Yes" };
              } else {
                if (entry.method === "select" && !question.options.some(option => option.label === answer))
                  return yield* protocolError("OMP select answer must match an offered option");
                payload = { value: answer };
              }
            }
          }
          // Authorization is rechecked after answer validation; same admission ID.
          yield* (entry.approval ? authorize(entry.turn) : authorizePrompt(entry.turn));
          yield* connection.send({ type: "extension_ui_response", id: entry.nativeId, ...payload });
          yield* resolveUi(entry, response.decision === "cancel" ? "cancelled" : "resolved", response);
        }))),
        readThreadSnapshot: value => protect(snapshot(value.providerThread)),
        rollbackThread: () => Effect.fail(protocolError("OMP rollback is unsupported; capability=false")),
        forkThread: () => Effect.fail(protocolError("OMP fork is unsupported; capability=false")),
      };
      const unbind = bindOmpSessionEvidence(runtime, {
        probe: protect(Effect.gen(function* () {
          const native = yield* verifyNative(thread?.nativeThreadRef?.nativeId ?? undefined);
          if (!readOmpActiveBranch(yield* request({ type: "get_entries" }))) return yield* protocolError("OMP native session tree schema was not confirmed");
          if (proof.sessionId !== native.sessionId && !registered) return yield* protocolError("OMP initial native identity changed");
          return { protocol: "omp.rpc-jsonl-v2:get_state+get_entries:boundary-v1", cwd, homeDirectory: nativeHome.homeDirectory };
        })),
        readLegacy: legacy => protect(Effect.gen(function* () {
          if (turn || starting || closed) return yield* protocolError("Cannot restore OMP history during live native work");
          if (legacy.ensure.existingProviderThread?.nativeThreadRef?.nativeId !== undefined &&
            legacy.ensure.existingProviderThread.nativeThreadRef.nativeId !== legacy.nativeSessionId)
            return yield* protocolError("OMP legacy requested path disagrees with the saved provider identity");
          const restored = yield* register({ ...legacy.ensure, existingProviderThread: legacy.ensure.existingProviderThread ?? {
            id: ids.derive.providerThread({ driver: OMP, nativeThreadId: legacy.nativeSessionId, providerInstanceId: options.instanceId }), driver: OMP,
            providerInstanceId: options.instanceId, providerSessionId: input.providerSessionId, appThreadId: legacy.ensure.threadId,
            ownerNodeId: null, nativeThreadRef: ref(legacy.nativeSessionId), nativeConversationHeadRef: null, status: "idle",
            firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [], forkedFrom: null, pendingBackgroundTasks: [], createdAt: yield* DateTime.now, updatedAt: yield* DateTime.now } });
          if (restored.nativeThreadRef?.nativeId !== legacy.nativeSessionId) return yield* protocolError("OMP legacy source does not match the requested native session");
          const result = yield* snapshot(restored);
          if (!result.nativeHistory?.completedTurnRefs.length || (legacy.turnId && !result.nativeHistory.completedTurnRefs.some(value => value.nativeId === legacy.turnId)))
            return yield* protocolError("OMP legacy history has no exact successful native assistant boundary");
          const boundary = legacy.messageId ?? legacy.turnId;
          if (boundary) {
            const branch = readOmpActiveBranch(yield* request({ type: "get_entries" }));
            if (!branch || branch.leafId !== result.providerThread.nativeConversationHeadRef?.nativeId ||
              !ompBranchPreservesConversationHead(branch.entries, boundary))
              return yield* protocolError("OMP legacy conversation advanced beyond the requested native boundary");
            // PM's exact-head consumer compares the requested conversational
            // cursor, not OMP's later dispose metadata leaf. This is the real
            // observed ancestor, with the suffix proven not to change context.
            const current = { ...result.providerThread, nativeConversationHeadRef: ref(boundary) };
            thread = current;
            return { ...result, providerThread: current };
          }
          return result;
        })),
      });
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        closed = true; unbind(); yield* gate.update({ active: false }).pipe(Effect.ignore);
        yield* cancelUi(); yield* cancelHostCalls(); yield* Queue.end(events);
      }));
      return runtime;
    })),
  });
});

export type OmpAdapterV2DriverEnv = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | IdAllocator.IdAllocatorV2 | ProviderRuntimeHost | ProviderHost.ProviderHost;
export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP, configSchema: OmpSettings, defaultConfig: () => Schema.decodeSync(OmpSettings)({}),
  create: Effect.fn("OmpAdapterV2Driver.create")(function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
    const environment = yield* HostProcess.Environment;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    return yield* makeOmpAdapterV2({ instanceId: input.instanceId, settings: { ...input.config, enabled: input.enabled },
      environment: yield* mergeProviderInstanceEnvironment(input.environment, environment), continuationRequests });
  }, (effect, input) => effect.pipe(Effect.mapError(cause => new ProviderAdapterDriverCreateError({ driver: OMP, instanceId: input.instanceId,
    detail: "Failed to create OMP adapter", cause })))),
};

import { createHash, randomUUID } from "node:crypto";
import type { ThreadActionCapabilities } from "@agent-workspace/contracts/chat";
import { resolveProviderRuntime } from "../providers/runtime.ts";
import { getLiveSteering } from "../providers/t3code/live-actions.ts";
import { closeMcpAppSession } from "../mcp-apps/live.ts";
import { createPmVisibilityProjector, recordPmContentProvenance } from "../pm-visibility.ts";
import { resolveChatExecutionScope, deliveryStore } from "../task-delivery/binding.ts";
import { authorizePmTarget, resolvePmReferenceOperations } from "./pm-context.ts";
import { sameExecutionIdentity } from "./agent-execution.ts";
import { forkChatGeneration, getActiveChat, getChatGeneration, listChatGenerations, submitChat } from "./chat-runtime.ts";
import { getNativeOutput, emitNativeOutput } from "./native-output.ts";
import { listRuns, withThreadExecution } from "./engine.ts";
import { DurableError } from "./errors.ts";
import { getThread, getThreadBranch, getThreadHistory, ensureThread, setThreadHead, setThreadNativeSession, updateThread, ThreadConflictError } from "./threads.ts";
import { listRecords, readRecord, transaction, writeRecord } from "./store.ts";

const OPERATIONS = "chat:thread-actions", STEERING = "chat:steering";
function requireThread(id: string) {
  const thread = getThread(id);
  if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
  return thread;
}
/** A derived ordinary Session must never discard a managed operation's tool/scope ceiling. */
function managedSession(threadId: string): boolean {
  return deliveryStore.list().some(value => value.threadId === threadId) ||
    listRecords<{ threadId: string }>("pm-automation:native-thread-bindings").some(value => value.threadId === threadId) ||
    listRecords<{ threadId: string }>("pm-automation:native-repositories").some(value => value.threadId === threadId);
}
function assertIdle(threadId: string): void {
  if (getActiveChat(threadId) || listRuns(threadId).some(value => value.status === "queued" || value.status === "running"))
    throw new DurableError(409, "chat_busy", "当前会话仍在执行；请等待完成或明确停止，不自动中断。");
}
export async function threadActionCapabilities(threadId: string, headers: Headers): Promise<ThreadActionCapabilities> {
  const thread = requireThread(threadId);
  await resolveChatExecutionScope(thread, headers, "inspect");
  const active = getActiveChat(threadId), live = active ? getLiveSteering(active.id) : undefined;
  const managed = managedSession(threadId), archived = thread.status === "archived";
  const blockedReason = managed ? "受管交付/自动化会话不能通过普通会话操作绕过原始范围与工具限制。" : archived ? "请先恢复已归档会话。" : undefined;
  let nativeFork = false, forkReason = blockedReason;
  if (!blockedReason && thread.settings.providerInstanceId && thread.settings.model) {
    try {
      const runtime = await resolveProviderRuntime({ providerInstanceId: thread.settings.providerInstanceId, modelName: thread.settings.model });
      nativeFork = runtime.capabilities.nativeFork && runtime.capabilities.boundedFork;
      if (!nativeFork) forkReason = "当前 Provider 未证明支持精确边界的原生分支；不能冒充原生 Fork。";
    } catch { forkReason = "无法核验当前 Provider 的原生分支能力。"; }
  }
  return {
    steer: { supported: Boolean(live && !blockedReason), generationId: active?.id, interruptsTools: live?.interruptsTools,
      reason: blockedReason ?? (!active ? "没有正在执行的原生轮次。" : !live ? "当前原生轮次尚未就绪或 Provider 不支持真正的活动引导；不会用停止后重发冒充。" : undefined) },
    fork: { supported: nativeFork && !blockedReason, reason: forkReason },
    rewind: { supported: !blockedReason && !active, reason: blockedReason ?? (active ? "请先等待当前执行结束。" : undefined) },
    planImplementation: { supported: !blockedReason, reason: blockedReason },
    rewindEffects: "conversation-only",
  };
}
export async function nativeForkGeneration(generationId: string, idempotencyKey: string, headers: Headers): Promise<{ threadId: string }> {
  const generation = getChatGeneration(generationId);
  if (!generation) throw new DurableError(404, "not_found", "找不到分支来源。");
  const capability = await threadActionCapabilities(generation.threadId, headers);
  if (!capability.fork.supported) throw new DurableError(409, "unsupported_fork", capability.fork.reason!);
  if (generation.status !== "completed" || !generation.nativeSession ||
      !(generation.nativeSession.driver === "claude" ? generation.nativeSession.messageId : generation.nativeSession.turnId))
    throw new DurableError(409, "unstable_fork_boundary", "该回复没有已完成且可证明的原生分支边界。");
  const source = requireThread(generation.threadId);
  if (source.settings.providerInstanceId !== generation.providerInstanceId ||
      JSON.stringify(source.settings) !== JSON.stringify(generation.threadSettingsSnapshot) ||
      generation.nativeSession.cwd !== generation.executionSnapshot?.path ||
      !sameExecutionIdentity(source.executionEnvironment, generation.executionSnapshot?.environment))
    throw new DurableError(409, "native_fork_context_changed", "来源模型设置、Provider 或执行环境已改变，不能冒充原生分支。");
  const projector = await createPmVisibilityProjector(generation.threadId, headers);
  if (projector.nativeContextContaminated) throw new DurableError(403, "native_context_unavailable", "原生上下文包含当前不可访问的内容，不能复制。");
  return forkChatGeneration(generationId, { idempotencyKey }, headers);
}
export async function implementGenerationPlan(generationId: string, itemId: string, idempotencyKey: string, headers: Headers): Promise<{ threadId: string; generationId: string }> {
  const generation = getChatGeneration(generationId);
  if (!generation) throw new DurableError(404, "not_found", "找不到计划来源。");
  const source = requireThread(generation.threadId);
  await resolveChatExecutionScope(source, headers);
  if (managedSession(source.remoteId) || source.status === "archived")
    throw new DurableError(409, "managed_session", "该来源不能派生普通执行会话；请使用原始受管流程。");
  if (generation.status !== "completed") throw new DurableError(409, "unstable_plan", "请等待计划回复完整结束。");
  const projector = await createPmVisibilityProjector(source.remoteId, headers);
  const snapshot = getNativeOutput(generationId), item = snapshot ? projector.nativeSnapshot(snapshot).items.find(value => value.id === itemId) : undefined;
  if (!item || item.type !== "proposed_plan" || item.status !== "completed" || item.error || item.visibility && item.visibility !== "visible" || !item.text?.trim())
    throw new DurableError(409, "plan_unavailable", "该计划没有完整且当前可访问的权威文本。");
  if (item.text.length > 256000) throw new DurableError(413, "plan_too_large", "计划超过单次消息上限；不能裁剪后冒充完整计划。");
  const refs = generation.turnContext?.pmReferences ?? generation.pmReferences ?? [];
  const pmReferences = refs.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision }));
  if (pmReferences.length) await resolvePmReferenceOperations(pmReferences, headers);
  const opKey = JSON.stringify(["plan", generationId, itemId, idempotencyKey]);
  const prior = readRecord<{ fingerprint: string; threadId: string; messageId: string }>(OPERATIONS, opKey);
  if (prior) {
    const accepted = listChatGenerations(prior.threadId).find(value => value.request.idempotencyKey === `plan:${prior.messageId}`);
    if (accepted) { await resolveChatExecutionScope(requireThread(prior.threadId), headers, "inspect"); return { threadId: prior.threadId, generationId: accepted.id }; }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ item: item.text, settings: source.settings, revision: source.revision, selection: source.executionSelection, pmReferences })).digest("hex");
  const operation = transaction(() => {
    const existing = readRecord<{ fingerprint: string; threadId: string; messageId: string }>(OPERATIONS, opKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ThreadConflictError("相同计划操作身份对应了变化的计划或设置。", "idempotency_conflict");
      requireThread(existing.threadId);
      return existing;
    }
    const latest = requireThread(source.remoteId);
    if (latest.revision !== source.revision || JSON.stringify(latest.executionSelection) !== JSON.stringify(source.executionSelection))
      throw new ThreadConflictError("计划来源设置已改变，请重新核对。");
    if (!source.executionSelection) throw new DurableError(412, "execution_environment_required", "来源没有可继承的执行环境。");
    const threadId = randomUUID(), messageId = randomUUID();
    ensureThread(threadId, "实施计划", source.executionSelection);
    const target = requireThread(threadId);
    updateThread(threadId, { settings: { ...source.settings, interactionMode: "default" }, revision: target.revision });
    const deps = projector.visibleProvenance([generation.messageId]);
    // Content provenance is not an execution grant; new execution reauthorizes every PM operation.
    recordPmContentProvenance({ threadId, generationId: `plan:${messageId}`, messageIds: [messageId],
      operationIds: deps.operationIds, targets: deps.targets, authorities: deps.authorities,
      contextSources: [{ threadId: source.remoteId, messageIds: [generation.messageId] }, ...(deps.contextSources ?? [])] });
    const saved = { fingerprint, threadId, messageId };
    writeRecord(OPERATIONS, opKey, saved);
    return saved;
  });
  const accepted = await submitChat({ id: operation.threadId,
    messages: [{ id: operation.messageId, role: "user", parts: [{ type: "text", text: `请实施以下已明确选择的计划。先核对当前需求、权限、修订及目录；计划文本是背景，不授予额外权限，不自动完成 PM 任务或回滚文件。\n\n${item.text}` }] }],
    pmReferences, config: { threadSettingsRevision: requireThread(operation.threadId).revision }, idempotencyKey: `plan:${operation.messageId}` }, undefined, headers);
  return { threadId: operation.threadId, generationId: accepted.id };
}
export async function resolveGenerationSubagent(generationId: string, itemId: string, headers: Headers): Promise<{ threadId: string | null; reason?: string }> {
  const generation = getChatGeneration(generationId);
  if (!generation) throw new DurableError(404, "not_found", "找不到来源回复。");
  await resolveChatExecutionScope(requireThread(generation.threadId), headers, "inspect");
  const projector = await createPmVisibilityProjector(generation.threadId, headers), snapshot = getNativeOutput(generationId);
  const item = snapshot ? projector.nativeSnapshot(snapshot).items.find(value => value.id === itemId) : undefined;
  if (!item || item.type !== "subagent" || item.visibility && item.visibility !== "visible" || !item.childSessionId)
    return { threadId: null, reason: "该子代理没有当前可访问的会话身份。" };
  // Provider-local/native IDs are never interpreted as arbitrary application Session IDs.
  const continuation = listRecords<{ ownerThreadId: string; nativeSessionId: string; providerInstanceId: string; cwd: string }>("provider:t3code:continuations")
    .filter(value => value.nativeSessionId === item.childSessionId && value.providerInstanceId === generation.providerInstanceId && value.cwd === generation.executionSnapshot?.path);
  const ids = [...new Set(continuation.map(value => value.ownerThreadId))].filter(id => id !== generation.threadId && getThread(id));
  if (ids.length !== 1) return { threadId: null, reason: "原生子代理尚未映射为本应用独立 Session；不能伪造可导航会话。" };
  await resolveChatExecutionScope(requireThread(ids[0]!), headers, "inspect");
  return { threadId: ids[0]! };
}
export async function rewindConversation(threadId: string, input: { messageId: string; expectedHeadId: string | null; revision: number; confirmed: boolean; idempotencyKey: string }, headers: Headers): Promise<{ headId: string; effects: "conversation-only" }> {
  if (!input.confirmed) throw new DurableError(400, "confirmation_required", "须明确确认：只回退对话上下文，不撤销文件、终端或 PM 业务操作。");
  const thread = requireThread(threadId);
  await resolveChatExecutionScope(thread, headers, "inspect");
  if (managedSession(threadId)) throw new DurableError(409, "managed_session", "受管流程不能通过对话回退改写执行阶段。");
  assertIdle(threadId);
  const opKey = JSON.stringify(["rewind", threadId, input.idempotencyKey]);
  const apply = () => transaction(() => {
    const previous = readRecord<{ messageId: string; expectedHeadId: string | null }>(OPERATIONS, opKey);
    if (previous) {
      if (previous.messageId !== input.messageId || previous.expectedHeadId !== input.expectedHeadId) throw new ThreadConflictError("回退操作身份冲突。", "idempotency_conflict");
      return { headId: input.messageId, effects: "conversation-only" as const };
    }
    assertIdle(threadId);
    const latest = requireThread(threadId), history = getThreadHistory(threadId);
    if (latest.status !== "regular" || latest.revision !== input.revision || history.headId !== input.expectedHeadId)
      throw new ThreadConflictError("会话状态已改变，请重新预览回退边界。", "rewind_conflict");
    const branch = getThreadBranch(threadId), boundary = branch.find(value => value.id === input.messageId);
    if (!boundary || boundary.id === history.headId || boundary.content.role !== "assistant" ||
        !listChatGenerations(threadId).some(value => value.messageId === boundary.id && value.status === "completed"))
      throw new DurableError(409, "unstable_rewind_boundary", "只能回退到当前分支中较早的已完成助手回复。");
    setThreadHead(threadId, boundary.id);
    setThreadNativeSession(threadId, undefined);
    writeRecord(OPERATIONS, opKey, { messageId: input.messageId, expectedHeadId: input.expectedHeadId });
    return { headId: boundary.id, effects: "conversation-only" as const };
  });
  await closeMcpAppSession(threadId);
  return withThreadExecution(threadId, async () => apply());
}
type SteeringOperation = { id: string; threadId: string; generationId: string; text: string; status: "dispatching" | "accepted" | "unknown"; createdAt: string };
export async function steerActiveGeneration(threadId: string, input: { generationId: string; idempotencyKey: string; text: string; confirmToolInterruption?: boolean }, headers: Headers): Promise<{ status: "accepted" | "unknown" }> {
  const thread = requireThread(threadId), generation = getActiveChat(threadId);
  if (!generation || generation.id !== input.generationId) throw new DurableError(409, "stale_execution", "活动轮次已变化；引导未发送。");
  if (managedSession(threadId)) throw new DurableError(409, "managed_session", "受管流程的活动引导须由原始执行入口提供。");
  const snapshot = await resolveChatExecutionScope(thread, headers);
  if (!sameExecutionIdentity(snapshot.environment, generation.executionSnapshot?.environment)) throw new DurableError(409, "stale_execution", "执行身份已变化。");
  for (const operation of generation.pmOperations ?? []) {
    const current = await authorizePmTarget(operation.target, headers);
    if (current.actorId !== operation.actorId) throw new DurableError(403, "actor_changed", "活动轮次的 PM 身份已改变。");
  }
  const live = getLiveSteering(generation.id);
  if (!live || live.threadId !== threadId) throw new DurableError(409, "unsupported_steering", "此轮次不支持真正的原生活动引导；不会以停止后重发替代。");
  if (live.interruptsTools && !input.confirmToolInterruption) throw new DurableError(400, "confirmation_required", "此 Provider 的活动引导会打断待处理工具，须明确确认。");
  const opKey = JSON.stringify([threadId, generation.id, input.idempotencyKey]);
  const previous = readRecord<SteeringOperation>(STEERING, opKey);
  if (previous) {
    if (previous.text !== input.text) throw new ThreadConflictError("相同引导身份对应了不同内容。", "idempotency_conflict");
    return { status: previous.status === "accepted" ? "accepted" : "unknown" };
  }
  if (listRecords<SteeringOperation>(STEERING).some(value => value.generationId === generation.id && value.status !== "accepted"))
    throw new DurableError(409, "steering_unknown", "已有引导结果未明，请核对原生输出，不再派发。");
  const operation: SteeringOperation = { id: randomUUID(), threadId, generationId: generation.id, text: input.text, status: "dispatching", createdAt: new Date().toISOString() };
  transaction(() => {
    if (getActiveChat(threadId)?.id !== generation.id || getLiveSteering(generation.id) !== live)
      throw new DurableError(409, "stale_execution", "活动轮次已变化；引导未发送。");
    writeRecord(STEERING, opKey, operation);
  });
  try {
    await live.steer({ messageId: operation.id, text: input.text });
    writeRecord(STEERING, opKey, { ...operation, status: "accepted" });
    emitNativeOutput(generation.id, { type: "item.upsert", item: { id: `steer:${operation.id}`, type: "notification", status: "completed", title: "已发送活动引导（不是下一条排队消息）", text: input.text } });
    return { status: "accepted" };
  } catch {
    writeRecord(STEERING, opKey, { ...operation, status: "unknown" });
    return { status: "unknown" };
  }
}

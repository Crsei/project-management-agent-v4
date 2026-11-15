import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type { ChatDraftInput, QueuedChatMessage, StashedChatDraft, ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import { chatDraftInputSchema } from "@agent-workspace/contracts/chat";
import { resolveChatExecutionScope, deliveryStore } from "../task-delivery/binding.ts";
import { createPmVisibilityProjector, recordPmQuoteProvenance } from "../pm-visibility.ts";
import { getActiveChat, listChatGenerations, lookupChatSubmission, startChatRuntime, submitChat } from "./chat-runtime.ts";
import { sameExecutionIdentity } from "./agent-execution.ts";
import { resolvePmReferenceOperations } from "./pm-context.ts";
import { DurableError } from "./errors.ts";
import { assertThreadWritable, getThread, getThreadBranch, getThreadHistory, ThreadConflictError, type ThreadMetadata } from "./threads.ts";
import { getDatabase, listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import { getStoreIdentity } from "./persistence-schema.ts";
import { listRuns } from "./engine.ts";
import { resolveChatContextItems, validateContextAttachmentBindings } from "./message-context.ts";
import { validateChatAttachments } from "../providers/chat-attachments.ts";
import { getStoredInstance } from "../providers/instances.ts";
import type { AcceptedChatContext } from "@agent-workspace/contracts/message-context";

const QUEUE = "chat:message-queue", STASH = "chat:draft-stash";
/** A browser coordinator pauses when the server process/HMR lifetime changes. */
export const queueRuntimeId = randomUUID();
type QueueRow = Omit<QueuedChatMessage, "draft"> & { draft: ChatDraftInput | null; acceptedContextItems?: AcceptedChatContext[] | undefined; settingsRevision: number; settingsDigest: string; environment: ExecutionEnvironment; order: number; digest: string; dispatchKey: string; dispatchStoreId?: string; dispatchRestoreEpoch?: number };
type StashRow = Omit<StashedChatDraft, "draft"> & { draft: ChatDraftInput | null; acceptedContextItems?: AcceptedChatContext[] | undefined; digest: string; removed?: boolean };
const acceptedDraftContext = Symbol("server-accepted-draft-context");
type AuthorizedDraft = ChatDraftInput & { [acceptedDraftContext]: AcceptedChatContext[] };
const dispatches = new Set<string>();
const key = (threadId: string, id: string) => JSON.stringify([threadId, id]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function threadFor(threadId: string, revision?: number, readOnly = false): ThreadMetadata {
  const thread = getThread(threadId);
  if (!thread) throw new DurableError(404, "not_found", "找不到会话。");
  if (!readOnly) assertThreadWritable(threadId);
  if (deliveryStore.list().some(value => value.threadId === threadId) ||
      listRecords<{ threadId: string }>("pm-automation:native-thread-bindings").some(value => value.threadId === threadId) ||
      listRecords<{ threadId: string }>("pm-automation:native-repositories").some(value => value.threadId === threadId))
    throw new DurableError(409, "managed_session", "受管交付/自动化会话不能通过普通队列或草稿操作绕过原始范围与工具限制。");
  if (revision !== undefined && thread.revision !== revision) throw new ThreadConflictError("会话设置已更改，请重新载入。", "stale_settings");
  return thread;
}
function queueRows(threadId: string): QueueRow[] {
  return listRecords<QueueRow>(QUEUE).filter(row => row.threadId === threadId).sort((a, b) => a.order - b.order);
}
function rowFor(threadId: string, id: string, revision: number): QueueRow {
  const row = readRecord<QueueRow>(QUEUE, key(threadId, id));
  if (!row) throw new DurableError(404, "not_found", "找不到排队消息。");
  if (row.revision !== revision) throw new ThreadConflictError("队列已更改，请刷新。", "queue_conflict");
  return row;
}
function save(row: QueueRow, patch: Partial<QueueRow>): QueueRow {
  const next = { ...row, ...patch, revision: row.revision + 1, updatedAt: new Date().toISOString() };
  writeRecord(QUEUE, key(row.threadId, row.id), next);
  return next;
}
/** Only durable self-contained attachments can survive a browser/server restart. */
export function validateDurableDraft(input: ChatDraftInput): ChatDraftInput {
  const draft = chatDraftInputSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(draft), "utf8") > 20 * 1024 * 1024)
    throw new DurableError(413, "draft_too_large", "单条草稿最多保存 20 MiB。");
  if (!draft.message.parts.some(part => part.type === "file" || part.text.trim()) && !draft.message.metadata?.custom?.quote && !draft.contextItems?.length)
    throw new DurableError(400, "empty_draft", "不能保存空草稿。");
  for (const part of draft.message.parts) if (part.type === "file") {
    const prefix = `data:${part.mediaType};base64,`;
    if (!part.url.startsWith(prefix) || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(part.mediaType) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(part.url.slice(prefix.length)) || part.url.slice(prefix.length).length % 4 !== 0)
      throw new DurableError(400, "non_durable_attachment", "请等待附件上传完成；队列与暂存只接受完整 data/base64 附件，不保存 blob、网络地址或本地文件路径。");
  }
  return draft;
}
async function authorizeDraft(threadId: string, input: ChatDraftInput, headers: Headers, freeze: boolean): Promise<AuthorizedDraft> {
  const draft = validateDurableDraft(input);
  validateContextAttachmentBindings(draft.message as UIMessage, draft.contextItems);
  const refs = draft.pmReferences ?? [];
  const evidence = refs.length ? await resolvePmReferenceOperations(refs.map(ref => freeze ? ref : { ...ref, revision: null }), headers) : undefined;
  const contextItems = draft.contextItems?.length ? await resolveChatContextItems(threadId, draft.contextItems, headers) : undefined;
  const instance = getStoredInstance(getThread(threadId)?.settings.providerInstanceId ?? "");
  if (instance) validateChatAttachments(draft.message.parts as UIMessage["parts"], instance.driver);
  const quote = draft.message.metadata?.custom?.quote as { messageId?: unknown } | undefined;
  if (quote) {
    if (typeof quote.messageId !== "string") throw new DurableError(400, "invalid_quote", "引用缺少服务端消息身份。");
    const source = getThreadHistory(threadId).messages.find(message => message.id === quote.messageId);
    if (!source) throw new DurableError(409, "quote_unavailable", "引用的原消息已不可用。");
    const projector = await createPmVisibilityProjector(threadId, headers);
    const visible = projector.history([source])[0]!;
    if ((visible.content.metadata as { pmVisibility?: string } | undefined)?.pmVisibility)
      throw new DurableError(403, "quote_unavailable", "引用的消息当前不可访问。");
  }
  return { ...draft, ...(contextItems ? { contextItems: contextItems.flatMap(item => item.input ? [item.input] : []) } : {}),
    ...(freeze && evidence ? { pmReferences: evidence.references.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision })) } : {}), [acceptedDraftContext]: contextItems ?? [] };
}
async function publicDraft(threadId: string, draft: ChatDraftInput, headers: Headers): Promise<{ draft: ChatDraftInput | null; reason?: string }> {
  try { await authorizeDraft(threadId, draft, headers, false); return { draft }; }
  catch (error) { return { draft: null, reason: error instanceof DurableError && error.status < 500 ? "当前权限无法读取此草稿；未发送。" : "无法核验草稿权限；未发送。" }; }
}
export async function listQueuedMessages(threadId: string, headers: Headers): Promise<QueuedChatMessage[]> {
  await resolveChatExecutionScope(threadFor(threadId, undefined, true), headers, "inspect");
  return Promise.all(queueRows(threadId).filter(row => row.status !== "removed").map(async row => ({
    id: row.id, threadId, revision: row.revision, status: row.status === "dispatching" && !dispatches.has(key(threadId, row.id)) ? "unknown" : row.status,
    createdAt: row.createdAt, updatedAt: row.updatedAt, generationId: row.generationId, reason: row.reason,
    afterGenerationId: row.afterGenerationId, afterHeadId: row.afterHeadId,
    afterGenerationWasActive: row.afterGenerationWasActive,
    ...(row.draft ? await publicDraft(threadId, row.draft, headers) : { draft: null }),
  })));
}
export async function enqueueMessage(threadId: string, id: string, input: ChatDraftInput, revision: number, headers: Headers): Promise<void> {
  const thread = threadFor(threadId, revision), draft = await authorizeDraft(threadId, input, headers, true);
  const environment = (await resolveChatExecutionScope(thread, headers)).environment;
  const fingerprint = digest(input);
  transaction(() => {
    threadFor(threadId, revision);
    const previous = readRecord<QueueRow>(QUEUE, key(threadId, id));
    if (previous) {
      if (previous.digest !== fingerprint) throw new ThreadConflictError("相同队列 ID 对应了不同草稿。", "idempotency_conflict");
      return;
    }
    const rows = queueRows(threadId);
    if (rows.filter(row => !["removed", "sent"].includes(row.status)).length >= 100)
      throw new DurableError(409, "queue_full", "每个会话最多排队 100 条消息。");
    if (getThreadHistory(threadId).messages.some(message => message.id === draft.message.id))
      throw new DurableError(409, "input_already_accepted", "此输入已在会话历史中；请核对原执行，不要重新排队。");
    const now = new Date().toISOString();
    const afterGeneration = getActiveChat(threadId) ?? listChatGenerations(threadId)[0];
    const afterGenerationId = afterGeneration?.id ?? null;
    const afterGenerationWasActive = afterGeneration?.status === "queued" || afterGeneration?.status === "running";
    const afterHeadId = getThreadHistory(threadId).headId;
    writeRecord<QueueRow>(QUEUE, key(threadId, id), { id, threadId, draft, acceptedContextItems: draft[acceptedDraftContext], status: "queued", revision: 0,
      createdAt: now, updatedAt: now, digest: fingerprint, settingsRevision: revision, settingsDigest: digest(thread.settings), environment,
      afterGenerationId, afterHeadId, afterGenerationWasActive,
      order: (rows.at(-1)?.order ?? 0) + 1, dispatchKey: `queue:${id}:0` });
    const quote = draft.message.metadata?.custom?.quote as { messageId?: string } | undefined;
    if (quote?.messageId) recordPmQuoteProvenance({ threadId, messageId: draft.message.id, sourceMessageId: quote.messageId });
  });
}
export async function editQueuedMessage(threadId: string, id: string, revision: number, input: ChatDraftInput, settingsRevision: number, headers: Headers): Promise<void> {
  const thread = threadFor(threadId, settingsRevision), draft = await authorizeDraft(threadId, input, headers, true);
  const environment = (await resolveChatExecutionScope(thread, headers)).environment;
  transaction(() => {
    threadFor(threadId, settingsRevision);
    const row = rowFor(threadId, id, revision);
    if (!["queued", "blocked"].includes(row.status)) throw new DurableError(409, "queue_locked", "已派发或结果未明的消息不能编辑；先核对原执行。");
    if (draft.message.id === row.draft?.message.id || getThreadHistory(threadId).messages.some(message => message.id === draft.message.id))
      throw new DurableError(409, "new_input_id_required", "编辑必须使用新的输入消息 ID。");
    save(row, { draft, acceptedContextItems: draft[acceptedDraftContext], digest: digest(input), status: "queued", reason: undefined, environment,
      settingsRevision, settingsDigest: digest(thread.settings), dispatchKey: `queue:${id}:${revision + 1}` });
    const quote = draft.message.metadata?.custom?.quote as { messageId?: string } | undefined;
    if (quote?.messageId) recordPmQuoteProvenance({ threadId, messageId: draft.message.id, sourceMessageId: quote.messageId });
  });
}
export async function mutateQueue(threadId: string, id: string, revision: number, action: "move" | "remove", headers: Headers, beforeId?: string | null): Promise<void> {
  await resolveChatExecutionScope(threadFor(threadId), headers, "inspect");
  transaction(() => {
    threadFor(threadId);
    const row = rowFor(threadId, id, revision);
    if (row.status === "removed" && action === "remove") return;
    if (!["queued", "blocked", "sent"].includes(row.status)) throw new DurableError(409, "queue_locked", "结果未明的派发不能删除或重排；先核对。");
    if (action === "remove") { save(row, { status: "removed", draft: null, acceptedContextItems: undefined }); return; }
    const rows = queueRows(threadId).filter(value => value.id !== id && value.status !== "removed");
    const index = beforeId === null ? rows.length : rows.findIndex(value => value.id === beforeId);
    if (index < 0) throw new DurableError(409, "queue_conflict", "目标队列位置已变化。");
    rows.splice(index, 0, row);
    rows.forEach((value, order) => { if (value.order !== order) save(value, { order }); });
  });
}
export async function reconcileQueuedMessage(threadId: string, id: string, revision: number, headers: Headers): Promise<void> {
  await startChatRuntime();
  await resolveChatExecutionScope(threadFor(threadId, undefined, true), headers, "inspect");
  transaction(() => {
    const row = rowFor(threadId, id, revision);
    if (!row.draft || row.status === "removed") return;
    if (dispatches.has(key(threadId, id))) throw new DurableError(409, "dispatch_in_progress", "派发请求仍在处理，请只刷新状态。");
    const proof = lookupChatSubmission(threadId, row.dispatchKey);
    if (proof.status === "accepted" && proof.generationId) {
      const generation = listChatGenerations(threadId).find(value => value.id === proof.generationId && value.inputMessageId === row.draft!.message.id);
      if (generation) save(row, { status: "sent", generationId: generation.id, reason: undefined });
      else save(row, { status: "unknown", reason: "Original submission identity is inconsistent; no replay is permitted." });
    } else if (proof.status === "not_accepted" && row.dispatchStoreId === proof.storeId && row.dispatchRestoreEpoch === proof.restoreEpoch) {
      if (["dispatching", "unknown"].includes(row.status)) save(row, { status: "blocked", reason: "Original submission was explicitly not accepted. Review before a new explicit send." });
    } else if (["dispatching", "unknown"].includes(row.status)) save(row, { status: "unknown", reason: "No authoritative rejection in the original Store/restore epoch; reconcile without replay." });
  });
}
/** Dispatch is an explicit fresh HTTP operation. No cookies, bearer tokens or background authority are stored. */
export async function sendQueuedMessage(threadId: string, id: string, revision: number, headers: Headers, confirmAfterGenerationId?: string,
  expected?: { headId?: string | null; generationId?: string | null }): Promise<void> {
  await startChatRuntime();
  const row = rowFor(threadId, id, revision), thread = threadFor(threadId, row.settingsRevision);
  const draft = row.draft;
  if (!draft || row.status === "removed") throw new DurableError(409, "queue_removed", "该排队消息已移除，不能重新派发。");
  await authorizeDraft(threadId, draft, headers, true);
  const environment = (await resolveChatExecutionScope(thread, headers)).environment;
  if (!sameExecutionIdentity(row.environment, environment) || digest(thread.settings) !== row.settingsDigest)
    throw new DurableError(409, "queue_context_changed", "排队时冻结的执行环境或模型已改变；请编辑消息并显式重新确认设置。");
  const localKey = key(threadId, id);
  transaction(() => {
    const current = rowFor(threadId, id, revision);
    threadFor(threadId, row.settingsRevision);
    if (current.status === "sent") return;
    if (!["queued", "blocked"].includes(current.status)) throw new DurableError(409, "queue_locked", "派发结果未明；先核对，不自动重发。");
    if (getActiveChat(threadId) || listRuns(threadId).some(run => run.status === "queued" || run.status === "running"))
      throw new DurableError(409, "chat_busy", "请等待当前执行结束；发送下一条不会停止或引导当前执行。");
    const latest = listChatGenerations(threadId)[0];
    if (expected && (expected.headId !== undefined && getThreadHistory(threadId).headId !== expected.headId ||
        expected.generationId !== undefined && (latest?.id ?? null) !== expected.generationId))
      throw new DurableError(409, "queue_head_changed", "队列等待期间对话边界已改变；已暂停，请重新核对后恢复。");
    if (latest && latest.status !== "completed" && confirmAfterGenerationId !== latest.id)
      throw new DurableError(409, "previous_result_unconfirmed", "上一执行未成功结束。请核对其副作用，再明确确认发送这条新消息；这不是重试上一执行。");
    const identity = getStoreIdentity(getDatabase());
    save(current, { status: "dispatching", reason: undefined, dispatchStoreId: identity.storeId, dispatchRestoreEpoch: identity.restoreEpoch });
    dispatches.add(localKey);
  });
  if (!dispatches.has(localKey)) return;
  try {
    const messages = getThreadBranch(threadId).map(message => ({ id: message.id, ...message.content }) as UIMessage);
    const generation = await submitChat({ id: threadId, messages: [...messages, draft.message as UIMessage],
      config: { threadSettingsRevision: row.settingsRevision }, pmReferences: draft.pmReferences, contextItems: draft.contextItems,
      idempotencyKey: row.dispatchKey }, undefined, headers);
    transaction(() => { const current = readRecord<QueueRow>(QUEUE, localKey); if (current) save(current, { status: "sent", generationId: generation.id }); });
  } catch (error) {
    transaction(() => {
      const current = readRecord<QueueRow>(QUEUE, localKey);
      if (!current) return;
      const proof = lookupChatSubmission(threadId, row.dispatchKey);
      if (proof.status === "accepted" && proof.generationId) save(current, { status: "sent", generationId: proof.generationId });
      else save(current, { status: proof.status === "not_accepted" && current.dispatchStoreId === proof.storeId && current.dispatchRestoreEpoch === proof.restoreEpoch ? "blocked" : "unknown",
        reason: error instanceof DurableError || error instanceof ThreadConflictError ? error.message : "派发结果未明；请先核对，不要重新发送。" });
    });
    throw error;
  } finally { dispatches.delete(localKey); }
}
export async function stashDraft(threadId: string, id: string, input: ChatDraftInput, headers: Headers): Promise<void> {
  await resolveChatExecutionScope(threadFor(threadId), headers, "inspect");
  const draft = await authorizeDraft(threadId, input, headers, true), fingerprint = digest(input);
  transaction(() => {
    threadFor(threadId);
    const previous = readRecord<StashRow>(STASH, key(threadId, id));
    if (previous) { if (previous.digest !== fingerprint) throw new ThreadConflictError("暂存 ID 对应了不同内容。", "idempotency_conflict"); return; }
    if (listRecords<StashRow>(STASH).filter(row => row.threadId === threadId && !row.removed).length >= 50)
      throw new DurableError(409, "stash_full", "每个会话最多暂存 50 份草稿。");
    writeRecord<StashRow>(STASH, key(threadId, id), { id, threadId, draft, acceptedContextItems: draft[acceptedDraftContext], createdAt: new Date().toISOString(), digest: fingerprint });
  });
}
export async function listStashedDrafts(threadId: string, headers: Headers): Promise<StashedChatDraft[]> {
  await resolveChatExecutionScope(threadFor(threadId, undefined, true), headers, "inspect");
  return Promise.all(listRecords<StashRow>(STASH).filter(row => row.threadId === threadId && !row.removed).map(async row => ({
    id: row.id, threadId, createdAt: row.createdAt, ...(row.draft ? await publicDraft(threadId, row.draft, headers) : { draft: null }),
  })));
}
export async function removeStashedDraft(threadId: string, id: string, headers: Headers): Promise<void> {
  await resolveChatExecutionScope(threadFor(threadId), headers, "inspect");
  transaction(() => { threadFor(threadId); const row = readRecord<StashRow>(STASH, key(threadId, id)); if (row) writeRecord(STASH, key(threadId, id), { ...row, draft: null, acceptedContextItems: undefined, removed: true }); });
}
/** A tombstone still proves a save succeeded, even if another tab sent/removed its visible receipt. */
export async function savedDraftExists(threadId: string, id: string, kind: "queue" | "stash", headers: Headers): Promise<boolean> {
  await resolveChatExecutionScope(threadFor(threadId, undefined, true), headers, "inspect");
  return readRecord(kind === "queue" ? QUEUE : STASH, key(threadId, id)) !== null;
}

import { useEffect, useRef, useState } from "react";
import type { ChatDraftInput, ChatGenerationView, QueuedChatMessage, RemoteThread, StashedChatDraft, ThreadActionCapabilities } from "@agent-workspace/contracts/chat";
import { flushThreadSettings } from "@agent/hooks/use-chat-settings";
import { Button } from "@agent/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { forkGeneration, getThreadActionCapabilities, rewindThreadConversation } from "./thread-actions";
import { useChatActions } from "./chat-actions";
import { ForegroundQueueCoordinator, type QueuePauseReason, type QueueSnapshot, type QueueGeneration } from "./queue-coordinator";
import { steeringAttemptAfterError, type SteeringAttempt } from "./steering-attempt";
import { ContextChipShell } from "./context-chip-parts";
import { contextInputLabel } from "./context-presentation";
import { InlineComposerAttachment } from "./composer-context-attachments";
import { PmContextChip } from "../pm/pm-reference-tray";
import { readContextAttachmentBindings, reindexContextAttachmentBindings } from "./context-attachments";
import { ChevronDownIcon, QuoteIcon } from "lucide-react";

export type DraftInput = ChatDraftInput;
const changed = "agent-message-actions-changed";
function textOf(draft: DraftInput | null): string {
  return draft?.message.parts.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
}

function SavedDraftContexts({ draft }: { draft: DraftInput }) {
  const bindings = readContextAttachmentBindings(draft.message.metadata?.custom?.contextAttachments);
  return <div className="flex flex-wrap items-start gap-2 text-sm">
    {draft.contextItems?.map(input => <ContextChipShell key={input.contextId} kind={input.kind === "response" ? "citation" : input.kind} state="unresolved" icon={<QuoteIcon />} label={contextInputLabel(input)} tooltip={<div className="max-h-64 max-w-sm overflow-auto whitespace-pre-wrap text-xs"><p>Saved draft context; the frozen source is revalidated before sending. This is not an accepted historical snapshot.</p><pre>{"selectedText" in input ? input.selectedText : "text" in input ? input.text : JSON.stringify(input.source, null, 2)}</pre>{input.comment && <p>{input.comment}</p>}</div>} />)}
    {draft.pmReferences?.map(reference => <PmContextChip key={JSON.stringify([reference.workspaceId, reference.projectId, reference.kind, reference.id])} reference={{ ...reference, title: reference.id, availability: "unverified" }} />)}
    {draft.message.parts.map((part, partIndex) => part.type === "file" ? <InlineComposerAttachment key={partIndex} attachment={{ id: bindings.find(binding => binding.partIndex === partIndex)?.attachmentId ?? `saved:${draft.message.id}:${partIndex}`, type: part.mediaType.startsWith("image/") ? "image" : "file", name: part.filename || "Attachment", contentType: part.mediaType, status: { type: "complete" }, content: [{ type: "file", data: part.url, mimeType: part.mediaType, ...(part.filename ? { filename: part.filename } : {}) }] }} /> : null)}
  </div>;
}

/** Text editing reindexes actual retained file objects, never filenames or attachment guesses. */
function editSavedDraftText(draft: DraftInput, text: string): DraftInput {
  const parts: DraftInput["message"]["parts"] = [{ type: "text", text }, ...draft.message.parts.filter(part => part.type !== "text")];
  const bindings = readContextAttachmentBindings(draft.message.metadata?.custom?.contextAttachments);
  const contextAttachments = reindexContextAttachmentBindings(draft.message.parts, parts, bindings);
  return { ...draft, message: { ...draft.message, id: crypto.randomUUID(), parts, ...(draft.message.metadata ? { metadata: { ...draft.message.metadata, custom: { ...draft.message.metadata.custom, ...(bindings.length ? { contextAttachments } : {}) } } } : {}) } };
}
export function ComposerMessageActions({ threadId, readDraft, restoreDraft, clearDraft, disabled = false }: {
  threadId: string;
  readDraft: () => DraftInput | Promise<DraftInput>;
  restoreDraft: (draft: DraftInput) => void | Promise<void>;
  clearDraft: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const t = useAgentText();
  const [stashes, setStashes] = useState<StashedChatDraft[]>([]);
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const [unknown, setUnknown] = useState<{ id: string; kind: "queue" | "stash" }>();
  const [capabilities, setCapabilities] = useState<ThreadActionCapabilities>();
  const [steerOpen, setSteerOpen] = useState(false), [steerText, setSteerText] = useState("");
  const [steerConfirmed, setSteerConfirmed] = useState(false);
  const steerAttempt = useRef<SteeringAttempt | null>(null);
  const target = useRef(threadId); target.current = threadId;
  const base = `/api/chat/threads/${encodeURIComponent(threadId)}`;
  useEffect(() => { setStashes([]); setPending(false); setOpen(false); setUnknown(undefined); setError(undefined); setSteerOpen(false); setSteerText(""); setSteerConfirmed(false); setCapabilities(undefined); steerAttempt.current = null; }, [threadId]);
  const refresh = async () => {
    const data = await workspaceClient.json<{ drafts: StashedChatDraft[] }>(`${base}/stash`);
    if (target.current === threadId) setStashes(data.drafts);
    return data.drafts;
  };
  const save = async (kind: "queue" | "stash") => {
    setPending(true); setError(undefined);
    let submitted = false;
    const id = crypto.randomUUID();
    try {
      const draft = await readDraft();
      if (target.current !== threadId) return;
      const settings = kind === "queue" ? await flushThreadSettings(threadId)
        : (await workspaceClient.json<{ thread: RemoteThread }>(base)).thread;
      if (target.current !== threadId) return;
      submitted = true;
      await workspaceClient.json(`${base}/${kind}`, { method: "POST", body: JSON.stringify({ id, draft, threadSettingsRevision: settings.revision }) });
      if (target.current !== threadId) return;
      await clearDraft();
      if (target.current !== threadId) return;
      window.dispatchEvent(new CustomEvent(changed, { detail: { threadId, ...(kind === "queue" ? { armQueueId: id } : {}) } }));
      if (kind === "stash") { await refresh(); if (target.current === threadId) setOpen(true); }
    } catch (reason) {
      if (target.current !== threadId) return;
      const status = typeof reason === "object" && reason && "status" in reason ? Number(reason.status) : 0;
      if (submitted && (!status || status >= 500)) setUnknown({ id, kind });
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (target.current === threadId) setPending(false); }
  };
  const reconcileSave = async () => {
    if (!unknown) return;
    setPending(true); setError(undefined);
    try {
      const data = await workspaceClient.json<{ saved: boolean }>(`${base}/saved-drafts/${unknown.kind}/${encodeURIComponent(unknown.id)}`);
      if (target.current !== threadId) return;
      if (data.saved) {
        await clearDraft();
        if (target.current !== threadId) return;
        setUnknown(undefined);
        window.dispatchEvent(new CustomEvent(changed, { detail: { threadId } }));
        if (unknown.kind === "stash") { await refresh(); if (target.current === threadId) setOpen(true); }
      } else {
        setUnknown(undefined);
        setError(t("已核对：服务端没有该保存记录，草稿仍保留，可重新显式保存。", "Confirmed: no server save exists. Your draft remains; explicitly save it again if wanted."));
      }
    } catch (reason) { if (target.current === threadId) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (target.current === threadId) setPending(false); }
  };
  const sendSteer = async () => {
    if (!capabilities?.steer.supported || !capabilities.steer.generationId || !steerText.trim()) return;
    const attempt = steerAttempt.current ?? { id: crypto.randomUUID(), generationId: capabilities.steer.generationId, text: steerText };
    steerAttempt.current = attempt;
    setPending(true); setError(undefined);
    try {
      const result = await workspaceClient.json<{ status: "accepted" | "unknown" }>(`${base}/steer`, { method: "POST", body: JSON.stringify({
        generationId: attempt.generationId, idempotencyKey: attempt.id, text: attempt.text, confirmToolInterruption: steerConfirmed,
      }) });
      if (target.current !== threadId) return;
      if (result.status === "unknown") { setError(t("引导结果未明；不会重发。请核对原生输出。", "Steering result is unknown; it will not be resent. Inspect native output.")); return; }
      setSteerText(""); setSteerOpen(false); steerAttempt.current = null;
    } catch (reason) {
      if (target.current !== threadId) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      if (steeringAttemptAfterError(attempt, reason) === null && steerAttempt.current === attempt) {
        steerAttempt.current = null;
        setCapabilities(undefined);
        void getThreadActionCapabilities(threadId).then(value => { if (target.current === threadId) setCapabilities(value); })
          .catch(() => { /* Original authoritative rejection stays visible; reopening rechecks capabilities. */ });
      }
    }
    finally { if (target.current === threadId) setPending(false); }
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs" aria-label={t("排队和草稿暂存", "Queue and draft stash")}>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" variant="ghost" aria-label={t("草稿与队列", "Draft and queue")} />}>
        <span>{t("草稿与队列", "Draft and queue")}</span><ChevronDownIcon aria-hidden="true" className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={4} className="w-48">
        <DropdownMenuItem disabled={disabled || pending || Boolean(unknown)} onSelect={() => void save("queue")}>{t("加入队列", "Queue draft")}</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled || pending || Boolean(unknown)} onSelect={() => void save("stash")}>{t("暂存草稿", "Stash draft")}</DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={() => { setOpen(!open); if (!open) void refresh().catch(reason => { if (target.current === threadId) setError(String(reason)); }); }}>{t("草稿库", "Draft stash")}</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled || pending} onSelect={() => { setSteerOpen(!steerOpen); if (!steerOpen) void getThreadActionCapabilities(threadId).then(value => { if (target.current === threadId) setCapabilities(value); }).catch(reason => { if (target.current === threadId) setError(String(reason)); }); }}>{t("引导当前执行", "Steer current turn")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {unknown && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void reconcileSave()}>{t("核对保存结果", "Check save result")}</Button>}
    {steerOpen && <section className="border-border basis-full space-y-2 rounded border p-2">
      <p>{t("引导直接发给当前活动轮次；队列是结束后才发送的新消息，两者不同。", "Steering changes the active native turn; a queued draft is a new message sent after it ends.")}</p>
      {!capabilities ? <p>{t("正在核验能力…", "Checking capability…")}</p> : !capabilities.steer.supported ? <p>{capabilities.steer.reason}</p> : <>
        <textarea className="border-border w-full rounded border p-2" aria-label={t("活动引导内容", "Active steering instruction")} value={steerText} disabled={pending || Boolean(steerAttempt.current)} onChange={event => setSteerText(event.target.value)} />
        {capabilities.steer.interruptsTools && <label className="flex items-center gap-2"><input type="checkbox" checked={steerConfirmed} onChange={event => setSteerConfirmed(event.target.checked)} />{t("我确认此 Provider 的引导可能打断待处理工具。", "I confirm this Provider may interrupt pending tools when steering.")}</label>}
        <Button type="button" size="sm" disabled={pending || !steerText.trim() || Boolean(steerAttempt.current) || capabilities.steer.interruptsTools && !steerConfirmed} onClick={() => void sendSteer()}>{t("发送活动引导", "Send steering")}</Button>
      </>}
    </section>}
    {open && <section className="border-border max-h-64 basis-full space-y-2 overflow-auto rounded border p-2" aria-label={t("显式多草稿暂存", "Explicit multi-draft stash")}>
      <p>{t("暂存不会发送。恢复要求输入框为空；原暂存保留至手动删除。", "Stashing never sends. Restore requires an empty composer; the stash remains until explicitly deleted.")}</p>
      {!stashes.length && <p>{t("没有暂存草稿。", "No stashed drafts.")}</p>}
      {stashes.map(row => <div key={row.id} className="border-border space-y-1 border-t pt-2">
        <p className="line-clamp-3 whitespace-pre-wrap">{row.draft ? textOf(row.draft) || t("附件或引用草稿", "Attachment or quote draft") : row.reason}</p>
        {row.draft && <SavedDraftContexts draft={row.draft} />}
        <span>{new Date(row.createdAt).toLocaleString()}</span>
        <Button type="button" size="sm" variant="outline" disabled={pending || !row.draft} onClick={() => { setPending(true); void Promise.resolve().then(() => { if (target.current === threadId) return restoreDraft(row.draft!); }).catch(reason => { if (target.current === threadId) setError(String(reason)); }).finally(() => { if (target.current === threadId) setPending(false); }); }}>{t("恢复到输入框", "Restore to composer")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => { setPending(true); void workspaceClient.json(`${base}/stash/${encodeURIComponent(row.id)}`, { method: "DELETE" }).then(() => { if (target.current === threadId) return refresh(); }).catch(reason => { if (target.current === threadId) setError(String(reason)); }).finally(() => { if (target.current === threadId) setPending(false); }); }}>{t("删除暂存", "Delete stash")}</Button>
      </div>)}
    </section>}
    {error && <p role="alert" className="text-destructive basis-full whitespace-pre-wrap">{error}</p>}
  </div>;
}

export function QueuedMessages({ threadId }: { threadId: string }) {
  const t = useAgentText();
  const [rows, setRows] = useState<QueuedChatMessage[]>([]), [latest, setLatest] = useState<QueueGeneration>();
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string>(), [editText, setEditText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const target = useRef(threadId); target.current = threadId;
  const base = `/api/chat/threads/${encodeURIComponent(threadId)}`;
  const snapshot = useRef<QueueSnapshot | null>(null), coordinator = useRef<ForegroundQueueCoordinator | null>(null);
  const [autoState, setAutoState] = useState<{ armed: boolean; reason?: QueuePauseReason }>({ armed: false, reason: "not-resumed" });
  useEffect(() => { setConfirmed(false); }, [latest?.id]);
  useEffect(() => {
    let alive = true, fetching = false, armQueueId: string | undefined;
    setRows([]); setLatest(undefined); setPending(false); setError(undefined); setEditing(undefined); setConfirmed(false);
    snapshot.current = null;
    const owner = new ForegroundQueueCoordinator(async (row, expected) => {
      if (!alive || document.visibilityState !== "visible") throw new Error("Foreground queue is paused.");
      try {
        const accepted = await workspaceClient.json<{ generationId: string }>(`${base}/queue/${encodeURIComponent(row.id)}`, {
          method: "POST", body: JSON.stringify({ action: "send", revision: row.revision, ...expected }),
        });
        if (alive) window.dispatchEvent(new CustomEvent("agent-thread-action", { detail: { threadId, generationId: accepted.generationId, reload: true } }));
        return accepted;
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      }
    }, state => { if (alive) setAutoState(state); });
    coordinator.current = owner;
    setAutoState({ armed: false, reason: "not-resumed" });
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const queue = await workspaceClient.json<QueueSnapshot>(`${base}/queue`);
        if (!alive) return;
        snapshot.current = queue; setRows(queue.messages); setLatest(queue.latest ?? undefined);
        if (armQueueId) { owner.enqueueIntent(queue, armQueueId); armQueueId = undefined; }
        if (document.visibilityState === "visible") await owner.advance(queue);
        else owner.pause("hidden");
      } catch (reason) {
        owner.pause("unavailable");
        if (alive) { setRows([]); setError(reason instanceof Error ? reason.message : String(reason)); }
      } finally { fetching = false; }
    };
    const change = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; armQueueId?: string }>).detail;
      if (detail.threadId !== threadId) return;
      armQueueId = detail.armQueueId ?? armQueueId;
      void refresh();
    };
    const visibility = () => { if (document.visibilityState !== "visible") owner.pause("hidden"); else void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 2000);
    window.addEventListener(changed, change); document.addEventListener("visibilitychange", visibility);
    return () => { alive = false; owner.dispose(); coordinator.current = null; window.clearInterval(timer); window.removeEventListener(changed, change); document.removeEventListener("visibilitychange", visibility); };
  }, [threadId, base]);
  const action = async (row: QueuedChatMessage, input: Record<string, unknown>) => {
    setPending(true); setError(undefined);
    coordinator.current?.pause();
    try {
      const accepted = await workspaceClient.json<{ generationId?: string }>(`${base}/queue/${encodeURIComponent(row.id)}`, { method: "POST", body: JSON.stringify({ ...input, revision: row.revision,
        ...(input.action === "send" && snapshot.current ? { expectedHeadId: snapshot.current.headId, expectedGenerationId: snapshot.current.latest?.id ?? null } : {}),
      }) });
      if (target.current !== threadId) return;
      if (input.action === "send") window.dispatchEvent(new CustomEvent("agent-thread-action", { detail: { threadId, generationId: accepted.generationId, reload: true } }));
      setEditing(undefined);
    } catch (reason) { if (target.current === threadId) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (target.current === threadId) { setPending(false); window.dispatchEvent(new CustomEvent(changed, { detail: { threadId } })); } }
  };
  if (!rows.length && !error) return null;
  const busy = latest?.status === "running" || latest?.status === "queued";
  const needsConfirmation = latest && !busy && latest.status !== "completed";
  return <section className="border-border max-h-72 shrink-0 space-y-2 overflow-auto border-t px-3 py-2 text-xs" aria-label={t("持久消息队列", "Durable message queue")}>
    <p>{t("队列已持久保存。当前页面保持可见且授权有效时，上一轮完成后自动发送下一条；离页、重启、失败或未知结果会暂停，不重放。", "Queued messages are durable. While this page is visible and authorized, the next message is sent automatically after completion. Leaving, restarting, failure or an unknown result pauses the queue without replay.")}</p>
    <p role="status">{autoState.armed ? t("队列已启用，等待已核验的完成边界。", "Queue enabled; waiting for a verified completion boundary.") : `${t("队列已暂停：", "Queue paused: ")}${({
      "not-resumed": t("请明确恢复；不会自动恢复旧队列。", "Explicitly resume; old queues never restart automatically."),
      hidden: t("页面离开前台，请重新核对后恢复。", "Page left the foreground; inspect and resume."),
      "server-restarted": t("服务端生命周期已变化。", "Server lifetime changed."),
      "history-changed": t("对话边界已改变。", "Conversation boundary changed."),
      "previous-failed": t("上一执行失败、中断或取消，先核对副作用。", "Previous execution failed, interrupted or cancelled; inspect side effects."),
      unknown: t("派发结果未明，须先只核对原操作。", "Dispatch result unknown; check the original operation first."),
      blocked: t("消息被阻止，先编辑并核对上下文或手动发送。", "Message blocked; edit/review context or explicitly send."),
      unavailable: t("连接或当前授权不可用，先刷新核对。", "Connection or current authorization unavailable; refresh and inspect."),
      empty: t("没有待发送消息。", "No pending messages."),
      paused: t("已手动暂停或修改队列。", "Manually paused or queue edited."),
    } satisfies Record<QueuePauseReason, string>)[autoState.reason ?? "not-resumed"]}`}</p>
    <Button type="button" size="sm" variant="outline" disabled={pending || !rows.some(row => row.status === "queued") || Boolean(needsConfirmation && !confirmed)} onClick={() => {
      if (autoState.armed) coordinator.current?.pause();
      else if (snapshot.current) { coordinator.current?.resume(snapshot.current, needsConfirmation && confirmed ? latest!.id : undefined); void coordinator.current?.advance(snapshot.current); }
    }}>{autoState.armed ? t("暂停队列", "Pause queue") : t("核对后恢复队列", "Resume queue after review")}</Button>
    {needsConfirmation && <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("已核对上一执行的副作用；发送新消息不是重试上一执行。", "I checked the previous execution's side effects; sending a new message is not retrying it.")}</label>}
    {rows.map((row, index) => <article key={row.id} className="border-border space-y-1 border-t pt-2">
      <div className="flex flex-wrap items-center gap-1"><strong>{index + 1}. {row.status}</strong><time>{new Date(row.createdAt).toLocaleTimeString()}</time></div>
      {editing === row.id ? <textarea className="border-border w-full rounded border p-2" value={editText} onChange={event => setEditText(event.target.value)} aria-label={t("编辑排队文本", "Edit queued text")} /> : <p className="line-clamp-3 whitespace-pre-wrap">{textOf(row.draft) || row.reason || t("附件或引用草稿", "Attachment or quote draft")}</p>}
      {row.draft && <SavedDraftContexts draft={row.draft} />}
      {row.reason && <p role="status">{row.reason}</p>}
      {(row.status === "queued" || row.status === "blocked") && <div className="flex flex-wrap gap-1">
        <Button type="button" size="sm" variant="outline" disabled={pending || busy || !row.draft || Boolean(needsConfirmation && !confirmed)} onClick={() => void action(row, { action: "send", ...(needsConfirmation ? { confirmAfterGenerationId: latest!.id } : {}) })}>{t("发送下一条 / 立即发送", "Send next / send now")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending || !row.draft} onClick={() => { setEditing(row.id); setEditText(textOf(row.draft)); }}>{t("编辑", "Edit")}</Button>
        {editing === row.id && <Button type="button" size="sm" disabled={pending} onClick={() => { void flushThreadSettings(threadId).then(settings => {
          if (target.current !== threadId) return;
          return action(row, { action: "edit", threadSettingsRevision: settings.revision,
            draft: editSavedDraftText(row.draft!, editText) });
        }).catch(reason => { if (target.current === threadId) setError(String(reason)); }); }}>{t("保存编辑并确认当前设置", "Save edit and confirm settings")}</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={pending || index === 0} onClick={() => void action(row, { action: "move", beforeId: rows[index - 1]!.id })}>{t("上移", "Move up")}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending || index === rows.length - 1} onClick={() => void action(row, { action: "move", beforeId: rows[index + 2]?.id ?? null })}>{t("下移", "Move down")}</Button>
      </div>}
      {(row.status === "unknown" || row.status === "dispatching") && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void action(row, { action: "reconcile" })}>{t("只核对派发结果", "Check dispatch only")}</Button>}
      {!["unknown", "dispatching"].includes(row.status) && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void action(row, { action: "remove" })}>{row.status === "sent" ? t("移除队列收据", "Dismiss queue receipt") : t("移除", "Remove")}</Button>}
    </article>)}
    {error && <p role="alert" className="text-destructive whitespace-pre-wrap">{error}</p>}
  </section>;
}

export function ThreadMessageActions({ threadId, messageId, open, onOpenChange: setOpen }: {
  threadId: string; messageId: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const t = useAgentText();
  const navigation = useChatActions();
  const [pending, setPending] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [data, setData] = useState<{ caps: ThreadActionCapabilities; thread: RemoteThread; generation?: ChatGenerationView; headId: string | null }>();
  const [error, setError] = useState<string>();
  const attempt = useRef<{ kind: "fork" | "rewind"; id: string } | null>(null);
  const target = useRef({ threadId, messageId }); target.current = { threadId, messageId };
  useEffect(() => { setOpen(false); setPending(false); setConfirmed(false); setData(undefined); setError(undefined); attempt.current = null; }, [threadId, messageId, setOpen]);
  const load = async () => {
    const base = `/api/chat/threads/${encodeURIComponent(threadId)}`;
    const [caps, thread, generations, history] = await Promise.all([getThreadActionCapabilities(threadId), workspaceClient.json<{ thread: RemoteThread }>(base), workspaceClient.json<{ generations: ChatGenerationView[] }>(`${base}/generations`), workspaceClient.json<{ headId: string | null }>(`${base}/history?limit=1`)]);
    if (target.current.threadId !== threadId || target.current.messageId !== messageId) return;
    setData({ caps, thread: thread.thread, generation: generations.generations.find(generation => generation.messageId === messageId), headId: history.headId });
  };
  const act = async (kind: "fork" | "rewind") => {
    if (!data?.generation) return;
    if (kind === "fork" && !navigation) { setError(t("当前视图不能导航到新会话。", "This view cannot navigate to a new session.")); return; }
    const current = attempt.current?.kind === kind ? attempt.current : { kind, id: crypto.randomUUID() };
    attempt.current = current; setPending(true); setError(undefined);
    try {
      if (kind === "fork") {
        const result = await forkGeneration(data.generation.id, current.id);
        if (target.current.threadId !== threadId || target.current.messageId !== messageId) return;
        await navigation!.navigateSession(result.threadId);
      } else await rewindThreadConversation(threadId, { messageId, expectedHeadId: data.headId, revision: data.thread.revision, confirmed, idempotencyKey: current.id });
      if (target.current.threadId !== threadId || target.current.messageId !== messageId) return;
      setOpen(false); attempt.current = null;
    } catch (reason) { if (target.current.threadId === threadId && target.current.messageId === messageId) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (target.current.threadId === threadId && target.current.messageId === messageId) setPending(false); }
  };
  return <span className="inline-flex flex-wrap items-center gap-1 text-xs">
    <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load().catch(reason => { if (target.current.threadId === threadId && target.current.messageId === messageId) setError(String(reason)); }); }}>{t("分支 / 回退", "Fork / rewind")}</Button>
    {open && <span className="border-border flex basis-full flex-wrap gap-2 rounded border p-2">
      {!data ? <span>{error ?? t("正在核验操作…", "Checking actions…")}</span> : <>
        <Button type="button" size="sm" variant="outline" disabled={pending || !data.generation || !data.caps.fork.supported || data.generation.status !== "completed"} title={data.caps.fork.reason} onClick={() => void act("fork")}>{t("准备此回复的原生分支", "Prepare native fork from reply")}</Button>
        {!data.caps.fork.supported && <span>{data.caps.fork.reason}</span>}
        {data.caps.fork.supported && <span>{t("创建独立会话；第一次明确发送消息时，Provider 才建立原生分支。不自动执行计划或重放历史。", "Creates a separate session; the Provider establishes the native fork on its first explicit send. No plan runs or history replays automatically.")}</span>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("确认只回退对话到此回复。保留分支历史；不撤销文件、终端、PM 写入或业务状态。原生游标将分离，后续从已保存上下文开始。", "Confirm conversation-only rewind to this reply. Branch history remains. Files, terminals, PM writes and business state are NOT rolled back. The native cursor is detached; later turns start from saved context.")}</label>
        <Button type="button" size="sm" variant="outline" disabled={pending || !confirmed || !data.generation || !data.caps.rewind.supported || data.headId === messageId || data.generation.status !== "completed"} title={data.caps.rewind.reason} onClick={() => void act("rewind")}>{t("确认回退对话", "Confirm conversation rewind")}</Button>
        {error && <span role="alert" className="text-destructive basis-full">{error}</span>}
      </>}
    </span>}
  </span>;
}

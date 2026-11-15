import { useAui, useAuiState, type QuoteInfo } from "@assistant-ui/react";
import { useRef } from "react";
import { useAgentText } from "../i18n";
import { usePmIssueWorkspace, PM_REFERENCE_LIMIT } from "../pm/pm-issue-workspace";
import { ComposerMessageActions, type DraftInput } from "./message-actions";
import { useMessageContextDraft } from "./message-context";
import { captureMessageContext, consumeMessageContext, type MessageContextSnapshot } from "./message-context-store";
import { readContextAttachmentBindings, type ContextAttachmentBinding } from "./context-attachments";

/** Freeze the real runtime draft; no submission, provider change, or business operation. */
export function ComposerDraftActions({ disabled }: { disabled: boolean }) {
  const aui = useAui();
  const t = useAgentText();
  const workspace = usePmIssueWorkspace();
  const contextDraft = useMessageContextDraft();
  const liveWorkspace = useRef(workspace);
  liveWorkspace.current = workspace;
  const localId = useAuiState((state) => state.threads.mainThreadId);
  const threadId = useAuiState((state) => state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  const captured = useRef<{
    text: string; quote: QuoteInfo | undefined; attachments: string[];
    references: typeof workspace.references;
    context: MessageContextSnapshot;
  } | undefined>(undefined);
  if (!threadId) return null;

  const readDraft = async (): Promise<DraftInput> => {
    const composer = aui.composer.getState();
    const context = captureMessageContext(threadId, false);
    const contextAttachments: ContextAttachmentBinding[] = [];
    const appendFile = (attachmentId: string, part: Extract<DraftInput["message"]["parts"][number], { type: "file" }>) => {
      contextAttachments.push({ attachmentId, partIndex: parts.length });
      parts.push(part);
    };
    const parts: DraftInput["message"]["parts"] = [{ type: "text", text: composer.text }];
    const readBytes = async (blob: Blob) => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(t("无法读取附件。", "Could not read attachment.")));
      reader.onerror = () => reject(reader.error ?? new Error(t("无法读取附件。", "Could not read attachment.")));
      reader.onabort = () => reject(new Error(t("附件读取已取消。", "Attachment read cancelled.")));
      reader.readAsDataURL(blob);
      return promise;
    };
    const references = workspace.references.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision }));
    const fileBytes = composer.attachments.reduce((total, attachment) => total + (attachment.file?.size ?? 0), 0);
    if (fileBytes > 20 * 1024 * 1024) throw new Error(t("排队或暂存的附件总量不能超过 20 MiB；当前草稿已保留。", "Queued or stashed attachments cannot exceed 20 MiB total; the current draft is preserved."));
    for (const attachment of composer.attachments) {
      if (attachment.status.type === "running" || attachment.status.type === "incomplete")
        throw new Error(t(`附件「${attachment.name}」尚未就绪。`, `Attachment "${attachment.name}" is not ready.`));
      if (attachment.file) {
        const url = await readBytes(attachment.file);
        appendFile(attachment.id, { type: "file", url, mediaType: attachment.contentType || attachment.file.type || "application/octet-stream", filename: attachment.name });
        continue;
      }
      if (!attachment.content?.length) throw new Error(t("附件没有可持久保存的内容。", "Attachment has no durable content."));
      for (const part of attachment.content) {
        if (part.type === "text") appendFile(attachment.id, { type: "file", url: await readBytes(new Blob([part.text], { type: "text/plain" })), mediaType: "text/plain", filename: attachment.name });
        else if (part.type === "image" && typeof part.image === "string") {
          const mediaType = /^data:([^;,]+)/i.exec(part.image)?.[1] || attachment.contentType || "image/png";
          appendFile(attachment.id, { type: "file", url: part.image, mediaType, filename: attachment.name });
        } else if (part.type === "file" && typeof part.data === "string") {
          const mediaType = /^data:([^;,]+)/i.exec(part.data)?.[1] || part.mimeType || attachment.contentType || "application/octet-stream";
          const url = /^(?:data:|[a-z][a-z\d+.-]*:)/i.test(part.data) ? part.data : `data:${mediaType};base64,${part.data}`;
          appendFile(attachment.id, { type: "file", url, mediaType, filename: part.filename || attachment.name });
        } else throw new Error(t("此附件内容不能安全暂存；请保留当前草稿并直接发送。", "This attachment cannot be safely stashed; keep the current draft and send it directly."));
      }
    }
    if (aui.threads.getState().mainThreadId !== localId) throw new Error(t("会话已改变，草稿未提交。", "Session changed; draft was not submitted."));
    const current = aui.composer.getState();
    if (current.text !== composer.text || current.quote !== composer.quote || current.attachments.length !== composer.attachments.length || current.attachments.some((item, index) => item.id !== composer.attachments[index]?.id))
      throw new Error(t("读取附件时草稿已改变，请重试。", "The draft changed while reading attachments. Try again."));
    if (JSON.stringify(captureMessageContext(threadId, false).selectionIds) !== JSON.stringify(context.selectionIds) || liveWorkspace.current.references !== workspace.references)
      throw new Error(t("读取附件时上下文已改变，请重试。", "Context changed while reading attachments. Try again."));
    captured.current = { text: composer.text, quote: composer.quote, attachments: composer.attachments.map((item) => item.id), references: workspace.references, context };
    return { message: { id: crypto.randomUUID(), role: "user", parts,
      metadata: { custom: { ...(composer.quote ? { quote: composer.quote } : {}), ...(contextAttachments.length ? { contextAttachments } : {}) } } }, pmReferences: references, contextItems: context.items.map(item => item.input) };
  };

  const restoreDraft = async (draft: DraftInput) => {
    const composer = aui.composer.getState();
    if (composer.text || composer.attachments.length || composer.quote || workspace.references.length || contextDraft.items.length)
      throw new Error(t("请先暂存或清空当前文字、附件和引用，再恢复此草稿。", "Stash or clear the current text, attachments, and references before restoring this draft."));
    if ((draft.pmReferences?.length ?? 0) > PM_REFERENCE_LIMIT) throw new Error(t("草稿的 PM 引用超过当前限制。", "The draft exceeds the current PM reference limit."));
    const text: string[] = [];
    const files: Array<{ id: string; name: string; mediaType: string; url: string }> = [];
    const metadata = draft.message.metadata as { custom?: { quote?: unknown; contextAttachments?: unknown } } | undefined;
    const bindings = readContextAttachmentBindings(metadata?.custom?.contextAttachments);
    for (const [partIndex, raw] of draft.message.parts.entries()) {
      if (!raw || typeof raw !== "object") throw new Error(t("草稿内容无效。", "Invalid draft content."));
      const part = raw as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") text.push(part.text);
      else if (part.type === "file" && typeof part.url === "string" && typeof part.mediaType === "string" && /^data:[^;,]+;base64,/i.test(part.url))
        files.push({ id: bindings.find(binding => binding.partIndex === partIndex)?.attachmentId ?? crypto.randomUUID(), name: typeof part.filename === "string" ? part.filename : t("附件", "Attachment"), mediaType: part.mediaType, url: part.url });
      else throw new Error(t("草稿包含不支持的附件或内容。", "The draft contains an unsupported attachment or content."));
    }
    const quote = metadata?.custom?.quote;
    if (quote !== undefined && (!quote || typeof quote !== "object" || !("text" in quote) || typeof quote.text !== "string" || !("messageId" in quote) || typeof quote.messageId !== "string"))
      throw new Error(t("草稿的选中文字引用无效。", "Invalid selected-text citation in draft."));
    const added: string[] = [];
    let restoredContext: MessageContextSnapshot | undefined;
    try {
      for (const file of files) {
        const id = file.id;
        added.push(id);
        await aui.composer.addAttachment({ id, name: file.name, type: file.mediaType.startsWith("image/") ? "image" : "file", contentType: file.mediaType,
          content: [file.mediaType.startsWith("image/") ? { type: "image", image: file.url } : { type: "file", data: file.url, mimeType: file.mediaType, filename: file.name }] });
        if (aui.threads.getState().mainThreadId !== localId) throw new Error(t("恢复时会话已改变。", "Session changed while restoring."));
      }
      if (draft.contextItems?.length) {
        await contextDraft.restore(draft.contextItems);
        restoredContext = captureMessageContext(threadId, false);
      }
      const current = aui.composer.getState();
      if (current.text || current.quote || current.attachments.some((item) => !added.includes(item.id)) || liveWorkspace.current.references.length)
        throw new Error(t("恢复时当前草稿已改变；原暂存草稿仍保留。", "The current draft changed during restore; the stashed draft is still retained."));
      aui.composer.setText(text.join("\n"));
      aui.composer.setQuote(quote as QuoteInfo | undefined);
      workspace.replaceReferences((draft.pmReferences ?? []).map((reference) => ({ ...reference, revision: reference.revision ?? null, title: reference.id, availability: "unverified" })));
    } catch (cause) {
      if (restoredContext) consumeMessageContext(restoredContext);
      if (aui.threads.getState().mainThreadId === localId) await Promise.all(added.filter((id) => aui.composer.getState().attachments.some((item) => item.id === id)).map((id) => aui.composer.attachment({ id }).remove()));
      throw cause;
    }
  };

  return <ComposerMessageActions threadId={threadId} disabled={disabled} readDraft={readDraft} restoreDraft={restoreDraft} clearDraft={async () => {
    const frozen = captured.current;
    if (!frozen || aui.threads.getState().mainThreadId !== localId) return;
    if (aui.composer.getState().text === frozen.text) aui.composer.setText("");
    if (aui.composer.getState().quote === frozen.quote) aui.composer.setQuote(undefined);
    consumeMessageContext(frozen.context);
    await Promise.all(frozen.attachments.filter((id) => aui.composer.getState().attachments.some((item) => item.id === id)).map((id) => aui.composer.attachment({ id }).remove()));
    if (aui.threads.getState().mainThreadId !== localId) { captured.current = undefined; return; }
    for (const reference of frozen.references) if (liveWorkspace.current.references.includes(reference)) workspace.removeReference(reference);
    captured.current = undefined;
  }} />;
}

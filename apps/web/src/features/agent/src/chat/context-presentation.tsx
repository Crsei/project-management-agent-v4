// Native presentation adapted from t3code 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c.
// Inputs: composerContextPresentation.tsx, ThreadContextChip.tsx, EnvironmentContextChip.tsx,
// chat/AssistantCitationChip.tsx. Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
import { useState, type ReactElement } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { getExternalStoreMessages } from "@assistant-ui/core";
import type { UIMessage } from "ai";
import { canonicalContextAttachments, readContextAttachmentBindings } from "./context-attachments";
import { GitPullRequestIcon, GlobeIcon, MessageCircleIcon, MessagesSquareIcon, MousePointerClickIcon, PencilIcon, QuoteIcon, TerminalIcon } from "lucide-react";
import { chatContextResolveResponseSchema, type AcceptedChatContext, type ChatContextInput } from "@agent-workspace/contracts/message-context";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { workspaceClient } from "../network";
import { ContextChip, ContextChipAction, ContextChipLabel } from "./context-chip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@agent/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useChatActions } from "./chat-actions";
import { useMessageContextDraft } from "./message-context";
import type { MessageContextDraftItem } from "./message-context-store";
import { bindClipboardContext } from "./message-context-clipboard";
import { ContextChipPopover, ContextChipShell, UnresolvedChip } from "./context-chip-parts";
import { createContextPresentationRegistry } from "./context-presentation-registry";
import { TerminalContextInlineChip } from "./terminal-context-chip";
import { requestContextSource } from "./context-source-navigation";
import { CitationCommentEditor } from "./citation-comment-editor";
import { citationCommentSupported, citationCommentValue, withCitationComment } from "./citation-comment";
import { composerContextDragPayload, writeComposerContextDrag } from "./composer-context-drag";
import { useAgentText } from "../i18n";

export function contextInputLabel(input: ChatContextInput): string {
  const source = input.source;
  if (source.type === "file" || source.type === "diff") return `${source.path}${input.kind === "review-comment" && input.diffSelection ? `:${input.diffSelection.side} ${input.diffSelection.start}–${input.diffSelection.endSide || input.diffSelection.side} ${input.diffSelection.end}` : "selection" in input && input.selection ? `:${input.selection.startLine}–${input.selection.endLine}` : ""}`;
  if (source.type === "browser") return source.title || source.selector || source.url;
  if (source.type === "pull-request") return source.url;
  if (source.type === "environment") return "Local";
  if (source.type === "terminal") return input.kind === "terminal" ? input.terminalLabel || "Terminal selection" : "Terminal selection";
  if (source.type === "thread") return "Referenced session";
  return source.type === "response" ? "Quoted response" : "Native output";
}
const icons = { terminal: TerminalIcon, "review-comment": MessageCircleIcon, "preview-annotation": MousePointerClickIcon, element: MousePointerClickIcon, thread: MessagesSquareIcon, environment: GlobeIcon, response: QuoteIcon };

/** Same native inline block for reply and selected-response history; never a popover. */
export function ResponseContextCard({ text, title, comment, onOpen, label }: { text: string; title?: string; comment?: string; onOpen: () => void; label: string }) {
  return <span className="my-[0.65rem] block" data-markdown-copy={text}>
    <button type="button" onClick={onOpen} aria-label={label} className="block w-full min-w-0 rounded-lg bg-black/10 px-2.5 py-1.5 text-start text-sm text-muted-foreground no-underline wrap-break-word hover:bg-black/14 focus-visible:outline-2 focus-visible:outline-ring dark:bg-black/35 dark:hover:bg-black/50">
      {title ? <span className="block truncate text-xs font-medium text-foreground/80" dir="auto">{title}</span> : null}
      <span className="line-clamp-2" dir="auto">{text.replace(/\s+/g, " ")}</span>
    </button>{comment ? <span className="mt-1.5 block whitespace-pre-wrap" dir="auto">{comment}</span> : null}
  </span>;
}

function ResponseDraftChip({ input, text, label, onOpen }: { input: Extract<ChatContextInput, { kind: "response" }>; text: string; label: string; onOpen: () => void }) {
  const t = useAgentText();
  const draft = useMessageContextDraft();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const comment = citationCommentValue(input);
  const save = (value: string) => {
    setPending(true); setError(undefined);
    // The comment is part of the existing input digest; re-resolving keeps the frozen source check.
    void draft.add(withCitationComment(input, value)).then(() => { if (draft.isCurrent()) setOpen(false); })
      .catch(cause => { if (draft.isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (draft.isCurrent()) setPending(false); });
  };
  return <ContextChip kind="citation" contentEditable={false}>
    <button type="button" onClick={onOpen} aria-label={t(`查看引用回复：${label}`, `View cited response: ${label}`)} title={comment ? `${text}\n\n${comment}` : text} className="inline-flex min-w-0 items-center gap-[0.2em] rounded-sm text-inherit no-underline"><QuoteIcon /><ContextChipLabel className="max-w-[16em]">{input.selectedText || label}</ContextChipLabel></button>
    {/* The quote/context structure carries a comment only for response citations. */}
    {citationCommentSupported(input) && <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<ContextChipAction aria-label={comment ? t("编辑引用评论", "Edit citation comment") : t("添加引用评论", "Add citation comment")} title={comment ? t("编辑引用评论", "Edit citation comment") : t("添加引用评论", "Add citation comment")}><PencilIcon /></ContextChipAction>} />
      <PopoverContent side="top" className="w-[min(30rem,90vw)] space-y-2"><PopoverTitle className="text-sm font-medium">{t("回复评论", "Comment on this response")}</PopoverTitle><blockquote className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{text}</blockquote>
        {comment && <p className="citation-comment-saved whitespace-pre-wrap text-sm" dir="auto">{comment}</p>}
        <CitationCommentEditor value={comment} disabled={pending || !draft.available} onSave={save} onCancel={() => setOpen(false)} />
        {!draft.available && <p role="status" className="text-xs text-muted-foreground">{t("会话尚未就绪，评论未保存。", "The session is not ready; the comment was not saved.")}</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}</PopoverContent>
    </Popover>}
  </ContextChip>;
}

function ContextRecord({ item, history = false }: { item: MessageContextDraftItem; history?: boolean }) {
  const actions = useChatActions();
  const aui = useAui();
  const [error, setError] = useState<string>();
  const { input, accepted } = item;
  const source = input.source;
  const unavailable = item.error || accepted?.visibility === "unavailable";
  const label = accepted?.visibility === "available" && accepted.label && (input.kind === "thread" || input.kind === "environment" || input.kind === "response") ? accepted.label : contextInputLabel(input);
  const Icon = source.type === "pull-request" ? GitPullRequestIcon : icons[input.kind];
  const attachments = useAuiState(s => history ? s.optional.message?.attachments ?? [] : s.composer.attachments);
  const message = useAuiState(s => s.optional.message);
  const screenshotId = source.type === "browser" ? source.attachmentId : undefined;
  const original = message && screenshotId ? (getExternalStoreMessages(message) as UIMessage[]).at(-1) : undefined;
  const canonicalAttachments = screenshotId ? canonicalContextAttachments(attachments, original?.parts ?? [], readContextAttachmentBindings(message?.metadata.custom.contextAttachments)) : attachments;
  const screenshot = screenshotId ? canonicalAttachments.find(attachment => attachment.id === screenshotId) : undefined;
  const screenshotPart = screenshot?.content?.find(part => part.type === "image" || part.type === "file");
  const screenshotUrl = screenshotPart?.type === "image" && typeof screenshotPart.image === "string" ? screenshotPart.image : screenshotPart?.type === "file" && typeof screenshotPart.data === "string" && screenshot?.contentType?.startsWith("image/") ? screenshotPart.data : undefined;
  const openSource = async () => {
    try {
      if (!actions?.threadId) throw new Error("Source navigation is unavailable in this view.");
      const owner = aui.threads.getState().mainThreadId;
      const resolved = chatContextResolveResponseSchema.parse(await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(actions.threadId)}/context/resolve`, { method: "POST", body: JSON.stringify({ contextItems: [input] }) }));
      if (aui.threads.getState().mainThreadId !== owner) throw new Error("The session changed before source navigation.");
      if (resolved.contextItems[0]?.contextId !== input.contextId || resolved.contextItems[0]?.visibility !== "available") throw new Error("The original context source is no longer available. Its saved snapshot is unchanged.");
      if (source.type === "file") actions.openFile(source.path, "selection" in input ? input.selection?.startLine : undefined);
      else if (source.type === "diff") actions.openDiff(source.path, { staged: source.staged });
      else if (source.type === "response" || source.type === "thread" || source.type === "native-output") {
        const activeThread = aui.threads.getState().mainThreadId;
        let messageId = source.type === "thread" ? source.headMessageId : source.type === "response" ? source.messageId : undefined;
        if (source.type === "native-output") {
          const result = await workspaceClient.json<{ generations: ChatGenerationView[] }>(`/api/chat/threads/${encodeURIComponent(source.threadId)}/generations`);
          messageId = result.generations.find(generation => generation.id === source.generationId)?.messageId;
          if (!messageId) throw new Error("The original native output message is unavailable.");
          if (aui.threads.getState().mainThreadId !== activeThread) throw new Error("The session changed before source navigation.");
        }
        if (source.threadId !== actions.threadId) await actions.navigateSession(source.threadId);
        if (messageId) requestContextSource(source.threadId, messageId, source.type !== "thread" && source.itemId && source.generationId ? { generationId: source.generationId, itemId: source.itemId } : undefined);
      } else if (source.type === "browser" || source.type === "pull-request") window.open(source.url, "_blank", "noopener,noreferrer");
      else if (source.type === "environment") setError("This reference describes the local server execution captured at acceptance, not a remote host.");
      else setError("The saved terminal selection is shown here; opening it never replays a command.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  if (unavailable) return <ContextChipShell kind={input.kind === "response" ? "citation" : input.kind} state="invalid" icon={<Icon />} label={label} tooltip={item.error || accepted?.reason || "This saved context is no longer accessible."} />;
  const text = accepted?.text ?? ("text" in input ? input.text : "") ?? "";
  if (history && input.kind === "response") return <><ResponseContextCard text={text} comment={input.comment} label="Go to the quoted response" onOpen={() => void openSource()} />{error && <span role="alert">{error}</span>}</>;
  if (input.kind === "response") return <><ResponseDraftChip input={input} text={text} label={label} onOpen={() => void openSource()} />{error && <span role="alert" className="text-xs">{error}</span>}</>;
  if (input.kind === "thread") return <TooltipProvider><Tooltip><TooltipTrigger render={<ContextChip kind="thread" render={<button type="button" />} aria-label={`Thread, ${label}`} onClick={() => void openSource()}><MessagesSquareIcon /><ContextChipLabel>{label}</ContextChipLabel></ContextChip>} /><TooltipContent side="top"><div className="max-h-64 max-w-sm overflow-auto whitespace-pre-wrap text-xs">{text}</div>{error && <p role="alert">{error}</p>}</TooltipContent></Tooltip></TooltipProvider>;
  if (input.kind === "environment") return <ContextChipShell kind="environment" icon={<GlobeIcon />} label={label} tooltip={<pre className="max-h-64 max-w-sm overflow-auto whitespace-pre-wrap text-xs">{text}</pre>} />;
  if (input.kind === "terminal") return <span className="inline-flex items-center gap-1"><TerminalContextInlineChip label={label} terminalLabel={accepted?.visibility === "available" ? accepted.terminalLabel || input.terminalLabel || "Terminal" : input.terminalLabel || "Terminal"} lineStart={input.selection?.startLine ?? 1} lineEnd={input.selection?.endLine ?? text.split("\n").length} text={[text, input.comment].filter(Boolean).join("\n\n")} detailsMode="popover" />{source.type === "native-output" && <ContextChipAction aria-label="Open original native output" title="Open original native output" onClick={() => void openSource()}><MessagesSquareIcon /></ContextChipAction>}{error && <span role="alert" className="text-xs">{error}</span>}</span>;
  return <ContextChipPopover kind={source.type === "pull-request" ? "pull-request" : input.kind} icon={<Icon />} label={label} accessibleLabel={label}>
    <div className="space-y-2 overflow-hidden rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="truncate text-xs font-medium">{label}</div>
      {source.type === "pull-request" && <p className="text-xs text-muted-foreground">User-provided pull request URL. No remote title, state or repository metadata was fetched.</p>}
      {source.type === "browser" && <><p className="break-all text-xs">{source.url}{source.selector ? ` · ${source.selector}` : ""}</p>{screenshotUrl ? <img src={screenshotUrl} alt="Captured preview" className="max-h-64 w-full object-contain" /> : screenshotId ? <p role="status" className="text-xs text-muted-foreground">Screenshot unavailable; the annotation text is preserved.</p> : null}</>}
      <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">{text || "No text snapshot was accepted."}</pre>
      {input.comment && <p className="whitespace-pre-wrap text-sm">{input.comment}</p>}
      {accepted && <p className="text-xs text-muted-foreground">{accepted.provenance} · {accepted.acceptedAt}{accepted.truncated ? " · Truncated" : ""}</p>}
      <button type="button" className="text-xs underline" onClick={() => void openSource()}>Open source</button>{error && <p role="alert" className="text-xs">{error}</p>}
    </div>
  </ContextChipPopover>;
}
const registry = createContextPresentationRegistry<MessageContextDraftItem, { history: boolean }, ReactElement>({
  handlers: (["terminal", "review-comment", "preview-annotation", "element", "thread", "environment", "response"] as const).map(kind => ({ kind, canRender: item => item.input.kind === kind, render: (item, context) => <ContextRecord item={item} history={context.history} /> })),
  fallback: kind => <UnresolvedChip label={kind} tooltip="This context kind is missing or unsupported. Remove it or attach it again." />,
});
export function MessageContextChip({ item, history = false }: { item: MessageContextDraftItem; history?: boolean }) { return <span data-message-context-record draggable ref={element => { bindClipboardContext(element, () => ({ type: "native", item: { input: item.input } })); }} onDragStart={event => {
  writeComposerContextDrag(event.dataTransfer, composerContextDragPayload("", [{ type: "native", item: { input: item.input } }]));
  event.dataTransfer.setData("text/plain", contextInputLabel(item.input));
}}>{registry.render(item.input.kind, item, { history })}{item.accepted?.visibility === "available" && item.accepted.reason && <span role="status" className="ml-1 whitespace-normal text-xs text-muted-foreground">{item.accepted.reason}</span>}</span>; }
export function AcceptedMessageContexts({ items }: { items: readonly AcceptedChatContext[] }) { return <div className="flex flex-wrap items-start gap-2 py-1 text-sm">{items.map(accepted => <span className={accepted.kind === "response" ? "block w-full" : "inline-flex"} key={accepted.contextId}>{accepted.visibility === "available" ? <MessageContextChip item={{ input: accepted.input, accepted }} history /> : <ContextChipShell kind={accepted.kind === "response" ? "citation" : accepted.kind} state="invalid" icon={<MessageCircleIcon />} label="Context unavailable" tooltip={accepted.reason || "The saved context is no longer accessible."} />}</span>)}</div>; }
export function MessageContextDraftStatus() { const draft = useMessageContextDraft(); return draft.error ? <p role="alert" className="px-2 text-xs text-destructive">{draft.error}</p> : null; }

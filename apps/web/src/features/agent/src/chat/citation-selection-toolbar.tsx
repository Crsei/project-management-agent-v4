import { useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { MessageSquareQuoteIcon } from "lucide-react";
import { cn } from "@agent/lib/utils";
import { useAgentText } from "../i18n";
import { useMessageContextDraft } from "./message-context";

const MAX_CITATION_SELECTION = 16_000;
const ASSISTANT_CONTENT = '[data-slot="aui_assistant-message-content"]';
const ASSISTANT_MESSAGE = '[data-role="assistant"][data-message-id]';
const SELECTION_CONTROLS = 'button, [role="button"], input, textarea, select, [contenteditable]:not([contenteditable="false"])';

type CapturedSelection = { text: string; messageId: string } | "too-long" | null;

/**
 * Reads the live selection that the toolbar deliberately keeps alive. Only a
 * single assistant message body qualifies; controls and cross-message ranges
 * are rejected instead of attaching a misleading source anchor.
 */
function captureAssistantSelection(): CapturedSelection {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;
  const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
  const focusElement = focusNode instanceof Element ? focusNode : focusNode.parentElement;
  const anchorContent = anchorElement?.closest<HTMLElement>(ASSISTANT_CONTENT);
  const focusContent = focusElement?.closest<HTMLElement>(ASSISTANT_CONTENT);
  if (!anchorContent || anchorContent !== focusContent) return null;
  const messageId = anchorContent.closest<HTMLElement>(ASSISTANT_MESSAGE)?.getAttribute("data-message-id");
  if (!messageId) return null;
  const range = selection.getRangeAt(0);
  if (!anchorContent.contains(range.commonAncestorContainer)) return null;
  if ([...anchorContent.querySelectorAll(SELECTION_CONTROLS)].some(control => range.intersectsNode(control))) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  return text.length > MAX_CITATION_SELECTION ? "too-long" : { text, messageId };
}

/**
 * Adds a source-anchored citation for the selected assistant text through the
 * existing response-context draft path (server-verified on insert).
 */
export function SelectionToolbarCite({ className }: { className?: string }) {
  const t = useAgentText();
  const draft = useMessageContextDraft();
  const threadId = useAuiState(state => state.threads.threadItems.find(item => item.id === state.threads.mainThreadId)?.remoteId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const cite = async () => {
    const captured = captureAssistantSelection();
    if (captured === "too-long") {
      setError(t("选中文字超过引用上限。", "The selection exceeds the citation length limit."));
      return;
    }
    if (!captured) {
      setError(t("请只选择一条助手消息中的正文。", "Select text from one assistant message body only."));
      return;
    }
    if (!threadId || !draft.available) {
      setError(t("当前会话暂不能添加引用。", "A citation cannot be added to this session right now."));
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await draft.add({
        contextId: crypto.randomUUID(),
        kind: "response",
        source: { type: "response", threadId, messageId: captured.messageId },
        selectedText: captured.text,
      });
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("无法添加引用。", "The citation could not be added."));
    } finally {
      setPending(false);
    }
  };
  return <span className="inline-flex items-center gap-1">
    <button
      type="button"
      data-slot="selection-toolbar-cite"
      className={cn("text-popover-foreground hover:bg-accent flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors disabled:cursor-default disabled:opacity-50", className)}
      disabled={pending || !draft.available || !threadId}
      aria-label={t("引用选中文字", "Cite selected text")}
      title={t("把选中文字作为带来源锚点的引用加入输入框", "Add the selection to the composer as a source-anchored citation")}
      onClick={() => void cite()}
    >
      <MessageSquareQuoteIcon className="size-3.5" aria-hidden="true" />
      {pending ? t("引用中…", "Citing…") : t("引用来源", "Cite")}
    </button>
    {error && <span role="alert" className="max-w-56 text-xs text-destructive">{error}</span>}
  </span>;
}

// Source-navigation interaction adapted from t3code 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c
// chat/AssistantCitationSource.tsx. Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { QuoteIcon } from "lucide-react";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import type { MessageContextDraft } from "./message-context";
import { consumeContextSource, getContextSourceTarget, nativeContextSourceAnchor, subscribeContextSource } from "./context-source-navigation";

export const NativeOutputContext = createContext<{ draft: MessageContextDraft; threadId: string; messageId: string } | null>(null);
export function NativeOutputContextAction({ item, generationId, settled }: { item: NativeOutputItem; generationId: string; settled: boolean }) {
  const source = useContext(NativeOutputContext);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  if (!source || !settled || !source.draft.available || item.visibility === "redacted" || item.visibility === "unavailable") return null;
  return <span className="inline-flex flex-wrap items-center gap-1 text-xs"><button type="button" className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" disabled={pending} onMouseDown={event => event.preventDefault()} onClick={() => {
    const selection = window.getSelection();
    const anchor = document.getElementById(nativeContextSourceAnchor(generationId, item.id));
    const selected = selection?.toString() ?? "";
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (selected && (!range || !anchor?.contains(range.startContainer) || !anchor.contains(range.endContainer))) {
      setError("The selection must belong to this output item. Select it again; no whole-item reference was added.");
      return;
    }
    const selectedText = selected || undefined;
    setPending(true); setError(undefined);
    const input = item.type === "command_execution" && !selectedText
      ? { contextId: crypto.randomUUID(), kind: "terminal" as const, source: { type: "native-output" as const, threadId: source.threadId, generationId, itemId: item.id } }
      : { contextId: crypto.randomUUID(), kind: "response" as const, source: { type: "response" as const, threadId: source.threadId, messageId: source.messageId, generationId, itemId: item.id }, ...(selectedText ? { selectedText } : {}) };
    void source.draft.add(input).catch(cause => { if (source.draft.isCurrent()) setError(String(cause)); }).finally(() => { if (source.draft.isCurrent()) setPending(false); });
  }}><QuoteIcon className="size-3" />Reference output</button>{error && <span role="alert" className="text-destructive">{error}</span>}</span>;
}

/** Open the actual native row after history paging/folding has exposed its message. */
export function useNativeOutputContextSource(generationId: string, itemIds: readonly string[], onOpen: (open: boolean) => void, consume = true) {
  const target = useSyncExternalStore(subscribeContextSource, getContextSourceTarget, () => null);
  const open = useRef(onOpen); open.current = onOpen;
  const itemKey = JSON.stringify(itemIds);
  useEffect(() => {
    if (!target?.itemId || target.generationId !== generationId || !itemIds.includes(target.itemId)) return;
    open.current(true);
    const frame = requestAnimationFrame(() => {
      const node = document.getElementById(nativeContextSourceAnchor(generationId, target.itemId!));
      if (!node) return;
      node.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      node.animate?.([{ outline: "2px solid var(--color-ring)" }, { outline: "2px solid transparent" }], { duration: 1575 });
      if (consume) consumeContextSource(target.requestId);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, generationId, itemKey, consume]);
}

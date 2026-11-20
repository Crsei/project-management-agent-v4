import { useState } from "react";
import type { QuoteInfo } from "@assistant-ui/react";
import { QuoteIcon } from "lucide-react";
import { useAgentText } from "../i18n";
import { useChatActions } from "./chat-actions";
import { ContextChipPopover } from "./context-chip-parts";
import { ResponseContextCard } from "./context-presentation";
import { requestContextSource } from "./context-source-navigation";
import { citationAnchorFromQuote, markdownCitationLabel, type MarkdownCitationAnchor } from "./markdown-citation";

type Locale = "zh-CN" | "en";

/**
 * Inline citation chip rendered inside message Markdown. The popover shows the
 * saved excerpt and locates the source message through the existing
 * context-source navigation; it never verifies or rewrites the excerpt.
 */
export function MarkdownCitationChip({ anchor, locale }: { anchor: MarkdownCitationAnchor; locale: Locale }) {
  const t = useAgentText();
  const actions = useChatActions();
  const threadId = anchor.threadId ?? actions?.threadId;
  const canLocate = Boolean(actions && threadId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const label = markdownCitationLabel(anchor);
  const locate = async () => {
    if (!actions || !threadId) return;
    setPending(true);
    setError(undefined);
    try {
      if (threadId !== actions.threadId) await actions.navigateSession(threadId);
      requestContextSource(threadId, anchor.messageId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("无法定位来源消息。", "The source message could not be located."));
    } finally {
      setPending(false);
    }
  };
  return <ContextChipPopover
    kind="citation"
    icon={<QuoteIcon aria-hidden="true" />}
    label={label}
    accessibleLabel={locale === "zh-CN" ? `引用：${label}` : `Citation: ${label}`}
  >
    <div className="space-y-2 p-2 text-sm">
      <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs text-muted-foreground" dir="auto">{anchor.text}</blockquote>
      {canLocate ? <button
        type="button"
        disabled={pending}
        onClick={() => void locate()}
        className="text-xs underline disabled:opacity-50"
      >{pending ? t("正在定位…", "Locating…") : t("定位来源消息", "Go to source message")}</button> : <p role="status" className="text-xs text-muted-foreground">{t("此视图无法定位来源消息，仅显示已保存的摘录。", "The source message cannot be located in this view; only the saved excerpt is shown.")}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </ContextChipPopover>;
}

/**
 * A citation link without a usable source id keeps the existing quote card.
 * Clicking it explains that no anchor exists instead of navigating anywhere.
 */
export function AnchorlessCitationCard({ text }: { text: string }) {
  const t = useAgentText();
  const [notice, setNotice] = useState(false);
  return <span className="block">
    <ResponseContextCard
      text={text}
      label={t("引用摘录（没有来源锚点）", "Cited excerpt (no source anchor)")}
      onOpen={() => setNotice(true)}
    />
    {notice && <span role="status" className="block ps-1 text-xs text-muted-foreground">{t("此引用没有可定位的来源锚点；只保留已保存的摘录。", "This citation has no source anchor; only the saved excerpt is shown.")}</span>}
  </span>;
}

/** Assistant messages can carry quote metadata; render it inline instead of dropping it. */
export function AssistantQuoteCitation({ quote, locale }: { quote: QuoteInfo; locale: Locale }) {
  const anchor = citationAnchorFromQuote({ messageId: quote.messageId, text: quote.text });
  if (!anchor) return typeof quote.text === "string" && quote.text.trim() ? <AnchorlessCitationCard text={quote.text} /> : null;
  return <span className="my-1 inline-flex max-w-full">
    <MarkdownCitationChip anchor={anchor} locale={locale} />
  </span>;
}

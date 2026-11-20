// Shoulder badge + drawer for the durable draft stash.
// Adapted from t3code ComposerStashBadge.tsx / ComposerStashMenu.tsx at
// 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c. Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
// Restore/delete keep the existing host endpoints and the "restore requires an empty
// composer" rule; this component never sends and never mutates a draft by itself.
import { useEffect, useRef, useState } from "react";
import { BookmarkIcon, FileIcon, MessageSquareQuoteIcon, MessagesSquareIcon, Trash2Icon, XIcon } from "lucide-react";
import type { StashedChatDraft } from "@agent-workspace/contracts/chat";
import { useAgentText, type AgentText } from "../i18n";
import {
  moveStashHighlight, stashDraftCounts, stashDraftSnippet, stashDrawerCommand, stashRelativeTime, type StashRelativeTime,
} from "./composer-stash-model";
import "./composer-stash.css";

function relativeLabel(parts: StashRelativeTime, t: AgentText): string {
  switch (parts.unit) {
    case "now": return t("刚刚", "just now");
    case "minute": return t(`${parts.value} 分钟前`, `${parts.value} min ago`);
    case "hour": return t(`${parts.value} 小时前`, `${parts.value} h ago`);
    case "day": return t(`${parts.value} 天前`, `${parts.value} d ago`);
    case "date": return new Date(parts.value).toLocaleDateString();
    default: return "";
  }
}

function StashEntrySummary({ draft }: { draft: StashedChatDraft["draft"] }) {
  const t = useAgentText();
  const snippet = stashDraftSnippet(draft);
  const counts = stashDraftCounts(draft);
  return <span className="composer-stash-summary">
    <span className="composer-stash-text" dir="auto">{snippet ?? t("附件或引用草稿", "Attachment or quote draft")}</span>
    <span className="composer-stash-chips">
      {counts.attachments > 0 && <span className="composer-stash-chip"><FileIcon aria-hidden="true" />{t(`${counts.attachments} 附件`, `${counts.attachments} file${counts.attachments === 1 ? "" : "s"}`)}</span>}
      {counts.contexts > 0 && <span className="composer-stash-chip"><MessagesSquareIcon aria-hidden="true" />{t(`${counts.contexts} 引用`, `${counts.contexts} citation${counts.contexts === 1 ? "" : "s"}`)}</span>}
      {counts.references > 0 && <span className="composer-stash-chip"><MessagesSquareIcon aria-hidden="true" />{t(`${counts.references} PM 引用`, `${counts.references} PM ref${counts.references === 1 ? "" : "s"}`)}</span>}
      {counts.quoted && <span className="composer-stash-chip"><MessageSquareQuoteIcon aria-hidden="true" />{t("选中文字", "Quote")}</span>}
    </span>
  </span>;
}

export type ComposerStashPanelProps = {
  entries: readonly StashedChatDraft[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (entry: StashedChatDraft) => void | Promise<void>;
  onDelete: (entry: StashedChatDraft) => void | Promise<void>;
  pending?: boolean;
  /** A stash save is in flight; the badge pulses instead of showing a spinner alone. */
  saving?: boolean;
  disabled?: boolean;
  error?: string;
};

export function ComposerStashPanel({ entries, open, onOpenChange, onRestore, onDelete, pending = false, saving = false, disabled = false, error }: ComposerStashPanelProps) {
  const t = useAgentText();
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pulse, setPulse] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const drawerRef = useRef<HTMLElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const previousCount = useRef(entries.length);
  const highlighted = entries.find(entry => entry.id === highlightedId) ?? entries[0];
  const count = entries.length;

  useEffect(() => {
    setHighlightedId(current => current && entries.some(entry => entry.id === current) ? current : entries[0]?.id ?? null);
    if (!entries.some(entry => entry.id === confirmingId)) setConfirmingId(null);
  }, [entries, confirmingId]);

  useEffect(() => {
    if (entries.length > previousCount.current || saving) {
      setPulse(true);
      const timer = window.setTimeout(() => setPulse(false), 900);
      previousCount.current = entries.length;
      return () => window.clearTimeout(timer);
    }
    previousCount.current = entries.length;
    setPulse(false);
    return undefined;
  }, [entries.length, saving]);

  useEffect(() => {
    if (!open) { setConfirmingId(null); return; }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    drawerRef.current?.focus({ preventScroll: true });
    return () => window.clearInterval(timer);
  }, [open]);

  // Two-step confirm; the first activation only arms, matching the existing delete semantics.
  const requestDelete = (entry: StashedChatDraft) => {
    if (pending || disabled) return;
    if (confirmingId === entry.id) { setConfirmingId(null); void onDelete(entry); return; }
    setConfirmingId(entry.id);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Node && drawerRef.current && !drawerRef.current.contains(target) && !badgeRef.current?.contains(target) && target !== document.body) return;
      const command = stashDrawerCommand({
        key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey,
        composing: event.isComposing || event.keyCode === 229, hasHighlight: Boolean(highlighted),
      });
      if (!command) return;
      // A focused action button inside a row owns its own Enter activation.
      if (command === "restore" && target instanceof Element && target.closest("button:not([data-stash-restore])")) return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "close") { onOpenChange(false); return; }
      if (command === "previous" || command === "next") {
        const next = moveStashHighlight(entries.findIndex(entry => entry.id === highlighted?.id), command === "next" ? 1 : -1, entries.length);
        setHighlightedId(entries[next]?.id ?? null);
        return;
      }
      if (!highlighted || pending || disabled) return;
      if (command === "restore") { void onRestore(highlighted); return; }
      requestDelete(highlighted);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, entries, highlighted, pending, disabled, confirmingId, onOpenChange, onRestore, onDelete]);

  return <div className="composer-stash" data-open={open || undefined}>
    {count > 0 && <button ref={badgeRef} type="button" className="composer-stash-badge" data-saving={saving || undefined} data-pulse={pulse || undefined}
      aria-expanded={open} aria-controls="composer-stash-drawer" aria-label={t(`暂存草稿 ${count} 条；打开草稿库`, `${count} stashed draft${count === 1 ? "" : "s"}; open stash`)}
      onClick={() => onOpenChange(!open)}>
      <BookmarkIcon aria-hidden="true" />
      <span>{t("暂存", "Stash")}</span>
      <span className="composer-stash-count" key={`${count}:${pulse ? "pulse" : "steady"}`}>{count}</span>
      {saving && <span className="sr-only" role="status">{t("正在暂存…", "Stashing…")}</span>}
    </button>}
    {open && <section ref={drawerRef} id="composer-stash-drawer" className="composer-stash-drawer" role="dialog" aria-label={t("草稿暂存库", "Draft stash")} tabIndex={-1}>
      <header className="composer-stash-header">
        <span>{t(`暂存草稿（${count}）`, `Stashed drafts (${count})`)}</span>
        <button type="button" className="composer-stash-close" aria-label={t("关闭草稿库", "Close stash")} onClick={() => onOpenChange(false)}><XIcon aria-hidden="true" /></button>
      </header>
      <p className="composer-stash-hint" role="note">{t("暂存不会发送。恢复要求输入框为空；原暂存保留至手动删除。↑/↓ 选择，Enter 恢复，⌘/Ctrl+Backspace 删除，Esc 关闭。", "Stashing never sends. Restore requires an empty composer; the stash remains until explicitly deleted. ↑/↓ select, Enter restores, ⌘/Ctrl+Backspace deletes, Esc closes.")}</p>
      {count === 0 && <p className="composer-stash-empty">{t("没有暂存草稿。", "No stashed drafts.")}</p>}
      <ul className="composer-stash-list">
        {entries.map(entry => <li key={entry.id} className="composer-stash-row" data-highlighted={highlighted?.id === entry.id || undefined} onMouseMove={() => setHighlightedId(entry.id)}>
          <button type="button" className="composer-stash-restore" data-stash-restore disabled={pending || !entry.draft}
            aria-label={entry.draft ? t(`恢复暂存草稿：${stashDraftSnippet(entry.draft) ?? "附件或引用草稿"}`, `Restore stashed draft: ${stashDraftSnippet(entry.draft) ?? "attachment or quote draft"}`) : undefined}
            onClick={() => { setHighlightedId(entry.id); void onRestore(entry); }}>
            {entry.draft ? <StashEntrySummary draft={entry.draft} /> : <span className="composer-stash-text">{entry.reason ?? t("暂存内容不可用。", "Stashed content is unavailable.")}</span>}
            {(() => { const relative = stashRelativeTime(entry.createdAt, now); const label = relativeLabel(relative, t); return label ? <time dateTime={entry.createdAt} className="composer-stash-time">{label}</time> : null; })()}
          </button>
          {confirmingId === entry.id
            ? <span className="composer-stash-confirm" role="group" aria-label={t("确认删除暂存", "Confirm stash deletion")}>
              <span>{t("删除这条暂存？", "Delete this stash?")}</span>
              <button type="button" disabled={pending} onClick={() => { setConfirmingId(null); void onDelete(entry); }}>{t("确认删除", "Delete")}</button>
              <button type="button" onClick={() => setConfirmingId(null)}>{t("取消", "Cancel")}</button>
            </span>
            : <button type="button" className="composer-stash-delete" aria-label={t("删除暂存", "Delete stash")} disabled={pending} onClick={() => requestDelete(entry)}><Trash2Icon aria-hidden="true" /></button>}
        </li>)}
      </ul>
      {error && <p role="alert" className="composer-stash-error">{error}</p>}
    </section>}
  </div>;
}

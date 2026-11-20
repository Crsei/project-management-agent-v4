// Inline citation-comment editor used by composer citation chips.
// Adapted from t3code AssistantCitationCommentEditor.tsx at
// 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c. Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
import { useEffect, useRef, useState } from "react";
import { useAgentText } from "../i18n";
import { CITATION_COMMENT_MAX_LENGTH, citationCommentTooLong } from "./citation-comment";
import "./citation-comment.css";

export type CitationCommentEditorProps = {
  value: string;
  onSave: (comment: string) => void;
  onCancel: () => void;
  disabled?: boolean;
};

export function CitationCommentEditor({ value, onSave, onCancel, disabled = false }: CitationCommentEditorProps) {
  const t = useAgentText();
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLTextAreaElement>(null);
  const tooLong = citationCommentTooLong(draft);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  const save = () => { if (!tooLong && !disabled) onSave(draft); };
  return <div className="citation-comment-editor" onKeyDownCapture={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <textarea ref={field} className="citation-comment-field" value={draft} disabled={disabled} rows={3}
      aria-label={t("引用评论", "Citation comment")}
      aria-invalid={tooLong || undefined}
      aria-describedby={tooLong ? "citation-comment-error" : undefined}
      placeholder={t("可选的评论…", "Add an optional comment…")}
      onChange={event => setDraft(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save(); }
      }} />
    {tooLong
      ? <p id="citation-comment-error" role="alert" className="citation-comment-error">{t(`评论最多 ${CITATION_COMMENT_MAX_LENGTH.toLocaleString()} 字符，请缩短后再保存。`, `Comments can contain up to ${CITATION_COMMENT_MAX_LENGTH.toLocaleString()} characters; shorten before saving.`)}</p>
      : <p className="citation-comment-hint">{t("Enter 保存，Shift+Enter 换行，Esc 取消。", "Enter saves, Shift+Enter adds a line, Esc cancels.")}</p>}
    <div className="citation-comment-actions">
      {value.trim() && <button type="button" className="citation-comment-clear" disabled={disabled || tooLong} onClick={() => onSave("")}>{t("清除评论", "Clear comment")}</button>}
      <button type="button" disabled={disabled} onClick={onCancel}>{t("取消", "Cancel")}</button>
      <button type="button" disabled={disabled || tooLong} onClick={save}>{t("保存评论", "Save comment")}</button>
    </div>
  </div>;
}

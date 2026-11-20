// Durable queue rows: drag/Alt-arrow ordering plus inline composer-region editing.
// Adapted from t3code QueuedRunsControl.tsx / useQueuedRunEdit.ts at
// 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c. Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
// The parent keeps the coordinator, revisions and settings confirmation; this list only
// renders rows and turns drag/keyboard intent into the existing `move` action.
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { GripVerticalIcon } from "lucide-react";
import type { QueuedChatMessage } from "@agent-workspace/contracts/chat";
import { Button } from "@agent/components/ui/button";
import { useAgentText, type AgentText } from "../i18n";
import { queueDropIndex, queueDropPosition, queueEditableText, queueKeyboardBeforeId, queueMoveBeforeId, queueRowReorderable } from "./composer-queue-order";
import "./composer-queue.css";

export const QUEUED_MESSAGE_DRAG_TYPE = "application/x-dovspace-queued-message";

const statusLabels = (t: AgentText): Record<QueuedChatMessage["status"], string> => ({
  queued: t("排队中", "Queued"),
  dispatching: t("派发中", "Dispatching"),
  sent: t("已发送", "Sent"),
  blocked: t("已阻止", "Blocked"),
  unknown: t("结果未明", "Unknown"),
  removed: t("已移除", "Removed"),
});

export type ComposerQueueListProps = {
  rows: readonly QueuedChatMessage[];
  latestStatus?: string;
  pending: boolean;
  /** A previous execution ended abnormally; sending the next row needs the explicit check. */
  needsConfirmation: boolean;
  confirmed: boolean;
  editingId?: string;
  editText: string;
  onEditTextChange: (text: string) => void;
  onBeginEdit: (row: QueuedChatMessage) => void;
  onEditInComposer?: (row: QueuedChatMessage) => void;
  onCancelEdit: () => void;
  onSaveEdit: (row: QueuedChatMessage) => void;
  onSend: (row: QueuedChatMessage) => void;
  onMove: (row: QueuedChatMessage, beforeId: string | null) => void;
  onRemove: (row: QueuedChatMessage) => void;
  onReconcile: (row: QueuedChatMessage) => void;
  renderDraftDetails?: (row: QueuedChatMessage) => ReactNode;
};

export function ComposerQueueList(props: ComposerQueueListProps) {
  const { rows, pending, confirmed, needsConfirmation, editingId, editText } = props;
  const t = useAgentText();
  const [drag, setDrag] = useState<{ id: string; insertIndex: number | null }>();
  // Only the grip arms a row, so dragging selected text never reorders the queue.
  const armed = useRef<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const arm = (id: string | null) => { armed.current = id; setArmedId(id); };
  const busy = props.latestStatus === "running" || props.latestStatus === "queued";
  const canMove = !pending && rows.length > 1;

  const completeDrag = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const active = drag;
    setDrag(undefined);
    arm(null);
    if (!active || active.insertIndex === null) return;
    const fromIndex = rows.findIndex(row => row.id === active.id);
    if (fromIndex < 0) return;
    const beforeId = queueMoveBeforeId(rows, fromIndex, active.insertIndex);
    if (beforeId === undefined) return;
    props.onMove(rows[fromIndex]!, beforeId);
  };

  return <ol className="composer-queue-list" aria-label={t("持久消息队列（可拖拽排序）", "Durable message queue (drag to reorder)")}>
    {rows.map((row, index) => {
      const reorderable = queueRowReorderable(row.status) && canMove;
      const editing = editingId === row.id;
      return <li key={row.id} className="composer-queue-row" data-status={row.status}
        data-dragging={drag?.id === row.id || undefined}
        data-armed={armedId === row.id || undefined}
        draggable={reorderable}
        onDragStart={event => {
          if (!reorderable || armed.current !== row.id) { event.preventDefault(); return; }
          event.dataTransfer.setData(QUEUED_MESSAGE_DRAG_TYPE, row.id);
          event.dataTransfer.effectAllowed = "move";
          setDrag({ id: row.id, insertIndex: null });
        }}
        onDragOver={event => {
          if (!drag) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const insertIndex = queueDropIndex(index, queueDropPosition(event.clientY, rect.top, rect.height));
          if (drag.insertIndex !== insertIndex) setDrag({ id: drag.id, insertIndex });
        }}
        onDrop={completeDrag}
        onDragEnd={() => { setDrag(undefined); arm(null); }}>
        {drag && drag.insertIndex === index && <span aria-hidden="true" className="composer-queue-insert composer-queue-insert-top" />}
        {drag && index === rows.length - 1 && drag.insertIndex === rows.length && <span aria-hidden="true" className="composer-queue-insert composer-queue-insert-bottom" />}
        <div className="composer-queue-head">
          {reorderable
            ? <button type="button" className="composer-queue-grip" aria-label={t(`拖拽调整第 ${index + 1} 条顺序；或用 Alt+↑/↓`, `Reorder message ${index + 1} by dragging, or with Alt+↑/↓`)}
              disabled={pending}
              onPointerDown={() => arm(row.id)}
              onPointerUp={() => { if (!drag) arm(null); }}
              onPointerCancel={() => arm(null)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                const beforeId = queueKeyboardBeforeId(rows, index, event.key === "ArrowUp" ? "up" : "down");
                if (beforeId !== undefined) props.onMove(row, beforeId);
              }}><GripVerticalIcon aria-hidden="true" /></button>
            : <span aria-hidden="true" className="composer-queue-grip-placeholder" />}
          <strong>{index + 1}. {statusLabels(t)[row.status]}</strong>
          <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleTimeString()}</time>
        </div>
        {editing
          ? <div className="composer-queue-edit">
            <textarea className="composer-queue-editor" value={editText} disabled={pending}
              aria-label={t("编辑排队文本", "Edit queued text")}
              onChange={event => props.onEditTextChange(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Escape") { event.preventDefault(); props.onCancelEdit(); return; }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); props.onSaveEdit(row); }
              }} />
            <div className="composer-queue-edit-actions">
              <Button type="button" size="sm" disabled={pending || !row.draft} onClick={() => props.onSaveEdit(row)}>{t("保存编辑并核对当前设置", "Save edit and confirm settings")}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => props.onCancelEdit()}>{t("取消", "Cancel")}</Button>
              <span className="composer-queue-edit-hint">{t("保存时沿用该队列的 revision，并核对当前会话设置；失败时原队列不变。", "Saving keeps this queue row's revision and rechecks current session settings; on failure the original queue stays intact.")}</span>
            </div>
          </div>
          : <p className="composer-queue-text">{textOf(row.draft, row.reason) || t("附件或引用草稿", "Attachment or quote draft")}</p>}
        {props.renderDraftDetails?.(row)}
        {row.reason && <p role="status" className="composer-queue-reason">{row.reason}</p>}
        {(row.status === "queued" || row.status === "blocked") && <div className="composer-queue-actions">
          <Button type="button" size="sm" variant="outline" disabled={pending || busy || !row.draft || (needsConfirmation && !confirmed)}
            onClick={() => props.onSend(row)}>{t("发送下一条 / 立即发送", "Send next / send now")}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending || !row.draft || editing}
            onClick={() => props.onBeginEdit(row)}>{t("编辑", "Edit")}</Button>
          {props.onEditInComposer && <Button type="button" size="sm" variant="ghost"
            disabled={pending || busy || queueEditableText(row.draft) === undefined}
            title={queueEditableText(row.draft) === undefined ? t("只有纯文字队列草稿可以在输入框编辑", "Only plain-text queued drafts can be edited in the composer") : undefined}
            onClick={() => props.onEditInComposer?.(row)}>{t("在输入框编辑", "Edit in composer")}</Button>}
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => props.onRemove(row)}>{t("移除", "Remove")}</Button>
        </div>}
        {(row.status === "unknown" || row.status === "dispatching") && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => props.onReconcile(row)}>{t("只核对派发结果", "Check dispatch only")}</Button>}
        {row.status !== "unknown" && row.status !== "dispatching" && row.status !== "queued" && row.status !== "blocked" && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => props.onRemove(row)}>{row.status === "sent" ? t("移除队列收据", "Dismiss queue receipt") : t("移除", "Remove")}</Button>}
      </li>;
    })}
  </ol>;
}

function textOf(draft: QueuedChatMessage["draft"], reason?: string): string {
  const text = draft?.message.parts.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
  return text || reason || "";
}

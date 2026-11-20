import type { ReactNode } from "react";
import { GitForkIcon, MessageSquarePlusIcon } from "lucide-react";
import { useAgentText } from "../i18n";
import "./thread-lifecycle-rows.css";

export type ThreadLifecycleParent = { threadId: string; title?: string };

/** t3code-style lifecycle dividers backed only by persisted session metadata. */
export function ThreadLifecycleRows({
  threadCreatedAt,
  parent,
  onOpenParent,
}: {
  threadCreatedAt?: string;
  parent?: ThreadLifecycleParent;
  onOpenParent?: (threadId: string) => void;
}) {
  const t = useAgentText();
  const created = threadCreatedAt ? new Date(threadCreatedAt) : undefined;
  const createdAt = created && Number.isFinite(created.getTime()) ? created.toLocaleString() : undefined;
  if (!createdAt && !parent) return null;
  const rows: ReactNode[] = [];
  if (createdAt) rows.push(<div key="created" className="thread-lifecycle-row" role="separator" aria-label={t("会话创建", "Session created")}>
    <MessageSquarePlusIcon aria-hidden="true" />
    <span>{t("会话已创建", "Session created")}</span>
    <time dateTime={threadCreatedAt}>{createdAt}</time>
  </div>);
  if (parent) {
    const label = parent.title?.trim() || t("父会话", "Parent session");
    rows.push(<div key="fork" className="thread-lifecycle-row" role="separator" aria-label={t("从父会话分叉", "Forked from parent session")}>
      <GitForkIcon aria-hidden="true" />
      <span>{t("从父会话分叉", "Forked from")}</span>
      {onOpenParent
        ? <button type="button" className="thread-lifecycle-link" title={label} onClick={() => onOpenParent(parent.threadId)}>{label}</button>
        : <span className="thread-lifecycle-parent" title={label}>{label}</span>}
    </div>);
  }
  return <div className="thread-lifecycle-rows">{rows}</div>;
}

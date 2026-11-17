import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { AlarmClock, Moon } from "lucide-react";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import "./thread-status-line.css";

/** Snoozed/settled organization state is shown inside the thread, separate from execution status. */
export function ThreadStatusLine() {
  const t = useAgentText();
  const threadId = useAuiState(state => state.threadListItem.remoteId);
  const [thread, setThread] = useState<RemoteThread>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setThread(undefined); setError(undefined);
    if (!threadId) return;
    let alive = true;
    void workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(threadId)}`)
      .then(value => { if (alive) setThread(value.thread); }, () => { /* Organization state is optional; never block the thread. */ });
    return () => { alive = false; };
  }, [threadId]);
  if (!thread || !threadId) return null;
  const section = thread.sidebar.section;
  if (section !== "settled" && section !== "snoozed") return null;
  const snoozedUntil = thread.sidebar.snoozedUntil ? new Date(thread.sidebar.snoozedUntil) : null;
  const label = section === "snoozed" && snoozedUntil && !Number.isNaN(snoozedUntil.getTime())
    ? t(`已稍后提醒至 ${snoozedUntil.toLocaleString()}`, `Snoozed until ${snoozedUntil.toLocaleString()}`)
    : t("会话已归置；运行与业务状态不受影响。", "Session is settled; execution and business state are unchanged.");
  const action = section === "snoozed" ? "wake" : "unsettle";
  const actionLabel = section === "snoozed" ? t("唤醒", "Wake") : t("取消归置", "Unsettle");
  return <div className="thread-status-line" role="status">
    {section === "snoozed" ? <AlarmClock aria-hidden="true" /> : <Moon aria-hidden="true" />}
    <span>{label}</span>
    <span aria-hidden="true">·</span>
    <button type="button" disabled={pending} onClick={() => {
      if (pending) return;
      setPending(true); setError(undefined);
      void workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(threadId)}/sidebar`, { method: "POST", body: JSON.stringify({ action, revision: thread.sidebar.revision }) })
        .then(result => setThread(result.thread), cause => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setPending(false));
    }}>{pending ? t("处理中…", "Working…") : actionLabel}</button>
    {error && <span role="alert" className="thread-status-line-error">{error}</span>}
  </div>;
}

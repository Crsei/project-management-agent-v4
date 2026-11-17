import { useEffect, useId, useState } from "react";
import { FolderOpenIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import styles from "./thread-details-panel.module.css";
import { useAgentText } from "../i18n";
import type { GitStatusResponse } from "@agent-workspace/contracts/inspector";
import { inspectUrl } from "../workspace/inspector/api";
import { workspaceClient } from "../network";
import { threadActivityPresentation, type ThreadActivity } from "./thread-activity";

export function ThreadDetailsPanel({
  open,
  onClose,
  workspaceName,
  threadId,
  threadTitle,
  activity,
  environmentLabel,
  environmentPath,
  environmentStatus,
  environmentError,
  onConfigureFiles,
  onSessionSettings,
  sessionSettingsDisabled,
}: {
  open: boolean;
  onClose: () => void;
  workspaceName?: string;
  threadId?: string;
  threadTitle?: string;
  activity?: ThreadActivity;
  environmentLabel?: string;
  environmentPath?: string;
  environmentStatus?: string;
  environmentError?: string;
  onConfigureFiles?: () => void;
  onSessionSettings: () => void;
  sessionSettingsDisabled: boolean;
}) {
  const t = useAgentText();
  const headingId = useId();
  const status = threadActivityPresentation(activity, t);
  const [branch, setBranch] = useState<string>();
  useEffect(() => {
    setBranch(undefined);
    if (!open || !threadId || !environmentPath) return;
    const controller = new AbortController();
    void workspaceClient.json<GitStatusResponse>(inspectUrl("/api/inspector/git", { threadId }), { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && result.repo && result.branch) setBranch(result.branch); })
      .catch(() => { /* Branch is informational; a missing repository stays hidden. */ });
    return () => controller.abort();
  }, [open, threadId, environmentPath]);
  if (!open) return null;

  return <section className={`pm-agent-thread-details ${styles.root}`} aria-labelledby={headingId}>
    <header className={styles.header}>
      <h2 id={headingId}>{t("会话详情", "Session details")}</h2>
      <button type="button" className={styles.close} aria-label={t("关闭会话详情", "Close session details")} title={t("关闭会话详情", "Close session details")} onClick={onClose}><XIcon aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>
      <dl className={styles.facts}>
        <div><dt>{t("工作区", "Workspace")}</dt><dd>{workspaceName || "—"}</dd></div>
        <div><dt>{t("会话", "Session")}</dt><dd>{threadTitle || "—"}</dd></div>
        <div><dt>{t("状态", "Status")}</dt><dd data-activity={status.status} data-tone={status.tone} data-priority={status.priority}>{status.label}</dd></div>
        <div><dt>{t("执行环境", "Execution environment")}</dt><dd>{environmentLabel || "—"}</dd>{environmentPath && <dd><code>{environmentPath}</code></dd>}{environmentStatus && <dd>{environmentStatus}</dd>}{environmentError && <dd role="alert" className={styles.environmentError}>{environmentError}</dd>}</div>
        {branch && <div><dt>{t("代码分支", "Code branch")}</dt><dd><code>{branch}</code></dd></div>}
      </dl>
      <div className={styles.actions} role="group" aria-label={t("会话操作", "Session actions")}>
        <button type="button" className={styles.action} disabled={!onConfigureFiles} onClick={onConfigureFiles}>
          <FolderOpenIcon aria-hidden="true" /><span className={styles.actionLabel}>{t("选择执行环境", "Select execution environment")}</span>{!onConfigureFiles && <span className={styles.unavailable}>{t("不可用", "Unavailable")}</span>}
        </button>
        <button type="button" className={styles.action} disabled={sessionSettingsDisabled} onClick={onSessionSettings}>
          <SlidersHorizontalIcon aria-hidden="true" /><span className={styles.actionLabel}>{t("当前会话参数", "Session settings")}</span>{sessionSettingsDisabled && <span className={styles.unavailable}>{t("不可用", "Unavailable")}</span>}
        </button>
      </div>
    </div>
  </section>;
}

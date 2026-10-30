import { useId } from "react";
import { FolderOpenIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import styles from "./thread-details-panel.module.css";
import { useAgentText } from "../i18n";

export function ThreadDetailsPanel({
  open,
  onClose,
  workspaceName,
  projectName,
  threadTitle,
  path,
  statusLabel,
  onConfigureFiles,
  onSessionSettings,
  sessionSettingsDisabled,
}: {
  open: boolean;
  onClose: () => void;
  workspaceName?: string;
  projectName?: string;
  threadTitle?: string;
  path?: string | null;
  statusLabel: string;
  onConfigureFiles?: () => void;
  onSessionSettings: () => void;
  sessionSettingsDisabled: boolean;
}) {
  const t = useAgentText();
  const headingId = useId();
  if (!open) return null;

  return <section className={`pm-agent-thread-details ${styles.root}`} aria-labelledby={headingId}>
    <header className={styles.header}>
      <h2 id={headingId}>{t("会话详情", "Session details")}</h2>
      <button type="button" className={styles.close} aria-label={t("关闭会话详情", "Close session details")} title={t("关闭会话详情", "Close session details")} onClick={onClose}><XIcon aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>
      <dl className={styles.facts}>
        <div><dt>{t("工作区", "Workspace")}</dt><dd>{workspaceName || "—"}</dd></div>
        <div><dt>{t("项目", "Project")}</dt><dd>{projectName || "—"}</dd></div>
        <div><dt>{t("会话", "Session")}</dt><dd>{threadTitle || "—"}</dd></div>
        <div><dt>{t("文件区域", "File area")}</dt><dd><code>{path || "—"}</code></dd></div>
        <div><dt>{t("状态", "Status")}</dt><dd>{statusLabel}</dd></div>
      </dl>
      <div className={styles.actions} role="group" aria-label={t("会话操作", "Session actions")}>
        <button type="button" className={styles.action} disabled={!onConfigureFiles} onClick={onConfigureFiles}>
          <FolderOpenIcon aria-hidden="true" /><span className={styles.actionLabel}>{t("配置文件区域", "Configure file area")}</span>{!onConfigureFiles && <span className={styles.unavailable}>{t("不可用", "Unavailable")}</span>}
        </button>
        <button type="button" className={styles.action} disabled={sessionSettingsDisabled} onClick={onSessionSettings}>
          <SlidersHorizontalIcon aria-hidden="true" /><span className={styles.actionLabel}>{t("当前会话参数", "Session settings")}</span>{sessionSettingsDisabled && <span className={styles.unavailable}>{t("不可用", "Unavailable")}</span>}
        </button>
      </div>
    </div>
  </section>;
}

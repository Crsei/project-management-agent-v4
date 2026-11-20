import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { FolderOpenIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@agent/components/ui/dialog";
import styles from "./thread-details-panel.module.css";
import { useAgentText } from "../i18n";
import type { GitStatusResponse } from "@agent-workspace/contracts/inspector";
import { inspectUrl } from "../workspace/inspector/api";
import { workspaceClient } from "../network";
import { threadActivityPresentation, type ThreadActivity } from "./thread-activity";
import { detailsDensity, detailsPresentation, scrollFade, type ScrollFade } from "./thread-details-model";
import type { RelationshipThread } from "./thread-relationships";
import { ThreadWorkspaceSection } from "./thread-workspace-section";
import { ThreadProjectScriptsSection } from "./thread-project-scripts-section";
import { ThreadAutomationSection } from "./thread-automations-section";
import { ThreadRelationshipsSection } from "./thread-relationships-section";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function ThreadDetailsPanel({
  open,
  onClose,
  embedded,
  workspaceName,
  threadId,
  threadTitle,
  activity,
  environmentLabel,
  environmentPath,
  environmentStatus,
  environmentError,
  relatedThreads,
  threadCustom,
  codeEnvironment,
  activeTerminals,
  terminalAvailable,
  automationWorkspaceId,
  automationProjectId,
  automationReturnTo,
  onOpenThread,
  onOpenFiles,
  onOpenTerminal,
  onOpenAutomation,
  onWorktreeChanged,
  onConfigureFiles,
  onSessionSettings,
  sessionSettingsDisabled,
}: {
  open: boolean;
  onClose: () => void;
  /** Embedded chat panels never own a wide column; they always overlay. */
  embedded?: boolean;
  workspaceName?: string;
  threadId?: string;
  threadTitle?: string;
  activity?: ThreadActivity;
  environmentLabel?: string;
  environmentPath?: string;
  environmentStatus?: string;
  environmentError?: string;
  relatedThreads?: ReadonlyArray<RelationshipThread>;
  threadCustom?: Record<string, unknown>;
  /** False for chat-only or unverified sessions: no worktree, scripts or file entry. */
  codeEnvironment?: boolean;
  activeTerminals?: number;
  terminalAvailable?: boolean;
  automationWorkspaceId?: string;
  automationProjectId?: string;
  automationReturnTo?: string;
  onOpenThread?: (id: string) => void;
  onOpenFiles?: () => void;
  onOpenTerminal?: () => void;
  onOpenAutomation?: (href: string) => void;
  onWorktreeChanged?: (notice?: string) => void;
  onConfigureFiles?: () => void;
  onSessionSettings: () => void;
  sessionSettingsDisabled: boolean;
}) {
  const t = useAgentText();
  const headingId = useId();
  const status = threadActivityPresentation(activity, t);
  const wide = useMediaQuery("(min-width: 1401px)");
  const presentation = detailsPresentation({ wide, embedded: !!embedded });
  const [branch, setBranch] = useState<string>();
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [fade, setFade] = useState<ScrollFade>("none");
  useEffect(() => {
    setBranch(undefined);
    if (!open || !threadId || !environmentPath) return;
    const controller = new AbortController();
    void workspaceClient.json<GitStatusResponse>(inspectUrl("/api/inspector/git", { threadId }), { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && result.repo && result.branch) setBranch(result.branch); })
      .catch(() => { /* Branch is informational; a missing repository stays hidden. */ });
    return () => controller.abort();
  }, [open, threadId, environmentPath]);
  useLayoutEffect(() => {
    if (!open) return;
    const scroll = body.current;
    const box = content.current;
    if (!scroll || !box) return;
    const measure = () => {
      setHeight(box.getBoundingClientRect().height);
      setFade(scrollFade({ scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(box);
    observer?.observe(scroll);
    scroll.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer?.disconnect();
      scroll.removeEventListener("scroll", measure);
    };
  }, [open, presentation]);
  if (!open) return null;
  const density = detailsDensity(height);

  const section = <section
    className={`pm-agent-thread-details ${styles.root}`}
    data-presentation={presentation}
    data-density={density}
    aria-labelledby={presentation === "inline" ? headingId : undefined}
  >
    <header className={styles.header}>
      {presentation === "inline"
        ? <h2 id={headingId}>{t("会话详情", "Session details")}</h2>
        : <DialogTitle className={styles.heading}>{t("会话详情", "Session details")}</DialogTitle>}
      <button type="button" className={styles.close} aria-label={t("关闭会话详情", "Close session details")} title={t("关闭会话详情", "Close session details")} onClick={onClose}><XIcon aria-hidden="true" /></button>
    </header>
    <div ref={body} className={styles.body} data-fade={fade}>
      <div ref={content} className={styles.content}>
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
        {codeEnvironment && threadId && <ThreadWorkspaceSection
          key={threadId}
          threadId={threadId}
          environmentPath={environmentPath}
          activeTerminals={activeTerminals ?? 0}
          terminalAvailable={!!terminalAvailable}
          onOpenFiles={onOpenFiles}
          onOpenTerminal={onOpenTerminal}
          onChanged={onWorktreeChanged}
        />}
        {codeEnvironment && threadId && environmentPath && <ThreadProjectScriptsSection key={`${threadId}:${environmentPath}`} threadId={threadId} environmentPath={environmentPath} />}
        <ThreadAutomationSection
          key={`${threadId ?? ""}:${automationWorkspaceId ?? ""}:${automationProjectId ?? ""}`}
          threadId={threadId}
          workspaceId={automationWorkspaceId}
          projectId={automationProjectId}
          threadCustom={threadCustom}
          returnTo={automationReturnTo}
          onOpen={onOpenAutomation}
        />
        <ThreadRelationshipsSection threadId={threadId} threads={relatedThreads ?? []} onOpenThread={onOpenThread} />
      </div>
    </div>
  </section>;

  if (presentation === "inline") return section;
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className={`pm-agent-chat-dialog ${styles.dialog}`} showCloseButton={false}>
      {section}
    </DialogContent>
  </Dialog>;
}

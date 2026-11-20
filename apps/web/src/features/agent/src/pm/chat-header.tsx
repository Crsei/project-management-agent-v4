import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, CornerUpLeftIcon, PencilIcon } from "lucide-react";
import { breadcrumbLayout, initialsTone, workspaceInitials } from "./chat-header-model";
import { WorkspaceBadge } from "./workspace-badge";
import { useAgentText } from "../i18n";
import type { Workspace } from "./state";
import styles from "./chat-header.module.css";

/**
 * Session header identity: workspace/project mark, workspace, parent session and
 * the current title. Labels collapse by measured width; the title never leaves.
 */
export function ChatBreadcrumb({
  workspace,
  mark,
  parent,
  title,
  renamable,
  onRename,
  onOpenParent,
}: {
  workspace?: { name: string; path?: string };
  mark?: { icon?: Workspace["icon"]; color?: Workspace["color"]; name?: string };
  parent?: { id: string; title?: string };
  title: string;
  renamable: boolean;
  onRename?: () => void;
  onOpenParent?: (id: string) => void;
}) {
  const t = useAgentText();
  const container = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const layout = breadcrumbLayout(width, { workspace: !!workspace?.name, parent: !!parent });
  const label = mark?.name ?? workspace?.name;
  const initials = workspaceInitials(label);
  const tone = initialsTone(label);
  const parentTitle = parent?.title?.trim() || t("父会话", "Parent session");
  const markLabel = label ? t(`项目标识：${label}`, `Project mark: ${label}`) : t("项目标识", "Project mark");

  return (
    <nav
      ref={container}
      className={styles.breadcrumb}
      data-tier={layout.tier}
      aria-label={t("当前位置", "Current location")}
    >
      {label && (
        <span className={styles.mark} role="img" aria-label={markLabel} title={markLabel}>
          {mark?.icon && mark.color
            ? <WorkspaceBadge icon={mark.icon} color={mark.color} />
            : <span className={styles.initials} data-tone={tone} aria-hidden="true">{initials}</span>}
        </span>
      )}
      <div className={styles.trail}>
        {layout.showWorkspace && workspace?.name && (
          <>
            <span className={styles.workspace} title={workspace.path ?? workspace.name}>{workspace.name}</span>
            <ChevronRightIcon className={styles.separator} aria-hidden="true" />
          </>
        )}
        {!layout.showWorkspace && workspace?.name && <span className={styles.srOnly}>{workspace.name}</span>}
        {parent && layout.showParent && (
          <>
            <button
              type="button"
              className={styles.parent}
              title={parentTitle}
              aria-label={t(`打开父会话：${parentTitle}`, `Open parent session: ${parentTitle}`)}
              onClick={() => onOpenParent?.(parent.id)}
            >
              {parentTitle}
            </button>
            <ChevronRightIcon className={styles.separator} aria-hidden="true" />
          </>
        )}
        {parent && !layout.showParent && (
          <button
            type="button"
            className={styles.parentIcon}
            title={t(`父会话：${parentTitle}`, `Parent session: ${parentTitle}`)}
            aria-label={t(`打开父会话：${parentTitle}`, `Open parent session: ${parentTitle}`)}
            onClick={() => onOpenParent?.(parent.id)}
          >
            <CornerUpLeftIcon aria-hidden="true" />
          </button>
        )}
        <strong
          className={styles.title}
          aria-current="page"
          title={renamable ? t(`${title}（双击重命名）`, `${title} (double-click to rename)`) : title}
          onDoubleClick={renamable ? onRename : undefined}
        >
          {title}
        </strong>
      </div>
      {renamable && onRename && (
        <button
          type="button"
          className={styles.rename}
          aria-label={t("重命名会话", "Rename session")}
          title={t("重命名会话", "Rename session")}
          onClick={onRename}
        >
          <PencilIcon aria-hidden="true" />
        </button>
      )}
    </nav>
  );
}

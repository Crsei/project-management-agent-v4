import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { MoreHorizontalIcon } from "lucide-react";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import type { GitStatusResponse } from "@agent-workspace/contracts/inspector";
import { workspaceClient } from "../network";
import { inspectUrl } from "../workspace/inspector/api";

type SidebarAction = "pin" | "unpin" | "settle" | "unsettle" | "snooze" | "wake" | "auto-settle" | "mark-unread" | "visit";
type MenuProps = {
  thread: RemoteThread;
  title: string;
  path?: string | null;
  disabled: boolean;
  running: boolean;
  titleUnavailable?: string;
  filtered: boolean;
  onSidebar: (action: SidebarAction, options?: { snoozedUntil?: string; enabled?: boolean }) => void;
  onRename: () => void;
  onRegenerate: () => void;
  onCustomSnooze: () => void;
  onFilter: () => void;
  onSettings: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onError: (message: string) => void;
};

function presets(now: Date) {
  const hour = 60 * 60 * 1000;
  const evening = new Date(now); evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now); nextWeek.setDate(nextWeek.getDate() + ((1 - now.getDay() + 7) % 7 || 7)); nextWeek.setHours(9, 0, 0, 0);
  return [
    { label: "1 小时后 · In 1 hour", date: new Date(now.getTime() + hour) },
    { label: "3 小时后 · In 3 hours", date: new Date(now.getTime() + 3 * hour) },
    ...(evening.getTime() - now.getTime() > hour ? [{ label: "今晚 · This evening", date: evening }] : []),
    { label: "明天 · Tomorrow", date: tomorrow },
    ...(nextWeek.getTime() !== tomorrow.getTime() ? [{ label: "下周 · Next week", date: nextWeek }] : []),
  ];
}

export function SessionMenu({ thread, title, path, disabled, running, titleUnavailable, filtered, onSidebar, onRename, onRegenerate, onCustomSnooze, onFilter, onSettings, onArchive, onDelete, onError }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState<string>();
  const sidebar = thread.sidebar;
  useEffect(() => {
    setBranch(undefined);
    if (!open || !thread.scope || !path) return;
    const controller = new AbortController();
    void workspaceClient.json<GitStatusResponse>(inspectUrl("/api/inspector/git", { workspaceId: thread.scope.workspaceId, projectId: thread.scope.projectId ?? undefined, threadId: thread.remoteId }), { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted && result.repo && result.branch) setBranch(result.branch); })
      .catch(() => {});
    return () => controller.abort();
  }, [open, thread.remoteId, thread.scope?.workspaceId, thread.scope?.projectId, path]);
  const copy = (value: string) => { void (async () => { try { await navigator.clipboard.writeText(value); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } })(); };
  const item = (label: string, action: () => void, unavailable = false) => <Menu.Item className="pm-session-menu-item" disabled={disabled || unavailable} onClick={action}>{label}</Menu.Item>;
  const submenu = (label: string, children: ReactNode, unavailable = false) => <Menu.SubmenuRoot><Menu.SubmenuTrigger className="pm-session-menu-item pm-session-sub-trigger" disabled={disabled || unavailable}>{label}<span aria-hidden>›</span></Menu.SubmenuTrigger><Menu.Portal><Menu.Positioner className="pm-session-sub-positioner" side="right" align="start" sideOffset={3}><Menu.Popup className="pm-session-menu-popup">{children}</Menu.Popup></Menu.Positioner></Menu.Portal></Menu.SubmenuRoot>;
  return <Menu.Root open={open} onOpenChange={setOpen}>
    <Menu.Trigger className="pm-agent-session-menu-trigger" aria-label={`${title}的操作`} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}><MoreHorizontalIcon /></Menu.Trigger>
    <Menu.Portal><Menu.Positioner className="pm-session-positioner" side="bottom" align="end" sideOffset={3}><Menu.Popup className="pm-session-menu-popup">
      {item(sidebar.pinnedAt ? "取消置顶 · Unpin" : "置顶 · Pin", () => onSidebar(sidebar.pinnedAt ? "unpin" : "pin"))}
      {item(sidebar.settledAt ? "取消归置 · Un-settle" : "归置 · Settle", () => onSidebar(sidebar.settledAt ? "unsettle" : "settle"))}
      {sidebar.snoozedAt ? item("唤醒 · Wake", () => onSidebar("wake")) : submenu("稍后提醒 · Snooze", <>{presets(new Date()).map(({ label, date }) => <Menu.Item key={label} className="pm-session-menu-item" onClick={() => onSidebar("snooze", { snoozedUntil: date.toISOString() })}>{label} ({date.toLocaleString()})</Menu.Item>)}<Menu.Separator className="pm-agent-menu-separator" />{item("自定义时间… · Custom", onCustomSnooze)}</>, !sidebar.canSnooze)}
      <Menu.Separator className="pm-agent-menu-separator" />
      {item("重命名 · Rename", onRename)}
      {item("重新生成标题 · Regenerate title", onRegenerate, !!titleUnavailable)}
      {titleUnavailable && <div className="pm-session-menu-explanation">{titleUnavailable}</div>}
      {item("标为未读 · Mark unread", () => onSidebar("mark-unread"))}
      {thread.scope?.projectId && item(filtered ? "显示所有项目 · Show all projects" : "仅显示此项目 · Filter by project", onFilter)}
      {submenu("自动归置 · Auto-settle", <><div className="pm-session-menu-explanation">未活动 3 天后自动归置；置顶、运行中、等待请求及稍后提醒的会话除外。手动取消归置后，需有新活动才会再次自动归置。</div>{item(`${sidebar.autoSettle ? "✓ " : ""}启用 · Enabled`, () => onSidebar("auto-settle", { enabled: true }))}{item(`${!sidebar.autoSettle ? "✓ " : ""}停用 · Disabled`, () => onSidebar("auto-settle", { enabled: false }))}</>)}
      <Menu.Separator className="pm-agent-menu-separator" />
      {submenu("复制 · Copy", <>{path && item("路径 · Path", () => copy(path))}{branch && item("分支 · Branch", () => copy(branch))}{item("会话 ID · Thread ID", () => copy(thread.remoteId))}</>)}
      {item("项目设置 · Project settings", onSettings, !thread.scope)}
      <Menu.Separator className="pm-agent-menu-separator" />
      {item("归档会话 · Archive", onArchive, running || sidebar.running)}
      <Menu.Item className="pm-session-menu-item pm-session-menu-danger" disabled={disabled} onClick={onDelete}>删除会话 · Delete</Menu.Item>
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreHorizontalIcon } from "lucide-react";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import type { GitStatusResponse } from "@agent-workspace/contracts/inspector";
import { workspaceClient } from "../network";
import { useAgentText, type AgentText } from "../i18n";
import { inspectUrl } from "../workspace/inspector/api";

type SidebarAction = "pin" | "unpin" | "settle" | "unsettle" | "snooze" | "wake" | "auto-settle" | "mark-unread" | "visit";
type MenuProps = {
  thread: RemoteThread;
  title: string;
  path?: string | null;
  disabled: boolean;
  running: boolean;
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

function presets(now: Date, t: AgentText) {
  const hour = 60 * 60 * 1000;
  const evening = new Date(now); evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now); nextWeek.setDate(nextWeek.getDate() + ((1 - now.getDay() + 7) % 7 || 7)); nextWeek.setHours(9, 0, 0, 0);
  return [
    { label: t("1 小时后", "In 1 hour"), date: new Date(now.getTime() + hour) },
    { label: t("3 小时后", "In 3 hours"), date: new Date(now.getTime() + 3 * hour) },
    ...(evening.getTime() - now.getTime() > hour ? [{ label: t("今晚", "This evening"), date: evening }] : []),
    { label: t("明天", "Tomorrow"), date: tomorrow },
    ...(nextWeek.getTime() !== tomorrow.getTime() ? [{ label: t("下周", "Next week"), date: nextWeek }] : []),
  ];
}

export function SessionMenu({ thread, title, path, disabled, running, filtered, onSidebar, onRename, onRegenerate, onCustomSnooze, onFilter, onSettings, onArchive, onDelete, onError }: MenuProps) {
  const t = useAgentText();
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
  const item = (label: string, action: () => void, unavailable = false) => <DropdownMenuItem className="pm-session-menu-item" disabled={disabled || unavailable} onClick={action}>{label}</DropdownMenuItem>;
  const submenu = (label: string, children: ReactNode, unavailable = false) => <DropdownMenuSub><DropdownMenuSubTrigger className="pm-session-menu-item pm-session-sub-trigger" disabled={disabled || unavailable}>{label}</DropdownMenuSubTrigger><DropdownMenuSubContent className="pm-session-menu-popup" sideOffset={3}>{children}</DropdownMenuSubContent></DropdownMenuSub>;
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger className="pm-agent-session-menu-trigger" aria-label={t(`${title}的操作`, `${title} actions`)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}><MoreHorizontalIcon /></DropdownMenuTrigger>
    <DropdownMenuContent className="pm-session-menu-popup" side="bottom" align="start" sideOffset={6}>
      {item(sidebar.pinnedAt ? t("取消置顶", "Unpin") : t("置顶", "Pin"), () => onSidebar(sidebar.pinnedAt ? "unpin" : "pin"))}
      {item(sidebar.settledAt ? t("取消归置", "Un-settle") : t("归置", "Settle"), () => onSidebar(sidebar.settledAt ? "unsettle" : "settle"))}
      {sidebar.snoozedAt ? item(t("唤醒", "Wake"), () => onSidebar("wake")) : submenu(t("稍后提醒", "Snooze"), <>{presets(new Date(), t).map(({ label, date }) => <DropdownMenuItem key={label} className="pm-session-menu-item" onClick={() => onSidebar("snooze", { snoozedUntil: date.toISOString() })}>{label} ({date.toLocaleString()})</DropdownMenuItem>)}<DropdownMenuSeparator className="pm-agent-menu-separator" />{item(t("自定义时间…", "Custom…"), onCustomSnooze)}</>, !sidebar.canSnooze)}
      <DropdownMenuSeparator className="pm-agent-menu-separator" />
      {item(t("重命名", "Rename"), onRename)}
      {item(t("重新生成标题", "Regenerate title"), onRegenerate)}
      {item(t("标为未读", "Mark unread"), () => onSidebar("mark-unread"))}
      {thread.scope?.projectId && item(filtered ? t("显示所有项目", "Show all projects") : t("仅显示此项目", "Filter by project"), onFilter)}
      {submenu(t("自动归置", "Auto-settle"), <>{item(`${sidebar.autoSettle ? "✓ " : ""}${t("启用", "Enabled")}`, () => onSidebar("auto-settle", { enabled: true }))}{item(`${!sidebar.autoSettle ? "✓ " : ""}${t("停用", "Disabled")}`, () => onSidebar("auto-settle", { enabled: false }))}</>)}
      <DropdownMenuSeparator className="pm-agent-menu-separator" />
      {submenu(t("复制", "Copy"), <>{path && item(t("路径", "Path"), () => copy(path))}{branch && item(t("分支", "Branch"), () => copy(branch))}{item(t("会话 ID", "Thread ID"), () => copy(thread.remoteId))}</>)}
      {item(t("项目设置", "Project settings"), onSettings, !thread.scope)}
      <DropdownMenuSeparator className="pm-agent-menu-separator" />
      {item(t("归档会话", "Archive"), onArchive, running || sidebar.running)}
      <DropdownMenuItem className="pm-session-menu-item pm-session-menu-danger" disabled={disabled} onClick={onDelete}>{t("删除会话", "Delete")}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

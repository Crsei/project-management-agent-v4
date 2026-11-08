import { Link } from "react-router-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Bot, Check, ChevronsUpDown, FolderKanban, Loader2 } from "lucide-react";
import { useAgentText } from "../i18n";

export function ProductSwitcher({ pending, canLeave, pmHref }: { pending: boolean; canLeave: () => boolean; pmHref: string }) {
  const t = useAgentText();
  return <DropdownMenu><DropdownMenuTrigger className="pm-agent-switcher-trigger" aria-label={t("切换应用 · Agent Chat", "Switch app · Agent Chat")} aria-busy={pending} disabled={pending}>
    <span className="pm-agent-app-icon"><Bot aria-hidden="true" /></span><span className="pm-agent-switcher-text"><span className="pm-agent-switcher-name">Agent Chat</span><span className="pm-agent-switcher-desc">{pending ? t("请等待当前操作完成", "Wait for the current operation") : t("文件夹和会话", "Folders and sessions")}</span></span>{pending ? <Loader2 className="pm-agent-switcher-chevron animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ChevronsUpDown className="pm-agent-switcher-chevron" aria-hidden="true" />}
  </DropdownMenuTrigger><DropdownMenuContent className="pm-agent-switcher-menu" side="bottom" align="start" sideOffset={6}>
    <DropdownMenuItem className="pm-agent-menu-item" disabled><Bot /><span className="pm-agent-menu-text"><strong>Agent Chat</strong></span><Check /></DropdownMenuItem>
    <DropdownMenuItem className="pm-agent-menu-item" render={<Link to={pmHref} data-automation-leave-guarded="true" onClick={event => { if (!canLeave()) event.preventDefault(); }} />}><FolderKanban /><span className="pm-agent-menu-text"><strong>Project Management</strong><small>{t("项目、任务和计划", "Projects, tasks and plans")}</small></span></DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
}

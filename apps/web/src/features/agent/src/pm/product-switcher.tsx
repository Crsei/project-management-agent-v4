import { Link } from "react-router-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Bot, Check, ChevronsUpDown, Columns3, FolderKanban, Loader2 } from "lucide-react";
import { useAgentText } from "../i18n";

export function ProductSwitcher({ pending, canLeave, pmHref, runHref = "/agent/runs", product = "chat", chatHref = "/agent/workspace" }: { pending: boolean; canLeave: () => boolean; pmHref: string; runHref?: string; product?: "chat" | "runs"; chatHref?: string }) {
  const t = useAgentText();
  const productName = product === "runs" ? t("运行面板", "Run board") : "Agent Chat";
  return <DropdownMenu><DropdownMenuTrigger className="pm-agent-switcher-trigger" aria-label={t(`切换应用 · ${productName}`, `Switch app · ${productName}`)} aria-busy={pending} disabled={pending}>
    <span className="pm-agent-app-icon">{product === "runs" ? <Columns3 aria-hidden="true" /> : <Bot aria-hidden="true" />}</span><span className="pm-agent-switcher-text"><span className="pm-agent-switcher-name">{productName}</span><span className="pm-agent-switcher-desc">{pending ? t("请等待当前操作完成", "Wait for the current operation") : t("文件夹和会话", "Folders and sessions")}</span></span>{pending ? <Loader2 className="pm-agent-switcher-chevron animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ChevronsUpDown className="pm-agent-switcher-chevron" aria-hidden="true" />}
  </DropdownMenuTrigger><DropdownMenuContent className="pm-agent-switcher-menu" side="bottom" align="start" sideOffset={6}>
    <DropdownMenuItem className="pm-agent-menu-item" data-current={product === "chat" || undefined} disabled={product === "chat"} render={product === "runs" ? <Link to={chatHref} data-automation-leave-guarded="true" onClick={event => { if (!canLeave()) event.preventDefault(); }} /> : undefined}><Bot /><span className="pm-agent-menu-text"><strong>Agent Chat</strong></span>{product === "chat" && <Check />}</DropdownMenuItem>
    <DropdownMenuItem className="pm-agent-menu-item" data-current={product === "runs" || undefined} disabled={product === "runs"} render={product === "chat" ? <Link to={runHref} data-automation-leave-guarded="true" onClick={event => { if (!canLeave()) event.preventDefault(); }} /> : undefined}><Columns3 /><span className="pm-agent-menu-text"><strong>{t("运行面板", "Run board")}</strong><small>{t("业务执行与独立会话活动", "Business Runs and independent Session activity")}</small></span>{product === "runs" && <Check />}</DropdownMenuItem>
    <DropdownMenuItem className="pm-agent-menu-item" render={<Link to="/agent/agents" data-automation-leave-guarded="true" onClick={event => { if (!canLeave()) event.preventDefault(); }} />}><Bot /><span className="pm-agent-menu-text"><strong>Agents / Teams</strong><small>{t("配置、不可变版本与协作策略", "Definitions, immutable versions and collaboration")}</small></span></DropdownMenuItem>
    <DropdownMenuItem className="pm-agent-menu-item" render={<Link to={pmHref} data-automation-leave-guarded="true" onClick={event => { if (!canLeave()) event.preventDefault(); }} />}><FolderKanban /><span className="pm-agent-menu-text"><strong>Project Management</strong><small>{t("项目、任务和计划", "Projects, tasks and plans")}</small></span></DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
}

import { Link, useParams, useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { MemberAvatar } from "./people-components"
import { useMemberDirectory, useMemberInvitations } from "./pm-member-hooks"
import { MemberInvitationForm } from "./pm-member-editors"
import { useTeamDirectory, useTeamWorkload } from "./pm-team-hooks"
import type { TeamEditorSelection } from "./pm-team-editors"
import { usePmCommand, usePmService } from "./pm-service"
import { allowed, useText } from "./pm-ui"

const sections = ["overview", "members", "projects", "work", "settings"] as const
export function PeopleTeamDetail({ teamId, onEdit }: { teamId: string; onEdit: (mode: TeamEditorSelection["mode"]) => void }) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const { workspace } = usePmService()
  const [params, setParams] = useSearchParams()
  const section = sections.find(value => value === params.get("section")) ?? "overview"
  const directory = useTeamDirectory()
  const members = useMemberDirectory()
  const workload = useTeamWorkload(section === "work")
  const invitations = useMemberInvitations()
  const command = usePmCommand()
  const team = !directory.error ? directory.data?.teams.find(item => item.id === teamId) : undefined
  const canManage = allowed(workspace, "access.manage") && directory.data?.canManage === true && !directory.error
  const locked = !canManage || command.pending || !!command.unknownCommand
  const root = `/pm/${encodeURIComponent(workspaceSlug)}`
  const workScope = params.get("workScope") === "projects" ? "projects" : "members"
  const change = (key: string, value: string) => { const next = new URLSearchParams(params); next.set(key, value); setParams(next) }
  const tasks = team && !workload.error ? workload.data?.tasks.filter(task => workScope === "projects" ? team.projectIds.includes(task.projectId) : task.assigneeId !== null && team.data.memberIds.includes(task.assigneeId)) : undefined
  const titles = { overview: t("概览", "Overview"), members: t("成员", "Members"), projects: t("项目", "Projects"), work: t("工作", "Work"), settings: t("设置", "Settings") }
  return <section className="min-h-0 flex-1 overflow-auto p-4 sm:p-6" data-pm-team-detail={teamId}>
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-xl font-semibold">{team?.data.name ?? t("团队详情", "Team detail")}</h2>{team?.data.archivedAt && <p className="mt-1 text-sm">{t("已归档 · 保留历史，不授予权限", "Archived · History retained, no access granted")}</p>}</div><Link className="text-sm underline" to={`${root}/members?tab=teams${team?.data.archivedAt ? "&archive=archived" : ""}`}>{t("返回团队目录", "Back to teams")}</Link></header>
    {directory.isPending && <p role="status">{t("正在读取团队…", "Reading team…")}</p>}{directory.error && <div role="alert"><p>{directory.error.message}</p><Button variant="outline" onClick={() => { void directory.refetch() }}>{t("重新读取", "Read again")}</Button></div>}{!directory.isPending && !directory.error && !team && <p role="status">{t("该团队不存在或当前不可见。", "This team does not exist or is not currently visible.")}</p>}
    {team && <><Tabs value={section} onValueChange={value => change("section", String(value))}><TabsList activateOnFocus={false} className="mb-5 max-w-full overflow-x-auto" aria-label={t("团队详情导航", "Team detail navigation")}>{sections.map(value => <TabsTab key={value} value={value}>{titles[value]}</TabsTab>)}</TabsList></Tabs>
      <div className="space-y-5" aria-label={titles[section]}>
        {section === "overview" && <><p className="whitespace-pre-wrap break-words text-sm">{team.data.description || t("未填写团队说明。", "No team description provided.")}</p><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 break-words text-sm"><dt>{t("标识", "Identifier")}</dt><dd>{team.data.identifier || t("未提供", "Unavailable")}</dd><dt>{t("工作方向", "Focus")}</dt><dd>{team.data.focus || t("未提供", "Unavailable")}</dd><dt>{t("响应目标", "Response target")}</dt><dd>{team.data.responseTargetHours == null ? t("未知", "Unknown") : `${team.data.responseTargetHours} h`}</dd><dt>{t("可见成员", "Visible members")}</dt><dd>{team.data.memberIds.length}</dd><dt>{t("关联项目", "Linked projects")}</dt><dd>{team.projectIds.length}</dd><dt>{t("关联项目开放工作", "Open work in linked projects")}</dt><dd>{team.openWorkCount ?? t("未知", "Unknown")}</dd><dt>{t("记录更新时间", "Record updated")}</dt><dd><time dateTime={team.updatedAt}>{new Date(team.updatedAt).toLocaleString()}</time></dd></dl><p className="text-xs text-muted-foreground">{t("人类团队只组织协作，不是 AI Team，不授予项目访问。响应目标仅为配置，不表示已启用计时或 SLA。", "Human teams organize collaboration; they are not AI Teams and grant no project access. Response targets are configuration, not an active SLA.")}{!team.scopeComplete && ` ${t("统计仅覆盖当前可见范围，不是工作区总量。", "Counts cover visible scope, not workspace totals.")}`}</p></>}
        {section === "members" && <>
          {members.error && <div role="alert"><p>{members.error.message}</p><Button variant="outline" onClick={() => { void members.refetch() }}>{t("重新读取成员", "Read members again")}</Button></div>}
          {members.isPending && <p role="status">{t("正在读取成员…", "Reading members…")}</p>}
          {members.data && !members.error && <ul className="divide-y">{team.data.memberIds.map(id => {
            const member = members.data?.members.find(item => item.userId === id)
            return <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-3">{member ? <MemberAvatar member={member} workspaceSlug={workspaceSlug} showName /> : <span className="text-sm">{t("身份不可用", "Identity unavailable")}</span>}<span className="text-xs text-muted-foreground">{team.data.maintainerIds.includes(id) ? t("维护者（不增加权限）", "Maintainer (no additional access)") : t("成员", "Member")}</span></li>
          })}{team.data.memberIds.length === 0 && <li className="text-sm">{t("没有当前可见成员。", "No currently visible members.")}</li>}</ul>}
          {canManage && !team.data.archivedAt && <Button variant="outline" disabled={locked || !members.data || !!members.error} onClick={() => onEdit("members")}>{t("管理成员与维护者", "Manage members and maintainers")}</Button>}
          {canManage && !team.data.archivedAt && <section className="space-y-3 border-t pt-4"><h3 className="font-medium">{t("邀请加入此团队", "Invite to this team")}</h3><p className="text-sm text-muted-foreground">{t("邀请接受后加入此团队。团队选择本身不授予项目权限。", "The invitee joins this team after acceptance. Team selection itself grants no project access.")}</p>{invitations.error && <p role="alert">{invitations.error.message}</p>}<MemberInvitationForm defaultTeamIds={[team.id]} disabled={locked || !invitations.data || !!invitations.error} enabled={invitations.data?.enabled === true} onInvited={() => { void invitations.refetch() }} /></section>}
        </>}
        {section === "projects" && <><p className="text-sm text-muted-foreground">{t("关联团队、显式参与者与访问授权是独立关系。", "Team associations, explicit participants and access grants are independent.")}</p><ul className="space-y-3">{team.projectIds.map(id => <li key={id}><Link className="text-sm underline" to={`${root}/projects/${encodeURIComponent(id)}/overview`}>{directory.data?.projects.find(project => project.id === id)?.name ?? id}</Link></li>)}{team.projectIds.length === 0 && <li className="text-sm">{t("没有可见关联项目。", "No visible associated projects.")}</li>}</ul>{canManage && !team.data.archivedAt && <Button variant="outline" disabled={locked} onClick={() => onEdit("projects")}>{t("维护项目关联", "Manage project associations")}</Button>}</>}
        {section === "work" && <><Tabs value={workScope} onValueChange={value => change("workScope", String(value))}><TabsList activateOnFocus={false} className="max-w-full overflow-x-auto" aria-label={t("团队工作统计口径", "Team work definition")}><TabsTab value="members">{t("团队成员负责的任务", "Tasks assigned to team members")}</TabsTab><TabsTab value="projects">{t("团队关联项目的任务", "Tasks in team-linked projects")}</TabsTab></TabsList></Tabs><p className="text-sm text-muted-foreground">{workScope === "members" ? t("按当前团队成员作为单一负责人筛选，跨当前授权项目；不要求项目关联此团队。", "Single-assignee tasks of current team members across authorized projects, whether or not those projects link this team.") : t("按当前关联项目筛选，包含其他成员与未分配任务；不表示任务分配给整个团队。", "All tasks in associated projects, including other assignees and unassigned tasks; these tasks are not assigned to the whole team.")}</p>{workload.isPending && <p role="status">{t("读取真实工作…", "Reading work…")}</p>}{workload.error && <div role="alert"><p>{workload.error.message}</p><Button variant="outline" onClick={() => { void workload.refetch() }}>{t("重新读取工作", "Read work again")}</Button></div>}{workload.data && !workload.error && <p className="text-xs text-muted-foreground">{t("仅当前可见范围；估算单位为并行未完成工作点，不是周工时。", "Visible scope only; estimates measure concurrent unfinished work points, not weekly hours.")}{!workload.data.scope.complete && ` ${t("范围不完整。", "Scope is incomplete.")}`}</p>}{tasks && <ul className="divide-y">{tasks.map(task => <li key={task.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><Link className="break-words underline" to={`${root}/projects/${encodeURIComponent(task.projectId)}/entities/${encodeURIComponent(task.id)}`}>{task.title}</Link><span>{task.status} · {task.estimatePoints ?? t("估算未知", "Estimate unknown")}</span></li>)}{!tasks.length && <li className="text-sm">{t("该口径下没有可见任务。", "No visible tasks under this definition.")}</li>}</ul>}</>}
        {section === "settings" && <><p className="text-sm text-muted-foreground">{t("所有修改使用当前版本与原命令核对；归档和恢复不授予或撤销任何访问。", "Changes use version checks and original command reconciliation. Archiving and restoring neither grant nor revoke access.")}</p>{!canManage && <p role="status">{t("仅整个工作区管理员可修改团队。", "Only workspace-wide administrators can change this team.")}</p>}<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={locked || !!team.data.archivedAt} onClick={() => onEdit("details")}>{t("编辑团队资料", "Edit team details")}</Button><Button variant="outline" disabled={locked} onClick={() => onEdit(team.data.archivedAt ? "restore" : "archive")}>{team.data.archivedAt ? t("恢复团队", "Restore team") : t("归档团队", "Archive team")}</Button></div></>}
      </div>
    </>}
  </section>
}

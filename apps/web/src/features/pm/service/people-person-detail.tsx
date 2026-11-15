import { useState } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import type { MemberDirectoryMember } from "@contracts"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { MemberIdentityCard, MemberStatus } from "./people-components"
import { MemberLifecycleDialog } from "./member-lifecycle-dialog"
import { useMemberDirectory } from "./pm-member-hooks"
import { useTeamDirectory, useTeamWorkload } from "./pm-team-hooks"
import { usePmService } from "./pm-service"
import { allowed, useText } from "./pm-ui"

export function PeoplePersonDetail({ userId, onEditSelf, onManage }: { userId: string; onEditSelf: () => void; onManage: (member: MemberDirectoryMember) => void }) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const { workspace, actor } = usePmService()
  const [params, setParams] = useSearchParams()
  const [lifecycleOpen, setLifecycleOpen] = useState(false)
  const members = useMemberDirectory()
  const workload = useTeamWorkload()
  const teams = useTeamDirectory()
  const member = !members.error ? members.data?.members.find(item => item.userId === userId) : undefined
  const root = `/pm/${encodeURIComponent(workspaceSlug)}`
  const full = params.get("presentation") !== "drawer"
  const close = () => { const next = new URLSearchParams(params); next.delete("person"); next.delete("presentation"); setParams(next) }
  const tasks = !workload.error ? workload.data?.tasks.filter(task => task.assigneeId === userId) : undefined
  const capacity = !workload.error ? workload.data?.members.find(item => item.userId === userId) : undefined
  const canManage = allowed(workspace, "access.manage") && members.data?.capabilities.canManageMembers === true && !members.error
  const projectIds = [...new Set(tasks?.map(task => task.projectId) ?? [])]
  const content = <div className="space-y-6">
    {members.isPending && <p role="status">{t("正在读取成员资料…", "Reading member profile…")}</p>}
    {members.error && <div role="alert"><p>{members.error.message}</p><Button variant="outline" onClick={() => { void members.refetch() }}>{t("重新读取资料", "Read profile again")}</Button></div>}
    {!members.isPending && !members.error && !member && <p role="status">{t("该成员不可见或已不在当前目录。不会显示旧资料。", "This member is unavailable in your current directory. No old profile is displayed.")}</p>}
    {member && <>
      <MemberIdentityCard member={member} workspaceSlug={workspaceSlug}><MemberStatus status={member.access ? member.access.revokedAt ? "revoked" : "active" : "unknown"} /><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 break-words text-sm"><dt>{t("姓名", "Name")}</dt><dd>{member.name}</dd><dt>{t("职位", "Job title")}</dt><dd>{member.jobTitle || t("未提供", "Unavailable")}</dd><dt>{t("邮箱", "Email")}</dt><dd>{member.email || t("未公开或未提供", "Private or unavailable")}</dd><dt>{t("电话", "Phone")}</dt><dd>{member.phone || t("未公开或未提供", "Private or unavailable")}</dd><dt>{t("加入时间", "Joined")}</dt><dd><time dateTime={member.joinedAt}>{new Date(member.joinedAt).toLocaleDateString()}</time></dd><dt>{t("角色", "Role")}</dt><dd>{member.role === "unknown" ? t("未公开", "Private") : member.role}</dd><dt>{t("双重验证", "Two-factor authentication")}</dt><dd>{t("无可信状态来源", "No authoritative status source")}</dd></dl>
        {member.access && <details className="text-sm"><summary>{t("当前可见授权", "Visible access grants")}</summary><p className="mt-2 break-words">{member.access.capabilities.join(" · ") || t("无能力授权", "No capability grants")}</p><p>{member.access.projectIds === null ? t("整个工作区", "Entire workspace") : member.access.projectIds.join(" · ") || t("无项目访问", "No project access")}</p></details>}
      </MemberIdentityCard>
      <div className="flex flex-wrap gap-2">{member.isSelf && <Button variant="outline" disabled={!members.data?.capabilities.canEditSelfProfile} onClick={onEditSelf}>{t("编辑本人资料", "Edit my profile")}</Button>}{canManage && <Button variant="outline" onClick={() => onManage(member)}>{t("管理访问", "Manage access")}</Button>}{(member.userId === actor?.id || canManage) && <Button variant="outline" onClick={() => setLifecycleOpen(true)}>{member.isSelf ? t("离开与职责交接", "Leave and hand over") : t("移除与职责交接", "Remove and hand over")}</Button>}<Link className="inline-flex items-center text-sm underline" to={`${root}/members?tab=workload&memberId=${encodeURIComponent(userId)}`}>{t("查看工作量", "View workload")}</Link></div>
      <section className="space-y-2"><h3 className="font-medium">{t("团队", "Teams")}</h3><p className="text-xs text-muted-foreground">{t("团队组织关系不授予访问权限，也不是 AI Team。", "Human team membership grants no access and is distinct from AI Teams.")}</p>{member.teams.length ? <ul className="flex flex-wrap gap-3">{member.teams.map(team => <li key={team.id}><Link className="text-sm underline" to={`${root}/members?tab=teams&team=${encodeURIComponent(team.id)}&section=overview`}>{team.name}</Link></li>)}</ul> : <p className="text-sm">{t("当前没有可见团队。", "No visible teams.")}</p>}</section>
      <section className="space-y-3"><h3 className="font-medium">{t("当前可见工作", "Currently visible work")}</h3>{workload.isPending && <p role="status">{t("读取工作量…", "Reading workload…")}</p>}{workload.error && <div role="alert"><p>{workload.error.message}</p><Button variant="outline" onClick={() => { void workload.refetch() }}>{t("重新读取工作", "Read work again")}</Button></div>}{capacity && <p className="text-sm">{t(`开放 ${capacity.openCount} · 已完成 ${capacity.doneCount} · 已知并行估算 ${capacity.knownOpenPoints} 点 · 缺估算 ${capacity.unknownEstimateCount}`, `Open ${capacity.openCount} · Done ${capacity.doneCount} · Known concurrent estimate ${capacity.knownOpenPoints} points · Missing estimates ${capacity.unknownEstimateCount}`)} · {t("容量", "Capacity")} {capacity.capacityPoints ?? t("未知", "Unknown")}</p>}{workload.data && !workload.error && <p className="text-xs text-muted-foreground">{t("并行未完成工作估算点，不是周工时。仅当前授权项目；子任务与父任务按真实记录列出，不将任务负责人当作项目参与授权。", "Concurrent unfinished-work estimate points, not weekly hours. Only authorized projects; tasks and subtasks reflect actual records. Assignment is not project access.")}{!workload.data.scope.complete && ` ${t("当前范围不完整。", "The current scope is incomplete.")}`}</p>}{tasks && <ul className="divide-y">{tasks.map(task => <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><Link className="min-w-0 break-words underline" to={`${root}/projects/${encodeURIComponent(task.projectId)}/entities/${encodeURIComponent(task.id)}`}>{task.title}</Link><span className="text-muted-foreground">{task.status} · {task.estimatePoints ?? t("估算未知", "Estimate unknown")}</span></li>)}{tasks.length === 0 && <li className="text-sm">{t("当前可见范围没有分配给该成员的工作。", "No assigned work in the visible scope.")}</li>}</ul>}</section>
      <section className="space-y-2"><h3 className="font-medium">{t("工作所属项目", "Projects containing assigned work")}</h3><p className="text-xs text-muted-foreground">{t("由当前可见任务推导，不代表显式参与名单或完整项目权限。", "Derived from visible assignments, not explicit participation or complete access grants.")}</p>{teams.error && <p role="alert">{teams.error.message}</p>}{tasks && <ul className="space-y-2">{projectIds.map(id => <li key={id}><Link className="text-sm underline" to={`${root}/projects/${encodeURIComponent(id)}/overview`}>{!teams.error && teams.data?.projects.find(project => project.id === id)?.name || id}</Link></li>)}{!projectIds.length && <li className="text-sm">{t("没有由当前工作推导的项目。", "No projects derived from current work.")}</li>}</ul>}</section>
    </>}
    <MemberLifecycleDialog userId={userId} open={lifecycleOpen && !!member} onOpenChange={setLifecycleOpen} onCompleted={() => { void members.refetch(); void workload.refetch(); void teams.refetch() }} />
  </div>
  return full ? <section className="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><header className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">{member?.name ?? t("成员资料", "Member profile")}</h2><Button variant="outline" onClick={close}>{t("返回成员目录", "Back to members")}</Button></header>{content}</section> : <Sheet open onOpenChange={open => { if (!open) close() }}><SheetContent side="right" size={640} className="overflow-y-auto p-5 sm:p-6"><SheetTitle className="pr-8 text-lg font-semibold">{member?.name ?? t("成员资料", "Member profile")}</SheetTitle><SheetDescription className="mb-4 text-sm text-muted-foreground">{t("真实资料按当前授权脱敏。", "Actual profile data, redacted to current access.")}</SheetDescription><Link className="mb-4 inline-block text-sm underline" to={`${root}/members?person=${encodeURIComponent(userId)}`}>{t("打开完整资料页", "Open full profile")}</Link>{content}</SheetContent></Sheet>
}

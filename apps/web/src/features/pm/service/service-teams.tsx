import { useEffect, useRef, useState } from "react"
import { RefreshCw, X } from "lucide-react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useWorkspaceStore } from "@/providers/app-providers"
import { TeamCollectionView } from "@/views/pm/team-collection"
import type { PmControlledData } from "@/views/pm/controlled-contracts"
import type { TeamCollectionInteraction, TeamCollectionViewProps } from "@/views/pm/people-controlled-contracts"
import { copyText } from "@/views/pm/people-controller"
import { usePmCommand, usePmService } from "./pm-service"
import { CommandNotice, ServiceGuard, allowed, queryData, useDraftState, useText } from "./pm-ui"
import { useTeamDirectory, useTeamWorkload } from "./pm-team-hooks"
import { useMemberDirectory } from "./pm-member-hooks"
import { directoryMemberRecord, memberRoleValues } from "./pm-member-model"
import { TeamEditorDialog, type TeamEditorSelection } from "./pm-team-editors"
import { directoryTeams, teamProjectRecord, teamRecord, workloadProjection } from "./pm-team-model"
import { TeamMemberTaskActions, TeamTaskEstimateEditor } from "./team-task-actions"
import { teamFilterConditions, teamMatchesConditions, withSingleTeamFields } from "@/views/pm/team-filter"

export function ServiceTeams({ variant }: { variant: "team1" | "team3" }) {
  return <ServiceGuard><TeamsSurface key={variant} variant={variant} /></ServiceGuard>
}

function TeamsSurface({ variant }: { variant: "team1" | "team3" }) {
  const { workspace, capabilities } = usePmService()
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode)
  const teamsQuery = useTeamDirectory(variant === "team1")
  const membersQuery = useMemberDirectory()
  const workloadQuery = useTeamWorkload(variant === "team3")
  const command = usePmCommand()
  const navigate = useNavigate()
  const location = useLocation()
  const { workspaceSlug } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const memberId = variant === "team3" ? searchParams.get("memberId") || null : null
  const teamId = variant === "team3" ? searchParams.get("teamId") || null : null
  const t = useText()
  const root = workspaceSlug ? `/pm/${encodeURIComponent(workspaceSlug)}` : "/pm"
  const [interaction, setInteraction] = useDraftState<TeamCollectionInteraction>(`teams:${variant}`, "interaction", {
    query: "", sort: "name", display: variant === "team1" ? "table" : "cards", tab: variant === "team3" ? "workload" : "directory", teamId: null, selectedIds: [], selectedId: null, detailOpen: false, detailTab: "overview", expandedIds: [], selectedMemberId: null, memberDetailOpen: false, workloadStateFilter: "all", presenceFilter: "all", focusFilter: null,
  })
  const [editor, setEditor] = useDraftState<TeamEditorSelection | null>("teams", "editor", () => {
    const original = command.unknownCommand
    if (!original) return null
    if (original.commandType === "CreateProjectTeam") return { id: null, mode: "details" }
    if (!original.targetId) return null
    if (original.commandType === "UpdateProjectTeamDetails" || original.commandType === "RenameProjectTeam") return { id: original.targetId, mode: "details" }
    if (original.commandType === "SetProjectTeamMembers" || original.commandType === "SetProjectTeamMaintainers") return { id: original.targetId, mode: "members" }
    if (original.commandType === "ArchiveProjectTeam") return { id: original.targetId, mode: "archive" }
    return null
  })
  const [estimateTaskId, setEstimateTaskId] = useDraftState<string | null>("teams-workload", "estimateTaskId", null)
  const trigger = useRef<HTMLElement | null>(null)
  const [copyReceipt, setCopyReceipt] = useState<TeamCollectionViewProps["readModel"]["copyReceipt"]>(null)
  const allMembers = (membersQuery.data?.members ?? []).map(member => directoryMemberRecord(member, workspace?.ownerId, membersQuery.estimatedServerNow, membersQuery.data!.presenceTtlMs))
  const teams = (teamsQuery.data?.teams ?? []).filter(team => !team.data.archivedAt).map(teamRecord)
  const teamOptions = directoryTeams(allMembers, teams)
  for (const summary of workloadQuery.data?.teams ?? []) {
    if (!teamOptions.some(team => team.id === summary.id)) teamOptions.push({ id: summary.id, name: summary.name, description: "", identifier: null, focus: null, responseTarget: null, activityAt: null, openWorkCount: null, members: [], projectIds: [], version: "", scopeComplete: false })
  }
  const projects = (teamsQuery.data?.projects ?? []).map(teamProjectRecord)
  const expandedInitially = useRef(false)
  useEffect(() => {
    const snapshot = workloadQuery.data
    if (expandedInitially.current || !snapshot) return
    expandedInitially.current = true
    setInteraction(previous => previous.expandedIds.length ? previous : { ...previous, expandedIds: snapshot.members.map(member => member.userId) })
  }, [workloadQuery.data, setInteraction])
  const refresh = () => {
    if (variant === "team1") void teamsQuery.refetch()
    void membersQuery.refetch()
    if (variant === "team3") void workloadQuery.refetch()
  }
  const teamsData = queryData({ ...teamsQuery, data: teamsQuery.data?.teams }, teams.length)
  const membersData = queryData({ ...membersQuery, data: membersQuery.data?.members }, allMembers.length)
  const workloadData = queryData({ ...workloadQuery, data: workloadQuery.data?.members }, workloadQuery.data ? workloadQuery.data.members.length + workloadQuery.data.tasks.length : 0)
  const necessary = variant === "team1" ? [teamsData] : [workloadData, membersData]
  const sourceErrors = necessary.flatMap(data => data.error ? [data.error.message] : [])
  const data: PmControlledData = sourceErrors.length ? { state: "error", error: { category: "request", message: sourceErrors.join(" · "), reason: t("仅保留当前仍获授权的快照。写操作已暂停。", "Only snapshots still authorized are retained. Writes are paused.") }, onRetry: refresh } : necessary.some(data => data.state === "loading") ? { state: "loading", onRetry: refresh } : { state: "success", refreshing: necessary.some(data => data.refreshing), onRetry: refresh }
  const needle = interaction.query.trim().toLocaleLowerCase()
  const memberByUserId = new Map(allMembers.map(member => [member.userId, member]))
  const conditions = teamFilterConditions(interaction)
  const visibleTeams = teams.filter(team => teamMatchesConditions(team, conditions, memberByUserId) && [team.name, team.identifier ?? "", team.description, team.focus ?? "", ...team.members.map(entry => allMembers.find(member => member.userId === entry.userId)?.name ?? ""), ...team.projectIds.map(id => projects.find(project => project.id === id)?.title ?? "")].join(" ").toLocaleLowerCase().includes(needle)).sort((a, b) => interaction.sort === "activity" ? (b.activityAt ?? "").localeCompare(a.activityAt ?? "") : interaction.sort === "members" ? b.members.length - a.members.length : a.name.localeCompare(b.name) * (interaction.sort === "name-desc" ? -1 : 1))
  const effectiveInteraction = variant === "team3" ? { ...interaction, teamId, memberFilter: interaction.memberFilter ?? memberId } : interaction
  const workloadConditions = withSingleTeamFields(conditions, ["state", "team", "member"]).filter(condition => condition.field === "state" || condition.field === "team" || condition.field === "member")
  const workload = workloadQuery.data && membersQuery.data ? workloadProjection(workloadQuery.data, allMembers, {
    ...effectiveInteraction,
    memberId: effectiveInteraction.memberFilter ?? memberId,
    conditions: workloadConditions,
  }) : null
  const canManage = variant === "team1" && allowed(workspace, "access.manage") && !!teamsQuery.data?.canManage
  const teamReadBlocked = !teamsQuery.data || !!teamsQuery.error
  const memberReadBlocked = !membersQuery.data || !!membersQuery.error
  const locked = command.pending || !!command.unknownCommand
  const edit = (id: string | null, mode: TeamEditorSelection["mode"], element: HTMLElement | null) => {
    trigger.current = element
    setInteraction(previous => ({ ...previous, detailOpen: false }))
    setEditor({ id, mode })
  }
  const roles = [{ value: memberRoleValues.admin, label: "Admin" }, { value: memberRoleValues.member, label: "Member" }, { value: memberRoleValues.guest, label: "Guest" }, { value: memberRoleValues.custom, label: "Custom" }, { value: memberRoleValues.unknown, label: t("权限未知", "Access unknown") }]
  const headerActions = <div className="flex min-w-0 flex-wrap items-center gap-2">{variant === "team1" && teamsQuery.data && <span className="text-xs text-muted-foreground">{t(`${visibleTeams.length} 个可见团队`, `${visibleTeams.length} visible teams`)}</span>}<Button size="icon-sm" variant="ghost" aria-label={t("刷新当前来源", "Refresh current sources")} disabled={teamsQuery.isFetching || membersQuery.isFetching || workloadQuery.isFetching} onClick={refresh}><RefreshCw size={14} aria-hidden="true" /></Button></div>
  const openWorkload = (filter: { memberId: string } | { teamId: string }) => {
    setInteraction(previous => ({ ...previous, detailOpen: false, memberDetailOpen: false }))
    const params = new URLSearchParams(searchParams)
    params.set("tab", "workload")
    params.delete("memberId")
    params.delete("teamId")
    params.delete("profile")
    params.delete("panel")
    for (const [key, value] of Object.entries(filter)) params.set(key, value)
    navigate(`${root}/members?${params}`)
  }
  const changeInteraction: TeamCollectionViewProps["actions"]["setInteraction"] = next => {
    const updated = typeof next === "function" ? next(effectiveInteraction) : next
    setInteraction(updated)
    if (variant === "team3" && (updated.teamId !== teamId || (updated.memberFilter ?? null) !== memberId)) {
      const params = new URLSearchParams(searchParams)
      if (updated.teamId) params.set("teamId", updated.teamId)
      else params.delete("teamId")
      if (updated.memberFilter) params.set("memberId", updated.memberFilter)
      else params.delete("memberId")
      setSearchParams(params)
    }
  }
  const clearFilter = (key: "memberId" | "teamId") => {
    const params = new URLSearchParams(searchParams)
    params.delete(key)
    setSearchParams(params)
    setInteraction(previous => {
      const field = key === "memberId" ? "member" : "team"
      return {
        ...previous,
        ...(key === "memberId" ? { memberFilter: null } : { teamId: null }),
        conditions: previous.conditions && previous.conditions.filter(condition => condition.field !== field),
      }
    })
  }
  const canWriteTeam = (id: string) => canManage && !teamReadBlocked && !locked && !!teamsQuery.data?.teams.some(team => team.id === id && !team.data.archivedAt)
  return <>
    <CommandNotice />
    {variant === "team1" && membersQuery.error && <div role="alert" className="flex flex-wrap items-center gap-2 p-4 text-sm"><span>{t("成员来源：", "Member source: ")}{membersQuery.error.message}</span><Button variant="outline" onClick={() => { void membersQuery.refetch() }}>{t("重试成员读取", "Retry member read")}</Button></div>}
    {variant === "team3" && (memberId || teamId) && <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b bg-surface px-4 py-3 text-sm" aria-label={t("工作量筛选", "Workload filters")} data-pm-workload-filters>
      <span className="text-muted-foreground">{t("筛选：", "Filters:")}</span>
      {memberId && <Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal break-all text-left" onClick={() => clearFilter("memberId")} aria-label={t("清除成员筛选", "Clear member filter")}><span>{t("成员：", "Member: ")}{allMembers.find(member => member.userId === memberId)?.name ?? t("不可用成员", "Unavailable member")} · {memberId}</span><X className="shrink-0" size={14} aria-hidden="true" /></Button>}
      {teamId && <Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal break-all text-left" onClick={() => clearFilter("teamId")} aria-label={t("清除团队筛选", "Clear team filter")}><span>{t("团队：", "Team: ")}{teamOptions.find(team => team.id === teamId)?.name ?? t("不可用团队", "Unavailable team")} · {teamId}</span><X className="shrink-0" size={14} aria-hidden="true" /></Button>}
    </div>}
    <TeamCollectionView interactive embedded variant={variant} headerActions={headerActions}
      readModel={{
        teams: visibleTeams, selectedTeam: teams.find(team => team.id === interaction.selectedId) ?? null,
        teamsAvailable: variant === "team1" ? !!teamsQuery.data : !!membersQuery.data,
        members: allMembers, selectedMember: allMembers.find(member => member.membershipId === interaction.selectedMemberId) ?? null,
        projects, data, teamOptions, roles,
        workload: variant === "team3" ? workload : null,
        taskEstimates: workloadQuery.data ? Object.fromEntries(workloadQuery.data.tasks.map(task => [task.id, task.estimatePoints])) : undefined,
        unavailableAssigneeTaskIds: workloadQuery.data?.tasks.filter(task => task.assigneeStatus === "unavailable").map(task => task.id),
        copyReceipt: copyReceipt && allMembers.some(member => member.membershipId === copyReceipt.membershipId) ? copyReceipt : null,
        sourceDescription: variant === "team3" ? t("容量单位为并行未完成工作估算点，不是周工时。容量指标覆盖全部当前可见开放工作；筛选只改变任务列表。读取范围不完整或估算缺失时，未确认的过载保持未知。", "Capacity measures concurrent unfinished-work estimate points, not weekly hours. Capacity metrics cover all currently visible open work; filters change task lists only. Incomplete scope or estimates leave unconfirmed overload unknown.") : variant === "team1" && teams.some(team => team.scopeComplete === false) ? t("仅显示当前可见成员、项目与工作计数；不是工作区总量。", "Members, projects and work counts cover the current visible scope, not workspace totals.") : undefined,
      }}
      interaction={effectiveInteraction}
      capabilities={{ create: canManage && !teamReadBlocked && !locked, edit: team => canWriteTeam(team.id), members: team => canWriteTeam(team.id) && !memberReadBlocked, projectRelations: team => canWriteTeam(team.id), archive: team => canWriteTeam(team.id), openProject: id => projects.some(project => project.id === id), memberOpen: () => !memberReadBlocked, filterPresence: !!membersQuery.data, sortActivity: true, filterWorkloadTeam: !!workloadQuery.data, copyContact: (member, kind) => !memberReadBlocked && (kind === "email" ? !!member.email : kind === "phone" ? !!member.phone : !!member.email || !!member.phone) }}
      actions={{ setInteraction: changeInteraction, teamWorkload: variant === "team1" ? team => openWorkload({ teamId: team.id }) : undefined, memberWorkload: member => openWorkload({ memberId: member.userId }), copyContact: async (member, kind) => { const value = kind === "email" ? member.email : kind === "phone" ? member.phone : [member.email, member.phone].filter(Boolean).join("\n"); if (!memberReadBlocked && value) setCopyReceipt({ membershipId: member.membershipId, kind, ok: await copyText(value) }) }, open: team => setInteraction(previous => ({ ...previous, selectedId: team.id, detailOpen: true })), create: element => edit(null, "details", element), edit: (team, element) => edit(team.id, "details", element), members: (team, element) => edit(team.id, "members", element), projectRelations: (team, element) => edit(team.id, "projects", element), archive: (team, element) => edit(team.id, "archive", element), openProject: id => navigate(`${root}/projects/${encodeURIComponent(id)}`, { state: { returnTo: `${location.pathname}${location.search}` } }), memberOpen: member => setInteraction(previous => ({ ...previous, selectedMemberId: member.membershipId, memberDetailOpen: true })), openIssue: issue => navigate(taskOpenMode === "panel" ? `${root}/issues?${new URLSearchParams({ entity: issue.id, returnTo: `${location.pathname}${location.search}` })}` : `${root}/entities/${encodeURIComponent(issue.id)}?${new URLSearchParams({ returnTo: `${location.pathname}${location.search}` })}`, { state: { returnTo: `${location.pathname}${location.search}` } }) }}
      memberTaskActions={member => <TeamMemberTaskActions userId={member.userId} memberName={member.name} canManageCapacity={allowed(workspace, "access.manage") && !!workloadQuery.data && !workloadQuery.error && !memberReadBlocked} onChanged={refresh} />}
      taskActions={issue => <Button size="sm" variant="ghost" disabled={capabilities?.business.enabled !== true || !workspace?.capabilities.includes("planning.edit") || !workspace.capabilities.includes("domain.read") || !workloadQuery.data || !!workloadQuery.error || memberReadBlocked} onClick={() => setEstimateTaskId(issue.id)}>{t("编辑估算", "Edit estimate")}</Button>}
      poolActions={<TeamMemberTaskActions userId={null} onChanged={refresh} />}
      editDialog={<TeamEditorDialog selection={canManage ? editor : null} directory={teamsQuery.data} members={allMembers} disabled={!canManage || teamReadBlocked || editor?.mode === "members" && memberReadBlocked} onClose={() => setEditor(null)} onChanged={refresh} finalFocus={() => trigger.current} />}
    />
    <Dialog open={variant === "team3" && estimateTaskId !== null} onOpenChange={open => { if (!open) setEstimateTaskId(null) }}><DialogContent>
      <DialogTitle>{t("任务估算点", "Task estimate points")}</DialogTitle><DialogDescription>{t("只修改原生 Markdown 的 x-pm-estimate，不修改任务状态。", "Changes only native Markdown x-pm-estimate, never task status.")}</DialogDescription>
      <DialogBody>{estimateTaskId && <TeamTaskEstimateEditor workItemId={estimateTaskId} onSaved={refresh} onClose={() => setEstimateTaskId(null)} />}</DialogBody>
    </DialogContent></Dialog>
  </>
}

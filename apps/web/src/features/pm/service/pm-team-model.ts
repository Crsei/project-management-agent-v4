import type { TeamDirectory } from "../../../../../../packages/domain/src/team-directory.ts"
import type { TeamWorkload } from "../../../../../../packages/domain/src/team-workload.ts"

/** Portable projection inputs; generic members retain the caller's redacted record. */
type DirectoryPerson = {
  userId: string
  name: string
  email: string
  companyRole?: string | null
  presence?: "available" | "away" | "offline" | null
  teams?: readonly { id: string; name: string }[]
}
export type TeamProjectionFilters = {
  query: string
  teamId: string | null
  memberId?: string | null
  presenceFilter?: "all" | "available" | "away" | "offline"
  workloadStateFilter?: "all" | "open" | "done"
}
export type ProjectedTeam = {
  id: string
  name: string
  description: string
  identifier: string | null
  focus: string | null
  responseTarget: string | null
  activityAt: string | null
  openWorkCount: number | null
  scopeComplete: boolean
  members: readonly { membershipId: string; userId: string; role: "maintainer" | "member" }[]
  projectIds: readonly string[]
  version: string
}

export function teamRecord(team: TeamDirectory["teams"][number]): ProjectedTeam {
  return {
    id: team.id, name: team.data.name, description: team.data.description,
    identifier: team.data.identifier, focus: team.data.focus,
    responseTarget: team.data.responseTargetHours === null ? null : `${team.data.responseTargetHours}h`,
    activityAt: team.activityAt, openWorkCount: team.openWorkCount, scopeComplete: team.scopeComplete,
    members: team.data.memberIds.map(userId => {
      const role: "maintainer" | "member" = team.data.maintainerIds.includes(userId) ? "maintainer" : "member"
      return { membershipId: `${team.id}:${userId}`, userId, role }
    }),
    projectIds: team.projectIds, version: String(team.version),
  }
}

export function teamProjectRecord(project: TeamDirectory["projects"][number]) {
  return { id: project.id, identifier: project.id, title: project.name, description: null, owner: null, status: null, cycle: null, cycleWeeks: null, teamSize: null, health: null, dueDate: null, archived: null, artwork: null, starred: null, taskCounts: null }
}

/** MemberDirectory summaries are an independent lawful source, not a second roster. */
export function directoryTeams(members: readonly DirectoryPerson[], teams: readonly ProjectedTeam[]) {
  const byId = new Map<string, ProjectedTeam>(teams.map(team => [team.id, team]))
  for (const member of members) for (const summary of member.teams ?? []) {
    if (!byId.has(summary.id)) byId.set(summary.id, { id: summary.id, name: summary.name, description: "", identifier: null, focus: null, responseTarget: null, activityAt: null, openWorkCount: null, members: [], projectIds: [], version: "", scopeComplete: false })
  }
  return [...byId.values()]
}

export function peopleDirectoryRows<Member extends DirectoryPerson>(members: readonly Member[], teams: readonly ProjectedTeam[], state: TeamProjectionFilters) {
  const needle = state.query.trim().toLocaleLowerCase()
  return members.filter(member =>
    (!state.teamId || member.teams?.some(team => team.id === state.teamId)) &&
    (!state.presenceFilter || state.presenceFilter === "all" || member.presence === state.presenceFilter) &&
    [member.name, member.email, member.companyRole ?? "", ...(member.teams ?? []).map(team => team.name)].join(" ").toLocaleLowerCase().includes(needle)
  ).sort((a, b) => a.name.localeCompare(b.name)).map(member => {
    const memberTeams = teams.filter(team => member.teams?.some(summary => summary.id === team.id))
    const selected = state.teamId ? memberTeams.find(team => team.id === state.teamId) : undefined
    const relation = selected?.members.find(entry => entry.userId === member.userId)
    return { member, teams: memberTeams, membership: selected && relation ? { teamId: selected.id, membershipId: relation.membershipId, role: relation.role } : null }
  })
}

export function workloadProjection<Member extends DirectoryPerson>(source: TeamWorkload, members: readonly Member[], state: TeamProjectionFilters) {
  const byUser = new Map(members.map(member => [member.userId, member]))
  const needle = state.query.trim().toLocaleLowerCase()
  const matchesText = (value: string) => value.toLocaleLowerCase().includes(needle)
  const stateMatches = (task: TeamWorkload["tasks"][number]) => state.workloadStateFilter === "open" ? task.open : state.workloadStateFilter === "done" ? task.done : true
  const teamMatches = (task: TeamWorkload["tasks"][number]) => !state.teamId || task.teamIds.includes(state.teamId)
  const taskMatches = (task: TeamWorkload["tasks"][number]) => {
    const assignee = task.assigneeId ? byUser.get(task.assigneeId) : undefined
    return stateMatches(task) && teamMatches(task) && (!state.memberId || task.assigneeId === state.memberId) && (!needle || matchesText(`${task.id} ${task.title} ${assignee?.name ?? ""} ${assignee?.email ?? ""}`))
  }
  const stamp = Date.parse(source.serverNow)
  const records = new Map(source.tasks.map(task => [task.id, {
    id: task.id, projectId: task.projectId, identifier: task.id, title: task.title,
    stateId: task.status, priorityId: "", assigneeIds: task.assigneeId ? [task.assigneeId] : [],
    labelIds: [], dueDate: null, revision: stamp, version: "", sourceRevision: null,
    moduleIds: [], cycleId: null, estimatePointId: null,
  }]))
  const tasksById = new Map(source.tasks.map(task => [task.id, task]))
  const resolve = (ids: readonly string[], match = taskMatches) => ids.flatMap(id => {
    const task = tasksById.get(id)
    const record = records.get(id)
    return task && record && match(task) ? [record] : []
  })
  const rows = source.members.flatMap(row => {
    const member = byUser.get(row.userId)
    if (!member || state.memberId && row.userId !== state.memberId) return []
    const personMatches = !!needle && matchesText(`${member.name} ${member.email}`)
    const issues = resolve(row.taskIds)
    if (state.teamId && !row.teamIds.includes(state.teamId) && !issues.length) return []
    if (needle && !personMatches && !issues.length) return []
    return [{ id: row.userId, member, issues, openCount: row.openCount, doneCount: row.doneCount, knownOpenPoints: row.knownOpenPoints, unknownEstimateCount: row.unknownEstimateCount, capacityPoints: row.capacityPoints, overloaded: row.overloaded }]
  })
  const pool = resolve(source.unassignedTaskIds)
  const visibleTasks = source.tasks.filter(taskMatches)
  return {
    rows, unassigned: { issues: pool, unknownAssigneeCount: source.summary.unknownAssigneeCount },
    summary: { uniqueTaskCount: visibleTasks.length, rowTaskCount: rows.reduce((sum, row) => sum + row.issues.length, 0), overloadedMembers: source.summary.overloadedMemberCount, unknownOverloadMembers: source.summary.unknownOverloadMemberCount, unknownCapacityMembers: source.members.filter(row => row.capacityPoints === null).length, unknownEstimateCount: source.summary.unknownEstimateCount },
    grouping: "teams" as const,
    groups: source.teams.filter(team => !state.teamId || team.id === state.teamId).map(team => ({ id: team.id, label: team.name, issues: resolve(team.taskIds) })).filter(group => !state.memberId || group.issues.length > 0),
    pool,
  }
}

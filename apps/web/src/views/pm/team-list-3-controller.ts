import type { Locale } from "@/lib/i18n-core"
import { pmMembers, type PmMember } from "./model"
import type { PmIssue } from "./issue-domain"
import type { PersonFixture } from "./people-fixtures"
import { directoryRows, membersOfTeam } from "./people-controller"
import type { PeopleDomain } from "./people-domain"
import {
  teamFocuses,
  type DirectoryTeam,
  type TeamFocus,
} from "./team-list-1-fixtures"

export interface WorkloadState {
  tab: "workload" | "departments" | "pool"
  query: string
  stateFilter: "all" | "open" | "done"
  expandedIds: string[]
}

export function createWorkloadState(): WorkloadState {
  return {
    tab: "workload",
    query: "",
    stateFilter: "all",
    expandedIds: pmMembers.map((member) => member.id),
  }
}

const stateOrder = ["backlog", "todo", "progress", "review", "done"]

function issueMatches(
  state: WorkloadState,
  issue: PmIssue,
  locale: Locale,
): boolean {
  if (state.stateFilter === "open" && issue.stateId === "done") return false
  if (state.stateFilter === "done" && issue.stateId !== "done") return false
  const query = state.query.trim().toLocaleLowerCase(locale)
  if (!query) return true
  const haystack = [
    issue.titleCopy.en,
    issue.titleCopy["zh-CN"],
    issue.identifier,
  ].join(" ")
  return haystack.toLocaleLowerCase(locale).includes(query)
}

function sortIssues(a: PmIssue, b: PmIssue): number {
  const byState = stateOrder.indexOf(a.stateId) - stateOrder.indexOf(b.stateId)
  return byState !== 0 ? byState : a.identifier.localeCompare(b.identifier)
}

function uniqueIssues(issues: PmIssue[]): PmIssue[] {
  const seen = new Set<string>()
  return issues
    .filter((issue) => {
      if (seen.has(issue.id)) return false
      seen.add(issue.id)
      return true
    })
    .sort(sortIssues)
}

export interface WorkloadRow {
  member: PmMember
  person: PersonFixture | undefined
  issues: PmIssue[]
  openCount: number
  doneCount: number
  knownOpenPoints: number
  unknownEstimateCount: number
  capacityPoints: number | null
  overloaded: boolean
}

export interface WorkloadSnapshot {
  rows: WorkloadRow[]
  unassigned: { issues: PmIssue[]; unknownAssigneeCount: number }
  summary: {
    visibleCount: number
    uniqueShownCount: number
    rowAssignments: number
    overloadedMembers: number
    unknownCapacityMembers: number
    unknownEstimateCount: number
  }
}

export function workloadSnapshot(
  state: WorkloadState,
  domain: PeopleDomain,
  issues: readonly PmIssue[],
  locale: Locale,
): WorkloadSnapshot {
  const visible = issues.filter((issue) => issueMatches(state, issue, locale))
  const memberIds = new Set(pmMembers.map((member) => member.id))
  const rows: WorkloadRow[] = directoryRows(domain).map(
    ({ member, person }) => {
      const assigned = uniqueIssues(
        visible.filter((issue) => issue.assigneeIds.includes(member.id)),
      )
      const openIssues = assigned.filter((issue) => issue.stateId !== "done")
      const knownOpenPoints = openIssues.reduce(
        (sum, issue) => sum + (issue.estimate ?? 0),
        0,
      )
      const unknownEstimateCount = openIssues.filter(
        (issue) => issue.estimate === null,
      ).length
      const capacityPoints = person?.capacityPoints ?? null
      return {
        member,
        person,
        issues: assigned,
        openCount: openIssues.length,
        doneCount: assigned.length - openIssues.length,
        knownOpenPoints,
        unknownEstimateCount,
        capacityPoints,
        overloaded: capacityPoints !== null && knownOpenPoints > capacityPoints,
      }
    },
  )
  const unassignedIssues = visible.filter(
    (issue) => !issue.assigneeIds.some((id) => memberIds.has(id)),
  )
  const unknownAssigneeCount = unassignedIssues.filter(
    (issue) => issue.assigneeIds.length > 0,
  ).length
  const shownIds = new Set<string>()
  let rowAssignments = 0
  for (const row of rows) {
    rowAssignments += row.issues.length
    for (const issue of row.issues) shownIds.add(issue.id)
  }
  for (const issue of unassignedIssues) shownIds.add(issue.id)
  const unknownEstimateIds = new Set<string>()
  for (const issue of visible) {
    if (shownIds.has(issue.id) && issue.stateId !== "done" && issue.estimate === null) {
      unknownEstimateIds.add(issue.id)
    }
  }
  return {
    rows,
    unassigned: {
      issues: uniqueIssues(unassignedIssues),
      unknownAssigneeCount,
    },
    summary: {
      visibleCount: visible.length,
      uniqueShownCount: shownIds.size,
      rowAssignments,
      overloadedMembers: rows.filter((row) => row.overloaded).length,
      unknownCapacityMembers: rows.filter((row) => row.capacityPoints === null && (row.issues.length > 0 || (!state.query.trim() && state.stateFilter === "all"))).length,
      unknownEstimateCount: unknownEstimateIds.size,
    },
  }
}

export interface DepartmentWorkload {
  focus: TeamFocus
  teams: DirectoryTeam[]
  memberIds: string[]
  issues: PmIssue[]
}

export function departmentWorkload(
  state: WorkloadState,
  domain: PeopleDomain,
  issues: readonly PmIssue[],
  locale: Locale,
): DepartmentWorkload[] {
  const visible = issues.filter((issue) => issueMatches(state, issue, locale))
  return teamFocuses.flatMap((focus) => {
    const teams = domain.teams.filter((team) => team.focus === focus)
    const memberIds = [
      ...new Set(
        teams.flatMap((team) =>
          membersOfTeam(domain, team.id).map(
            (membership) => membership.memberId,
          ),
        ),
      ),
    ]
    const memberSet = new Set(memberIds)
    const deptIssues = uniqueIssues(
      visible.filter((issue) =>
        issue.assigneeIds.some((id) => memberSet.has(id)),
      ),
    )
    return teams.length && memberIds.length && deptIssues.length
      ? [{ focus, teams, memberIds, issues: deptIssues }]
      : []
  })
}

export interface PoolEntry {
  issue: PmIssue
  assignees: PmMember[]
}

export function taskPool(
  state: WorkloadState,
  issues: readonly PmIssue[],
  locale: Locale,
): PoolEntry[] {
  return issues
    .filter((issue) => issueMatches(state, issue, locale))
    .sort(sortIssues)
    .map((issue) => ({
      issue,
      assignees: issue.assigneeIds.flatMap((id) => {
        const member = pmMembers.find((item) => item.id === id)
        return member ? [member] : []
      }),
    }))
}

export function toggleWorkloadRow(
  state: WorkloadState,
  memberId: string,
): WorkloadState {
  const expandedIds = state.expandedIds.includes(memberId)
    ? state.expandedIds.filter((id) => id !== memberId)
    : [...state.expandedIds, memberId]
  return { ...state, expandedIds }
}

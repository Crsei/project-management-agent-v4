import type { Locale } from "@/lib/i18n-core"
import type { Availability } from "./people-fixtures"
import {
  directoryRows,
  personMatchesQuery,
  teamsForMember,
  type PersonRow,
} from "./people-controller"
import type { PeopleDomain } from "./people-domain"
import {
  teamFocuses,
  type DirectoryTeam,
  type TeamFocus,
} from "./team-list-1-fixtures"

export interface TeamList2State {
  tab: "directory" | "departments"
  teamId: "all" | string
  query: string
  availabilityFilter: "all" | Availability
  copyReceipt: { memberId: string; ok: boolean } | null
}

export function createTeamList2State(): TeamList2State {
  return {
    tab: "directory",
    teamId: "all",
    query: "",
    availabilityFilter: "all",
    copyReceipt: null,
  }
}

export interface DepartmentGroup {
  focus: TeamFocus | "unassigned"
  teams: DirectoryTeam[]
  members: (PersonRow & { teamIdentifiers: string[] })[]
}

export function directoryMembers(
  state: TeamList2State,
  domain: PeopleDomain,
  locale: Locale,
): PersonRow[] {
  return directoryRows(domain).filter((row) => {
    const teams = teamsForMember(domain, row.member.id)
    const inTeam =
      state.teamId === "all" ||
      (state.teamId === "unassigned"
        ? teams.length === 0
        : teams.some(({ team }) => team.id === state.teamId))
    return (
      inTeam &&
      personMatchesQuery(domain, row, state.query, locale) &&
      (state.availabilityFilter === "all" ||
        row.person.availability === state.availabilityFilter)
    )
  })
}

export function departmentGroups(
  state: TeamList2State,
  domain: PeopleDomain,
  locale: Locale,
): DepartmentGroup[] {
  const rows = directoryMembers(state, domain, locale)
  const groups: DepartmentGroup[] = teamFocuses.flatMap((focus) => {
    const teams = domain.teams.filter(
      (team) =>
        team.focus === focus &&
        (state.teamId === "all" || team.id === state.teamId),
    )
    const members = rows.flatMap((row) => {
      const identifiers = teamsForMember(domain, row.member.id)
        .filter(({ team }) => teams.some((item) => item.id === team.id))
        .map(({ team }) => team.identifier)
      return identifiers.length
        ? [{ ...row, teamIdentifiers: identifiers }]
        : []
    })
    return members.length ? [{ focus, teams, members }] : []
  })
  const unassigned = rows.filter(
    (row) => teamsForMember(domain, row.member.id).length === 0,
  )
  if (unassigned.length)
    groups.push({
      focus: "unassigned",
      teams: [],
      members: unassigned.map((row) => ({ ...row, teamIdentifiers: [] })),
    })
  return groups
}

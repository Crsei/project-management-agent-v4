import type { Locale } from "@/lib/i18n-core"
import type { PmMembership, PmMember } from "./model"
import { pmMembers } from "./model"
import type { DirectoryTeam } from "./team-list-1-fixtures"
import type { PersonFixture } from "./people-fixtures"

export interface DirectoryFacts {
  teams: DirectoryTeam[]
  memberships: PmMembership[]
}

export interface PersonRow {
  member: PmMember
  person: PersonFixture
}

/** pmMembers identity order joined with the people fixture slice. */
export function directoryRows(source: {
  people: readonly PersonFixture[]
}): PersonRow[] {
  return source.people.flatMap((person) => {
    const member = pmMembers.find((item) => item.id === person.memberId)
    return member
      ? [{ member: person.displayName ? { ...member, name: person.displayName } : member, person }]
      : []
  })
}

export function teamsForMember(
  directory: Pick<DirectoryFacts, "teams" | "memberships">,
  memberId: string,
): { team: DirectoryTeam; role: PmMembership["role"] }[] {
  return directory.memberships
    .filter((membership) => membership.memberId === memberId)
    .flatMap((membership) => {
      const team = directory.teams.find((item) => item.id === membership.teamId)
      return team ? [{ team, role: membership.role }] : []
    })
    .sort((a, b) => a.team.identifier.localeCompare(b.team.identifier))
}

export function membersOfTeam(
  directory: Pick<DirectoryFacts, "memberships">,
  teamId: string,
): { memberId: string; role: PmMembership["role"] }[] {
  return directory.memberships
    .filter((membership) => membership.teamId === teamId)
    .map((membership) => ({
      memberId: membership.memberId,
      role: membership.role,
    }))
    .sort((a, b) => a.memberId.localeCompare(b.memberId))
}

export function personMatchesQuery(
  directory: Pick<DirectoryFacts, "teams" | "memberships">,
  row: PersonRow,
  query: string,
  locale: Locale,
): boolean {
  const q = query.trim().toLocaleLowerCase(locale)
  if (!q) return true
  const { member, person } = row
  const teams = teamsForMember(directory, member.id)
    .map(
      ({ team }) => `${team.name.en} ${team.name["zh-CN"]} ${team.identifier}`,
    )
    .join(" ")
  const haystack = [
    member.name,
    member.role.en,
    member.role["zh-CN"],
    person.contact?.email ?? "",
    person.contact?.phone ?? "",
    person.ownership.en,
    person.ownership["zh-CN"],
    teams,
  ].join(" ")
  return haystack.toLocaleLowerCase(locale).includes(q)
}

export function joinedMonth(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(date))
}

export function joinedFullDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(date))
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

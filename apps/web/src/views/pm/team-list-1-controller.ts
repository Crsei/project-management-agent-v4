import type { Locale } from "@/lib/i18n-core"
import { pmClock, pmMembers, type PmMember, type PmScenario } from "./model"
import {
  createTeamList1Fixtures,
  focusLabels,
  type DirectoryTeam,
  type TeamFocus,
} from "./team-list-1-fixtures"

export type TeamDraft = {
  teamId: string | null
  name: string
  identifier: string
  description: string
  focus: TeamFocus
  slaHours: 8 | 24
  maintainerId: string
  locale: Locale
}
export type FixtureOutcome = "confirmed" | "rejected" | "unknown"
export type TeamList1State = ReturnType<typeof createTeamList1State>
export function createTeamList1State(scenario: PmScenario) {
  return {
    ...createTeamList1Fixtures(scenario),
    query: "",
    focusFilters: [] as readonly TeamFocus[],
    identifierFilters: [] as readonly string[],
    slaFilter: "all" as "all" | "8" | "24",
    display: "table" as "table" | "cards",
    sort: "name" as "name" | "name-desc" | "work-asc" | "work-desc" | "maintainers-asc" | "maintainers-desc" | "activity",
    selectedId: null as string | null,
    detailOpen: false,
    detailTab: "overview" as "overview" | "maintainers" | "projects",
    editorOpen: false,
    draft: null as TeamDraft | null,
    outcome: "confirmed" as FixtureOutcome,
    checkOutcome: "confirmed" as "confirmed" | "rejected",
    request: null as { id: string; draft: TeamDraft } | null,
    result: "idle" as "idle" | FixtureOutcome | "validation",
    sequence: 0,
    message: "" as
      "" | "required" | "duplicate" | "member-unavailable" | "confirmed" | "rejected" | "unknown",
  }
}
export function visibleTeams(
  state: TeamList1State,
  locale: Locale,
  members: readonly PmMember[] = pmMembers,
) {
  const q = state.query.trim().toLocaleLowerCase(locale)
  const maintainerCounts = state.sort === "maintainers-asc" || state.sort === "maintainers-desc"
    ? new Map<string, number>() : null
  if (maintainerCounts) {
    const available = new Set(members.map((member) => member.id))
    for (const membership of state.memberships) {
      if (membership.role === "maintainer" && available.has(membership.memberId)) {
        maintainerCounts.set(membership.teamId, (maintainerCounts.get(membership.teamId) ?? 0) + 1)
      }
    }
  }
  return state.teams
    .filter((team) => {
      const identities = state.memberships
        .filter((membership) => membership.teamId === team.id)
        .map(
          (membership) =>
            members.find((member) => member.id === membership.memberId)
              ?.name ?? "",
        )
        .join(" ")
      return (
        (!q ||
          `${team.name.en} ${team.name["zh-CN"]} ${team.identifier} ${team.description[locale]} ${focusLabels[team.focus][locale]} ${identities}`
            .toLocaleLowerCase(locale)
            .includes(q)) &&
        (!state.focusFilters.length || state.focusFilters.includes(team.focus)) &&
        (!state.identifierFilters.length || state.identifierFilters.includes(team.identifier)) &&
        (state.slaFilter === "all" || String(team.slaHours) === state.slaFilter)
      )
    })
    .sort((a, b) => {
      switch (state.sort) {
        case "activity": return b.activityAt.localeCompare(a.activityAt)
        case "name-desc": return b.name.en.localeCompare(a.name.en, "en")
        case "work-asc": return a.openWork - b.openWork
        case "work-desc": return b.openWork - a.openWork
        case "maintainers-asc": return (maintainerCounts?.get(a.id) ?? 0) - (maintainerCounts?.get(b.id) ?? 0)
        case "maintainers-desc": return (maintainerCounts?.get(b.id) ?? 0) - (maintainerCounts?.get(a.id) ?? 0)
        default: return a.name.en.localeCompare(b.name.en, "en")
      }
    })
}
export function openTeamEditor(
  state: TeamList1State,
  locale: Locale,
  team?: DirectoryTeam,
): TeamList1State {
  if (state.draft) return { ...state, editorOpen: true, detailOpen: false }
  const maintainer = state.memberships.find(
    (m) => m.teamId === team?.id && m.role === "maintainer",
  )
  return {
    ...state,
    editorOpen: true,
    detailOpen: false,
    result: "idle",
    message: "",
    request: null,
    draft: {
      teamId: team?.id ?? null,
      name: team?.name[locale] ?? "",
      identifier: team?.identifier ?? "",
      description: team?.description[locale] ?? "",
      focus: team?.focus ?? "delivery",
      slaHours: team?.slaHours ?? 8,
      maintainerId: maintainer?.memberId ?? (team ? "" : pmMembers[0].id),
      locale,
    },
  }
}
function applyConfirmed(
  state: TeamList1State,
  draft: TeamDraft,
  requestId: string,
): TeamList1State {
  const previous = state.teams.find((team) => team.id === draft.teamId)
  const id = draft.teamId ?? `team-local-${state.sequence}`
  const team: DirectoryTeam = {
    id,
    name: previous
      ? { ...previous.name, [draft.locale]: draft.name.trim() }
      : { en: draft.name.trim(), "zh-CN": draft.name.trim() },
    identifier: draft.identifier.trim().toUpperCase(),
    description: previous
      ? { ...previous.description, [draft.locale]: draft.description.trim() }
      : { en: draft.description.trim(), "zh-CN": draft.description.trim() },
    focus: draft.focus,
    slaHours: draft.slaHours,
    symbol: previous?.symbol ?? "users",
    openWork: previous?.openWork ?? 0,
    activityAt: previous?.activityAt ?? pmClock,
  }
  const memberships = draft.maintainerId
    ? [
        ...state.memberships.filter(
          (m) => !(m.teamId === id && m.memberId === draft.maintainerId),
        ),
        { teamId: id, memberId: draft.maintainerId, role: "maintainer" as const },
      ]
    : state.memberships
  return {
    ...state,
    teams: previous
      ? state.teams.map((t) => (t.id === id ? team : t))
      : [...state.teams, team],
    memberships,
    selectedId: id,
    editorOpen: false,
    draft: null,
    request: { id: requestId, draft },
    result: "confirmed",
    message: "confirmed",
  }
}
export function submitTeamDraft(state: TeamList1State): TeamList1State {
  if (!state.draft || state.result === "unknown") return state
  const draft = state.draft
  if (!draft.name.trim() || !draft.identifier.trim())
    return { ...state, result: "validation", message: "required" }
  if (
    state.teams.some(
      (t) =>
        t.id !== draft.teamId &&
        t.identifier.toLowerCase() === draft.identifier.trim().toLowerCase(),
    )
  )
    return { ...state, result: "validation", message: "duplicate" }
  if (draft.maintainerId && !pmMembers.some((member) => member.id === draft.maintainerId))
    return { ...state, result: "validation", message: "member-unavailable" }
  const sequence = state.sequence + 1
  const requestId = `pm-team-list-1-request-${sequence}`
  const next: TeamList1State = {
    ...state,
    sequence,
    request: { id: requestId, draft: { ...draft } },
    result: state.outcome,
    message: state.outcome,
  }
  return state.outcome === "confirmed"
    ? applyConfirmed(next, draft, requestId)
    : next
}
export function checkTeamResult(state: TeamList1State): TeamList1State {
  if (state.result !== "unknown" || !state.request) return state
  return state.checkOutcome === "confirmed"
    ? applyConfirmed(state, state.request.draft, state.request.id)
    : { ...state, result: "rejected", message: "rejected" }
}

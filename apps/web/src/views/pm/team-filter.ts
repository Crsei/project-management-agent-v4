import type { FilterCondition } from "../../lib/filter-model.ts"
import type { ControlledTeam, TeamCollectionInteraction } from "./people-controlled-contracts"

/** Conditions the team surface understands; anything else is ignored. */
export const teamFilterFields = ["focus", "presence", "team", "member"] as const
export type TeamFilterField = typeof teamFilterFields[number]

type PresenceLookup = ReadonlyMap<string, { presence?: "available" | "away" | "offline" | null } | undefined>
const singleTeamFields = ["focus", "presence", "team"]

/** Single-select fields keep one condition; a persisted duplicate collapses to the last edit. */
export function withSingleTeamFields(conditions: readonly FilterCondition[], fields: readonly string[]): FilterCondition[] {
  const single = new Set(fields)
  const normalized: FilterCondition[] = []
  for (const condition of conditions) {
    const index = single.has(condition.field) ? normalized.findIndex(entry => entry.field === condition.field) : -1
    if (index === -1) normalized.push(condition)
    else normalized[index] = condition
  }
  return normalized
}

/** Mirrors the legacy single-value filters into shared FilterCard conditions. */
export function teamFilterConditions(state: TeamCollectionInteraction, memberId?: string | null): FilterCondition[] {
  if (state.conditions) return withSingleTeamFields(state.conditions, singleTeamFields)
  const conditions: FilterCondition[] = []
  if (state.focusFilter) conditions.push({ field: "focus", operator: "is", values: [state.focusFilter] })
  if (state.presenceFilter && state.presenceFilter !== "all") conditions.push({ field: "presence", operator: "is", values: [state.presenceFilter] })
  if (state.teamId) conditions.push({ field: "team", operator: "is", values: [state.teamId] })
  const member = state.memberFilter ?? memberId
  if (member) conditions.push({ field: "member", operator: "is", values: [member] })
  return conditions
}

/** Keeps URL/state semantics alive while the shared conditions stay authoritative. */
export function withTeamFilterConditions(state: TeamCollectionInteraction, conditions: readonly FilterCondition[]): TeamCollectionInteraction {
  const normalized = withSingleTeamFields(conditions, singleTeamFields)
  const positive = (field: TeamFilterField) => {
    const condition = normalized.find(entry => entry.field === field && entry.values.length)
    return condition?.operator === "is" ? condition.values[0] ?? null : null
  }
  return {
    ...state,
    conditions: normalized,
    focusFilter: positive("focus"),
    presenceFilter: (() => {
      const presence = positive("presence")
      return presence === "available" || presence === "away" || presence === "offline" ? presence : "all"
    })(),
    teamId: positive("team"),
    memberFilter: positive("member"),
  }
}

/** AND across conditions, OR inside one condition's values; `isNot` negates. */
export function teamMatchesConditions(team: ControlledTeam, conditions: readonly FilterCondition[], members: PresenceLookup): boolean {
  return conditions.every(condition => {
    if (!condition.values.length) return true
    if (!teamFilterFields.includes(condition.field as TeamFilterField)) return true
    const values = new Set(condition.values)
    const hit = condition.field === "focus"
      ? !!team.focus && values.has(team.focus)
      : condition.field === "presence"
        ? team.members.some(entry => { const presence = members.get(entry.userId)?.presence; return !!presence && values.has(presence) })
        : condition.field === "team"
          ? values.has(team.id)
          : condition.field === "member"
            ? team.members.some(entry => values.has(entry.userId))
            : true
    return condition.operator === "isNot" ? !hit : hit
  })
}

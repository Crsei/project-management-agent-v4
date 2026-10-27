import type { PmMembership, PmScenario } from "./model"
import { pmClock } from "./model"
import {
  createTeamList1Fixtures,
  type DirectoryTeam,
} from "./team-list-1-fixtures"
import {
  createPeopleFixtures,
  type AccessRole,
  type PersonFixture,
} from "./people-fixtures"

export const peopleDomainRevision = "pm-people-domain-2026-10-12-v1"

export interface DomainInviteRow {
  email: string
  role: AccessRole
}

export type InviteRowOutcome = "confirmed" | "rejected" | "unknown"

export interface InviteRequest {
  id: string
  rows: DomainInviteRow[]
  rowOutcomes: InviteRowOutcome[]
  resolved: "pending" | "confirmed" | "rejected"
}

export interface PendingInvite {
  id: string
  email: string
  role: AccessRole
  invitedAt: string
  status: "pending" | "checking"
  requestId?: string
}

export interface PeopleDomain {
  people: PersonFixture[]
  teams: DirectoryTeam[]
  memberships: PmMembership[]
  pending: PendingInvite[]
  request: InviteRequest | null
  inviteRequestsById: Record<string, InviteRequest>
  sequence: number
}

const seedPending: readonly PendingInvite[] = [
  {
    id: "pm-invite-seed-1",
    email: "jordan.blake@example.com",
    role: "member",
    invitedAt: "2026-01-08T10:00:00Z",
    status: "pending",
  },
  {
    id: "pm-invite-seed-2",
    email: "priya.nair@example.com",
    role: "guest",
    invitedAt: "2026-01-10T15:30:00Z",
    status: "pending",
  },
]

export function createPeopleDomain(scenario: PmScenario): PeopleDomain {
  const directory = createTeamList1Fixtures(scenario)
  return {
    people: createPeopleFixtures(scenario),
    teams: directory.teams,
    memberships: directory.memberships,
    pending:
      scenario === "empty" ? [] : seedPending.map((item) => ({ ...item })),
    request: null,
    inviteRequestsById: {},
    sequence: 0,
  }
}

export function restorePeopleDomain(cached: unknown): PeopleDomain {
  const state = cached as PeopleDomain
  if (state.inviteRequestsById) return state
  return { ...state, inviteRequestsById: state.request ? { [state.request.id]: state.request } : {} }
}

export function getInviteRequest(state: PeopleDomain, id: string): InviteRequest | undefined {
  return state.inviteRequestsById[id]
}

export function setPeopleAvailability(
  state: PeopleDomain,
  memberId: string,
  value: PersonFixture["availability"],
): PeopleDomain {
  const person = state.people.find((item) => item.memberId === memberId)
  if (!person || person.availability === value) return state
  return {
    ...state,
    people: state.people.map((item) =>
      item.memberId === memberId ? { ...item, availability: value } : item,
    ),
  }
}

export function setPeopleAccessRole(
  state: PeopleDomain,
  memberId: string,
  role: AccessRole,
): PeopleDomain {
  const person = state.people.find((item) => item.memberId === memberId)
  if (!person || person.accessRole === role) return state
  return {
    ...state,
    people: state.people.map((item) =>
      item.memberId === memberId ? { ...item, accessRole: role } : item,
    ),
  }
}

/** Team/project membership role only; never touches org job role or access role. */
export function setPeopleMembershipRole(
  state: PeopleDomain,
  teamId: string,
  memberId: string,
  role: PmMembership["role"],
): PeopleDomain {
  const membership = state.memberships.find(
    (item) => item.teamId === teamId && item.memberId === memberId,
  )
  if (!membership || membership.role === role) return state
  return {
    ...state,
    memberships: state.memberships.map((item) =>
      item.teamId === teamId && item.memberId === memberId
        ? { ...item, role }
        : item,
    ),
  }
}

function createdInvites(
  request: InviteRequest,
  previous?: readonly InviteRowOutcome[],
): PendingInvite[] {
  const invites: PendingInvite[] = []
  for (let index = 0; index < request.rows.length; index++) {
    if (request.rowOutcomes[index] !== "confirmed" || previous?.[index] === "confirmed") continue
    const row = request.rows[index]
    invites.push({
      id: `pm-invite-${request.id}-${index + 1}`,
      email: row.email.trim(),
      role: row.role,
      invitedAt: pmClock,
      status: "pending",
      requestId: request.id,
    })
  }
  return invites
}

function inviteResolution(
  outcomes: readonly InviteRowOutcome[],
  fallback: InviteRowOutcome,
): InviteRequest["resolved"] {
  let confirmed = false
  for (const outcome of outcomes) {
    if (outcome === "unknown") return "pending"
    if (outcome === "confirmed") confirmed = true
  }
  if (!outcomes.length) return fallback === "unknown" ? "pending" : fallback
  return confirmed ? "confirmed" : "rejected"
}

/**
 * Records the immutable original invite request. While a request is pending
 * (unknown) no new request may start and nothing replays automatically; only
 * reconcileInviteRequest with an explicit known result resolves it.
 */
export function startInviteRequest(
  state: PeopleDomain,
  rows: DomainInviteRow[],
  outcome: InviteRowOutcome,
  rowOutcomes?: readonly InviteRowOutcome[],
): PeopleDomain {
  if (state.request?.resolved === "pending") return state
  if (rowOutcomes && rowOutcomes.length !== rows.length)
    throw new RangeError("Each original invitation row needs exactly one outcome")
  const sequence = state.sequence + 1
  const request: InviteRequest = {
    id: `pm-invite-request-${sequence}`,
    rows: rows.map((row) => ({ ...row })),
    rowOutcomes: rows.map((_, index) => rowOutcomes ? rowOutcomes[index] : outcome),
    resolved: "pending",
  }
  request.resolved = inviteResolution(request.rowOutcomes, outcome)
  const created = createdInvites(request)
  return {
    ...state,
    sequence,
    request,
    inviteRequestsById: { ...state.inviteRequestsById, [request.id]: request },
    pending: created.length ? [...state.pending, ...created] : state.pending,
  }
}

export function reconcileInviteRequest(
  state: PeopleDomain,
  outcome: "confirmed" | "rejected",
): PeopleDomain {
  const request = state.request
  if (!request || request.resolved !== "pending") return state
  const reconciled: InviteRequest = {
    ...request,
    rowOutcomes: request.rowOutcomes.map((previous) => previous === "unknown" ? outcome : previous),
    resolved: "pending",
  }
  reconciled.resolved = inviteResolution(reconciled.rowOutcomes, outcome)
  const created = createdInvites(reconciled, request.rowOutcomes)
  return {
    ...state,
    request: reconciled,
    inviteRequestsById: { ...state.inviteRequestsById, [reconciled.id]: reconciled },
    pending: created.length ? [...state.pending, ...created] : state.pending,
  }
}

export function cancelPendingInvite(
  state: PeopleDomain,
  inviteId: string,
): PeopleDomain {
  const invite = state.pending.find(
    (item) => item.id === inviteId && item.status === "pending",
  )
  if (!invite) return state
  return {
    ...state,
    pending: state.pending.filter((item) => item.id !== inviteId),
  }
}

/** Local member contacts plus active pending invitations; used for uniqueness. */
export function occupiedInviteEmails(state: PeopleDomain): Set<string> {
  const occupied = new Set<string>()
  for (const person of state.people)
    if (person.contact) occupied.add(person.contact.email.toLowerCase())
  for (const invite of state.pending)
    if (invite.status === "pending") occupied.add(invite.email.toLowerCase())
  return occupied
}

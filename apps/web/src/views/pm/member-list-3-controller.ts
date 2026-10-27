import type { Locale } from "@/lib/i18n-core"
import { pmClock } from "./model"
import type { AccessRole } from "./people-fixtures"
import {
  directoryRows,
  personMatchesQuery,
  type PersonRow,
} from "./people-controller"
import {
  cancelPendingInvite,
  getInviteRequest,
  occupiedInviteEmails,
  reconcileInviteRequest,
  setPeopleAccessRole,
  startInviteRequest,
  type PeopleDomain,
  type PendingInvite,
  type InviteRequest,
} from "./people-domain"

export type InviteOutcome = "confirmed" | "rejected" | "unknown"

export interface InviteDraftRow {
  key: string
  email: string
  role: AccessRole
  outcome?: InviteOutcome
}

export type InviteRowError = "" | "required" | "invalid" | "duplicate"

export type InviteMessage =
  | ""
  | "required"
  | "invalid"
  | "duplicate"
  | "confirmed"
  | "rejected"
  | "unknown"
  | "partial"
  | "checked-partial"
  | "suggestion-prepared"
  | "checked-confirmed"
  | "checked-rejected"
  | "shared-checked-confirmed"
  | "shared-checked-rejected"
  | "shared-checked-partial"
  | "invite-cancelled"
  | "role-updated"

export interface MemberList3State {
  tab: "members" | "invitations" | "suggested"
  query: string
  roleFilter: "all" | AccessRole
  securityFilter: "any" | "enrolled" | "missing"
  sort: "joined-desc" | "joined-asc" | "name-asc" | "name-desc"
  selectedIds: string[]
  inviteSelectedIds: string[]
  accessId: string | null
  rows: InviteDraftRow[]
  rowSequence: number
  rowErrors: Record<string, InviteRowError>
  outcome: InviteOutcome
  checkOutcome: "confirmed" | "rejected"
  message: InviteMessage
  inviteRequestId: string | null
  inviteRequestPending: boolean
  sharedCheckRequestId: string | null
  inviteReceipt: { id: string; email: string } | null
  roleReceipt: { memberId: string; role: AccessRole } | null
  copyResult: { email: string; success: boolean } | null
}

const blankRow = (): InviteDraftRow => ({
  key: "row-0",
  email: "",
  role: "member",
})

export function createMemberList3State(): MemberList3State {
  return {
    tab: "members",
    query: "",
    roleFilter: "all",
    securityFilter: "any",
    sort: "joined-desc",
    selectedIds: [],
    inviteSelectedIds: [],
    accessId: null,
    rows: [blankRow()],
    rowSequence: 0,
    rowErrors: {},
    outcome: "confirmed",
    checkOutcome: "confirmed",
    message: "",
    inviteRequestId: null,
    inviteRequestPending: false,
    sharedCheckRequestId: null,
    inviteReceipt: null,
    roleReceipt: null,
    copyResult: null,
  }
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateRows(
  state: MemberList3State,
  domain: PeopleDomain,
): Record<string, InviteRowError> {
  const errors: Record<string, InviteRowError> = {}
  const occupied = occupiedInviteEmails(domain)
  for (const row of state.rows) {
    const email = row.email.trim().toLowerCase()
    if (!email) {
      errors[row.key] = "required"
      continue
    }
    if (!emailPattern.test(email)) {
      errors[row.key] = "invalid"
      continue
    }
    if (occupied.has(email)) {
      errors[row.key] = "duplicate"
      continue
    }
    occupied.add(email)
  }
  return errors
}

function clearedValidation(state: MemberList3State): InviteMessage {
  return state.message === "required" ||
    state.message === "invalid" ||
    state.message === "duplicate"
    ? ""
    : state.message
}

export function addInviteRow(state: MemberList3State): MemberList3State {
  const rowSequence = state.rowSequence + 1
  return {
    ...state,
    rowSequence,
    rows: [
      ...state.rows,
      { key: `row-${rowSequence}`, email: "", role: "member" },
    ],
  }
}

export function removeInviteRow(
  state: MemberList3State,
  key: string,
): MemberList3State {
  return {
    ...state,
    rows: state.rows.filter((row) => row.key !== key),
    rowErrors: {},
    message: clearedValidation(state),
  }
}

export function setInviteRowEmail(
  state: MemberList3State,
  key: string,
  email: string,
): MemberList3State {
  return {
    ...state,
    rows: state.rows.map((row) => (row.key === key ? { ...row, email } : row)),
    rowErrors: {},
    message: clearedValidation(state),
  }
}

export function setInviteRowRole(
  state: MemberList3State,
  key: string,
  role: AccessRole,
): MemberList3State {
  return {
    ...state,
    rows: state.rows.map((row) => (row.key === key ? { ...row, role } : row)),
  }
}

export function submitInvites(
  state: MemberList3State,
  domain: PeopleDomain,
): { page: MemberList3State; domain: PeopleDomain } {
  if (domain.request?.resolved === "pending") return { page: state, domain }
  const errors = validateRows(state, domain)
  const firstError = state.rows.find((row) => errors[row.key])
  if (firstError)
    return {
      page: {
        ...state,
        rowErrors: errors,
        message: errors[firstError.key] as "required" | "invalid" | "duplicate",
      },
      domain,
    }
  const outcomes = state.rows.map((row) => row.outcome ?? state.outcome)
  const nextDomain = startInviteRequest(
    domain,
    state.rows.map((row) => ({ email: row.email.trim(), role: row.role })),
    state.outcome,
    outcomes,
  )
  const confirmed = state.rows.filter((_, index) => outcomes[index] === "confirmed")
  const retained = state.rows.filter((_, index) => outcomes[index] !== "confirmed")
  return {
    page: {
      ...state,
      inviteRequestId: nextDomain.request?.id ?? null,
      inviteRequestPending: outcomes.includes("unknown"),
      sharedCheckRequestId: null,
      rowErrors: {},
      message: outcomes.includes("unknown")
        ? "unknown"
        : confirmed.length && retained.length
          ? "partial"
          : confirmed.length ? "confirmed" : "rejected",
      rows: retained.length ? retained : [blankRow()],
      inviteReceipt: confirmed.length
        ? {
            id: nextDomain.request?.id ?? "",
            email: confirmed.map((row) => row.email.trim()).join(", "),
          }
        : null,
    },
    domain: nextDomain,
  }
}

export function checkInviteResult(
  state: MemberList3State,
  domain: PeopleDomain,
): { page: MemberList3State; domain: PeopleDomain } {
  if (domain.request?.resolved !== "pending") return { page: state, domain }
  const correlated = syncMemberList3Request(state, domain)
  const nextDomain = reconcileInviteRequest(domain, state.checkOutcome)
  const request = nextDomain.request!
  if (correlated.inviteRequestId === request.id)
    return { page: settledInvitePage(correlated, request), domain: nextDomain }
  const confirmed = request.rowOutcomes.includes("confirmed")
  const rejected = request.rowOutcomes.includes("rejected")
  return {
    page: {
      ...correlated,
      sharedCheckRequestId: request.id,
      message: confirmed && rejected
        ? "shared-checked-partial"
        : confirmed ? "shared-checked-confirmed" : "shared-checked-rejected",
    },
    domain: nextDomain,
  }
}

function settledInvitePage(state: MemberList3State, request: InviteRequest): MemberList3State {
  const retained = request.rows.flatMap((row, index) => {
    if (request.rowOutcomes[index] === "confirmed") return []
    const existing = state.rows.find((draft) => draft.email.trim().toLowerCase() === row.email.toLowerCase())
    return [{ ...row, email: existing?.email ?? row.email, key: existing?.key ?? `${request.id}-row-${index}`, outcome: existing?.outcome }]
  })
  const confirmed = request.rows.filter((_, index) => request.rowOutcomes[index] === "confirmed")
  return {
    ...state,
    inviteRequestId: request.id,
    inviteRequestPending: false,
    message: confirmed.length && retained.length
      ? "checked-partial"
      : confirmed.length ? "checked-confirmed" : "checked-rejected",
    rows: retained.length ? retained : [blankRow()],
    rowErrors: {},
    inviteReceipt: confirmed.length
      ? { id: request.id, email: confirmed.map((row) => row.email).join(", ") }
      : null,
  }
}

/** Settles only the correlated request; external checks never replay a write. */
export function syncMemberList3Request(state: MemberList3State, domain: PeopleDomain): MemberList3State {
  const owned = state.inviteRequestId ? getInviteRequest(domain, state.inviteRequestId) : null
  if (owned && owned.resolved !== "pending" && (state.inviteRequestPending || state.message === "unknown"))
    return settledInvitePage(state, owned)
  const request = domain.request
  if (!request || request.resolved !== "pending") return state
  if (state.inviteRequestId == null && state.message === "unknown" &&
      state.rows.length > 0 && state.rows.every((draft) => request.rows.some((row) =>
        row.email.trim().toLowerCase() === draft.email.trim().toLowerCase() && row.role === draft.role)))
    return { ...state, inviteRequestId: request.id, inviteRequestPending: true }
  if (state.inviteRequestId === request.id)
    return state.inviteRequestPending ? state : { ...state, inviteRequestPending: true }
  if (state.inviteRequestId !== null || Object.keys(state.rowErrors).length > 0 || state.rows.length !== 1 ||
      state.rows[0].email.trim() || state.rows[0].role !== "member" ||
      state.rows[0].outcome !== undefined) return state
  return {
    ...state,
    inviteRequestId: request.id,
    inviteRequestPending: true,
    message: "unknown",
    rows: request.rows.flatMap((row, index) => request.rowOutcomes[index] === "confirmed"
      ? []
      : [{ ...row, key: `${request.id}-row-${index}` }]),
    rowErrors: {},
  }
}

export function cancelInvite(
  state: MemberList3State,
  domain: PeopleDomain,
  inviteId: string,
): { page: MemberList3State; domain: PeopleDomain } {
  const invite = domain.pending.find((item) => item.id === inviteId)
  const nextDomain = cancelPendingInvite(domain, inviteId)
  if (nextDomain === domain) return { page: state, domain }
  return {
    page: {
      ...state,
      message: "invite-cancelled",
      inviteSelectedIds: state.inviteSelectedIds.filter((id) => id !== inviteId),
      inviteReceipt: invite
        ? { id: invite.id, email: invite.email }
        : state.inviteReceipt,
    },
    domain: nextDomain,
  }
}

export function updateMemberRole(
  state: MemberList3State,
  domain: PeopleDomain,
  memberId: string,
  role: AccessRole,
): { page: MemberList3State; domain: PeopleDomain } {
  const nextDomain = setPeopleAccessRole(domain, memberId, role)
  if (nextDomain === domain) return { page: state, domain }
  return {
    page: {
      ...state,
      message: "role-updated",
      roleReceipt: { memberId, role },
    },
    domain: nextDomain,
  }
}

export function visibleMemberTableRows(
  state: MemberList3State,
  domain: PeopleDomain,
  locale: Locale,
): PersonRow[] {
  return directoryRows(domain)
    .filter(
      (row) =>
        personMatchesQuery(domain, row, state.query, locale) &&
        (state.roleFilter === "all" ||
          row.person.accessRole === state.roleFilter) &&
        (state.securityFilter === "any" ||
          (state.securityFilter === "enrolled"
            ? row.person.twoFactor
            : !row.person.twoFactor)),
    )
    .sort((a, b) => {
      if (state.sort === "name-asc" || state.sort === "name-desc") {
        const names = a.member.name.localeCompare(b.member.name, locale)
        return (state.sort === "name-desc" ? -names : names) || a.member.id.localeCompare(b.member.id)
      }
      return state.sort === "joined-desc"
        ? b.person.joinedAt.localeCompare(a.person.joinedAt)
        : a.person.joinedAt.localeCompare(b.person.joinedAt)
    })
}

/** Pending invitations plus a derived awaiting-check row for an unknown request. */
export function pendingRows(domain: PeopleDomain): PendingInvite[] {
  const checking: PendingInvite[] = domain.request?.resolved === "pending"
    ? domain.request.rows.flatMap((row, index) => domain.request!.rowOutcomes[index] === "unknown"
      ? [{
          id: `checking-${domain.request!.id}-${index + 1}`,
          email: row.email,
          role: row.role,
          invitedAt: pmClock,
          status: "checking" as const,
          requestId: domain.request!.id,
        }]
      : [])
    : []
  return [...checking, ...domain.pending]
}

export interface SuggestedInviteCandidate {
  id: string
  name: string
  email: string
  role: AccessRole
}

// Local invitation candidates, not directory members or verified identities.
const suggestedCandidates: readonly SuggestedInviteCandidate[] = [
  { id: "pm-suggestion-lin", name: "Lin Parker", email: "lin.parker@example.com", role: "member" },
  { id: "pm-suggestion-robin", name: "Robin Taylor", email: "robin.taylor@example.com", role: "guest" },
]

export function suggestedRows(
  state: MemberList3State,
  domain: PeopleDomain,
  empty: boolean,
): SuggestedInviteCandidate[] {
  if (empty) return []
  const occupied = occupiedInviteEmails(domain)
  for (const row of domain.request?.resolved === "pending" ? domain.request.rows : [])
    occupied.add(row.email.trim().toLowerCase())
  const query = state.query.trim().toLowerCase()
  return suggestedCandidates.filter((candidate) =>
    !occupied.has(candidate.email) &&
    `${candidate.name} ${candidate.email}`.toLowerCase().includes(query) &&
    (state.roleFilter === "all" || candidate.role === state.roleFilter),
  )
}

export function prepareSuggestedInvite(
  state: MemberList3State,
  candidate: SuggestedInviteCandidate,
): MemberList3State {
  const existing = state.rows.some((row) => row.email.trim().toLowerCase() === candidate.email)
  if (existing) return { ...state, message: "suggestion-prepared" }
  const rowSequence = state.rowSequence + 1
  const row = { key: `row-${rowSequence}`, email: candidate.email, role: candidate.role }
  return {
    ...state,
    rowSequence,
    rows: state.rows.length === 1 && !state.rows[0].email.trim() ? [row] : [...state.rows, row],
    rowErrors: {},
    message: "suggestion-prepared",
  }
}

import type { Locale } from "@/lib/i18n-core"
import type { PmMembership } from "./model"
import type { AccessRole, Availability } from "./people-fixtures"
import type { DirectoryTeam } from "./team-list-1-fixtures"
import {
  directoryRows,
  personMatchesQuery,
  teamsForMember,
  type PersonRow,
} from "./people-controller"
import {
  getInviteRequest,
  reconcileInviteRequest,
  startInviteRequest,
  type PeopleDomain,
} from "./people-domain"

export type FixtureOutcome = "confirmed" | "rejected" | "unknown"
export type InviteMessage =
  | ""
  | "required"
  | "invalid"
  | "duplicate"
  | "confirmed"
  | "rejected"
  | "unknown"
  | "checked-confirmed"
  | "checked-rejected"

export interface MemberInviteDraft {
  email: string
  role: AccessRole
}

export interface MemberList1State {
  query: string
  availabilityFilter: Availability[]
  roleFilter: AccessRole[]
  sort:
    | "name-asc"
    | "name-desc"
    | "joined-asc"
    | "joined-desc"
    | "teams-asc"
    | "teams-desc"
  density: "compact" | "comfortable"
  hiddenColumns?: string[]
  selectedId: string | null
  teamsDialogMemberId: string | null
  availabilityReceipt: { memberId: string; value: Availability } | null
  inviteOpen: boolean
  inviteDraft: MemberInviteDraft | null
  /** The immutable request created by this draft, never a shared check target. */
  inviteRequestId: string | null
  inviteReceiptRequestId: string | null
  inviteOutcome: FixtureOutcome
  inviteCheckOutcome: "confirmed" | "rejected"
  inviteResult: "idle" | "validation" | FixtureOutcome | "checked"
  inviteMessage: InviteMessage
}

// Restore the prior cache schema without replacing drafts or selection.
export function createMemberList1State(previous?: unknown): MemberList1State {
  const initial: MemberList1State = {
    query: "",
    availabilityFilter: [],
    roleFilter: [],
    sort: "name-asc",
    density: "compact",
    hiddenColumns: [],
    selectedId: null,
    teamsDialogMemberId: null,
    availabilityReceipt: null,
    inviteOpen: false,
    inviteDraft: null,
    inviteRequestId: null,
    inviteReceiptRequestId: null,
    inviteOutcome: "confirmed",
    inviteCheckOutcome: "confirmed",
    inviteResult: "idle",
    inviteMessage: "",
  }
  if (!previous || typeof previous !== "object") return initial
  const cached = previous as Partial<MemberList1State>
  const filters = previous as {
    availabilityFilter?: unknown
    roleFilter?: unknown
  }
  const savedSort = (previous as { sort?: unknown }).sort
  const receiptRequestId =
    cached.inviteReceiptRequestId ?? cached.inviteRequestId ?? null
  return {
    ...initial,
    ...cached,
    // The prior checked ID could belong to an unrelated shared request.
    inviteRequestId:
      cached.inviteReceiptRequestId === undefined &&
      cached.inviteResult === "checked" &&
      cached.inviteDraft
        ? null
        : (cached.inviteRequestId ?? null),
    inviteReceiptRequestId: receiptRequestId,
    sort:
      savedSort === "name"
        ? "name-asc"
        : savedSort === "joined"
          ? "joined-asc"
          : savedSort === "availability"
            ? "name-asc"
            : (cached.sort ?? initial.sort),
    availabilityFilter: Array.isArray(filters.availabilityFilter)
      ? filters.availabilityFilter
      : filters.availabilityFilter && filters.availabilityFilter !== "all"
        ? [filters.availabilityFilter as Availability]
        : [],
    roleFilter: Array.isArray(filters.roleFilter)
      ? filters.roleFilter
      : filters.roleFilter && filters.roleFilter !== "all"
        ? [filters.roleFilter as AccessRole]
        : [],
  }
}
export interface MemberDirectoryRow extends PersonRow {
  teams: { team: DirectoryTeam; role: PmMembership["role"] }[]
}

export function visibleMemberRows(
  state: MemberList1State,
  domain: PeopleDomain,
  locale: Locale,
): MemberDirectoryRow[] {
  const rows = directoryRows(domain)
    .filter((row) => {
      const person = row.person
      return (
        personMatchesQuery(domain, row, state.query, locale) &&
        (state.availabilityFilter.length === 0 ||
          state.availabilityFilter.includes(person.availability)) &&
        (state.roleFilter.length === 0 ||
          state.roleFilter.includes(person.accessRole))
      )
    })
    .map((row) => ({ ...row, teams: teamsForMember(domain, row.member.id) }))
  return rows.sort((a, b) => {
    let compared: number
    switch (state.sort) {
      case "name-desc":
        return b.member.name.localeCompare(a.member.name, locale)
      case "joined-asc":
        compared = a.person.joinedAt.localeCompare(b.person.joinedAt)
        break
      case "joined-desc":
        compared = b.person.joinedAt.localeCompare(a.person.joinedAt)
        break
      case "teams-asc":
        compared = a.teams.length - b.teams.length
        break
      case "teams-desc":
        compared = b.teams.length - a.teams.length
        break
      default:
        return a.member.name.localeCompare(b.member.name, locale)
    }
    return compared || a.member.name.localeCompare(b.member.name, locale)
  })
}

export function openInvite(state: MemberList1State): MemberList1State {
  if (state.inviteOpen) return state
  return {
    ...state,
    inviteOpen: true,
    inviteResult: state.inviteDraft ? state.inviteResult : "idle",
    inviteMessage: state.inviteDraft ? state.inviteMessage : "",
    inviteDraft: state.inviteDraft ?? { email: "", role: "member" },
    inviteRequestId: state.inviteDraft ? state.inviteRequestId : null,
    inviteReceiptRequestId: state.inviteDraft ? state.inviteReceiptRequestId : null,
  }
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function submitMemberInvite(
  state: MemberList1State,
  domain: PeopleDomain,
): { page: MemberList1State; domain: PeopleDomain } {
  if (!state.inviteDraft || domain.request?.resolved === "pending")
    return { page: state, domain }
  const draft = state.inviteDraft
  const email = draft.email.trim()
  if (!email)
    return {
      page: {
        ...state,
        inviteResult: "validation",
        inviteMessage: "required",
        inviteRequestId: null,
        inviteReceiptRequestId: null,
      },
      domain,
    }
  if (!emailPattern.test(email))
    return {
      page: {
        ...state,
        inviteResult: "validation",
        inviteMessage: "invalid",
        inviteRequestId: null,
        inviteReceiptRequestId: null,
      },
      domain,
    }
  const occupied = new Set([
    ...domain.people.flatMap((person) =>
      person.contact ? [person.contact.email.trim().toLowerCase()] : [],
    ),
    ...domain.pending.map((invite) => invite.email.trim().toLowerCase()),
  ])
  if (occupied.has(email.toLowerCase()))
    return {
      page: {
        ...state,
        inviteResult: "validation",
        inviteMessage: "duplicate",
        inviteRequestId: null,
        inviteReceiptRequestId: null,
      },
      domain,
    }
  const nextDomain = startInviteRequest(
    domain,
    [{ email, role: draft.role }],
    state.inviteOutcome,
  )
  const confirmed = state.inviteOutcome === "confirmed"
  return {
    page: {
      ...state,
      inviteRequestId: nextDomain.request?.id ?? null,
      inviteReceiptRequestId: nextDomain.request?.id ?? null,
      inviteResult: state.inviteOutcome,
      inviteMessage: state.inviteOutcome,
      inviteOpen: confirmed ? false : state.inviteOpen,
      inviteDraft: confirmed ? null : draft,
    },
    domain: nextDomain,
  }
}

export function syncMemberList1Request(
  state: MemberList1State,
  domain: PeopleDomain,
): MemberList1State {
  if (state.inviteResult !== "unknown" || !state.inviteRequestId) return state
  const request = getInviteRequest(domain, state.inviteRequestId)
  if (!request || request.resolved === "pending") return state
  const confirmed = request.resolved === "confirmed"
  const ownsDraft = request.rows.some(
    (row) =>
      row.email.trim().toLowerCase() ===
        state.inviteDraft?.email.trim().toLowerCase() &&
      row.role === state.inviteDraft?.role,
  )
  return {
    ...state,
    inviteReceiptRequestId: request.id,
    inviteResult: "checked",
    inviteMessage: confirmed ? "checked-confirmed" : "checked-rejected",
    inviteOpen: confirmed && ownsDraft ? false : state.inviteOpen,
    inviteDraft: confirmed && ownsDraft ? null : state.inviteDraft,
  }
}

export function checkMemberInviteResult(
  state: MemberList1State,
  domain: PeopleDomain,
): { page: MemberList1State; domain: PeopleDomain } {
  const page = syncMemberList1Request(state, domain)
  const request = domain.request
  if (request?.resolved !== "pending") return { page, domain }
  const confirmed = page.inviteCheckOutcome === "confirmed"
  const reconcilesDraft =
    page.inviteRequestId === request.id &&
    request.rows.some(
      (row) =>
        row.email.trim().toLowerCase() ===
          page.inviteDraft?.email.trim().toLowerCase() &&
        row.role === page.inviteDraft?.role,
    )
  const nextDomain = reconcileInviteRequest(domain, page.inviteCheckOutcome)
  return {
    page: {
      ...page,
      inviteReceiptRequestId: request.id,
      inviteResult: "checked",
      inviteMessage: confirmed ? "checked-confirmed" : "checked-rejected",
      inviteOpen: confirmed && reconcilesDraft ? false : page.inviteOpen,
      inviteDraft: confirmed && reconcilesDraft ? null : page.inviteDraft,
    },
    domain: nextDomain,
  }
}

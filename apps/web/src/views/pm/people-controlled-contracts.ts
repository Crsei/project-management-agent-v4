import type { Dispatch, ReactNode, SetStateAction } from "react"
import type { FilterCondition } from "../../lib/filter-model.ts"
import type { PmControlledData, PmControlledSurface, ControlledIssueRecord } from "./controlled-contracts"
import type { ProjectCollectionRecord } from "./project-collection-contracts"

/** Service-independent records. Membership identity is never a user identity.
 * Business strings are displayed verbatim; unknown facts are null, not fixtures.
 * The host owns permissions, CAS versions, drafts, requests and all mutations. */
export type ControlledPresence = "available" | "away" | "offline"
export type ControlledMember = {
  membershipId: string
  userId: string
  name: string
  email: string
  role: number
  scope: "workspace" | "project" | "unknown"
  projectId: string | null
  isActive: boolean
  isOwner: boolean
  version: string
  companyRole?: string | null
  avatarDataUrl?: string | null
  /** Source-provided team summaries; no team membership role is inferred. */
  teams?: readonly { id: string; name: string }[]
  phone?: string | null
  joinedAt?: string | null
  ownership?: string | null
  engagement?: string | null
  twoFactor?: boolean | null
  /** Source-provided presence, independent of isActive membership status. */
  presence?: ControlledPresence | null
}
export type ControlledTeam = {
  id: string
  name: string
  description: string
  identifier?: string | null
  focus?: string | null
  responseTarget?: string | null
  activityAt?: string | null
  /** Authorized visible facts; incomplete scope must not be presented as a total. */
  openWorkCount?: number | null
  scopeComplete?: boolean
  /** A TeamMembership identity is independent of workspace/project membership
   * identities. Resolve display identity by userId; keep membershipId as row key. */
  members: readonly { membershipId: string; userId: string; role: "maintainer" | "member" }[]
  projectIds: readonly string[]
  version: string
}
export type PeopleRoleOption = { value: number; label: string }
/** A source-provided invitation candidate, not a member or verified identity. */
export type ControlledSuggestedContact = { id: string; name: string; email: string; role: number }
/** confirmed means the invitation record is confirmed, not delivered or joined.
 * smtpAccepted means the SMTP server accepted it, not recipient delivery.
 * accepted means the invite was redeemed, not merely an email record created. */
export type ControlledInvitation = {
  id: string
  email: string
  role: number
  requestId: string | null
  status: "unknown" | "rejected" | "confirmed" | "smtpAccepted" | "accepted" | "pending" | "revoked" | "expired"
  createdAt: string | null
  error: string | null
  version?: number
  expiresAt?: string | null
  deliveryStatus?: "queued" | "sending" | "smtp_accepted" | "failed" | "unknown" | "cancelled" | null
}
export type PeopleContactKind = "email" | "phone" | "contact"
export type ControlledContactCopyReceipt = { membershipId: string; kind: PeopleContactKind; ok: boolean }
export type MemberDirectorySort = "name" | "name-desc" | "role" | "joined" | "joined-desc" | "teams" | "teams-desc" | "presence"
/** Optional clipboard actions use real contact facts, never service mutations. */
export type PeopleContactCapabilities = { copyContact?: (member: ControlledMember, kind: PeopleContactKind) => boolean }
export type PeopleContactActions = { copyContact?: (member: ControlledMember, kind: PeopleContactKind, trigger: HTMLElement) => void }
/** One canonical identity per person, already filtered by the host. A selected
 * TeamMembership remains distinct from the canonical directory membership. */
export type ControlledPeopleDirectoryRow = {
  member: ControlledMember
  teams: readonly ControlledTeam[]
  membership?: { teamId: string; membershipId: string; role: "maintainer" | "member" } | null
}
export type ControlledPeopleDirectory = {
  rows: readonly ControlledPeopleDirectoryRow[]
  groups: readonly { id: string; label: string; rows: readonly ControlledPeopleDirectoryRow[] }[]
  /** Group semantics are supplied explicitly; native Teams are not departments. */
  grouping?: "teams" | "departments"
  data: PmControlledData
  totalCount?: number | null
}
/** Counts, estimates, capacity and group labels are authoritative host facts.
 * The renderer never interprets an opaque estimate-point identity as points. */
export type ControlledPeopleWorkload = {
  rows: readonly {
    id: string
    member: ControlledMember
    issues: readonly ControlledIssueRecord[]
    openCount: number
    doneCount: number
    knownOpenPoints: number | null
    unknownEstimateCount: number | null
    capacityPoints: number | null
    overloaded: boolean | null
  }[]
  unassigned: { issues: readonly ControlledIssueRecord[]; unknownAssigneeCount: number | null }
  summary: { uniqueTaskCount: number | null; rowTaskCount: number | null; overloadedMembers: number | null; unknownOverloadMembers?: number | null; unknownCapacityMembers: number | null; unknownEstimateCount: number | null }
  grouping?: "teams" | "departments"
  groups: readonly { id: string; label: string; issues: readonly ControlledIssueRecord[] }[]
  pool: readonly ControlledIssueRecord[]
}
export type MemberDirectoryInteraction = {
  query: string
  roleFilter: number | null
  /** Member1 multi-select unions; Member3 keeps its independent scalar role filter. */
  roleFilters?: readonly number[]
  presenceFilters?: readonly ControlledPresence[]
  securityFilter?: "any" | "enrolled" | "missing"
  activeFilter: "all" | "active" | "inactive"
  sort: MemberDirectorySort
  display: "grid" | "list"
  comfortable: boolean
  hiddenColumns: readonly string[]
  tab: "members" | "invitations" | "suggested"
  selectedIds: readonly string[]
  selectedId: string | null
  detailOpen: boolean
  detailReadingPosition?: number
  /** Shared FilterCard conditions; the host applies them to its own pipeline. */
  conditions?: readonly FilterCondition[] | undefined
}
export type MemberDirectoryViewProps = PmControlledSurface & {
  variant: "member1" | "member2" | "member3"
  /** A containing people workspace owns the sole page heading. */
  embedded?: boolean
  readModel: {
    /** Authoritative visible query page; filtering/sorting is host-owned. */
    members: readonly ControlledMember[]
    selectedMember?: ControlledMember | null
    teams: readonly ControlledTeam[]
    /** False means team membership was not supplied, not an empty team list. */
    teamsAvailable?: boolean
    roles: readonly PeopleRoleOption[]
    invitations: readonly ControlledInvitation[]
    invitationsData?: PmControlledData
    invitationsNotice?: string
    /** Omitted/null means unavailable; an empty authoritative page is not unavailable. */
    suggestedContacts?: { items: readonly ControlledSuggestedContact[]; data: PmControlledData } | null
    totalMemberCount?: number | null
    sortOptions?: readonly MemberDirectorySort[]
    /** Unfiltered team choices for the shared filter card; omitted when teams are unavailable. */
    teamOptions?: readonly { id: string; name: string }[] | undefined
    copyReceipt?: ControlledContactCopyReceipt | null
    data: PmControlledData
    sourceDescription?: string
  }
  interaction: MemberDirectoryInteraction
  capabilities: PeopleContactCapabilities & {
    invite: boolean
    editRole: (member: ControlledMember) => boolean
    memberOpen: (member: ControlledMember) => boolean
    reconcileInvitation: boolean
    /** The host disables writes for readonly/loading/pending/unknown operations. */
    editPresence?: (member: ControlledMember) => boolean
    prepareSuggestedInvite?: (contact: ControlledSuggestedContact) => boolean
    manageAccess?: (member: ControlledMember) => boolean
    filterPresence?: boolean
    filterRole?: boolean
    filterSecurity?: boolean
    cancelInvitation?: (invitation: ControlledInvitation) => boolean
    resendInvitation?: (invitation: ControlledInvitation) => boolean
  }
  actions: PeopleContactActions & {
    setInteraction: Dispatch<SetStateAction<MemberDirectoryInteraction>>
    memberOpen: (member: ControlledMember, trigger: HTMLElement | null) => void
    editRole: (member: ControlledMember, trigger: HTMLElement | null) => void
    invite: (trigger: HTMLElement) => void
    reconcileInvitation: (invitation: ControlledInvitation) => void
    /** No optimistic presence: render only the next authoritative host record. */
    setPresence?: (member: ControlledMember, presence: ControlledPresence, trigger: HTMLElement | null) => void
    /** Prepare/de-duplicate a retained invite draft and focus its editor. Never submit. */
    prepareSuggestedInvite?: (contact: ControlledSuggestedContact, trigger: HTMLElement) => void
    manageAccess?: (member: ControlledMember, trigger: HTMLElement | null) => void
    cancelInvitation?: (invitation: ControlledInvitation, trigger: HTMLElement) => void
    resendInvitation?: (invitation: ControlledInvitation, trigger: HTMLElement) => void
    memberWorkload?: (member: ControlledMember) => void
  }
  /** The host supplies real invitation/role forms, including retained drafts. */
  /** Host-provided access action; never relabel an account grant as an invitation. */
  headerActions?: ReactNode
  inviteDialog?: ReactNode
  inviteEditor?: ReactNode
  roleEditor?: ReactNode
  memberInspector?: ReactNode
}
export type TeamCollectionInteraction = {
  query: string
  sort: "name" | "name-desc" | "members" | "activity"
  display: "table" | "cards"
  tab: "directory" | "groups" | "workload" | "departments" | "pool"
  teamId: string | null
  selectedIds: readonly string[]
  selectedId: string | null
  detailOpen: boolean
  detailTab: "overview" | "members" | "projects"
  expandedIds: readonly string[]
  selectedMemberId?: string | null
  memberDetailOpen?: boolean
  memberDetailReadingPosition?: number
  workloadStateFilter?: "all" | "open" | "done"
  presenceFilter?: "all" | ControlledPresence
  focusFilter?: string | null
  /** Shared FilterCard conditions; when present they drive the team pipeline. */
  conditions?: readonly FilterCondition[] | undefined
  /** Team membership filter; kept separate from the legacy URL-seeded teamId. */
  memberFilter?: string | null
}
export type TeamCollectionViewProps = PmControlledSurface & {
  variant: "team1" | "team2" | "team3"
  /** A containing people workspace owns the sole page heading. */
  embedded?: boolean
  readModel: {
    /** Actual Teams, never workspace/project pseudo-teams. */
    teams: readonly ControlledTeam[]
    /** False means the source cannot supply team membership/counts, not zero teams. */
    teamsAvailable?: boolean
    selectedTeam?: ControlledTeam | null
    members: readonly ControlledMember[]
    projects: readonly ProjectCollectionRecord[]
    data: PmControlledData
    sourceDescription?: string
    /** Optional authoritative person-centric projections retain the approved variants. */
    directory?: ControlledPeopleDirectory | null
    workload?: ControlledPeopleWorkload | null
    taskEstimates?: Readonly<Record<string, number | null>>
    unavailableAssigneeTaskIds?: readonly string[]
    selectedMember?: ControlledMember | null
    teamOptions?: readonly ControlledTeam[]
    roles?: readonly PeopleRoleOption[]
    copyReceipt?: ControlledContactCopyReceipt | null
  }
  interaction: TeamCollectionInteraction
  capabilities: PeopleContactCapabilities & {
    create: boolean
    edit: (team: ControlledTeam) => boolean
    members: (team: ControlledTeam) => boolean
    projectRelations: (team: ControlledTeam) => boolean
    archive?: (team: ControlledTeam) => boolean
    openProject: (projectId: string) => boolean
    memberOpen: (member: ControlledMember) => boolean
    editMembership?: (row: ControlledPeopleDirectoryRow) => boolean
    filterPresence?: boolean
    /** Recent activity sorting is unavailable unless the host supplies actual dates. */
    sortActivity?: boolean
    /** Only expose a task Team filter when the host implements that projection. */
    filterWorkloadTeam?: boolean
    navigate?: (target: "members" | "workload") => boolean
  }
  actions: PeopleContactActions & {
    setInteraction: Dispatch<SetStateAction<TeamCollectionInteraction>>
    open: (team: ControlledTeam, trigger: HTMLElement | null) => void
    create: (trigger: HTMLElement) => void
    edit: (team: ControlledTeam, trigger: HTMLElement | null) => void
    members: (team: ControlledTeam, trigger: HTMLElement | null) => void
    projectRelations: (team: ControlledTeam, trigger: HTMLElement | null) => void
    archive?: (team: ControlledTeam, trigger: HTMLElement | null) => void
    openProject: (projectId: string) => void
    memberOpen: (member: ControlledMember, trigger: HTMLElement | null) => void
    openIssue?: (issue: ControlledIssueRecord) => void
    setMembershipRole?: (row: ControlledPeopleDirectoryRow, role: "maintainer" | "member", trigger: HTMLElement | null) => void
    navigate?: (target: "members" | "workload") => void
    teamWorkload?: (team: ControlledTeam) => void
    memberWorkload?: (member: ControlledMember) => void
  }
  headerActions?: ReactNode
  poolActions?: ReactNode
  memberTaskActions?: (member: ControlledMember) => ReactNode
  taskActions?: (issue: ControlledIssueRecord) => ReactNode
  editDialog?: ReactNode
  membersEditor?: ReactNode
  projectRelationsEditor?: ReactNode
  teamInspector?: ReactNode
  memberInspector?: ReactNode
}
export type ControlledNotification = {
  id: string
  title: string
  entityName: string | null
  entityId: string | null
  readAt: string | null
  archivedAt: string | null
  createdAt: string
  version: string
}
export type NotificationInboxInteraction = {
  selectedId: string | null
  query: string
  folder: "inbox" | "archive"
  unreadOnly: boolean
  ordering: "newest" | "oldest"
  unreadFirst: boolean
  showId: boolean
  showStatusIcon: boolean
  listScroll: number
  detailScroll: Readonly<Record<string, number>>
  /** Shared FilterCard conditions; the host applies them to its own pipeline. */
  conditions?: readonly FilterCondition[] | undefined
}
export type NotificationInboxViewProps = PmControlledSurface & {
  variant: "inbox3" | "inbox4"
  readModel: { notifications: readonly ControlledNotification[]; selectedNotification?: ControlledNotification | null; data: PmControlledData; sourceDescription?: string }
  interaction: NotificationInboxInteraction
  capabilities: { read: (notification: ControlledNotification) => boolean; archive: (notification: ControlledNotification) => boolean; openEntity: (notification: ControlledNotification) => boolean }
  actions: {
    setInteraction: Dispatch<SetStateAction<NotificationInboxInteraction>>
    /** Selection alone never writes read state. */
    read: (notification: ControlledNotification) => void
    archive: (notification: ControlledNotification, archived: boolean) => void
    openEntity: (notification: ControlledNotification) => void
  }
}

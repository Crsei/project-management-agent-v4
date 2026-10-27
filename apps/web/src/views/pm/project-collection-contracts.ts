import type { Dispatch, ReactNode, SetStateAction } from "react"
import type { DataRegionProps } from "@/components/ui/data-region"
import type { BadgeProps } from "@/components/ui/badge"

/** Service-independent display projection. Business content is never UI copy. */
export type ProjectCollectionRecord = {
  id: string
  identifier: string
  title: string
  description: string | null
  owner: { id: string; name: string; role: string | null } | null
  status: { value: string; label: string; tone: BadgeProps["tone"] } | null
  cycle: { value: string; label: string } | null
  cycleWeeks: number | null
  teamSize: number | null
  /** Known identities only; teamSize may include members absent from this projection. */
  members?: readonly { id: string; name: string; avatarUrl?: string | null }[]
  health: number | null
  /** Explicit human assessment; undefined keeps non-service callers' existing metric. */
  healthAssessment?: { status: "on_track" | "at_risk" | "off_track"; rationale: string } | null
  dueDate: string | null
  archived: boolean | null
  artwork: number | null
  /** Authenticated immutable cover reference, never an arbitrary remote image URL. */
  coverVersionId?: string | null
  starred: boolean | null
  taskCounts: { closed: number; total: number } | null
  updatedAt?: string | null
  teams?: readonly { id: string; name: string }[] | null
  milestone?: { title: string; date: string | null } | null
  teamId?: string | null
}
export type ProjectCollectionQuickView = "all" | "active" | "archived" | "recent" | "three" | "larger"
export type ProjectCollectionViewInteraction = {
  quickView: ProjectCollectionQuickView
  search: string
  sort: "newest" | "oldest" | "name" | "name-desc"
  teamSize: "all" | "three" | "larger" | "small" | "medium" | "large"
  updatedWithin: 0 | 7 | 14
  archiveScope: "current" | "archived" | "all"
  status: string
  starredOnly: boolean
  filtersOpen: boolean
  selectedId: string | null
  detailOpen: boolean
}
export type ProjectCollectionCapabilities = {
  create: boolean
  edit: (projectId: string) => boolean
  star: (projectId: string) => boolean
  openFullDetails: boolean
  filters: { archive: boolean; updated: boolean; status: boolean; starred: boolean; teamSize: boolean }
}
export type ProjectCollectionActions = {
  setInteraction: Dispatch<SetStateAction<ProjectCollectionViewInteraction>>
  create: (trigger: HTMLElement) => void
  edit: (projectId: string, trigger: HTMLElement | null) => void
  star: (projectId: string) => void
  openFullDetails: (projectId: string) => void
}
export type ProjectCollectionReadModel = {
  /** Authoritative current query results; the View does not filter a partial page. */
  projects: readonly ProjectCollectionRecord[]
  /** Selection may remain available when its row is filtered out. */
  selectedProject: ProjectCollectionRecord | null
  data: Pick<DataRegionProps, "state" | "refreshing" | "updatedAt" | "error" | "onRetry" | "partialDescription" | "onLoadMore" | "loadingLabel">
  defaultArchiveScope: ProjectCollectionViewInteraction["archiveScope"]
  statusOptions: readonly { value: string; label: string }[]
  sourceDescription: string
  emptyDescription: string
  healthDescription?: string
  /** Completion percentages are not schedule-health assessments. */
  healthMetric?: "assessment" | "completion"
  healthLabel?: string
  unavailableHealthLabel?: string
  unavailableTasksLabel?: string
  unavailableDateLabel?: string
  healthAssessmentLabel?: string
  /** Explicit date-only reference for days-left display; never a fixture clock. */
  referenceDate: string | null
  dateContextLabel?: string
  summaryLabel?: string
  selectedIssueSummary?: ReactNode
  renderCover?: (project: ProjectCollectionRecord, className: string) => ReactNode
}
/** The host owns service facts, permissions, writes, drafts, hydration and recovery. */
export type ProjectCollectionViewProps = {
  /** Host hydration readiness, independent from loading and write authority. */
  interactive?: boolean
  variant: "cover" | "browse" | "table" | "compact"
  readModel: ProjectCollectionReadModel
  interaction: ProjectCollectionViewInteraction
  capabilities: ProjectCollectionCapabilities
  actions: ProjectCollectionActions
  hasDraft?: boolean
  pendingRequestId?: string
  feedback?: ReactNode
  editLabel?: string
  createDialog?: ReactNode
  readingPosition?: number
  onReadingPositionChange?: (top: number) => void
  toolbarActions?: ReactNode
  headerActions?: ReactNode
  /** Secondary per-project action (for example Agent); must not replace the default open/edit actions. */
  renderProjectAction?: (project: ProjectCollectionRecord) => ReactNode
  summarySort?: ReactNode
  table?: { hiddenColumns?: readonly ("owner" | "health" | "milestone" | "team" | "updated")[]; sortableKeys?: readonly ("name" | "owner" | "health" | "milestone" | "team" | "updated" | "due")[]; sortKey?: "name" | "owner" | "health" | "milestone" | "team" | "updated" | "due"; sortDir?: "asc" | "desc"; onSort?: (key: "name" | "owner" | "health" | "milestone" | "team" | "updated" | "due") => void; rowActions?: (project: ProjectCollectionRecord) => ReactNode; onOpen?: (projectId: string) => void }
}

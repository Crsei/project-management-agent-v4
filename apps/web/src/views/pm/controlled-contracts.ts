import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react"
import type { DataRegionProps } from "@/components/ui/data-region"
import type { WorkItemCapabilities, WorkItemCatalog, WorkItemField, WorkItemOption, WorkItemPatch, WorkItemRecord, WorkItemsHierarchy, WorkItemsInteraction, WorkItemsLaneSnapshot, WorkItemsViewState, MutationState, GroupSnapshot } from "@/lib/work-items-model"
import type { CalendarSettings, DateBucketSnapshot, ScheduleChangeIntent, ScheduleViewport, TimelineSettings } from "@/lib/schedule-view-model"
import type { ScheduleDates } from "@/lib/schedule-date-utils"
import type { WorkItemsBoardMove } from "@/components/blocks/work-items-views"
import type { DataTableColumnConfig } from "@/lib/data-table-model"
import type { DataTableSort } from "@/components/blocks/data-table"
import type { WorkflowCanvas } from "@/components/blocks/workflow-canvas"
import type { ProjectCollectionRecord } from "./project-collection-contracts"

/** Private PM presentation contract, not a Plane DTO. No network, fixture session,
 * outcome simulator or write hook belongs in a controlled View. The host supplies
 * authoritative pages/counts/catalogs, per-project permissions, retained drafts,
 * focus/read positions and request identities. UI strings alone are localized;
 * title/name/description/comments are business strings and remain unchanged.
 * UUIDs are opaque. moduleIds is the complete relation, and estimatePointId is an
 * opaque catalog key, never hours/numeric points. Unavailable metrics are null.
 * Showcases keep their explicit scenario/fixture adapters. Product/BFF/Plane,
 * authentication and P5 people/hour scheduling are outside this private boundary.
 */
export type PmControlledData = Pick<DataRegionProps, "state" | "refreshing" | "showRefreshingNotice" | "updatedAt" | "error" | "onRetry" | "partialDescription" | "onLoadMore" | "loadingLabel" | "emptyDescription" | "emptyTitle" | "emptyHeadingLevel">
export type PmReadingState = { top: number; left: number }
export type PmControlledSurface = {
  /** Host hydration readiness, independent from service loading and write authority. */
  interactive?: boolean
  feedback?: ReactNode
  securityNotice?: string
  /** Host request identity remains visible even when the editor is disabled. */
  pendingRequestId?: string
  readingPosition?: number
  onReadingPositionChange?: (top: number) => void
  /** Retained DOM focus identity, provided and changed by the host. */
  focusId?: string | null
  onFocusIdChange?: (id: string) => void
}
export type ControlledIssueRecord = WorkItemRecord & {
  /** Opaque host version; the host declares whether atomic comparison is available. */
  version: string
  /** Null means no source revision exists; revision remains a UI snapshot stamp. */
  sourceRevision?: number | null
  moduleIds: readonly string[]
  cycleId: string | null
  estimatePointId: string | null
}
export type ControlledIssuePatch = WorkItemPatch & Partial<Pick<ControlledIssueRecord, "projectId" | "parentId" | "moduleIds" | "cycleId" | "estimatePointId">>
export type ControlledIssueCatalog = WorkItemCatalog & {
  projects: readonly WorkItemOption[]
  modules: readonly (WorkItemOption & { projectId: string })[]
  cycles: readonly (WorkItemOption & { projectId: string })[]
  estimatePoints: readonly (WorkItemOption & { projectId: string })[]
}
export type ControlledIssueCapabilities = WorkItemCapabilities & {
  canEditRelation: (item: ControlledIssueRecord, field: "projectId" | "parentId" | "moduleIds" | "cycleId" | "estimatePointId") => boolean
}
export type AvailableCount = { value: number | null; description: string }
export type IssueCollectionReadModel = {
  title: string
  description: string
  items: readonly ControlledIssueRecord[]
  catalog: ControlledIssueCatalog
  /** Per-entity dictionary scope; global toolbar filters remain in catalog. */
  getCatalog?: (item: ControlledIssueRecord) => ControlledIssueCatalog
  groups: readonly GroupSnapshot[]
  lanes?: readonly WorkItemsLaneSnapshot[]
  queryKey: string
  data: PmControlledData
  today: string
  mutations: Readonly<Record<string, MutationState | undefined>>
  /** Never infer full-workspace totals from a loaded/filtered page. */
  counts?: { total: AvailableCount; completed: AvailableCount; overdue: AvailableCount; assigned: AvailableCount }
  /** Cohort facts share the current filtered scope; missing/partial facts remain null. */
  cohort?: { open: AvailableCount; active: AvailableCount; attention: AvailableCount; completion: AvailableCount }
  stateDistribution?: readonly { stateId: string; label: string; color: string | null; count: AvailableCount }[]
  buckets?: readonly DateBucketSnapshot[]
  unscheduled?: Omit<DateBucketSnapshot, "date">
  timelineViewport?: ScheduleViewport
  announcement?: string
  dateDrafts?: Readonly<Record<string, ScheduleDates | undefined>>
}
export type IssueCollectionInteraction = WorkItemsInteraction & {
  view: WorkItemsViewState
  calendar: CalendarSettings
  timeline: TimelineSettings
  scroll: PmReadingState
  excludedStateIds?: readonly string[]
  tableSort: DataTableSort
  columnConfig: DataTableColumnConfig
}
export type IssueCollectionActions = {
  setInteraction: Dispatch<SetStateAction<IssueCollectionInteraction>>
  open: (item: ControlledIssueRecord, trigger: HTMLElement | null) => void
  create: (defaults: { groupKey?: string; laneKey?: string; date?: string }, trigger: HTMLElement | null) => void
  patch: (item: ControlledIssueRecord, patch: ControlledIssuePatch) => void
  move: (intent: WorkItemsBoardMove) => void
  schedule: (intent: ScheduleChangeIntent) => void
  /** Queries the host result endpoint; never fabricates confirm/reject. */
  reconcile: (itemId: string, operationId: string) => void
  loadGroup?: (group: GroupSnapshot) => void
  retryGroup?: (group: GroupSnapshot) => void
  loadLaneGroup?: (lane: WorkItemsLaneSnapshot, group: GroupSnapshot) => void
  retryLaneGroup?: (lane: WorkItemsLaneSnapshot, group: GroupSnapshot) => void
  loadDate?: (bucket: DateBucketSnapshot) => void
  retryDate?: (bucket: DateBucketSnapshot) => void
  loadUnscheduled?: () => void
  retryUnscheduled?: () => void
  dateDraftChange?: (item: ControlledIssueRecord, dates: ScheduleDates) => void
}
export type IssueCollectionViewProps = PmControlledSurface & {
  variant: "list1" | "list2" | "board1" | "board2" | "board3" | "calendar1" | "gantt1" | "spreadsheet1"
  readModel: IssueCollectionReadModel
  interaction: IssueCollectionInteraction
  capabilities: ControlledIssueCapabilities
  actions: IssueCollectionActions
  hierarchy?: WorkItemsHierarchy
  createDialog?: ReactNode
  inspector?: ReactNode
  pageId?: string
  toolbarExtension?: ReactNode
  titleSuffix?: ReactNode
}
export type IssueDraft = {
  title: string
  description: string
  projectId: string
  stateId: string
  priorityId: string
  assigneeIds: readonly string[]
  labelIds: readonly string[]
  moduleIds: readonly string[]
  cycleId: string | null
  estimatePointId: string | null
  parentId: string | null
  startDate: string | null
  dueDate: string | null
}
export type PmActivityRecord = { id: string; actor: string; description: string; at: string; kind: "comment" | "update" }
export type PmAttachmentRecord = { id: string; name: string; description: string | null; sizeLabel: string | null }
export type IssueDetailViewProps = PmControlledSurface & {
  variant: "detail1" | "detail2"
  readModel: { item: ControlledIssueRecord | null; catalog: ControlledIssueCatalog; parentOptions?: readonly WorkItemOption[]; children: readonly ControlledIssueRecord[]; activity: readonly PmActivityRecord[]; attachments: readonly PmAttachmentRecord[]; data: PmControlledData; mutation?: MutationState; today: string }
  interaction: { editing: boolean; draft: IssueDraft | null; commentDraft: string; activityFilter: "all" | "comment" | "update" }
  capabilities: ControlledIssueCapabilities & { comment: boolean; attach: boolean; createChild: boolean }
  actions: { back: () => void; edit: (trigger: HTMLElement) => void; setDraft: (draft: IssueDraft) => void; save: () => void; cancel: () => void; patch: IssueCollectionActions["patch"]; open: (item: ControlledIssueRecord) => void; openProject: (projectId: string) => void; createChild: (item: ControlledIssueRecord, trigger: HTMLElement) => void; setCommentDraft: (value: string) => void; comment: () => void; setActivityFilter: (value: "all" | "comment" | "update") => void; attach: (trigger: HTMLElement) => void; openAttachment: (attachmentId: string) => void; reconcile: (operationId: string) => void }
  fieldErrors?: Partial<Record<keyof IssueDraft, string>>
  commentMutation?: MutationState
  createDialog?: ReactNode
  pageId?: string
  headerActions?: ReactNode
  regions?: Partial<Record<"editor" | "properties" | "attachments" | "subissues" | "comments" | "activity" | "mutation", ReactNode>>
}
export type ProjectDetailRecord = ProjectCollectionRecord & { version: string; revision: number; startDate: string | null; updatedAt: string | null; budget: number | null }
export type ProjectDetailTab = "overview" | "board" | "list" | "table" | "calendar" | "timeline" | "tree" | "graph" | "files" | "activity" | "comments" | "tasks" | "issues" | "dependencies"
export type ProjectDetailViewProps = PmControlledSurface & {
  variant: "detail1" | "detail2"
  readModel: { project: ProjectDetailRecord | null; issues: readonly ControlledIssueRecord[]; catalog: ControlledIssueCatalog; activity: readonly PmActivityRecord[]; attachments: readonly PmAttachmentRecord[]; counts: { total: AvailableCount; completed: AvailableCount; overdue: AvailableCount; members: AvailableCount }; data: PmControlledData; today: string; mutation?: MutationState }
  interaction: { tab: ProjectDetailTab; metadataOpen: boolean }
  capabilities: { edit: boolean; createIssue: boolean; attach: boolean; dependency: boolean }
  actions: { back: () => void; edit: (trigger: HTMLElement) => void; setInteraction: Dispatch<SetStateAction<ProjectDetailViewProps["interaction"]>>; openIssue: (item: ControlledIssueRecord) => void; createIssue: (projectId: string, trigger: HTMLElement) => void; patchIssue: IssueCollectionActions["patch"]; issueCapabilities: ControlledIssueCapabilities; attach: (trigger: HTMLElement) => void; openAttachment: (attachmentId: string) => void; reconcile: (operationId: string) => void }
  /** Host supplies its retained project-comment composer; activity still renders real comments. */
  commentEditor?: ReactNode
  editDialog?: ReactNode
  dependencyPanel?: ReactNode
  headerActions?: ReactNode
  /** Shared host project navigation; fixtures retain their own tabs when omitted. */
  projectNavigation?: ReactNode
  tabs?: readonly ProjectDetailViewProps["interaction"]["tab"][]
  /** Host-owned toolbar rendered directly below the tab strip. */
  toolbar?: ReactNode
  /** Move the shared metrics strip out of the header and into the host overview. */
  metricsInOverview?: boolean
  regions?: Partial<Record<"metadata" | "chips" | "metrics" | "attachments" | "files" | "board" | "list" | "table" | "calendar" | "tree" | "graph" | "overview" | "tasks" | "issues" | "dependencies" | "timeline" | "activity" | "comments", ReactNode>>
}
export type DashboardViewProps = PmControlledSurface & {
  variant: "dashboard1" | "dashboard2" | "dashboard3" | "dashboard4"
  readModel: { title: string; description: string; projects: readonly ProjectCollectionRecord[]; issues: readonly ControlledIssueRecord[]; catalog: ControlledIssueCatalog; counts: { projects: AvailableCount; issues: AvailableCount; completed: AvailableCount; overdue: AvailableCount; members: AvailableCount; teams: AvailableCount }; stateCounts: readonly { id: string; label: string; count: AvailableCount }[]; activity: readonly PmActivityRecord[]; data: PmControlledData; today: string; dependencyMap?: ComponentProps<typeof WorkflowCanvas>; dependencyDescription: string; unavailableDescription: string }
  interaction: { selectedProjectId: string | null; query: string }
  actions: { setInteraction: Dispatch<SetStateAction<DashboardViewProps["interaction"]>>; refresh: () => void; openProject: (id: string) => void; openIssue: (item: ControlledIssueRecord) => void; openIssues: (filter?: { projectId?: string; stateId?: string; overdue?: boolean; completed?: boolean }) => void; createProject: (trigger: HTMLElement) => void; createIssue: (trigger: HTMLElement) => void; openPeople: () => void }
  capabilities: { createProject: boolean; createIssue: boolean }
  createDialog?: ReactNode
  regions?: Partial<Record<"metrics" | "distribution" | "timeline" | "projects" | "issues" | "currentProject" | "rail" | "cards" | "activity", ReactNode>>
  toolbar?: ReactNode
  navigation?: ReactNode
  headerActions?: ReactNode
  pageId?: string
  showRail?: boolean
}
export type ControlledIssueField = WorkItemField | "projectId" | "parentId" | "moduleIds" | "cycleId" | "estimatePointId"

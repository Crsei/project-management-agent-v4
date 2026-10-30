import type { GroupSnapshot } from "@/lib/grouped-items-model"
import type {
  WorkItemCapabilities,
  WorkItemCatalog,
  WorkItemRecord,
  WorkItemsViewState,
} from "@/lib/work-items-model"
import {
  defaultWorkItemsView,
  isMutationLocked,
} from "@/lib/work-items-model"
import {
  groupWorkItems,
  selectWorkItems,
} from "@/lib/work-items-view"
import {
  addIssueDomain,
  patchIssueDomain,
  reconcileIssueDomain,
  type PmIssue,
  type PmIssueDomain,
  type PmIssueOutcome,
  type PmIssuePatch,
} from "./issue-domain"
import { pmClock, type PmScenario } from "./model"

export type IssueOutcome = PmIssueOutcome
export const issueOutcomes: readonly IssueOutcome[] = [
  "confirmed",
  "rejected",
  "unknown",
]

/** readonly/loading scenes guard every writing callback, not only appearance. */
export function scenarioWritable(scenario: PmScenario) {
  return scenario !== "readonly" && scenario !== "loading"
}

export function issueCapabilities(
  writable: boolean,
  reason: string,
): WorkItemCapabilities {
  return {
    canCreate: writable,
    canEditField: () => writable,
    canMove: () => writable,
    ...(writable ? {} : { reason }),
  }
}

export const issueToday = pmClock.slice(0, 10)

/** Local dashboard navigation hands off filters, never a service request. */
export type IssueDrilldown = {
  projectId: string | null
  query: string
  stateIds: readonly string[]
  overdue: boolean
}

// ---------------------------------------------------------------------------
// List view state (page + scenario cache; retained across remounts)
// ---------------------------------------------------------------------------

export type IssueCreateDraft = {
  title: string
  stateId: string
  priorityId: string
  assigneeIds: string[]
  projectId: string
  dueDate: string | null
  parentId?: string | null
  description?: string
  startDate?: string | null
}

export type IssueListUi = {
  view: WorkItemsViewState
  outcome: IssueOutcome
  selectedIds: string[]
  activeId: string | null
  collapsedGroupIds: string[]
  createOpen: boolean
  createDraft: IssueCreateDraft
  resultCheckId: string | null
  lastCreatedId: string | null
}

export function createIssueCreateDraft(
  stateId = "backlog",
  projectId = "project-rev-241",
): IssueCreateDraft {
  return {
    title: "",
    stateId,
    priorityId: "medium",
    assigneeIds: [],
    projectId,
    dueDate: null,
  }
}

export function createIssueListUi(compact = false): IssueListUi {
  return {
    view: {
      ...defaultWorkItemsView,
      query: "",
      filters: [],
      groupBy: "state",
      sort: "manual",
      sortDirection: "asc",
      visibleProperties: compact
        ? ["state", "dueDate", "labels", "priority"]
        : ["state", "priority", "assignees", "labels", "dueDate"],
      showEmptyGroups: true,
    },
    outcome: "confirmed",
    selectedIds: [],
    activeId: null,
    // Compact reference page opens Todo and Done collapsed.
    collapsedGroupIds: compact ? ["todo", "done"] : [],
    createOpen: false,
    createDraft: createIssueCreateDraft(),
    resultCheckId: null,
    lastCreatedId: null,
  }
}

// ---------------------------------------------------------------------------
// Selection: filter, meaningful sort, group
// ---------------------------------------------------------------------------

export function sortIssueList(
  items: readonly WorkItemRecord[],
  view: WorkItemsViewState,
  catalog: WorkItemCatalog,
  locale: "zh-CN" | "en",
): WorkItemRecord[] {
  if (view.sort === "manual") return [...items]
  const priorityRank = new Map(
    catalog.priorities.map((option, index) => [option.id, index]),
  )
  const stateRank = new Map(
    catalog.states.map((option, index) => [option.id, index]),
  )
  const label = (options: WorkItemCatalog["labels"], id: string | undefined) =>
    options.find((option) => option.id === id)?.label
  const direction = view.sortDirection === "desc" ? -1 : 1
  const tie = (a: WorkItemRecord, b: WorkItemRecord) => a.id.localeCompare(b.id)
  // Missing values stay last in both directions; ranks always have a value.
  const compareOptional = (
    left: string | null | undefined,
    right: string | null | undefined,
    compare: (left: string, right: string) => number,
  ) => {
    if (!left && !right) return 0
    if (!left) return 1
    if (!right) return -1
    return compare(left, right) * direction
  }
  return [...items].sort((a, b) => {
    if (view.sort === "priority") {
      const left = priorityRank.get(a.priorityId) ?? priorityRank.size
      const right = priorityRank.get(b.priorityId) ?? priorityRank.size
      return (left - right) * direction || tie(a, b)
    }
    if (view.sort === "state") {
      const left = stateRank.get(a.stateId) ?? stateRank.size
      const right = stateRank.get(b.stateId) ?? stateRank.size
      return (left - right) * direction || tie(a, b)
    }
    if (view.sort === "dueDate")
      return (
        compareOptional(a.dueDate, b.dueDate, (left, right) =>
          left.localeCompare(right),
        ) || tie(a, b)
      )
    if (view.sort === "assignees")
      return (
        compareOptional(
          label(catalog.assignees, a.assigneeIds[0]),
          label(catalog.assignees, b.assigneeIds[0]),
          (left, right) => left.localeCompare(right, locale),
        ) || tie(a, b)
      )
    if (view.sort === "labels")
      return (
        compareOptional(
          label(catalog.labels, a.labelIds[0]),
          label(catalog.labels, b.labelIds[0]),
          (left, right) => left.localeCompare(right, locale),
        ) || tie(a, b)
      )
    return (a.title.localeCompare(b.title, locale) || tie(a, b)) * direction
  })
}

export function selectVisibleIssues(
  items: readonly WorkItemRecord[],
  view: WorkItemsViewState,
  catalog: WorkItemCatalog,
  locale: "zh-CN" | "en",
): WorkItemRecord[] {
  const filtered = selectWorkItems(items, { ...view, sort: "manual" })
  return sortIssueList(filtered, view, catalog, locale)
}

/** Groups count visible roots; a child only nests under a visible parent. */
export function issueListGroups(
  visible: readonly WorkItemRecord[],
  catalog: WorkItemCatalog,
  view: WorkItemsViewState,
  queryKey: string,
): GroupSnapshot[] {
  const byId = new Map(visible.map((item) => [item.id, item]))
  const roots = visible.filter((item) => {
    const parent = item.parentId ? byId.get(item.parentId) : undefined
    return !parent || parent.projectId !== item.projectId
  })
  return groupWorkItems(roots, catalog, view, queryKey)
}

// ---------------------------------------------------------------------------
// Shared entity editor draft (retained in page cache)
// ---------------------------------------------------------------------------

export type IssueDraft = {
  baseRevision: number
  title: string
  description: string
  stateId: string
  priorityId: string
  assigneeIds: string[]
  labelIds: string[]
  startDate: string | null
  dueDate: string | null
}

export type IssueEditorStore = {
  editingId: string | null
  drafts: Record<string, IssueDraft | undefined>
}

export function createIssueEditorStore(): IssueEditorStore {
  return { editingId: null, drafts: {} }
}

export function issueDraftFrom(item: PmIssue): IssueDraft {
  return {
    // Captured when the draft opens; stale drafts must fail by revision, not
    // silently rebase onto another route's edit.
    baseRevision: item.revision,
    title: item.title,
    description: item.description ?? "",
    stateId: item.stateId,
    priorityId: item.priorityId,
    assigneeIds: [...item.assigneeIds],
    labelIds: [...item.labelIds],
    startDate: item.startDate ?? null,
    dueDate: item.dueDate,
  }
}

export function issueDraftChanges(
  item: PmIssue,
  draft: IssueDraft,
): PmIssuePatch | null {
  const patch: PmIssuePatch = {}
  if (draft.title !== item.title) patch.title = draft.title
  if (draft.description !== (item.description ?? ""))
    patch.description = draft.description
  if (draft.stateId !== item.stateId) patch.stateId = draft.stateId
  if (draft.priorityId !== item.priorityId) patch.priorityId = draft.priorityId
  if (draft.assigneeIds.join("\u0000") !== item.assigneeIds.join("\u0000"))
    patch.assigneeIds = draft.assigneeIds
  if (draft.labelIds.join("\u0000") !== item.labelIds.join("\u0000"))
    patch.labelIds = draft.labelIds
  if (draft.startDate !== (item.startDate ?? null))
    patch.startDate = draft.startDate
  if (draft.dueDate !== item.dueDate) patch.dueDate = draft.dueDate
  return Object.keys(patch).length ? patch : null
}

export function issueDraftDirty(item: PmIssue, draft: IssueDraft) {
  return issueDraftChanges(item, draft) !== null
}

// ---------------------------------------------------------------------------
// Create: stable domain ids with full local result semantics
// ---------------------------------------------------------------------------

export type IssueCreateResult = {
  domain: PmIssueDomain
  status: "confirmed" | "rejected" | "unknown" | "blocked"
  id?: string
  error?: string
}

export function submitIssueCreate(
  domain: PmIssueDomain,
  draft: IssueCreateDraft,
  outcome: IssueOutcome,
): IssueCreateResult {
  if (Object.values(domain.requests).some((request) => request?.createItem))
    return {
      domain,
      status: "blocked",
      error:
        "A create with an unknown result is still checked / 仍有创建结果待确认",
    }
  const id = `issue-local-${domain.sequence + 1}`
  const next = addIssueDomain(
    domain,
    {
      title: draft.title,
      stateId: draft.stateId,
      priorityId: draft.priorityId,
      assigneeIds: draft.assigneeIds,
      projectId: draft.projectId,
      dueDate: draft.dueDate,
      parentId: draft.parentId,
      description: draft.description,
      startDate: draft.startDate,
    },
    outcome,
  )
  if (next === domain)
    return {
      domain,
      status: "blocked",
      error: "Create request already pending / 创建请求仍在确认中",
    }
  const mutation = next.mutations[id]
  if (mutation?.status === "confirmed")
    return { domain: next, status: "confirmed", id }
  if (mutation?.status === "unknown")
    return { domain: next, status: "unknown", id }
  return { domain: next, status: "rejected", id, error: mutation?.error }
}

export function hasPendingCreate(domain: PmIssueDomain) {
  return Object.values(domain.requests).some((request) => !!request?.createItem)
}

// ---------------------------------------------------------------------------
// Per-item local comments (no service sends)
// ---------------------------------------------------------------------------

export type IssueCommentEntry = {
  id: string
  text: string
  at: string
  author: string
}

export type IssueCommentDraft = {
  text: string
  outcome: IssueOutcome
  status: "idle" | "unknown" | "rejected"
  error?: string
  operationId?: string
}

export type IssueCommentState = {
  entries: IssueCommentEntry[]
  draft: IssueCommentDraft
  sort: "oldest" | "newest"
  sequence: number
}

export type IssueCommentStore = Record<string, IssueCommentState | undefined>

export function createIssueCommentState(): IssueCommentState {
  return {
    entries: [],
    draft: { text: "", outcome: "confirmed", status: "idle" },
    sort: "oldest",
    sequence: 0,
  }
}

export function issueCommentState(
  store: IssueCommentStore,
  itemId: string,
): IssueCommentState {
  return store[itemId] ?? createIssueCommentState()
}

function withCommentState(
  store: IssueCommentStore,
  itemId: string,
  state: IssueCommentState,
): IssueCommentStore {
  return { ...store, [itemId]: state }
}

export type IssueCommentSubmit = {
  store: IssueCommentStore
  status: "confirmed" | "rejected" | "unknown"
}

export function submitIssueComment(
  store: IssueCommentStore,
  itemId: string,
  author: string,
): IssueCommentSubmit {
  const state = issueCommentState(store, itemId)
  const text = state.draft.text.trim()
  const sequence = state.sequence + 1
  const operationId = `pm-comment-${itemId}-${sequence}`
  if (!text)
    return {
      store: withCommentState(store, itemId, {
        ...state,
        sequence,
        draft: {
          ...state.draft,
          status: "rejected",
          error: "Comment text required / 评论内容不能为空",
          operationId: undefined,
        },
      }),
      status: "rejected",
    }
  if (state.draft.outcome === "rejected")
    return {
      store: withCommentState(store, itemId, {
        ...state,
        sequence,
        draft: {
          ...state.draft,
          status: "rejected",
          error: "Local comment rejected / 本地评论被拒绝",
          operationId: undefined,
        },
      }),
      status: "rejected",
    }
  if (state.draft.outcome === "unknown")
    return {
      store: withCommentState(store, itemId, {
        ...state,
        sequence,
        draft: {
          ...state.draft,
          status: "unknown",
          error: undefined,
          operationId,
        },
      }),
      status: "unknown",
    }
  return {
    store: withCommentState(store, itemId, {
      ...state,
      sequence,
      entries: [
        ...state.entries,
        { id: operationId, text, at: pmClock, author },
      ],
      draft: { ...state.draft, text: "", status: "idle", error: undefined },
    }),
    status: "confirmed",
  }
}

/** Explicit check only: confirmed appends and clears the applied draft text;
 * rejected keeps the payload. Nothing replays automatically. */
export function settleIssueComment(
  store: IssueCommentStore,
  itemId: string,
  result: "confirmed" | "rejected",
  author: string,
): IssueCommentStore {
  const state = issueCommentState(store, itemId)
  if (result === "rejected")
    return withCommentState(store, itemId, {
      ...state,
      draft: {
        ...state.draft,
        status: "rejected",
        error: "Comment result check rejected / 评论结果核对拒绝",
        operationId: undefined,
      },
    })
  const text = state.draft.text.trim()
  const entries = text
    ? [
        ...state.entries,
        {
          id: state.draft.operationId ?? `pm-comment-${itemId}-settled`,
          text,
          at: pmClock,
          author,
        },
      ]
    : state.entries
  return withCommentState(store, itemId, {
    ...state,
    entries,
    draft: {
      ...state.draft,
      text: "",
      status: "idle",
      error: undefined,
      operationId: undefined,
    },
  })
}

// ---------------------------------------------------------------------------
// Row-level write guards shared by lists and details
// ---------------------------------------------------------------------------

export function canWriteIssue(
  domain: PmIssueDomain,
  itemId: string,
  writable: boolean,
) {
  return writable && !isMutationLocked(domain.mutations[itemId])
}

export function patchWritableIssue(
  domain: PmIssueDomain,
  setDomain: (update: (state: PmIssueDomain) => PmIssueDomain) => void,
  itemId: string,
  patch: PmIssuePatch,
  outcome: IssueOutcome,
  writable: boolean,
  baseRevision?: number,
) {
  if (!canWriteIssue(domain, itemId, writable)) return false
  setDomain((state) =>
    patchIssueDomain(state, itemId, patch, outcome, baseRevision),
  )
  return true
}

export function reconcileWritableIssue(
  domain: PmIssueDomain,
  setDomain: (update: (state: PmIssueDomain) => PmIssueDomain) => void,
  itemId: string,
  result: "confirmed" | "rejected",
  writable: boolean,
) {
  if (!canWriteIssue(domain, itemId, writable)) return false
  setDomain((state) => reconcileIssueDomain(state, itemId, result))
  return true
}

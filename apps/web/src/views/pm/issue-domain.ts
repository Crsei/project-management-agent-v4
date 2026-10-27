import type {
  WorkItemRecord,
  WorkItemCatalog,
  WorkItemPatch,
  MutationState,
  MoveIntent,
} from "@/lib/work-items-model"
import type { GroupSnapshot } from "@/lib/grouped-items-model"
import { isMutationLocked } from "@/lib/work-items-model"
import {
  isScheduleDate,
  isScheduleTimeZone,
} from "@/lib/schedule-date-utils"
import type { Copy } from "../views-model"
import { pmClock, pmMembers, type PmScenario } from "./model"
export const issueFixtureRevision = "pm-issues-2026-10-12-v1"
export type PmIssue = WorkItemRecord & {
  titleCopy: Copy
  descriptionCopy: Copy
  moduleId: string
  cycleId: string
  estimate: number | null
  startAt: string | null
  endAt: string | null
  timeZone: string
  allDay: boolean
  attachments: {
    id: string
    name: string
    content: string
    status: "available" | "error"
  }[]
}
export type PmIssuePatch = WorkItemPatch &
  Partial<
    Pick<
      PmIssue,
      | "moduleId"
      | "cycleId"
      | "estimate"
      | "startAt"
      | "endAt"
      | "timeZone"
      | "allDay"
    >
  >
export type PmIssueOutcome = "confirmed" | "rejected" | "unknown"
export type PmIssueRequest = {
  operationId: string
  itemId: string
  baseRevision: number
  patch: PmIssuePatch
  order?: { beforeId?: string; afterId?: string }
  createItem?: PmIssue
}
export type PmIssueDomain = {
  items: PmIssue[]
  mutations: Record<string, MutationState | undefined>
  requests: Record<string, PmIssueRequest | undefined>
  sequence: number
  activity: { id: string; itemId: string; at: string; description: Copy }[]
}
const states: { id: string; label: Copy; color: string }[] = [
  {
    id: "backlog",
    label: { en: "Backlog", "zh-CN": "待规划" },
    color: "var(--status-neutral)",
  },
  {
    id: "todo",
    label: { en: "Todo", "zh-CN": "待办" },
    color: "var(--status-info)",
  },
  {
    id: "progress",
    label: { en: "In progress", "zh-CN": "进行中" },
    color: "var(--status-waiting)",
  },
  {
    id: "review",
    label: { en: "In review", "zh-CN": "评审中" },
    color: "var(--status-thinking)",
  },
  {
    id: "done",
    label: { en: "Done", "zh-CN": "已完成" },
    color: "var(--status-success)",
  },
]
export function issueCatalog(locale: "en" | "zh-CN"): WorkItemCatalog {
  return {
    states: states.map((s) => ({
      ...s,
      label: s.label[locale],
      category: s.id === "done" ? "completed" : "active",
    })),
    priorities: [
      { id: "urgent", label: locale === "en" ? "Urgent" : "紧急" },
      { id: "high", label: locale === "en" ? "High" : "高" },
      { id: "medium", label: locale === "en" ? "Medium" : "中" },
      { id: "low", label: locale === "en" ? "Low" : "低" },
    ],
    assignees: pmMembers.map((m) => ({ id: m.id, label: m.name })),
    labels: [
      { id: "design", label: locale === "en" ? "Design" : "设计" },
      { id: "engineering", label: locale === "en" ? "Engineering" : "工程" },
      { id: "risk", label: locale === "en" ? "Risk" : "风险" },
    ],
  }
}
export function issueRecord(item: PmIssue, locale: "en" | "zh-CN"): PmIssue {
  return {
    ...item,
    title: item.titleCopy[locale],
    description: item.descriptionCopy[locale],
  }
}
export function createIssueDomain(scenario: PmScenario): PmIssueDomain {
  const titles: Copy[] = [
    { en: "Redesign project navigation", "zh-CN": "重设计项目导航" },
    { en: "Measure onboarding activation", "zh-CN": "衡量入门激活率" },
    { en: "Resolve duplicate claims", "zh-CN": "修复重复理赔" },
    { en: "Review launch accessibility", "zh-CN": "审核上线可访问性" },
    { en: "Confirm release scope", "zh-CN": "确认发布范围" },
    { en: "Audit inventory variance", "zh-CN": "审计库存差异" },
    { en: "Document API ownership", "zh-CN": "记录 API 负责人" },
    { en: "Track partner escalation", "zh-CN": "跟踪合作伙伴升级" },
    { en: "Verify keyboard navigation", "zh-CN": "验证键盘导航" },
    { en: "Publish delivery checklist", "zh-CN": "发布交付检查表" },
    { en: "Test empty collections", "zh-CN": "测试空集合" },
    { en: "Review renewal forecast", "zh-CN": "审核续约预测" },
  ]
  const projectIds = [
    "project-rev-241",
    "project-onb-118",
    "project-clm-084",
    "project-rtl-062",
    "project-mob-092",
    "project-inv-176",
    "project-kb-057",
    "project-sla-203",
    "project-hir-074",
    "project-ren-133",
  ]
  const count = scenario === "empty" ? 0 : scenario === "long-content" ? 48 : 12
  const items = Array.from({ length: count }, (_, i): PmIssue => {
    const baseTitle = titles[i % titles.length]
    const titleCopy: Copy =
      scenario === "long-content"
        ? {
            en:
              baseTitle.en +
              " — cross-team delivery, internationalisation and accessibility review " +
              (i + 1),
            "zh-CN":
              baseTitle["zh-CN"] +
              "：跨团队交付、国际化与可访问性评审 " +
              (i + 1),
          }
        : baseTitle
    const descriptionCopy: Copy = {
      en: "## Delivery objective\n\nCoordinate ownership, validate the proposal and record the acceptance evidence.\n\n- Preserve existing drafts and selection.\n- Check keyboard and error recovery.\n\n### Acceptance\nChanges remain local until a confirmed simulation result.",
      "zh-CN":
        "## 交付目标\n\n协调负责人、验证方案并记录验收证据。\n\n- 保留草稿和选择。\n- 检查键盘与错误恢复。\n\n### 验收\n模拟结果确认之前不修改实体事实。",
    }
    const startDate =
      i % 6 === 0 ? null : `2026-01-${String(11 + (i % 12)).padStart(2, "0")}`
    const dueDate = startDate
      ? `2026-01-${String(13 + (i % 12)).padStart(2, "0")}`
      : null
    return {
      id: `issue-${i + 1}`,
      projectId: projectIds[i % 10],
      identifier: `PM-${101 + i}`,
      title: titleCopy.en,
      titleCopy,
      description: descriptionCopy.en,
      descriptionCopy,
      stateId: states[i % 5].id,
      priorityId: ["high", "medium", "low", "urgent"][i % 4],
      assigneeIds: i % 7 === 0 ? [] : [pmMembers[i % 6].id],
      labelIds: [i % 2 ? "engineering" : "design"],
      startDate,
      dueDate,
      revision: 1,
      parentId: i === 8 ? "issue-1" : null,
      subItemCount: i === 0 ? 1 : 0,
      attachmentCount: i === 0 ? 2 : 0,
      linkCount: 0,
      moduleId: i % 2 ? "delivery" : "experience",
      cycleId: "cycle-2026-01",
      estimate: i % 5 === 0 ? null : ((i % 3) + 1) * 2,
      startAt:
        i === 3
          ? "2026-01-14T00:00:00Z"
          : startDate
            ? startDate + "T09:00:00Z"
            : null,
      endAt:
        i === 3
          ? "2026-01-15T00:00:00Z"
          : startDate
            ? startDate + "T10:30:00Z"
            : null,
      timeZone: "UTC",
      allDay: i === 3,
      attachments:
        i === 0
          ? [
              {
                id: "brief",
                name: "navigation-brief.md",
                content:
                  "# Navigation brief\n\nPreserve drafts and keyboard focus.",
                status: "available",
              },
              {
                id: "review",
                name: "review-notes.md",
                content: "",
                status: "error",
              },
            ]
          : [],
    }
  })
  return { items, mutations: {}, requests: {}, sequence: 0, activity: [] }
}
export function issueGroups(
  items: readonly WorkItemRecord[],
  locale: "en" | "zh-CN",
  queryKey = "pm-issues",
): GroupSnapshot[] {
  return issueCatalog(locale).states.map((state) => {
    const ids = items.filter((i) => i.stateId === state.id).map((i) => i.id)
    return {
      key: state.id,
      label: state.label,
      itemIds: ids,
      loadedCount: ids.length,
      totalCount: ids.length,
      hasMore: false,
      dataState: "success",
      queryKey,
    }
  })
}
function invalidPatch(item: PmIssue, patch: PmIssuePatch): string | null {
  if (
    patch.title !== undefined &&
    (!patch.title.trim() || patch.title.length > 240)
  )
    return "Invalid title / 标题无效"
  if (
    patch.stateId !== undefined &&
    !states.some((s) => s.id === patch.stateId)
  )
    return "Unknown state / 未知状态"
  if (patch.timeZone !== undefined && !isScheduleTimeZone(patch.timeZone))
    return "Invalid time zone / 时区无效"
  const start =
      patch.startDate === undefined ? item.startDate : patch.startDate,
    due = patch.dueDate === undefined ? item.dueDate : patch.dueDate
  if (
    (start && !isScheduleDate(start)) ||
    (due && !isScheduleDate(due)) ||
    (start && due && start > due)
  )
    return "Invalid date range / 日期范围无效"
  const from = patch.startAt === undefined ? item.startAt : patch.startAt,
    to = patch.endAt === undefined ? item.endAt : patch.endAt
  if (
    (from !== null || to !== null) &&
    (!from ||
      !to ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(to) <= Date.parse(from))
  )
    return "Invalid event range / 事件范围无效"
  if (
    patch.estimate !== undefined &&
    patch.estimate !== null &&
    (!Number.isFinite(patch.estimate) || patch.estimate < 0)
  )
    return "Invalid estimate / 估点无效"
  return null
}
function applyRequest(
  state: PmIssueDomain,
  request: PmIssueRequest,
): PmIssueDomain {
  const item = state.items.find((i) => i.id === request.itemId)
  if (request.createItem && !item) {
    const created = request.createItem
    return {
      ...state,
      items: [...state.items.map((entry) => entry.id === created.parentId
        ? { ...entry, subItemCount: (entry.subItemCount ?? 0) + 1, revision: entry.revision + 1 }
        : entry), created],
      requests: { ...state.requests, [created.id]: undefined },
      mutations: {
        ...state.mutations,
        [created.id]: {
          operationId: request.operationId,
          itemId: created.id,
          baseRevision: 0,
          status: "confirmed",
        },
      },
      activity: [
        ...state.activity,
        {
          id: request.operationId,
          itemId: created.id,
          at: pmClock,
          description: { en: "Created locally", "zh-CN": "已本地创建" },
        },
      ],
    }
  }
  if (!item || request.createItem || item.revision !== request.baseRevision)
    return {
      ...state,
      requests: { ...state.requests, [request.itemId]: undefined },
      mutations: {
        ...state.mutations,
        [request.itemId]: {
          ...request,
          status: "rejected",
          error: "Revision conflict / 版本冲突",
        },
      },
    }
  const patch = request.patch
  let items = state.items.map((i) =>
    i.id !== item.id
      ? i
      : {
          ...i,
          ...patch,
          revision: i.revision + 1,
          ...(patch.title !== undefined
            ? { titleCopy: { en: patch.title, "zh-CN": patch.title } }
            : {}),
          ...(patch.description !== undefined
            ? {
                descriptionCopy: {
                  en: patch.description,
                  "zh-CN": patch.description,
                },
              }
            : {}),
        },
  )
  if (request.order) {
    const moved = items.find((i) => i.id === item.id)!
    items = items.filter((i) => i.id !== item.id)
    const before = items.findIndex((i) => i.id === request.order?.beforeId),
      after = items.findIndex((i) => i.id === request.order?.afterId)
    items.splice(
      before >= 0 ? before : after >= 0 ? after + 1 : items.length,
      0,
      moved,
    )
  }
  return {
    ...state,
    items,
    requests: { ...state.requests, [item.id]: undefined },
    mutations: {
      ...state.mutations,
      [item.id]: {
        operationId: request.operationId,
        itemId: item.id,
        baseRevision: request.baseRevision,
        status: "confirmed",
      },
    },
    activity: [
      ...state.activity,
      {
        id: request.operationId,
        itemId: item.id,
        at: pmClock,
        description: {
          en: "Confirmed local update",
          "zh-CN": "已确认本地更新",
        },
      },
    ],
  }
}
export function patchIssueDomain(
  state: PmIssueDomain,
  itemId: string,
  patch: PmIssuePatch,
  outcome: PmIssueOutcome = "confirmed",
  baseRevision?: number,
  order?: PmIssueRequest["order"],
): PmIssueDomain {
  if (state.requests[itemId]) return state
  const item = state.items.find((i) => i.id === itemId)
  if (!item) return state
  const sequence = state.sequence + 1,
    operationId = `pm-issue-request-${sequence}`,
    error = invalidPatch(item, patch)
  const request = {
    operationId,
    itemId,
    baseRevision: baseRevision ?? item.revision,
    patch: structuredClone(patch),
    order,
  }
  const next = { ...state, sequence }
  if (error || outcome === "rejected")
    return {
      ...next,
      mutations: {
        ...state.mutations,
        [itemId]: {
          operationId,
          itemId,
          baseRevision: request.baseRevision,
          status: "rejected",
          error: error ?? "Local change rejected / 本地更改被拒绝",
        },
      },
    }
  if (outcome === "unknown")
    return {
      ...next,
      requests: { ...state.requests, [itemId]: request },
      mutations: {
        ...state.mutations,
        [itemId]: {
          operationId,
          itemId,
          baseRevision: request.baseRevision,
          status: "unknown",
        },
      },
    }
  return applyRequest(next, request)
}
export function reconcileIssueDomain(
  state: PmIssueDomain,
  itemId: string,
  outcome: Exclude<PmIssueOutcome, "unknown"> = "confirmed",
): PmIssueDomain {
  const request = state.requests[itemId]
  if (!request) return state
  return outcome === "confirmed"
    ? applyRequest(state, request)
    : {
        ...state,
        requests: { ...state.requests, [itemId]: undefined },
        mutations: {
          ...state.mutations,
          [itemId]: {
            operationId: request.operationId,
            itemId,
            baseRevision: request.baseRevision,
            status: "rejected",
            error: "Result check rejected / 结果核对拒绝",
          },
        },
      }
}
export function moveIssueDomain(
  state: PmIssueDomain,
  intent: MoveIntent,
  outcome: PmIssueOutcome = "confirmed",
) {
  return patchIssueDomain(
    state,
    intent.itemId,
    { stateId: intent.targetGroup },
    outcome,
    intent.baseRevision,
    { beforeId: intent.beforeId, afterId: intent.afterId },
  )
}

export function addIssueDomain(
  state: PmIssueDomain,
  input: {
    title: string
    stateId: string
    priorityId: string
    assigneeIds: readonly string[]
    projectId: string
    dueDate?: string | null
    parentId?: string | null
    description?: string
    startDate?: string | null
  },
  outcome: PmIssueOutcome = "confirmed",
): PmIssueDomain {
  if (Object.values(state.requests).some((request) => !!request?.createItem))
    return state
  const sequence = state.sequence + 1,
    id = `issue-local-${sequence}`,
    operationId = `pm-issue-request-${sequence}`
  const title = input.title.trim(),
    descriptionCopy = {
      en: input.description ?? "Local project delivery issue.",
      "zh-CN": input.description ?? "本地项目交付任务。",
    }
  const item: PmIssue = {
    id,
    projectId: input.projectId,
    identifier: `PM-L${String(sequence).padStart(3, "0")}`,
    title,
    titleCopy: { en: title, "zh-CN": title },
    description: descriptionCopy.en,
    descriptionCopy,
    stateId: input.stateId,
    priorityId: input.priorityId,
    assigneeIds: [...input.assigneeIds],
    labelIds: [],
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    revision: 1,
    parentId: input.parentId ?? null,
    subItemCount: 0,
    attachmentCount: 0,
    linkCount: 0,
    moduleId: "delivery",
    cycleId: "cycle-2026-01",
    estimate: null,
    startAt: null,
    endAt: null,
    timeZone: "UTC",
    allDay: false,
    attachments: [],
  }
  const error =
    invalidPatch(item, {
      title: input.title,
      stateId: input.stateId,
      dueDate: input.dueDate,
      startDate: input.startDate,
    }) ||
    (!input.projectId ? "Project required / 请选择项目" : null) ||
    (input.parentId && !state.items.some((entry) => entry.id === input.parentId && entry.projectId === input.projectId)
      ? "Parent issue not in this project / 父问题不属于此项目"
      : null) ||
    (input.parentId && isMutationLocked(state.mutations[input.parentId])
      ? "Parent issue has an unchecked request / 父问题仍有结果待核对"
      : null) ||
    (!["urgent", "high", "medium", "low"].includes(input.priorityId)
      ? "Unknown priority / 未知优先级"
      : null) ||
    (input.assigneeIds.some(
      (id) => !pmMembers.some((member) => member.id === id),
    )
      ? "Unknown assignee / 未知负责人"
      : null)
  const request: PmIssueRequest = {
    operationId,
    itemId: id,
    baseRevision: 0,
    patch: {},
    createItem: item,
  }
  const next = { ...state, sequence }
  if (error || outcome === "rejected")
    return {
      ...next,
      mutations: {
        ...state.mutations,
        [id]: {
          operationId,
          itemId: id,
          baseRevision: 0,
          status: "rejected",
          error: error ?? "Create rejected / 创建被拒绝",
        },
      },
    }
  if (outcome === "unknown")
    return {
      ...next,
      requests: { ...state.requests, [id]: request },
      mutations: {
        ...state.mutations,
        [id]: { operationId, itemId: id, baseRevision: 0, status: "unknown" },
      },
    }
  return applyRequest(next, request)
}

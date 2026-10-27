import type {
  WorkItemCatalog,
  WorkItemRecord,
} from "@/lib/work-items-model"
import type { Copy } from "../views-model"
import { pmClock, pmTimeZone, type PmMember, type PmScenario } from "./model"

export const dashboardFixtureRevision = "pm-dashboard-1-2026-10-12-v1"
export const dashboardMembers: PmMember[] = [
  {
    id: "nina",
    name: "Nina Oliver",
    role: { "zh-CN": "工程师", en: "Engineer" },
  },
  { id: "kai", name: "Kai Young", role: { "zh-CN": "设计师", en: "Designer" } },
  {
    id: "lena",
    name: "Lena Moss",
    role: { "zh-CN": "项目负责人", en: "Project lead" },
  },
  {
    id: "ava",
    name: "Ava Reed",
    role: { "zh-CN": "产品经理", en: "Product manager" },
  },
]

// Source photographs stay inside the explicit Lab adapter.
export const dashboardAvatarSources: Record<string, string> = {
  nina: "https://shadcnblocks-admin.vercel.app/avatars/avatar-5.png",
  kai: "https://shadcnblocks-admin.vercel.app/avatars/avatar-black-2.png",
  lena: "https://shadcnblocks-admin.vercel.app/avatars/avatar-3.png",
  ava: "https://shadcnblocks-admin.vercel.app/avatars/avatar-1.png",
  profile: "https://shadcnblocks-admin.vercel.app/avatars/ausrobdev-avatar.png",
}
export const dashboardStates: { id: string; label: Copy; color: string }[] = [
  {
    id: "backlog",
    label: { "zh-CN": "待规划", en: "Backlog" },
    color: "#a1a1aa",
  },
  {
    id: "todo",
    label: { "zh-CN": "待办", en: "Todo" },
    color: "#22c7d6",
  },
  {
    id: "progress",
    label: { "zh-CN": "进行中", en: "In Progress" },
    color: "#f59e0b",
  },
  {
    id: "review",
    label: { "zh-CN": "评审中", en: "Review" },
    color: "#d946ef",
  },
  {
    id: "done",
    label: { "zh-CN": "已完成", en: "Done" },
    color: "#10b981",
  },
]
export type DashboardIssue = WorkItemRecord & {
  titleCopy: Copy
  createdByMe: boolean
  assignedToMe: boolean
  watching: boolean
}
export type WorkLog = {
  id: string
  issueId: string
  date: string
  minutes: number
  extraMinutes: number
  samples: number[]
}
export type ScheduleEntry = {
  id: string
  kind: "meetings" | "events" | "focus"
  title: Copy
  startsAt: string
  endsAt: string
  memberIds: string[]
  additionalMembers?: number
  timeCopy?: Copy
  issueId?: string
  label: Copy
  location: Copy
  description: Copy
}
export type DashboardFixture = {
  issues: DashboardIssue[]
  logs: WorkLog[]
  agenda: ScheduleEntry[]
  profile: { name: string; email: string; joined: string }
  clock: string
  timeZone: string
}
const titles: Copy[] = [
  { "zh-CN": "确定任务时间轴架构", en: "Finalize issue timeline architecture" },
  { "zh-CN": "评审甘特图交互状态", en: "Review gantt interaction states" },
  {
    "zh-CN": "同步任务筛选与项目视图",
    en: "Sync issue filters with project views",
  },
  { "zh-CN": "梳理时间轴键盘操作", en: "Plan timeline keyboard navigation" },
  {
    "zh-CN": "创建时间轴空白与加载状态",
    en: "Create empty and loading timeline states",
  },
  {
    "zh-CN": "补充模拟依赖与交接说明",
    en: "Add mock dependencies and handoff notes",
  },
  { "zh-CN": "优化季度视图密度", en: "Polish the quarter view density" },
  { "zh-CN": "整理排期验收清单", en: "Prepare schedule acceptance checklist" },
]
export function dashboardCatalog(locale: "zh-CN" | "en"): WorkItemCatalog {
  return {
    states: dashboardStates.map((s) => ({
      id: s.id,
      label: s.label[locale],
      color: s.color,
    })),
    priorities: [
      { id: "high", label: locale === "en" ? "High" : "高" },
      { id: "medium", label: locale === "en" ? "Medium" : "中" },
      { id: "low", label: locale === "en" ? "Low" : "低" },
    ],
    assignees: dashboardMembers.map((m) => ({ id: m.id, label: m.name })),
    labels: [
      "timeline",
      "frontend",
      "review",
      "views",
      "filters",
      "keyboard",
      "states",
      "handoff",
      "density",
      "planning",
    ].map((id) => ({ id, label: id })),
  }
}
export function createDashboardFixture(scenario: PmScenario): DashboardFixture {
  const states = [
    "progress",
    "todo",
    "review",
    "backlog",
    "todo",
    "done",
    "review",
    "backlog",
  ]
  const owners = [["nina"], [], ["kai"], [], [], ["lena"], ["ava"], []]
  const labels = [
    ["timeline", "frontend"],
    ["review"],
    ["views", "filters"],
    ["keyboard"],
    ["states"],
    ["handoff"],
    ["density"],
    ["planning"],
  ]
  const due = [
    "2026-04-10",
    "2026-04-06",
    "2026-04-16",
    "2026-04-18",
    "2026-04-21",
    "2026-04-07",
    "2026-04-08",
    "2026-04-22",
  ]
  let issues: DashboardIssue[] = titles.map((titleCopy, index) => ({
    id: `rfc-${101 + index}`,
    projectId: "roadmap",
    identifier: `RFC-${101 + index}`,
    title: titleCopy.en,
    titleCopy,
    stateId: states[index],
    priorityId: [
      "high",
      "medium",
      "high",
      "low",
      "medium",
      "low",
      "medium",
      "low",
    ][index],
    assigneeIds: owners[index],
    labelIds: labels[index],
    dueDate: due[index],
    revision: 1,
    description: "Local roadmap fixture · no external execution",
    createdByMe: true,
    assignedToMe: [0, 2, 5, 6].includes(index),
    watching: [0, 1, 2, 4, 5, 6].includes(index),
  }))
  if (scenario === "long-content")
    issues = issues.map((issue) => ({
      ...issue,
      titleCopy: {
        "zh-CN": `${issue.titleCopy["zh-CN"]}：跨团队依赖、键盘操作、长文本与刷新恢复的完整验收说明`,
        en: `${issue.titleCopy.en}: cross-team dependencies, keyboard navigation, long content and refresh recovery acceptance`,
      },
    }))
  const recentSamples = [
    [1.5, 1.5, 5],
    [5, 5, 3],
    [3, 4, 4, 4],
    [5, 5, 3],
    [3, 4, 5, 5],
  ]
  const logs: WorkLog[] = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(pmClock)
    date.setUTCDate(date.getUTCDate() - (29 - index))
    const minutes =
      index >= 25
        ? [278, 451, 521, 451, 591][index - 25]
        : [420, 360, 480, 300, 420][index % 5]
    const weights = index >= 25 ? recentSamples[index - 25] : [3, 4, 4]
    const totalWeight = weights.reduce((total, value) => total + value, 0)
    return {
      id: `work-log-${index + 1}`,
      issueId: issues[index % issues.length].id,
      date: date.toISOString().slice(0, 10),
      minutes,
      extraMinutes: Math.max(0, minutes - 480),
      samples: weights.map(weight => minutes * weight / totalWeight),
    }
  })
  const agenda: ScheduleEntry[] = [
    {
      id: "planning",
      kind: "meetings",
      title: { "zh-CN": "时间轴规划评审", en: "Timeline planning review" },
      startsAt: "2026-01-12T09:00:00Z",
      endsAt: "2026-01-12T09:45:00Z",
      memberIds: ["nina", "kai", "ava"],
      additionalMembers: 2,
      timeCopy: { "zh-CN": "09:00 - 09:45 AM", en: "09:00 - 09:45 AM" },
      label: { "zh-CN": "路线图", en: "Roadmap" },
      location: {
        "zh-CN": "在 Google Meet",
        en: "On Google Meet",
      },
      description: {
        "zh-CN": "讨论 RFC-101 的交付范围和依赖。此处仅供查看，不会加入会议。",
        en: "Review RFC-101 scope and dependencies. Inspection only; no meeting is joined.",
      },
    },
    {
      id: "handoff",
      kind: "meetings",
      title: { "zh-CN": "设计交接同步", en: "Design handoff sync" },
      startsAt: "2026-01-12T11:30:00Z",
      endsAt: "2026-01-12T12:00:00Z",
      memberIds: ["lena", "nina", "ava"],
      additionalMembers: 1,
      timeCopy: { "zh-CN": "11:30 - 12:00 PM", en: "11:30 - 12:00 PM" },
      label: { "zh-CN": "设计", en: "Design" },
      location: { "zh-CN": "在 Zoom", en: "On Zoom" },
      description: {
        "zh-CN": "核对设计状态和交接说明。",
        en: "Review design states and handoff notes.",
      },
    },
    {
      id: "release",
      kind: "meetings",
      title: { "zh-CN": "发布准备检查", en: "Release readiness check" },
      startsAt: "2026-01-12T15:00:00Z",
      endsAt: "2026-01-12T15:30:00Z",
      memberIds: ["nina", "kai", "ava"],
      additionalMembers: 3,
      timeCopy: { "zh-CN": "03:00 - 03:30 PM", en: "03:00 - 03:30 PM" },
      label: { "zh-CN": "发布", en: "Launch" },
      location: { "zh-CN": "在 Slack", en: "On Slack" },
      description: {
        "zh-CN": "查看发布清单与未解决事项。",
        en: "Inspect launch checklist and open issues.",
      },
    },
    {
      id: "sprint-demo",
      kind: "events",
      title: { "zh-CN": "迭代演示窗口", en: "Sprint demo window" },
      startsAt: "2026-01-12T14:00:00Z",
      endsAt: "2026-01-12T14:30:00Z",
      memberIds: ["nina"],
      label: { "zh-CN": "演示", en: "Demo" },
      location: { "zh-CN": "本地演示日程", en: "Local demonstration agenda" },
      description: { "zh-CN": "分享时间轴与交互更新", en: "Share timeline and interaction updates" },
      timeCopy: { "zh-CN": "02:00 - 02:30 PM", en: "02:00 - 02:30 PM" },
    },
    {
      id: "notes-freeze",
      kind: "events",
      title: { "zh-CN": "发布说明冻结", en: "Release notes freeze" },
      startsAt: "2026-01-12T16:00:00Z",
      endsAt: "2026-01-12T16:30:00Z",
      memberIds: [],
      label: { "zh-CN": "发布", en: "Release" },
      location: { "zh-CN": "本地演示日程", en: "Local demonstration agenda" },
      description: { "zh-CN": "锁定收入洞察改版文案", en: "Lock copy for Revenue Insights Revamp" },
      timeCopy: { "zh-CN": "04:00 PM", en: "04:00 PM" },
    },
    {
      id: "qa-signoff",
      kind: "events",
      title: { "zh-CN": "质量验收", en: "QA sign-off" },
      startsAt: "2026-01-13T09:00:00Z",
      endsAt: "2026-01-13T09:30:00Z",
      memberIds: [],
      label: { "zh-CN": "质量", en: "QA" },
      location: { "zh-CN": "本地演示日程", en: "Local demonstration agenda" },
      description: { "zh-CN": "理赔工作区回归验收", en: "Claims workspace regression pass" },
      timeCopy: { "zh-CN": "明天", en: "Tomorrow" },
    },
    {
      id: "review-architecture",
      kind: "focus",
      title: { "zh-CN": "评审时间轴架构", en: "Review timeline architecture" },
      startsAt: "2026-01-12T13:00:00Z",
      endsAt: "2026-01-12T14:30:00Z",
      memberIds: ["nina"],
      label: { "zh-CN": "高优先级", en: "High priority" },
      location: { "zh-CN": "个人本地日程", en: "Personal local agenda" },
      description: { "zh-CN": "独立评审 RFC-101，不会启动真实执行。", en: "Independent RFC-101 review; no real execution is started." },
      issueId: "rfc-101",
    },
    {
      id: "unassigned-work",
      kind: "focus",
      title: { "zh-CN": "处理未分配的待办", en: "Clear unassigned todo work" },
      startsAt: "2026-01-12T14:30:00Z",
      endsAt: "2026-01-12T15:00:00Z",
      memberIds: [],
      label: { "zh-CN": "需要负责人", en: "Needs owner" },
      location: { "zh-CN": "个人本地日程", en: "Personal local agenda" },
      description: { "zh-CN": "查看本地任务并确定下一步。", en: "Inspect the local issue and identify its next step." },
      issueId: "rfc-102",
    },
    {
      id: "release-handoff",
      kind: "focus",
      title: { "zh-CN": "准备发布交接", en: "Prepare release handoff" },
      startsAt: "2026-01-12T15:30:00Z",
      endsAt: "2026-01-12T16:00:00Z",
      memberIds: ["lena"],
      label: { "zh-CN": "今天到期", en: "Due today" },
      location: { "zh-CN": "个人本地日程", en: "Personal local agenda" },
      description: { "zh-CN": "整理本地任务的交接说明。", en: "Prepare handoff notes for the local issue." },
      issueId: "rfc-106",
    },
  ]
  return {
    issues: scenario === "empty" ? [] : issues,
    logs: scenario === "empty" ? [] : logs,
    agenda: scenario === "empty" ? [] : agenda,
    profile: {
      name: "ausrobdev",
      email: "rob@shadcnblocks.com",
      joined: "2026-01-10",
    },
    clock: pmClock,
    timeZone: pmTimeZone,
  }
}

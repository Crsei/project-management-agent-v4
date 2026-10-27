import type { Copy } from "../views-model"
import { pmClock, pmTimeZone, type PmProject, type PmScenario } from "./model"

export const projectList1FixtureRevision = "pm-project-collection-2026-10-12-v3"
export type ProjectStatus = "active" | "paused" | "completed"
export type ProjectCycle = "improvement" | "launch" | "fix" | "maintenance"
export type ProjectCardRecord = PmProject & {
  status: ProjectStatus
  cycle: ProjectCycle
  cycleWeeks: number
  teamSize: number
  description: Copy
  archived: boolean
  updatedAt: string
  createdAt: string
  artwork: number
  starred: boolean
}
export const statusCopy: Record<ProjectStatus, Copy> = {
  active: { "zh-CN": "进行中", en: "Active" },
  paused: { "zh-CN": "已暂停", en: "Paused" },
  completed: { "zh-CN": "已完成", en: "Completed" },
}
export const cycleCopy: Record<ProjectCycle, Copy> = {
  improvement: { "zh-CN": "改进", en: "Improvement" },
  launch: { "zh-CN": "发布", en: "Launch" },
  fix: { "zh-CN": "修复", en: "Fix" },
  maintenance: { "zh-CN": "维护", en: "Maintenance" },
}
const seeds: [
  string,
  string,
  string,
  ProjectCycle,
  number,
  number,
  string,
  number,
][] = [
  [
    "REV-241",
    "Revenue Insights Revamp",
    "营收洞察重构",
    "improvement",
    4,
    58,
    "2026-02-14",
    4,
  ],
  [
    "ONB-118",
    "Enterprise Onboarding Flow",
    "企业入门流程",
    "launch",
    6,
    72,
    "2026-02-22",
    8,
  ],
  [
    "CLM-084",
    "Claims Resolution Workspace",
    "理赔处理工作台",
    "fix",
    2,
    24,
    "2026-01-20",
    3,
  ],
  [
    "RTL-062",
    "Retail Launch Readiness",
    "零售上线准备",
    "improvement",
    3,
    85,
    "2026-03-03",
    6,
  ],
  [
    "MOB-092",
    "Mobile Release Train",
    "移动端发布计划",
    "launch",
    5,
    45,
    "2026-02-01",
    10,
  ],
  [
    "INV-176",
    "Inventory Accuracy Audit",
    "库存准确性审计",
    "maintenance",
    8,
    91,
    "2026-03-18",
    12,
  ],
  [
    "KB-057",
    "Knowledge Base Migration",
    "知识库迁移",
    "improvement",
    4,
    66,
    "2026-02-08",
    5,
  ],
  [
    "SLA-203",
    "Partner SLA Tracker",
    "合作伙伴服务追踪",
    "fix",
    3,
    38,
    "2026-01-24",
    2,
  ],
  [
    "HIR-074",
    "Hiring Pipeline Cleanup",
    "招聘流程整理",
    "maintenance",
    6,
    78,
    "2026-02-28",
    7,
  ],
  [
    "REN-133",
    "Renewal Forecast Console",
    "续约预测控制台",
    "launch",
    2,
    15,
    "2026-01-17",
    11,
  ],
]
export function createProjectList1Fixtures(
  scenario: PmScenario,
): ProjectCardRecord[] {
  if (scenario === "empty") return []
  const projects = seeds.map(
    (
      [identifier, en, zh, cycle, cycleWeeks, health, dueDate, teamSize],
      index,
    ): ProjectCardRecord => ({
      id: `project-${identifier.toLowerCase()}`,
      identifier,
      title: { en, "zh-CN": zh },
      description: {
        en: `${en}: coordinate ownership, milestones and delivery decisions.`,
        "zh-CN": `${zh}：协调负责人、里程碑与交付决策。`,
      },
      archived: false,
      updatedAt: new Date(Date.parse(pmClock) - index * 86400000).toISOString(),
      ownerId: [
        "member-alex",
        "member-sarah",
        "member-james",
        "member-emily",
        "member-michael",
        "member-lisa",
      ][index % 6],
      teamId: ["team-cx", "team-field", "team-growth"][index % 3],
      health,
      dueDate,
      status: "active",
      cycle,
      cycleWeeks,
      teamSize,
      artwork: index,
      starred: false,
      createdAt: new Date(Date.parse(pmClock) - index * 86400000).toISOString(),
    }),
  )
  if (scenario !== "long-content") return projects
  return Array.from({ length: 30 }, (_, index) => ({
    ...projects[index % projects.length],
    id:
      index < projects.length
        ? projects[index].id
        : `project-long-${index + 1}`,
    identifier:
      index < projects.length
        ? projects[index].identifier
        : `EXT-${String(index + 1).padStart(3, "0")}`,
    title: {
      en: `${projects[index % projects.length].title.en} — cross-functional planning, accessibility and international rollout ${index + 1}`,
      "zh-CN": `${projects[index % projects.length].title["zh-CN"]}：跨团队规划、可访问性与国际化上线的长期协作项目 ${index + 1}`,
    },
    ownerId:
      index === 10
        ? "member-missing"
        : projects[index % projects.length].ownerId,
    health: index === 10 ? null : projects[index % projects.length].health,
    archived: index > 0 && index % 7 === 0,
    updatedAt: new Date(Date.parse(pmClock) - index * 86400000).toISOString(),
    status:
      index % 5 === 0 ? "paused" : index % 7 === 0 ? "completed" : "active",
    createdAt: new Date(Date.parse(pmClock) - index * 86400000).toISOString(),
  }))
}
export function projectDaysLeft(dueDate: string | null) {
  if (!dueDate) return null
  return Math.round(
    (Date.parse(`${dueDate}T00:00:00Z`) -
      Date.parse(`${pmClock.slice(0, 10)}T00:00:00Z`)) /
      86400000,
  )
}
export function formatProjectDate(date: string | null, locale: "zh-CN" | "en") {
  return date
    ? new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: pmTimeZone,
      }).format(new Date(`${date}T00:00:00Z`))
    : locale === "en"
      ? "Not scheduled"
      : "未排期"
}

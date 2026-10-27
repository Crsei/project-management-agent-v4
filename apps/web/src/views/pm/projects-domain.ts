import {
  dependencyCycles,
  type WorkDependency,
} from "@/lib/analytics-dependency-model"
import type { AnalyticsEntityRef } from "@/lib/analytics-model"
import type { Copy } from "../views-model"
import { pmClock, pmMembers, type PmScenario } from "./model"
import {
  createProjectList1Fixtures,
  type ProjectCardRecord,
  type ProjectCycle,
  type ProjectStatus,
} from "./project-list-1-fixtures"
import { createIssueDomain, type PmIssue } from "./issue-domain"
import { projectHealthBand, type ProjectHealthBand } from "./project-health"

export const projectsFamilyRevision = "pm-projects-family-2026-10-12-v1"
export type ProjectOutcome = "confirmed" | "rejected" | "unknown"
export type ProjectMilestone = {
  id: string
  projectId: string
  title: Copy
  dueDate: string | null
  status: "planned" | "active" | "done"
}
export type ProjectFile = {
  id: string
  projectId: string
  name: string
  size: string
  content: Copy
  status: "available" | "error"
}
export type ProjectComment = {
  id: string
  projectId: string
  authorId: string
  body: Copy
  createdAt: string
}
export type ProjectActivityEntry = {
  id: string
  projectId: string
  at: string
  actorId: string | null
  title: Copy
  detail?: Copy
}
export type ProjectOverview = {
  projectId: string
  outcomes: Copy[]
  scope: { label: Copy; state: "in" | "out" }[]
  healthNote: Copy
}
export type ProjectDependencySeed = {
  id: string
  projectId: string
  fromId: string
  toId: string
  state: "blocked" | "satisfied" | "unknown"
  evidence: string
}
export type ProjectsFamily = {
  revision: number
  milestones: ProjectMilestone[]
  files: ProjectFile[]
  comments: ProjectComment[]
  activity: ProjectActivityEntry[]
  overview: ProjectOverview[]
  dependencies: ProjectDependencySeed[]
}
export type HealthBandKey = "ontrack" | "watching" | "needsupdate" | "unknown"
export const healthBandLabel: Record<HealthBandKey, Copy> = {
  ontrack: { en: "On track", "zh-CN": "进展顺利" },
  watching: { en: "Watching", "zh-CN": "需要关注" },
  needsupdate: { en: "Needs update", "zh-CN": "需要更新" },
  unknown: { en: "Health unknown", "zh-CN": "健康度未知" },
}
const healthTone: Record<
  HealthBandKey,
  "success" | "warning" | "danger" | "neutral"
> = {
  ontrack: "success",
  watching: "warning",
  needsupdate: "danger",
  unknown: "neutral",
}
/** Adapter over the shared 70/40 thresholds; local vocabulary keeps its band keys. */
const bandAdapter: Record<ProjectHealthBand, HealthBandKey> = {
  "on-track": "ontrack",
  "at-risk": "watching",
  "off-track": "needsupdate",
  unknown: "unknown",
}
export function healthBand(health: number | null): {
  key: HealthBandKey
  label: Copy
  tone: "success" | "warning" | "danger" | "neutral"
} {
  const key = bandAdapter[projectHealthBand(health)]
  return { key, label: healthBandLabel[key], tone: healthTone[key] }
}
function shiftDate(date: string | null, days: number): string | null {
  if (!date) return null
  const value = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(value)) return null
  return new Date(value + days * 86400000).toISOString().slice(0, 10)
}
const today = pmClock.slice(0, 10)
function milestoneStatus(dueDate: string | null): ProjectMilestone["status"] {
  if (!dueDate) return "planned"
  if (dueDate < today) return "done"
  const soon = shiftDate(today, 14)
  if (soon && dueDate <= soon) return "active"
  return "planned"
}
export function projectMilestones(
  family: ProjectsFamily,
  projectId: string,
): ProjectMilestone[] {
  return family.milestones.filter((m) => m.projectId === projectId)
}
export function projectFiles(
  family: ProjectsFamily,
  projectId: string,
): ProjectFile[] {
  return family.files.filter((f) => f.projectId === projectId)
}
export function projectComments(
  family: ProjectsFamily,
  projectId: string,
): ProjectComment[] {
  return family.comments.filter((c) => c.projectId === projectId)
}
export function projectOverview(
  family: ProjectsFamily,
  projectId: string,
): ProjectOverview | undefined {
  return family.overview.find((o) => o.projectId === projectId)
}
export function projectDependencies(
  family: ProjectsFamily,
  projectId: string,
): ProjectDependencySeed[] {
  return family.dependencies.filter((d) => d.projectId === projectId)
}
export type ProjectIssueStats = {
  total: number
  byState: Record<string, number>
  done: number
  progress: number
  review: number
  unassigned: number
  scheduled: number
  unscheduled: number
  estimateSum: number | null
}
const emptyStats = (): ProjectIssueStats => ({
  total: 0,
  byState: {},
  done: 0,
  progress: 0,
  review: 0,
  unassigned: 0,
  scheduled: 0,
  unscheduled: 0,
  estimateSum: null,
})
/** Counts derive only from the shared issue domain; an empty set stays empty, never 0-styled facts. */
export function projectIssueStats(
  items: readonly PmIssue[],
  projectId: string,
): ProjectIssueStats {
  const own = items.filter((item) => item.projectId === projectId)
  if (own.length === 0) return emptyStats()
  const stats = emptyStats()
  stats.total = own.length
  let estimate = 0
  let estimates = 0
  for (const item of own) {
    stats.byState[item.stateId] = (stats.byState[item.stateId] ?? 0) + 1
    if (item.stateId === "done") stats.done += 1
    if (item.stateId === "progress") stats.progress += 1
    if (item.stateId === "review") stats.review += 1
    if (item.assigneeIds.length === 0) stats.unassigned += 1
    if (item.startDate && item.dueDate) stats.scheduled += 1
    else stats.unscheduled += 1
    if (item.estimate !== null) {
      estimate += item.estimate
      estimates += 1
    }
  }
  stats.estimateSum = estimates > 0 ? estimate : null
  return stats
}
function issueRef(projectId: string, entityId: string): AnalyticsEntityRef {
  return { kind: "workItem", sourceId: "pm-issues", projectId, entityId }
}
export type ProjectDependencyGraph = {
  edges: WorkDependency[]
  unresolved: {
    id: string
    fromId: string
    toId: string
    reason: "missing-from" | "missing-to"
  }[]
  cycleCount: number
}
/** Stable seed ids validated against the shared issue domain; unresolved refs are reported, never faked. */
export function validateProjectDependencies(
  seeds: readonly ProjectDependencySeed[],
  issues: readonly PmIssue[],
  projectId: string,
): ProjectDependencyGraph {
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const edges: WorkDependency[] = []
  const unresolved: ProjectDependencyGraph["unresolved"] = []
  for (const seed of seeds) {
    if (seed.projectId !== projectId) continue
    const from = byId.get(seed.fromId)
    const to = byId.get(seed.toId)
    if (!from || !to) {
      unresolved.push({
        id: seed.id,
        fromId: seed.fromId,
        toId: seed.toId,
        reason: !from ? "missing-from" : "missing-to",
      })
      continue
    }
    edges.push({
      id: seed.id,
      from: issueRef(projectId, seed.fromId),
      to: issueRef(projectId, seed.toId),
      state: seed.state,
      evidence: seed.evidence,
    })
  }
  return { edges, unresolved, cycleCount: dependencyCycles(edges).length }
}
export function formatProjectDay(
  date: string | null,
  locale: "zh-CN" | "en",
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
  if (!date) return "—"
  const value = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(value)) return date
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    ...options,
    timeZone: "UTC",
  }).format(new Date(value))
}
export function formatProjectInstant(
  instant: string,
  locale: "zh-CN" | "en",
): string {
  const value = Date.parse(instant)
  if (!Number.isFinite(value)) return instant
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value))
}
export type ProjectSortKey = "updated" | "name" | "due" | "health"
export const projectSortLabel: Record<ProjectSortKey, Copy> = {
  updated: { en: "Recently updated", "zh-CN": "最近更新" },
  name: { en: "Name", "zh-CN": "名称" },
  due: { en: "Due date", "zh-CN": "截止日期" },
  health: { en: "Health", "zh-CN": "健康度" },
}
/** Deterministic: equal values keep fixture order (stable sort with index tie-break). */
export function sortProjects(
  projects: readonly ProjectCardRecord[],
  key: ProjectSortKey,
  dir: "asc" | "desc",
  locale: "zh-CN" | "en",
): ProjectCardRecord[] {
  const direction = dir === "asc" ? 1 : -1
  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => {
      let result = 0
      if (key === "name")
        result = a.project.title[locale].localeCompare(
          b.project.title[locale],
          locale,
        )
      else if (key === "due")
        result = (a.project.dueDate ?? "").localeCompare(
          b.project.dueDate ?? "",
        )
      else if (key === "health")
        result = (a.project.health ?? -1) - (b.project.health ?? -1)
      else result = a.project.updatedAt.localeCompare(b.project.updatedAt)
      return result * direction || a.index - b.index
    })
    .map(({ project }) => project)
}
function createMilestones(
  projects: readonly ProjectCardRecord[],
): ProjectMilestone[] {
  const milestones: ProjectMilestone[] = []
  projects.forEach((project, index) => {
    const due = project.dueDate
    milestones.push({
      id: `${project.id}-ms-scope`,
      projectId: project.id,
      title: { en: "Scope lock", "zh-CN": "范围锁定" },
      dueDate: shiftDate(due, -28),
      status: milestoneStatus(shiftDate(due, -28)),
    })
    milestones.push({
      id: `${project.id}-ms-rc`,
      projectId: project.id,
      title: { en: "Release candidate", "zh-CN": "发布候选" },
      // Every fifth project keeps an undated milestone so missing dates stay visible.
      dueDate: index % 5 === 4 ? null : shiftDate(due, -7),
      status: milestoneStatus(index % 5 === 4 ? null : shiftDate(due, -7)),
    })
  })
  return milestones
}
function createFiles(
  projects: readonly ProjectCardRecord[],
  scenario: PmScenario,
): ProjectFile[] {
  // Snapshot counters come from the baseline issue domain, not live mutations.
  const snapshot = createIssueDomain(scenario).items
  const files: ProjectFile[] = []
  projects.forEach((project, index) => {
    // Every fourth project intentionally has no local files.
    if (index % 4 === 3) return
    const stats = projectIssueStats(snapshot, project.id)
    files.push({
      id: `${project.id}-file-brief`,
      projectId: project.id,
      name: `${project.identifier.toLowerCase()}-brief.md`,
      size: "12 KB",
      content: {
        en: `# ${project.title.en}\n\n${project.description.en}\n\nOwner brief stored locally for preview.`,
        "zh-CN": `# ${project.title["zh-CN"]}\n\n${project.description["zh-CN"]}\n\n本地保存的负责人简报，用于预览。`,
      },
      status: "available",
    })
    files.push({
      id: `${project.id}-file-metrics`,
      projectId: project.id,
      name: `${project.identifier.toLowerCase()}-metrics.csv`,
      size: "184 KB",
      content: {
        en: `metric,value,unit\ntasks_closed_snapshot,${stats.done},count\ntasks_total_snapshot,${stats.total},count\nteam_size,${project.teamSize},people\nhealth,${project.health ?? ""},percent\nsource,local-baseline-issue-snapshot,text`,
        "zh-CN": `指标,数值,单位\ntasks_closed_snapshot,${stats.done},count\ntasks_total_snapshot,${stats.total},count\nteam_size,${project.teamSize},people\nhealth,${project.health ?? ""},percent\nsource,local-baseline-issue-snapshot,text`,
      },
      status: "available",
    })
    // Even projects keep one broken local artifact to exercise failure states.
    if (index % 2 === 0)
      files.push({
        id: `${project.id}-file-handoff`,
        projectId: project.id,
        name: `${project.identifier.toLowerCase()}-handoff.zip`,
        size: "8.6 MB",
        content: { en: "", "zh-CN": "" },
        status: "error",
      })
  })
  return files
}
function createComments(
  projects: readonly ProjectCardRecord[],
): ProjectComment[] {
  const comments: ProjectComment[] = []
  projects.forEach((project, index) => {
    if (index % 2 !== 0) return
    comments.push({
      id: `${project.id}-comment-1`,
      projectId: project.id,
      authorId: pmMembers[(index + 1) % pmMembers.length].id,
      body: {
        en: "Brief reviewed — milestones and owners confirmed for this cycle.",
        "zh-CN": "简报已评审——本周期的里程碑与负责人已确认。",
      },
      createdAt: new Date(Date.parse(pmClock) - 3600000).toISOString(),
    })
    comments.push({
      id: `${project.id}-comment-2`,
      projectId: project.id,
      authorId: pmMembers[(index + 2) % pmMembers.length].id,
      body: {
        en: "Open risk: an undecided scope question could move the due date.",
        "zh-CN": "未决风险：范围问题若不定论可能影响截止日期。",
      },
      createdAt: new Date(Date.parse(pmClock) - 7200000).toISOString(),
    })
  })
  return comments
}
function createActivity(
  projects: readonly ProjectCardRecord[],
): ProjectActivityEntry[] {
  const entries: ProjectActivityEntry[] = []
  for (const project of projects) {
    entries.push({
      id: `${project.id}-activity-update`,
      projectId: project.id,
      at: project.updatedAt,
      actorId: project.ownerId,
      title: { en: "Project brief updated", "zh-CN": "项目简报已更新" },
      detail: project.description,
    })
    entries.push({
      id: `${project.id}-activity-create`,
      projectId: project.id,
      at: project.createdAt,
      actorId: null,
      title: { en: "Project created", "zh-CN": "项目已创建" },
    })
  }
  return entries
}
function createOverview(
  projects: readonly ProjectCardRecord[],
): ProjectOverview[] {
  return projects.map((project) => {
    const band = healthBand(project.health)
    return {
      projectId: project.id,
      outcomes: [
        {
          en: `Ship ${project.title.en} milestones on schedule`,
          "zh-CN": `按计划交付${project.title["zh-CN"]}的里程碑`,
        },
        {
          en: "Keep owners, health and dates visible to stakeholders",
          "zh-CN": "向干系人保持负责人、健康度与日期可见",
        },
        {
          en: "Reduce manual status reporting effort",
          "zh-CN": "减少人工状态汇报工作量",
        },
      ],
      scope: [
        { label: { en: "Delivery", "zh-CN": "交付" }, state: "in" },
        { label: { en: "Reporting", "zh-CN": "报表" }, state: "in" },
        { label: { en: "Intake", "zh-CN": "需求受理" }, state: "in" },
        { label: { en: "Hiring", "zh-CN": "招聘" }, state: "out" },
      ],
      healthNote: {
        en:
          band.key === "unknown"
            ? "Health has not been measured for this project yet; treat forecasts as unconfirmed."
            : `Delivery is assessed as “${band.label.en}” from the local health value. Re-check after the next milestone.`,
        "zh-CN":
          band.key === "unknown"
            ? "本项目尚未测量健康度，请勿据此确认预测。"
            : `本地健康度评估为“${band.label["zh-CN"]}”，下个里程碑后请重新检查。`,
      },
    }
  })
}
function createDependencies(
  projects: readonly ProjectCardRecord[],
  issues: readonly PmIssue[],
): ProjectDependencySeed[] {
  const seeds: ProjectDependencySeed[] = []
  const states: ProjectDependencySeed["state"][] = [
    "satisfied",
    "blocked",
    "unknown",
  ]
  for (const project of projects) {
    const own = issues.filter((issue) => issue.projectId === project.id)
    for (let index = 0; index + 1 < own.length && index < 4; index++) {
      seeds.push({
        id: `dep-${project.id}-${index + 1}`,
        projectId: project.id,
        fromId: own[index].id,
        toId: own[index + 1].id,
        state: states[index % states.length],
        evidence: `${own[index].identifier} must land before ${own[index + 1].identifier}`,
      })
    }
  }
  const first = projects[0]
  const firstIssue = issues.find((issue) => issue.projectId === first?.id)
  if (first && firstIssue)
    seeds.push({
      id: `dep-${first.id}-external`,
      projectId: first.id,
      fromId: "issue-external-9999",
      toId: firstIssue.id,
      state: "unknown",
      evidence: "External tracker link recorded outside the local issue domain",
    })
  return seeds
}
export function createProjectsFamily(
  scenario: PmScenario,
  projects: readonly ProjectCardRecord[],
  issues: readonly PmIssue[],
): ProjectsFamily {
  // Extra fixed facts belong to the baseline fixture entities only. Intersect the
  // canonical array with baseline ids so a project created after this factory runs
  // never inherits invented files/milestones/overview from factory timing.
  const baseline = new Map(
    createProjectList1Fixtures(scenario).map((project) => [
      project.id,
      project,
    ]),
  )
  const list =
    scenario === "empty"
      ? []
      : projects.flatMap((project) => {
          const seed = baseline.get(project.id)
          return seed ? [seed] : []
        })
  return {
    revision: 1,
    milestones: createMilestones(list),
    files: createFiles(list, scenario),
    comments: createComments(list),
    activity: createActivity(list),
    overview: createOverview(list),
    dependencies: scenario === "empty" ? [] : createDependencies(list, issues),
  }
}
export function appendProjectComment(
  family: ProjectsFamily,
  comment: ProjectComment,
): ProjectsFamily {
  return family.comments.some((existing) => existing.id === comment.id)
    ? family
    : { ...family, comments: [...family.comments, comment] }
}
export type ProjectMetaDraft = {
  dueDate: string
  cycle: ProjectCycle
  status: ProjectStatus
}
export const projectMetaDraft = (
  project: ProjectCardRecord | undefined,
): ProjectMetaDraft => ({
  dueDate: project?.dueDate ?? "",
  cycle: project?.cycle ?? "improvement",
  status: project?.status ?? "active",
})

import { usePmScenarioState } from "./shared"
import { useI18n } from "@/lib/i18n-provider"
import { issueCatalog, issueRecord, type PmIssue } from "./issue-domain"
import { cycleCopy, statusCopy, type ProjectCardRecord } from "./project-list-1-fixtures"
import { pmMembers, type PmScenario } from "./model"
import type { ControlledIssueCatalog, ControlledIssueRecord, PmControlledData, ProjectDetailRecord } from "./controlled-contracts"

/** Only explicit showcase adapters translate bilingual fixture business copy. */
export function fixtureIssueProjection(item: PmIssue, locale: "en" | "zh-CN"): ControlledIssueRecord {
  return { ...issueRecord(item, locale), version: `fixture:${item.revision}`, moduleIds: item.moduleId ? [item.moduleId] : [], cycleId: item.cycleId || null, estimatePointId: item.estimate === null ? null : `fixture-estimate:${item.estimate}` }
}
export function fixtureCatalogProjection(items: readonly PmIssue[], projects: readonly ProjectCardRecord[], locale: "en" | "zh-CN"): ControlledIssueCatalog {
  const modules = new Map<string, ControlledIssueCatalog["modules"][number]>()
  const cycles = new Map<string, ControlledIssueCatalog["cycles"][number]>()
  const estimates = new Map<string, ControlledIssueCatalog["estimatePoints"][number]>()
  for (const item of items) {
    if (item.moduleId) modules.set(item.moduleId, { id: item.moduleId, label: item.moduleId, projectId: item.projectId })
    if (item.cycleId) cycles.set(item.cycleId, { id: item.cycleId, label: item.cycleId, projectId: item.projectId })
    if (item.estimate !== null) estimates.set(`${item.projectId}:${item.estimate}`, { id: `fixture-estimate:${item.estimate}`, label: `${item.estimate}h`, projectId: item.projectId })
  }
  return { ...issueCatalog(locale), projects: projects.map((project) => ({ id: project.id, label: project.title[locale] })), modules: [...modules.values()], cycles: [...cycles.values()], estimatePoints: [...estimates.values()] }
}
export function fixtureProjectProjection(project: ProjectCardRecord, issues: readonly PmIssue[], locale: "en" | "zh-CN"): ProjectDetailRecord {
  const own = issues.filter((item) => item.projectId === project.id)
  const owner = pmMembers.find((member) => member.id === project.ownerId)
  const memberIds = new Set([project.ownerId, ...own.flatMap((item) => item.assigneeIds)])
  const members = pmMembers.filter((member) => memberIds.has(member.id)).map((member) => ({ id: member.id, name: member.name }))
  return { id: project.id, identifier: project.identifier, title: project.title[locale], description: project.description[locale], owner: owner ? { id: owner.id, name: owner.name, role: owner.role[locale] } : null, status: { value: project.status, label: statusCopy[project.status][locale], tone: project.status === "active" ? "info" : project.status === "paused" ? "warning" : "success" }, cycle: { value: project.cycle, label: cycleCopy[project.cycle][locale] }, cycleWeeks: project.cycleWeeks, teamSize: project.teamSize, members, health: project.health, dueDate: project.dueDate, archived: project.archived, artwork: project.artwork, starred: project.starred, taskCounts: { closed: own.filter((item) => item.stateId === "done").length, total: own.length }, version: `fixture:${project.updatedAt}`, revision: 1, startDate: null, updatedAt: project.updatedAt, budget: null }
}
export function useFixtureReadState(scenario: PmScenario, consumer: string): PmControlledData {
  const { locale } = useI18n()
  const en = locale === "en"
  const [recovered, setRecovered] = usePmScenarioState(`${consumer}:read-recovered`, () => false)
  return { state: scenario === "loading" ? "loading" : scenario === "empty" ? "empty" : scenario === "refresh-error" && !recovered ? "error" : "success", emptyTitle: en ? "Nothing to display" : "暂无内容", emptyHeadingLevel: 2, error: scenario === "refresh-error" && !recovered ? { category: "network", message: en ? "The simulated refresh failed." : "模拟刷新失败。", reason: en ? "Existing data and edits are retained." : "已有数据和编辑已保留。" } : undefined, onRetry: scenario === "refresh-error" ? () => setRecovered(true) : undefined }
}

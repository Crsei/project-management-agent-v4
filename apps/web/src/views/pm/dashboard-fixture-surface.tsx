import { useI18n } from "@/lib/i18n-provider"
import { usePmScenarioState } from "./shared"
import { pmClock, type PmScenario } from "./model"
import { usePmControlsReady, usePmDomainState, usePmNavigation } from "./domain-session"
import { fixtureIssueProjection, fixtureCatalogProjection, fixtureProjectProjection, useFixtureReadState } from "./fixture-projections"
import type { DashboardViewProps } from "./controlled-contracts"
import type { ProjectCardRecord } from "./project-list-1-fixtures"
import type { PmIssue, PmIssueDomain } from "./issue-domain"
import type { PeopleDomain } from "./people-domain"
import type { IssueDrilldown } from "./issues-controller"

export function useFixtureDashboardSurface(scenario: PmScenario, variant: DashboardViewProps["variant"], projects: readonly ProjectCardRecord[], issues: readonly PmIssue[], people: PeopleDomain, activity: PmIssueDomain["activity"] = []): DashboardViewProps {
  const interactive = usePmControlsReady()
  const { locale } = useI18n()
  const en = locale === "en"
  const { navigate } = usePmNavigation()
  const [, setIssueDrilldown] = usePmDomainState<IssueDrilldown | null>("issue-list-1:drilldown", () => null)
  const [interaction, setInteraction] = usePmScenarioState<DashboardViewProps["interaction"]>(`pm-${variant}-controlled-interaction`, () => ({ selectedProjectId: null, query: "" }))
  const [readingPosition, setReadingPosition] = usePmScenarioState(`pm-${variant}-reading`, () => 0)
  const [focusId, setFocusId] = usePmScenarioState<string | null>(`pm-${variant}-focus`, () => null)
  const [snapshotReads, setSnapshotReads] = usePmScenarioState(`pm-${variant}-snapshot-reads`, () => 0)
  const data = useFixtureReadState(scenario, variant)
  const available = (value: number) => ({ value: scenario === "loading" ? null : value, description: en ? "Explicit local fixture count" : "显式本地场景计数" })
  const today = pmClock.slice(0, 10)
  const catalog = fixtureCatalogProjection(issues, projects, locale)
  const completedStateIds = new Set(catalog.states.filter(state => state.category === "completed").map(state => state.id))
  const query = interaction.query.trim().toLocaleLowerCase(locale)
  const cohort = issues.filter(issue => (!interaction.selectedProjectId || issue.projectId === interaction.selectedProjectId) && (!query || `${issue.identifier} ${issue.titleCopy[locale]}`.toLocaleLowerCase(locale).includes(query)))
  const title = variant === "dashboard1" ? (en ? "My workspace" : "我的工作区") : variant === "dashboard2" ? (en ? "Dashboard" : "概览") : variant === "dashboard3" ? (en ? "Command Center" : "指挥中心") : (en ? "Project Dependency Map" : "项目依赖地图")
  const description = variant === "dashboard3" ? (en ? "Track delivery, focus on what matters, and ship with confidence." : "追踪交付，专注要务，从容发布。") : variant === "dashboard4" ? (en ? "Track delivery risk, owners, blockers, and dependent milestones across active projects." : "跟踪活跃项目的交付风险、负责人、阻塞项与依赖里程碑。") : ""
  return {
    variant,
    interactive,
    pageId: `pm-dashboard-${variant.slice(-1)}`,
    readModel: {
      title, description,
      projects: scenario === "loading" ? [] : projects.map(project => fixtureProjectProjection(project, issues, locale)),
      issues: scenario === "loading" ? [] : cohort.map(issue => fixtureIssueProjection(issue, locale)),
      catalog,
      counts: { projects: available(projects.length), issues: available(cohort.length), completed: available(cohort.filter(issue => completedStateIds.has(issue.stateId)).length), overdue: available(cohort.filter(issue => !completedStateIds.has(issue.stateId) && issue.dueDate !== null && issue.dueDate < today).length), members: available(people.people.length), teams: available(people.teams.length) },
      stateCounts: catalog.states.map(state => ({ id: state.id, label: state.label, count: available(cohort.filter(issue => issue.stateId === state.id).length) })),
      activity: activity.map(event => ({ id: event.id, at: event.at, actor: en ? "Local fixture" : "本地场景", description: event.description[locale], kind: "update" })),
      data: { ...data, updatedAt: pmClock, loadingLabel: en ? "Loading local scene" : "正在加载本地场景", emptyDescription: en ? "This local scene has no projects or issues. Choose another scene to inspect the examples." : "当前本地场景没有项目或任务。请选择其他场景查看示例。", emptyTitle: en ? "Nothing to display" : "暂无内容", emptyHeadingLevel: 2 },
      today,
      dependencyDescription: en ? "Stored fixture edges only; node positions never establish a dependency." : "依赖只来自存储的场景边，节点位置不会产生依赖。",
      unavailableDescription: en ? "Local showcase data; no remote service is connected." : "本地展示数据，未连接远端服务。",
    },
    interaction,
    actions: {
      setInteraction,
      refresh: () => { data.onRetry?.(); setSnapshotReads(previous => previous + 1) },
      openProject: id => navigate("project-detail-1", id),
      openIssue: issue => navigate("issue-detail-1", issue.id),
      openIssues: filter => {
        const projectId = filter?.projectId ?? interaction.selectedProjectId
        setIssueDrilldown({ projectId, query: interaction.query, stateIds: filter?.stateId ? [filter.stateId] : filter?.completed ? [...completedStateIds] : [], overdue: filter?.overdue ?? false })
        navigate("issue-list-1", projectId ?? undefined)
      },
      createProject: () => navigate("project-list-1"),
      createIssue: () => navigate("issue-list-1"),
      openPeople: () => navigate("member-list-1"),
    },
    capabilities: { createProject: scenario !== "readonly" && scenario !== "loading", createIssue: scenario !== "readonly" && scenario !== "loading" },
    readingPosition,
    onReadingPositionChange: setReadingPosition,
    focusId,
    onFocusIdChange: setFocusId,
    feedback: snapshotReads > 0 ? <p role="status" className="mb-3 text-xs text-muted-foreground">{en ? "Local snapshot re-read" : "已重读本地快照"} · {snapshotReads}</p> : undefined,
  }
}

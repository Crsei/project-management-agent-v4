import { useMemo } from "react"
import { ChevronRight, Globe } from "lucide-react"
import type { BadgeProps } from "@/components/ui/badge"
import { useI18n } from "@/lib/i18n-provider"
import type { ProjectCollectionRecord, ProjectCollectionViewProps } from "./project-collection-contracts"
import { projectHealthBand } from "./project-health"
import styles from "./project-list-4.module.css"

export type ProjectSummaryIssue = {
  id: string
  identifier: string
  title: string
  description: string | null
  state: { label: string; tone: BadgeProps["tone"] } | null
  priorityTone?: BadgeProps["tone"]
  updatedAt?: string | null
  /** Relative copy must come from the host's authoritative clock. */
  updatedLabel?: string | null
}

export type ProjectSummaryIssuesProps = {
  project: ProjectCollectionRecord
  issues: readonly ProjectSummaryIssue[]
  onOpenProject?: () => void
  onOpenIssues?: () => void
  onOpenIssue?: (issueId: string) => void
  emptyLabel?: string
}

/** Compact rows select a project; navigation remains available in the shared summary rail. */
export function ProjectListFourSurface({ props, onSelect }: {
  props: ProjectCollectionViewProps
  onSelect: (project: ProjectCollectionRecord, trigger: HTMLButtonElement) => void
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const formatter = useMemo(() => new Intl.DateTimeFormat(en ? "en-US" : locale, { month: "short", day: "numeric", year: "numeric" }), [en, locale])
  return <ul className={styles.projectList} data-pm-summary-list>
    {props.readModel.projects.map((project) => <li key={project.id} className={styles.projectItem} data-selected={props.interaction.selectedId === project.id || undefined}>
      <button type="button" className={styles.projectRow} data-pm-summary-row={project.id} aria-current={props.interaction.selectedId === project.id ? "true" : undefined} onClick={(event) => onSelect(project, event.currentTarget)}>
        <span className={styles.projectMain}>
          <span className={styles.projectTitleLine}>
            <span className={styles.dot} data-health={project.healthAssessment === undefined ? projectHealthBand(project.health) : project.healthAssessment?.status.replaceAll("_", "-") ?? "unknown"} aria-hidden="true"><span /></span>
            <span className={styles.projectTitle}><span>{project.identifier}</span><span className={styles.separator}>/</span><span className={styles.truncate} title={project.title}>{project.title}</span></span>
          </span>
          <span className={styles.descriptionLine}>
            <span className={styles.truncate} title={project.description ?? undefined}>{project.description ?? "—"}</span>
            {project.updatedAt && <><span className={styles.metadataDot} aria-hidden="true" /><time dateTime={project.updatedAt}>{formatter.format(new Date(project.updatedAt))}</time></>}
          </span>
        </span>
        <span className={styles.issueCount} title={project.taskCounts ? undefined : props.readModel.unavailableTasksLabel} aria-label={project.taskCounts ? undefined : props.readModel.unavailableTasksLabel ?? (en ? "Issue count unavailable" : "任务数量不可用")}>{project.taskCounts ? `${project.taskCounts.total}${en ? project.taskCounts.total === 1 ? " issue" : " issues" : " 个任务"}` : "—"}</span>
        <ChevronRight className={styles.rowChevron} aria-hidden="true" />
      </button>
      {props.renderProjectAction && <span className={styles.projectAction}>{props.renderProjectAction(project)}</span>}
    </li>)}
  </ul>
}

/** Host-projected issue facts only: fixtures and service pages use this same rail. */
export function ProjectSummaryIssues({ project, issues, onOpenProject, onOpenIssues, onOpenIssue, emptyLabel }: ProjectSummaryIssuesProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const formatter = useMemo(() => new Intl.DateTimeFormat(en ? "en-US" : locale, { month: "short", day: "numeric" }), [en, locale])
  return <>
    <div className={styles.railSticky}>
      <header className={styles.railHeading}><h2>{en ? "Issues" : "任务"}</h2><button type="button" className={styles.viewAll} disabled={!onOpenIssues} onClick={onOpenIssues}>{en ? "View all" : "查看全部"}</button></header>
      <button type="button" className={styles.railProject} disabled={!onOpenProject} onClick={onOpenProject} data-pm-summary-project={project.id}>
        <span className={styles.projectIcon}><Globe aria-hidden="true" /></span>
        <span className={styles.railProjectCopy}><strong title={project.title}>{project.title}</strong><span>{project.teamSize === null ? "—" : `${project.teamSize}${en ? " members" : " 名成员"}`} · {project.taskCounts ? `${project.taskCounts.closed}/${project.taskCounts.total}${en ? " tasks closed" : " 项任务已完成"}` : emptyLabel ?? (en ? "No linked task snapshot" : "无关联任务快照")}</span></span>
      </button>
    </div>
    {issues.length > 0 ? <ul className={styles.issueList}>{issues.map((issue) => <li key={issue.id}>
      <button type="button" className={styles.issueRow} disabled={!onOpenIssue} data-pm-summary-issue={issue.id} onClick={() => onOpenIssue?.(issue.id)}>
        <span className={styles.dot} data-tone={issue.priorityTone ?? "neutral"} aria-hidden="true"><span /></span>
        <span className={styles.issueMain}>
          <span className={styles.issueTitleLine}>
            <span className={styles.issueTitle}><span>{issue.identifier}</span><span className={styles.separator}>/</span><span className={styles.truncate} title={issue.title}>{issue.title}</span></span>
            {issue.state && <span className={styles.issueState} data-tone={issue.state.tone ?? "neutral"}>{issue.state.label}</span>}
          </span>
          <span className={styles.issueDescription}>
            <span className={styles.truncate} title={issue.description ?? undefined}>{issue.description || (en ? "No description" : "暂无描述")}</span>
            {(issue.updatedLabel || issue.updatedAt) && <><span className={styles.metadataDot} aria-hidden="true" /><time dateTime={issue.updatedAt ?? undefined}>{issue.updatedLabel ?? (issue.updatedAt ? formatter.format(new Date(issue.updatedAt)) : "")}</time></>}
          </span>
        </span>
      </button>
    </li>)}</ul> : <p className={styles.empty}>{emptyLabel ?? (en ? "No shared issues relate to this project." : "当前项目暂无关联的共享任务。")}</p>}
  </>
}

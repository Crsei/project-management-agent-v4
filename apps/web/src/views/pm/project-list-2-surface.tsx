import { CalendarDays, PanelsTopLeft } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Meter } from "@/components/ui/progress"
import type { ProjectCollectionRecord, ProjectCollectionViewProps } from "./project-collection-contracts"
import styles from "./project-list-2.module.css"

type ProjectBrowseCardProps = {
  project: ProjectCollectionRecord
  locale: "zh-CN" | "en"
  selected: boolean
  readonly: boolean
  onSelect: (element: HTMLButtonElement) => void
  onStar: () => void
  readModel: ProjectCollectionViewProps["readModel"]
  renderProjectAction?: ProjectCollectionViewProps["renderProjectAction"]
}

/** Browse uses the host's records and selection flow, without introducing a second data source. */
export function ProjectBrowseCard({ project, locale, selected, onSelect, readModel, renderProjectAction }: ProjectBrowseCardProps) {
  const en = locale === "en"
  const members: NonNullable<ProjectCollectionRecord["members"]> = project.members?.length ? project.members : project.teamSize !== null && project.owner ? [project.owner] : []
  const visibleMembers = members.slice(0, 3)
  const extraMembers = Math.max(0, (project.teamSize ?? members.length) - visibleMembers.length)
  const counts = project.taskCounts
  const date = project.dueDate
    ? new Intl.DateTimeFormat(en ? "en-GB" : locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(project.dueDate + "T00:00:00Z"))
    : readModel.unavailableDateLabel ?? "—"
  const status = project.archived ? en ? "Archived" : "已归档" : project.status?.label ?? "—"
  return <article className={styles.card} data-pm-project={project.id} data-selected={selected} aria-labelledby={`${project.id}-title`}>
    <div className={styles.cardTop}>
      <div className={styles.identity}>
        <span className={styles.projectIcon}><PanelsTopLeft aria-hidden="true" /></span>
        <span className={styles.identifier}>{project.identifier}</span>
      </div>
      <div className={styles.cardTopRight}>
        {renderProjectAction?.(project)}
        <span className={styles.status} data-tone={project.archived ? "neutral" : project.status?.tone ?? "neutral"}>
          <span aria-hidden="true" />{status}
        </span>
      </div>
    </div>
    <div className={styles.projectHeading}>
      <h2 id={`${project.id}-title`}><button className={styles.titleButton} onClick={(event) => onSelect(event.currentTarget)}>{project.title}</button></h2>
      <p className={styles.cycle}>{project.cycle?.label ?? "—"} • {project.cycleWeeks === null ? "—" : en ? `${project.cycleWeeks} weeks` : `${project.cycleWeeks} 周`}</p>
    </div>
    <p className={styles.description} title={project.description ?? undefined}>{project.description ?? "—"}</p>
    <div className={styles.meta}>
      <span className={styles.date}><CalendarDays aria-hidden="true" /><span>{date}</span></span>
      <span className={styles.team} aria-label={en ? `${project.teamSize ?? "—"} team members` : `${project.teamSize ?? "—"} 位团队成员`}>
        {visibleMembers.map((member) => <span className={styles.avatar} key={member.id}><Avatar name={member.name} src={member.avatarUrl ?? undefined} size={24} /></span>)}
        {extraMembers > 0 && <span className={`${styles.avatar} ${styles.extraMembers}`}>+{extraMembers}</span>}
        {members.length === 0 && <span>{project.teamSize === null ? "—" : en ? `${project.teamSize} members` : `${project.teamSize} 人`}</span>}
      </span>
    </div>
    <div className={styles.progress}>
      <div className={styles.healthSummary}>
        <span className={styles.healthValue}>{project.health === null ? readModel.unavailableHealthLabel ?? "—" : `${project.health}%`}</span>
        <span className={styles.taskCounts}>{counts ? `${counts.closed}/${counts.total} ${en ? "done" : "完成"} · ${counts.total - counts.closed} ${en ? "open" : "待办"}` : readModel.unavailableTasksLabel ?? "—"}</span>
      </div>
      {project.health !== null && <Meter className={styles.meter} min={0} max={100} value={project.health} data-low={project.health < 40} aria-label={readModel.healthMetric === "completion" ? en ? `${project.title} task completion` : `${project.title} 任务完成比例` : en ? `${project.title} timeline health` : `${project.title} 时间线健康度`} />}
    </div>
  </article>
}

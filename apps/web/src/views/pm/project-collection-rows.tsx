import { Activity, ArrowDown, ArrowUp, CalendarDays, CircleCheck, CircleHelp, Clock3, FolderKanban, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/ui/avatar"
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useI18n } from "@/lib/i18n-provider"
import { Fragment, useMemo, type ReactNode } from "react"
import type { ProjectCollectionRecord, ProjectCollectionViewProps } from "./project-collection-contracts"
import { projectHealthBand } from "./project-health"
import { ProjectListFourSurface } from "./project-list-4-surface"
import styles from "./project-list-3.module.css"

type ColumnKey = "owner" | "health" | "milestone" | "team" | "updated"
type SortKey = NonNullable<ProjectCollectionViewProps["table"]>["sortKey"]
type ProjectColumn = { key: ColumnKey; label: string; width: number; sortKey?: SortKey; cell: (project: ProjectCollectionRecord) => ReactNode }

/** Controlled project table; compact summaries have their own measured surface. */
export function ProjectCollectionRows({ props, onSelect }: { props: ProjectCollectionViewProps; onSelect: (project: ProjectCollectionRecord, trigger: HTMLButtonElement) => void }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const { readModel: model, interaction, actions, capabilities } = props
  const config = props.table
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale === "en" ? "en-US" : locale, { month: "short", day: "numeric", timeZone: "UTC" }), [locale])
  const fullDateFormatter = useMemo(() => new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }), [locale])
  if (props.variant === "compact") return <ProjectListFourSurface props={props} onSelect={onSelect} />

  const columns: ProjectColumn[] = [
    { key: "owner", label: en ? "Owner" : "负责人", width: 13.43, sortKey: config?.sortableKeys?.includes("owner") ? "owner" : undefined, cell: (project) => project.owner ? <span className={styles.ownerCell}><Avatar name={project.owner.name} size={24} className={styles.ownerAvatar} /><span title={project.owner.name}>{project.owner.name}</span></span> : <span className={styles.muted}>—</span> },
    { key: "health", label: model.healthAssessmentLabel ?? model.healthLabel ?? (en ? "Health" : "健康度"), width: 12.47, sortKey: "health", cell: (project) => {
      if (project.healthAssessment !== undefined) {
        const assessment = project.healthAssessment
        const band = assessment?.status === "on_track" ? "on-track" : assessment?.status === "at_risk" ? "at-risk" : assessment?.status === "off_track" ? "off-track" : "unknown"
        const Icon = band === "on-track" ? CircleCheck : band === "unknown" ? CircleHelp : Activity
        const label = band === "on-track" ? en ? "On track" : "进展顺利" : band === "at-risk" ? en ? "At risk" : "存在风险" : band === "off-track" ? en ? "Off track" : "偏离计划" : en ? "Not assessed" : "尚未评估"
        return <span className={styles.healthBadge} data-band={band} title={assessment?.rationale}><Icon aria-hidden="true" /><span>{label}</span></span>
      }
      const band = projectHealthBand(project.health)
      const Icon = band === "on-track" ? CircleCheck : band === "at-risk" ? Activity : CircleHelp
      const label = model.healthMetric === "completion"
        ? project.health === null ? model.unavailableHealthLabel ?? "—" : `${project.health}%`
        : band === "unknown" ? model.unavailableHealthLabel ?? (en ? "Health unknown" : "健康度未知") : band === "on-track" ? en ? "On track" : "进展顺利" : band === "at-risk" ? en ? "Watching" : "需要关注" : en ? "Needs update" : "需要更新"
      return <span className={styles.healthBadge} data-band={band} title={model.healthDescription}><Icon aria-hidden="true" /><span>{label}</span></span>
    } },
    { key: "milestone", label: en ? "Milestone" : "里程碑", width: 15.35, sortKey: config?.sortableKeys?.includes("milestone") ? "milestone" : "due", cell: (project) => <span className={styles.milestoneCell}><span className={styles.milestoneTitle} title={project.milestone?.title}>{project.milestone?.title ?? "—"}</span><span className={styles.milestoneDate}><CalendarDays aria-hidden="true" /><time dateTime={project.milestone?.date ?? undefined}>{project.milestone?.date ? dateFormatter.format(new Date(project.milestone.date)) : "—"}</time></span></span> },
    { key: "team", label: en ? "Team" : "团队", width: 12.47, sortKey: config?.sortableKeys?.includes("team") ? "team" : undefined, cell: (project) => {
      const names = project.teams === undefined ? project.teamId : project.teams?.map(team => team.name).join(", ")
      return <span className={styles.teamCell} title={names ? `${names}${project.teamSize === null ? "" : ` · ${project.teamSize}${en ? " members" : " 位成员"}`}` : undefined}><span className={styles.teamIcon}><Users aria-hidden="true" /></span><span>{names || (project.teamSize === null ? "—" : `${project.teamSize}${en ? " members" : " 位成员"}`)}</span></span>
    } },
    { key: "updated", label: en ? "Updated" : "更新于", width: 11.63, sortKey: "updated", cell: (project) => <span className={styles.updatedTime}><Clock3 aria-hidden="true" /><time dateTime={project.updatedAt ?? undefined} title={project.updatedAt ? fullDateFormatter.format(new Date(project.updatedAt)) + " UTC" : undefined}>{project.updatedAt ? dateFormatter.format(new Date(project.updatedAt)) : "—"}</time></span> },
  ]
  const visibleColumns = columns.filter((column) => !config?.hiddenColumns?.includes(column.key))
  const hasUpdated = visibleColumns.some((column) => column.key === "updated")
  // Desktop column proportions include the reference's 24px outer gutters.
  const nameColumnWidth = 34.65
  const columnWeight = nameColumnWidth + visibleColumns.reduce((sum, column) => sum + column.width, 0)
  return <TableContainer className={styles.tableScroll} aria-label={en ? "Projects" : "项目"} data-pm-project-table>
    <Table className={styles.table}>
      <colgroup>
        <col style={{ width: `${nameColumnWidth / columnWeight * 100}%` }} />
        {visibleColumns.map((column) => <col key={column.key} style={{ width: `${column.width / columnWeight * 100}%` }} />)}
        {!hasUpdated && <col className={styles.actionColumn} />}
      </colgroup>
      <TableHeader className={styles.tableHeader}><TableRow>
        {[{ key: "name", label: en ? "Project" : "项目", sortKey: "name" as const }, ...visibleColumns].map((column) => <TableHead key={column.key} data-pm-project-column={column.key === "name" ? undefined : column.key} aria-sort={column.sortKey && config?.sortKey === column.sortKey ? config.sortDir === "asc" ? "ascending" : "descending" : undefined}>
          {column.sortKey && (!config?.sortableKeys || config.sortableKeys.includes(column.sortKey)) && (column.key === "name" || config?.onSort || column.key === "updated") ? <Button variant="ghost" className={styles.sortButton} onClick={() => {
            if (config?.onSort && column.sortKey) config.onSort(column.sortKey)
            else actions.setInteraction((previous) => ({ ...previous, sort: column.key === "name" ? previous.sort === "name" ? "name-desc" : "name" : previous.sort === "newest" ? "oldest" : "newest" }))
          }}>{column.label}{config?.sortKey === column.sortKey && <span className={styles.sortIndicator} aria-hidden="true">{config?.sortDir === "asc" ? <ArrowUp /> : <ArrowDown />}</span>}</Button> : column.label}
        </TableHead>)}
        {!hasUpdated && <TableHead className={styles.rowActionCell}><span className={styles.srOnly}>{en ? "Actions" : "操作"}</span></TableHead>}
      </TableRow></TableHeader>
      <TableBody>{model.projects.map((project) => {
        const rowActions = config?.rowActions ? config.rowActions(project) : capabilities.edit(project.id) ? <Button variant="ghost" size="sm" onClick={(event) => actions.edit(project.id, event.currentTarget)}>{en ? "Edit" : "编辑"}</Button> : null
        const projectAction = props.renderProjectAction?.(project)
        const rowActionNodes = <>{projectAction}{rowActions}</>
        const row = <TableRow className={styles.tableRow} data-pm-project-row={project.id} data-selected={interaction.selectedId === project.id || undefined} onClick={(event) => { if (event.target instanceof Element && event.target.closest("button,a,input,[role=menuitem]")) return; actions.setInteraction((previous) => ({ ...previous, selectedId: project.id })) }}>
          <TableCell><Button variant="ghost" className={styles.projectButton} onClick={() => { if (config?.onOpen) config.onOpen(project.id); else if (capabilities.openFullDetails) actions.openFullDetails(project.id) }} disabled={!config?.onOpen && !capabilities.openFullDetails}><span className={styles.projectIcon}><FolderKanban aria-hidden="true" /></span><span className={styles.projectCell}><strong className={styles.projectCellTitle} title={project.title}>{project.title}</strong><span className={styles.projectIdentifier}>{project.identifier}</span></span></Button></TableCell>
          {visibleColumns.map((column) => <TableCell key={column.key} data-pm-project-column={column.key}>{column.key === "updated" ? <span className={styles.updatedCell}>{column.cell(project)}<span className={styles.inlineActions}>{rowActionNodes}</span></span> : column.cell(project)}</TableCell>)}
          {!hasUpdated && <TableCell className={styles.rowActionCell}>{rowActionNodes}</TableCell>}
        </TableRow>
        return <Fragment key={project.id}>{props.renderProjectContextMenu ? props.renderProjectContextMenu(project, row) : row}</Fragment>
      })}</TableBody>
    </Table>
  </TableContainer>
}

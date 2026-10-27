import { useRef, type ReactNode } from "react"
import { Check, ChevronDown, ChevronsUpDown, FolderKanban, Link2, Plus, SlidersHorizontal, Star } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Meter } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { FilterToolbar } from "@/components/blocks/filter-toolbar"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu"
import { useI18n } from "@/lib/i18n-provider"
import { DataRegion } from "@/components/ui/data-region"
import { PmPage, PmSearch } from "./presentation-page"
import type { ProjectCollectionRecord, ProjectCollectionViewInteraction, ProjectCollectionViewProps } from "./project-collection-contracts"
import { ProjectCollectionRows } from "./project-collection-rows"
import { ProjectBrowseCard } from "./project-list-2-surface"
import { ProjectSummaryIssues } from "./project-list-4-surface"
import familyStyles from "./projects-views.module.css"
import styles from "./project-list-1.module.css"
import browseStyles from "./project-list-2.module.css"
import compactStyles from "./project-list-4.module.css"

function projectDaysLeft(dueDate: string | null, referenceDate: string | null) {
  if (!dueDate || !referenceDate) return null
  return Math.round((Date.parse(dueDate + "T00:00:00Z") - Date.parse(referenceDate + "T00:00:00Z")) / 86400000)
}
function formatProjectDate(date: string | null, locale: "zh-CN" | "en", unavailableLabel?: string) {
  return date ? new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(date + "T00:00:00Z")) : unavailableLabel ?? "—"
}

export function ProjectSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
  displayLabel,
  icon,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
  id?: string
  displayLabel?: string
  icon?: ReactNode
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        className="inline-flex min-w-36 items-center justify-between gap-2"
      >
        <SelectValue>
          {displayLabel ?? options.find((option) => option.value === value)?.label}
        </SelectValue>
        {icon ?? <ChevronDown aria-hidden="true" className="size-4" />}
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ProjectHealth({
  project,
  locale,
  unavailableLabel,
  metric,
}: {
  project: ProjectCollectionRecord
  locale: "zh-CN" | "en"
  unavailableLabel?: string
  metric?: "assessment" | "completion"
}) {
  const en = locale === "en"
  return project.health === null ? (
    <p className={styles.value}>{unavailableLabel ?? "—"}</p>
  ) : (
    <div
      className={styles.health}
      data-tone={
        project.health < 40
          ? "danger"
          : project.health < 70
            ? "warning"
            : "success"
      }
    >
      <Meter
        min={0}
        max={100}
        value={project.health}
        aria-label={
          metric === "completion"
            ? en ? `${project.title} task completion` : `${project.title} 任务完成比例`
            : en ? `${project.title} timeline health` : `${project.title} 时间线健康度`
        }
      />
      <strong>{project.health}%</strong>
    </div>
  )
}

function ProjectStar({
  project,
  locale,
  readonly,
  onStar,
}: {
  project: ProjectCollectionRecord
  locale: "zh-CN" | "en"
  readonly: boolean
  onStar: () => void
}) {
  const en = locale === "en"
  const title = project.title
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={readonly || project.starred === null}
      aria-pressed={project.starred ?? undefined}
      aria-label={en ? `Star ${title}` : `收藏 ${title}`}
      onClick={onStar}
    >
      <Star
        aria-hidden="true"
        fill={project.starred ? "currentColor" : "none"}
        className={project.starred ? "text-primary" : undefined}
      />
    </Button>
  )
}

function ProjectCard({
  project,
  locale,
  selected,
  readonly,
  onSelect,
  onStar,
  readModel,
  renderProjectAction,
}: {
  project: ProjectCollectionRecord
  locale: "zh-CN" | "en"
  selected: boolean
  readonly: boolean
  onSelect: (element: HTMLButtonElement) => void
  onStar: () => void
  readModel: ProjectCollectionViewProps["readModel"]
  renderProjectAction?: ProjectCollectionViewProps["renderProjectAction"]
}) {
  const en = locale === "en"
  const title = project.title
  const taskCounts = project.taskCounts
  const days = projectDaysLeft(project.dueDate, readModel.referenceDate)
  const configuredArtwork = project.artwork !== null && Number.isInteger(project.artwork) && project.artwork >= 0 && project.artwork < 10
  // One shared decorative cover is presentation, never configured project metadata.
  const artwork = configuredArtwork ? `/images/project-backgrounds/${project.artwork! + 1}.webp` : "/images/project-backgrounds/1.webp"
  const daysLabel =
    days === null
      ? readModel.unavailableDateLabel ?? "—"
      : days < 0
        ? en
          ? `${Math.abs(days)} days overdue`
          : `逾期 ${Math.abs(days)} 天`
        : en
          ? `${days} days left`
          : `剩余 ${days} 天`
  return (
    <article
      className={styles.card}
      data-pm-project={project.id}
      data-selected={selected}
      aria-labelledby={`${project.id}-title`}
    >
      <div className={styles.cover} data-artwork={project.coverVersionId ?? (configuredArtwork ? project.artwork : "decorative-default")} data-pm-cover-source={project.coverVersionId ? "artifact-version" : configuredArtwork ? "project" : "decorative-default"}>
        {project.coverVersionId && readModel.renderCover ? readModel.renderCover(project, styles.coverImage) : <img className={styles.coverImage} src={artwork} alt="" aria-hidden="true" loading="lazy" />}
        <div className={styles.coverTop}>
          <Badge
            className={styles.coverStatus}
            shape="pill"
            size="sm"
            tone={project.archived ? "neutral" : project.status?.tone ?? "neutral"}
          >
            {project.archived ? (en ? "Archived" : "已归档") : project.status?.label ?? "—"}
          </Badge>
          <div className={styles.coverActions}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                en ? `Open details for ${title}` : `查看 ${title} 的详情`
              }
              onClick={(event) => onSelect(event.currentTarget)}
            >
              <Link2 aria-hidden="true" />
            </Button>
            {renderProjectAction?.(project)}
            <ProjectStar
              project={project}
              locale={locale}
              readonly={readonly}
              onStar={onStar}
            />
          </div>
        </div>
        <div>
          <p className={styles.identifier}>{project.identifier}</p>
          <h2 id={`${project.id}-title`} className={styles.projectTitle}>
            <button
              className={styles.titleButton}
              title={title}
              onClick={(event) => onSelect(event.currentTarget)}
            >
              {title}
            </button>
          </h2>
        </div>
      </div>
      <div className={styles.body}>
        <div>
          <p className={styles.label}>{en ? "Cycle" : "周期"}</p>
          <p className={styles.value}>
            {project.cycle?.label ?? "—"}
            <span className={styles.inlineNote}>
              {project.cycleWeeks === null ? "—" : en ? `${project.cycleWeeks} weeks` : `${project.cycleWeeks} 周`}
            </span>
          </p>
        </div>
        <div>
          <div className={styles.healthHeader}>
            <p className={styles.label}>
              {readModel.healthLabel ?? (en ? "Timeline health" : "时间线健康度")}
            </p>
            <span className={styles.label}>{daysLabel}</span>
          </div>
          <ProjectHealth project={project} locale={locale} metric={readModel.healthMetric} unavailableLabel={readModel.unavailableHealthLabel} />
        </div>
        <div className={styles.facts}>
          <div>
            <p className={styles.label}>{en ? "Due date" : "截止日期"}</p>
            <p className={styles.value}>
              {formatProjectDate(project.dueDate, locale, readModel.unavailableDateLabel)}
            </p>
            <p className={styles.note}>
              {days === null ? readModel.dateContextLabel : (en ? `${Math.max(0, Math.ceil(days / 7))} weeks` : `${Math.max(0, Math.ceil(days / 7))} 周`) + (readModel.dateContextLabel ? " · " + readModel.dateContextLabel : "")}
            </p>
          </div>
          <div>
            <p className={styles.label}>{en ? "Tasks closed" : "已关闭任务"}</p>
            <p className={styles.value}>
              {taskCounts ? `${taskCounts.closed}/${taskCounts.total}` : "—"}
            </p>
            <p className={styles.note}>
              {taskCounts
                ? en
                  ? `${taskCounts.total - taskCounts.closed} open tasks`
                  : `${taskCounts.total - taskCounts.closed} 个待关闭任务`
                : readModel.unavailableTasksLabel ?? (en ? "Task totals unavailable" : "任务统计不可用")}
            </p>
          </div>
        </div>
      </div>
    </article>
  )
}

/** Controlled rendering only: the caller supplies all facts, capabilities and actions. */
export function ProjectCollectionView(props: ProjectCollectionViewProps) {
  const { variant, readModel, interaction: state, capabilities, actions, hasDraft = false, pendingRequestId, feedback, editLabel, createDialog } = props
  const browse = variant === "browse"
  const pageId = variant === "table" ? "pm-project-list-3" : variant === "compact" ? "pm-project-list-4" : browse ? "pm-project-list-2" : "pm-project-list-1"
  const defaultArchiveScope = readModel.defaultArchiveScope
  const { locale } = useI18n()
  const en = locale === "en"
  const setState = actions.setInteraction
  const opener = useRef<HTMLButtonElement | null>(null)
  const addButton = useRef<HTMLButtonElement | null>(null)
  const projects = readModel.projects
  const hasSnapshot = projects.length > 0 || !!readModel.data.updatedAt || readModel.data.state === "success" || readModel.data.state === "empty" || readModel.data.state === "partial"
  const selected = readModel.selectedProject
  const owner = selected?.owner
  const selectedCounts = selected?.taskCounts
  const hasArchiveFilter = state.archiveScope !== defaultArchiveScope
  const filterCount = Number(state.status !== "all") + Number(state.starredOnly) + Number(state.updatedWithin > 0) + Number(hasArchiveFilter)
  const update = <K extends keyof ProjectCollectionViewInteraction>(
    key: K,
    value: ProjectCollectionViewInteraction[K],
  ) => setState((previous) => ({ ...previous, [key]: value }))
  const statusOptions = readModel.statusOptions
  const openDetail = (
    project: ProjectCollectionRecord,
    element: HTMLButtonElement,
  ) => {
    opener.current = element
    setState((previous) => ({
      ...previous,
      selectedId: project.id,
      detailOpen: true,
    }))
  }
  const finalFocus = () =>
    opener.current?.isConnected ? opener.current : addButton.current
  const sortControl = (
    <ProjectSelect
      id={`${pageId}-sort`}
      label={en ? "Sort projects" : "项目排序"}
      displayLabel={variant === "compact" ? (en ? "Sort by" : "排序") : undefined}
      icon={variant === "compact" ? <ChevronsUpDown aria-hidden="true" className="size-4" /> : undefined}
      value={state.sort}
      onChange={(value) => update("sort", value)}
      options={[
        { value: "newest", label: en ? "Newest first" : "最新优先" },
        { value: "oldest", label: en ? "Oldest first" : "最早优先" },
        { value: "name", label: en ? "Name A–Z" : "按名称排序" },
        { value: "name-desc", label: en ? "Name Z–A" : "名称 Z–A" },
      ]}
    />
  )
  const teamControl = (
    <ProjectSelect
      label={en ? "Filter by team size" : "按团队规模筛选"}
      value={state.teamSize}
      onChange={(value) => update("teamSize", value)}
      options={[
        { value: "all", label: en ? "Team size" : "团队规模" },
        { value: "three", label: en ? "3 members" : "3 人" },
        { value: "larger", label: en ? "4+ members" : "4 人及以上" },
        { value: "small", label: en ? "1–5 members" : "1–5 人" },
        { value: "medium", label: en ? "6–10 members" : "6–10 人" },
        { value: "large", label: en ? "11+ members" : "11 人及以上" },
      ]}
    />
  )
  const clearQuery = () => setState((previous) => ({
    ...previous, quickView: "all", search: "", teamSize: "all", status: "all", starredOnly: false, updatedWithin: 0, archiveScope: defaultArchiveScope,
  }))
  const hasFilters = !!state.search || state.teamSize !== "all" || state.status !== "all" || state.starredOnly || !!state.updatedWithin || hasArchiveFilter || (browse && state.quickView !== "active" && state.quickView !== "all")
  const clearFilters = hasFilters ? <Button variant="ghost" onClick={clearQuery}>{en ? "Clear filters" : "清除筛选"}</Button> : undefined
  const filterControl = Object.values(capabilities.filters).some(Boolean) ? (
    <DropdownMenu open={state.filtersOpen} onOpenChange={(open) => update("filtersOpen", open)}>
      <DropdownMenuTrigger render={<Button variant="secondary" aria-label={en ? "Filters" : "筛选"} />}>
        <SlidersHorizontal aria-hidden="true" />
        {en ? "Filters" : "筛选"}{filterCount ? ` · ${filterCount}` : ""}
      </DropdownMenuTrigger>
      <DropdownMenuContent className={styles.filtersMenu} align="end">
        {capabilities.filters.archive && <DropdownMenuGroup>
          <DropdownMenuLabel className={styles.filterLabel}>{en ? "Status" : "状态"}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={state.archiveScope !== "archived"} onCheckedChange={(checked) => setState((previous) => ({
            ...previous, archiveScope: checked ? previous.archiveScope === "archived" ? "all" : "current" : previous.archiveScope === "all" ? "archived" : "current",
          }))}>
            {en ? "Active" : "未归档"}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={state.archiveScope !== "current"} onCheckedChange={(checked) => setState((previous) => ({
            ...previous, archiveScope: checked ? previous.archiveScope === "current" ? "all" : "archived" : previous.archiveScope === "all" ? "current" : "archived",
          }))}>
            {en ? "Archived" : "已归档"}
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>}
        {capabilities.filters.updated && <><DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className={styles.filterLabel}>{en ? "Updated" : "最近更新"}</DropdownMenuLabel>
          {([7, 14] as const).map((days) => <DropdownMenuCheckboxItem key={days} checked={state.updatedWithin === days} onCheckedChange={(checked) => update("updatedWithin", checked ? days : 0)}>
            {en ? `Last ${days} days` : `最近 ${days} 天`}
          </DropdownMenuCheckboxItem>)}
        </DropdownMenuGroup></>}
        {(capabilities.filters.status || capabilities.filters.starred || (browse && capabilities.filters.teamSize)) && <><DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{en ? "Local filters" : "本地筛选"}</DropdownMenuSubTrigger>
          <DropdownMenuContent className={styles.filtersMenu} side="right" align="start">
            {capabilities.filters.status && <DropdownMenuGroup>
              <DropdownMenuLabel className={styles.filterLabel}>{en ? "Business status" : "业务状态"}</DropdownMenuLabel>
              {[{value: "all" as const, label: en ? "All statuses" : "全部状态"}, ...statusOptions].map((option) => <DropdownMenuCheckboxItem key={option.value} checked={state.status === option.value} onCheckedChange={() => update("status", option.value)}>{option.label}</DropdownMenuCheckboxItem>)}
            </DropdownMenuGroup>}
            {capabilities.filters.starred && <><DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={state.starredOnly} onCheckedChange={(checked) => update("starredOnly", checked)}>{en ? "Starred only" : "仅显示收藏"}</DropdownMenuCheckboxItem></>}
            {browse && capabilities.filters.teamSize && <DropdownMenuGroup>
              <DropdownMenuLabel className={styles.filterLabel}>{en ? "Team size" : "团队规模"}</DropdownMenuLabel>
              {[{value: "all" as const, label: en ? "All teams" : "全部团队"}, {value: "three" as const, label: en ? "3 members" : "3 人"}, {value: "larger" as const, label: en ? "4+ members" : "4 人及以上"}, {value: "small" as const, label: en ? "1–5 members" : "1–5 人"}, {value: "medium" as const, label: en ? "6–10 members" : "6–10 人"}, {value: "large" as const, label: en ? "11+ members" : "11 人及以上"}].map((option) => <DropdownMenuCheckboxItem key={option.value} checked={state.teamSize === option.value} onCheckedChange={() => update("teamSize", option.value)}>{option.label}</DropdownMenuCheckboxItem>)}
            </DropdownMenuGroup>}
          </DropdownMenuContent>
        </DropdownMenuSub></>}
        {hasFilters && <DropdownMenuItem onClick={clearQuery}>{en ? "Clear filters" : "清除筛选"}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : undefined
  return (
    <PmPage interactive={props.interactive} pageId={pageId}
    className={variant === "table" ? familyStyles.list3Page : variant === "compact" ? `${familyStyles.list4Page} ${compactStyles.page}` : browse ? browseStyles.page : styles.page}
    readingPosition={props.readingPosition}
    onReadingPositionChange={props.onReadingPositionChange}
    sidebarPlacement={variant === "compact" ? "right" : "left"}
    headerMode={variant === "compact" ? "hidden" : "default"}
    contentClassName={variant === "compact" ? compactStyles.content : variant === "table" ? familyStyles.listContent : undefined}
    titleIcon={<FolderKanban aria-hidden="true" className={styles.titleIcon} />}
    titleSuffix={variant === "table" && hasSnapshot ? <Badge tone="neutral" size="sm" shape="pill" aria-label={en ? `${projects.length} projects` : `${projects.length} 个项目`}>{projects.length}</Badge> : undefined}
    sidebar={
      browse ? (
        <aside className={browseStyles.sidebar} data-pm-quick-views>
          <PmSearch
            value={state.search}
            onChange={(value) => update("search", value)}
            label={en ? "Search projects..." : "搜索项目…"}
          />
          <nav aria-label={en ? "Project quick views" : "项目快捷视图"}>
            {(
              [
                ["all", en ? "Browse all" : "浏览全部"],
                ["active", en ? "Active" : "进行中"],
                ["archived", en ? "Archived" : "已归档"],
                ["recent", en ? "Recently updated" : "最近更新"],
                ["three", en ? "3-member teams" : "3 人团队"],
                ["larger", en ? "4+ member teams" : "4 人及以上团队"],
              ] satisfies [ProjectCollectionViewInteraction["quickView"], string][]
            ).filter(([value]) => value === "all" || value === "active" && capabilities.filters.status || value === "archived" && capabilities.filters.archive || value === "recent" && capabilities.filters.updated || (value === "three" || value === "larger") && capabilities.filters.teamSize).map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                aria-pressed={state.quickView === value}
                className={browseStyles.quickView}
                onClick={() => update("quickView", value)}
              >
                {label}
              </Button>
            ))}
          </nav>
        </aside>
      ) : variant === "compact" && selected ? <aside className={compactStyles.summaryRail} aria-label={en ? "Selected project issues" : "选中项目的任务"} data-pm-summary-rail data-pm-selected-project={selected.id}>{readModel.selectedIssueSummary ?? <ProjectSummaryIssues project={selected} issues={[]} onOpenProject={capabilities.openFullDetails ? () => actions.openFullDetails(selected.id) : undefined} emptyLabel={readModel.unavailableTasksLabel} />}</aside> : undefined
    }
    title={en ? "Projects" : "项目"}
    actions={
      variant === "compact" || (props.toolbarActions && !props.headerActions && variant !== "table") ? undefined : <>
        {props.headerActions}
        {variant === "table" && props.toolbarActions}
        {!browse && !props.toolbarActions && (variant === "cover" ? <div className={styles.toolbar} role="group" aria-label={en ? "Project search and filters" : "项目搜索与筛选"}>
          <PmSearch value={state.search} onChange={(value) => update("search", value)} label={en ? "Search projects..." : "搜索项目…"} />
          <div className={styles.toolbarFilters}>{sortControl}{capabilities.filters.teamSize && teamControl}{filterControl}{clearFilters}</div>
        </div> : <FilterToolbar
          label={en ? "Project search and filters" : "项目搜索与筛选"}
          search={<PmSearch value={state.search} onChange={(value) => update("search", value)} label={en ? "Search projects..." : "搜索项目…"} />}
          filters={<>{sortControl}{capabilities.filters.teamSize && teamControl}{filterControl}{clearFilters}</>}
        />)}
      {!props.toolbarActions && <Button
        ref={addButton}
        className={variant === "cover" ? styles.addProject : undefined}
        disabled={!capabilities.create}
        aria-label={
          hasDraft || pendingRequestId
            ? en
              ? "Resume project draft"
              : "继续项目草稿"
            : en
              ? "Add project"
              : "添加项目"
        }
        onClick={(event) => {
          opener.current = event.currentTarget
          actions.create(event.currentTarget)
        }}
      >
        <Plus aria-hidden="true" />
        <span className={variant === "cover" ? styles.addLabel : undefined}>{hasDraft || pendingRequestId
          ? en
            ? "Resume draft"
            : "继续草稿"
          : en
            ? "Add Project"
            : "添加项目"}</span>
      </Button>}
      </>
    }
    toolbar={variant === "table" ? undefined : props.toolbarActions ?? (variant === "compact" ? <>
      <PmSearch value={state.search} onChange={(value) => update("search", value)} label={en ? "Search projects..." : "搜索项目…"} />
      {filterControl}
      {clearFilters}
      {capabilities.create && <Button ref={addButton} size="icon" aria-label={hasDraft || pendingRequestId ? (en ? "Resume project draft" : "继续项目草稿") : (en ? "Add project" : "添加项目")} onClick={(event) => { opener.current = event.currentTarget; actions.create(event.currentTarget) }}><Plus aria-hidden="true" /></Button>}
    </> : undefined)}>
      {variant === "compact" ? <div className={compactStyles.listHeading}><h1>{en ? "Projects" : "项目"}</h1>{props.summarySort ?? sortControl}</div> : variant !== "table" && <div className={browse ? browseStyles.collectionHeader : styles.summary}>
        <div>
          {browse && <h2>{en ? "Projects" : "项目"}</h2>}
          <p aria-live="polite">
            {!hasSnapshot ? readModel.data.state === "loading" ? (en ? "Loading projects…" : "正在加载项目…") : (en ? "Project count unavailable" : "项目数量不可用") : en
              ? `${projects.length} projects${browse ? " in this view" : ""}`
              : `${projects.length} 个项目${browse ? " · 当前视图" : ""}`}
          </p>
        </div>
        {browse ? <div className={browseStyles.collectionControls}>{sortControl}<div className={browseStyles.additionalFilters}>{filterControl}{clearFilters}</div></div> : <Badge tone="neutral" className={styles.summaryBadge}><Check aria-hidden="true" />{readModel.summaryLabel ?? (en ? "Projects" : "项目")}</Badge>}
      </div>}
      <p className="sr-only">{readModel.sourceDescription}</p>
      {feedback}
      {pendingRequestId && <p role="status" className="mb-3 text-xs text-muted-foreground">{en ? "Request" : "请求"}: <code data-pm-request-id={pendingRequestId}>{pendingRequestId}</code></p>}

      <DataRegion
        {...readModel.data}
        state={readModel.data.state === "success" && projects.length === 0 ? "empty" : readModel.data.state}
        hasContent={projects.length > 0}
        emptyTitle={en ? "Nothing to display" : "暂无内容"}
        emptyDescription={readModel.emptyDescription}
        emptyHeadingLevel={2}
      >
        {variant === "table" || variant === "compact" ? <ProjectCollectionRows props={props} onSelect={(project, trigger) => { if (variant === "compact") setState((previous) => ({ ...previous, selectedId: project.id })); else openDetail(project, trigger) }} /> : <div
          className={browse ? browseStyles.grid : styles.grid}
          data-pm-project-grid
        >
          {projects.map((project) => (
            browse ? <ProjectBrowseCard
              key={project.id}
              project={project}
              locale={locale}
              selected={state.selectedId === project.id}
              readonly={!capabilities.star(project.id)}
              readModel={readModel}
              renderProjectAction={props.renderProjectAction}
              onSelect={(element) => openDetail(project, element)}
              onStar={() => { if (capabilities.star(project.id)) actions.star(project.id) }}
            /> : <ProjectCard
              key={project.id}
              project={project}
              locale={locale}
              selected={state.selectedId === project.id}
              readonly={!capabilities.star(project.id)}
              readModel={readModel}
              renderProjectAction={props.renderProjectAction}
              onSelect={(element) => openDetail(project, element)}
              onStar={() => { if (capabilities.star(project.id)) actions.star(project.id) }}
            />
          ))}
          {browse && <button className={browseStyles.createCard} disabled={!capabilities.create} onClick={(event) => {
            opener.current = event.currentTarget
            actions.create(event.currentTarget)
          }}>
            <Plus aria-hidden="true" className="mx-auto mb-2 size-5" />
            {hasDraft || pendingRequestId ? (en ? "Resume draft" : "继续草稿") : (en ? "Create new project" : "创建新项目")}
          </button>}
        </div>}
      </DataRegion>
      <Dialog
        open={state.detailOpen && !!selected}
        onOpenChange={(open) => update("detailOpen", open)}
      >
        <DialogContent finalFocus={finalFocus}>
          <DialogTitle>{en ? "Project details" : "项目详情"}</DialogTitle>
          {selected && (
            <div className={styles.details}>
              <p className={styles.identifier}>{selected.identifier}</p>
              <h2 className={`text-base font-semibold ${styles.detailsTitle}`}>
                {selected.title}
              </h2>
              <p className={styles.note}>{selected.description ?? "—"}</p>
              <Badge tone={selected.status?.tone ?? "neutral"}>{selected.status?.label ?? "—"}</Badge>
              <ProjectStar project={selected} locale={locale} readonly={!capabilities.star(selected.id)} onStar={() => { if (capabilities.star(selected.id)) actions.star(selected.id) }} />
              <div>
                <p className={`${styles.label} mb-2`}>
                  {en ? "Project lead" : "项目负责人"}
                </p>
                {owner ? <span className="inline-flex min-w-0 items-center gap-2" data-pm-member={owner.id}><Avatar name={owner.name} size={24} /><span className="min-w-0"><span className="block truncate text-sm">{owner.name}</span>{owner.role && <span className="block text-xs text-muted-foreground">{owner.role}</span>}</span></span> : <p className={styles.note}>
                  {en ? "Unassigned or unavailable project lead; no replacement has been inferred." : "项目负责人未分配或不可用；没有推断或替换负责人。"}
                </p>}
              </div>
              <dl className={styles.detailFacts}>
                <div>
                  <dt>{en ? "Team size" : "团队规模"}</dt>
                  <dd>
                    {selected.teamSize === null ? "—" : en ? `${selected.teamSize} members` : `${selected.teamSize} 人`}
                  </dd>
                </div>
                <div>
                  <dt>{en ? "Cycle" : "周期"}</dt>
                  <dd>{selected.cycle?.label ?? "—"}</dd>
                </div>
                <div>
                  <dt>{readModel.healthLabel ?? (en ? "Timeline health" : "时间线健康度")}</dt>
                  <dd>
                    {selected.health === null
                      ? readModel.unavailableHealthLabel ?? "—"
                      : `${selected.health}%`}
                  </dd>
                </div>
                <div>
                  <dt>{en ? "Task completion" : "任务完成比例"}</dt>
                  <dd>
                    {selectedCounts
                      ? `${selectedCounts.closed}/${selectedCounts.total} · ${selectedCounts.total ? Math.round((selectedCounts.closed / selectedCounts.total) * 100) : 0}%`
                      : "— · " + (readModel.unavailableTasksLabel ?? (en ? "Task totals unavailable" : "任务统计不可用"))}
                  </dd>
                </div>
                <div>
                  <dt>{(en ? "Due date" : "截止日期") + (readModel.dateContextLabel ? " · " + readModel.dateContextLabel : "")}</dt>
                  <dd>{formatProjectDate(selected.dueDate, locale, readModel.unavailableDateLabel)}</dd>
                </div>
              </dl>
              {readModel.healthDescription && <p className={styles.note}>{readModel.healthDescription}</p>}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => update("detailOpen", false)}
            >
              {en ? "Close" : "关闭"}
            </Button>
            <Button
              variant="secondary"
              disabled={!selected || !capabilities.openFullDetails}
              onClick={() => {
                if (!selected) return
                update("detailOpen", false)
                actions.openFullDetails(selected.id)
              }}
            >
              {en ? "Open full details" : "打开完整详情"}
            </Button>
            <Button disabled={!selected || !capabilities.edit(selected.id)} onClick={() => { if (selected && capabilities.edit(selected.id)) actions.edit(selected.id, finalFocus()) }}>
              {editLabel ?? (en ? "Edit project" : "编辑项目")}
            </Button>
          </DialogFooter>
          {(pendingRequestId || hasDraft) && (
            <p className={styles.note}>
              {en
                ? "Resume or explicitly discard the existing draft before editing another project."
                : "编辑其他项目之前，请先继续或显式丢弃已有草稿。"}
            </p>
          )}
        </DialogContent>
      </Dialog>
      {createDialog}
    </PmPage>
  )
}

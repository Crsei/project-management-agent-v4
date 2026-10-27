import { useId, type ReactNode } from "react"
import {
  Activity,
  CalendarDays,
  CircleCheck,
  Clock3,
  Files,
  FolderKanban,
  Gauge,
  Layers,
  Users,
  CircleHelp,
  ChevronRight,
  Download,
  Eye,
  FileText,
  MoreHorizontal,
  RotateCcw,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n } from "@/lib/i18n-provider"
import { pmMembers, type PmScenario } from "./model"
import { PmMemberIdentity, usePmScenarioState } from "./shared"
import { useIssueDomain } from "./use-issue-domain"
import {
  createProjectList1Fixtures,
  cycleCopy,
  statusCopy,
  type ProjectCardRecord,
  type ProjectCycle,
  type ProjectStatus,
} from "./project-list-1-fixtures"
import { usePmDomainState } from "./domain-session"
import {
  createProjectsFamily,
  formatProjectDay,
  formatProjectInstant,
  healthBand,
  projectMilestones,
  projectMetaDraft,
  projectOverview,
  type ProjectComment,
  type ProjectFile,
  type ProjectIssueStats,
  type ProjectMetaDraft,
  type ProjectsFamily,
  type ProjectOutcome,
} from "./projects-domain"
import { projectWriteFingerprint } from "./project-write-domain"
import { useProjectWrites } from "./use-project-writes"
import styles from "./projects-views.module.css"

/** Shared PM6 project context: one explicit project array plus family facts for lists and details. */
export function usePmProjectDomain(scenario: PmScenario) {
  const [projects, setProjects] = usePmDomainState<ProjectCardRecord[]>(
    "projects",
    () => createProjectList1Fixtures(scenario),
  )
  const [issueDomain] = useIssueDomain(scenario)
  const [family, setFamily] = usePmDomainState<ProjectsFamily>(
    "projects-family",
    () => createProjectsFamily(scenario, projects, issueDomain.items),
  )
  return {
    projects,
    setProjects,
    issues: issueDomain.items,
    issueActivity: issueDomain.activity,
    family,
    setFamily,
  }
}
/** readonly/loading permissions and pending requests guard every writing callback. */
export function canMutatePmProject(scenario: PmScenario): boolean {
  return scenario !== "readonly" && scenario !== "loading"
}
export function projectOutcomeMessage(
  result: "none" | ProjectOutcome | "invalid" | "stale" | "locked",
  en: boolean,
): string {
  if (result === "confirmed")
    return en
      ? "Confirmed locally. Shared project facts were updated; your filters are retained."
      : "本地已确认，共享项目事实已更新；筛选条件保持不变。"
  if (result === "rejected")
    return en
      ? "The local simulation rejected this change. Your draft is retained."
      : "本地模拟拒绝了此更改，草稿已保留。"
  if (result === "unknown")
    return en
      ? "Result unknown. Your draft and request identity are retained. Check the simulated result before submitting again."
      : "结果未知。草稿与请求标识已保留；再次提交前请显式检查模拟结果。"
  if (result === "invalid")
    return en
      ? "Enter a valid due date (YYYY-MM-DD) or leave the field empty."
      : "请输入有效截止日期（YYYY-MM-DD），或留空。"
  if (result === "stale")
    return en
      ? "The project changed after this draft was opened. The draft is retained; review it against the new values before confirming again."
      : "项目在草稿打开后已变更。草稿已保留，请对照新值复核后再确认。"
  if (result === "locked")
    return en
      ? "Another project write is in flight (or a create is pending). Your draft is retained; submit after it resolves."
      : "该项目已有进行中的写入（或存在待处理创建）。草稿已保留，请等待其结束后再提交。"
  return ""
}
function OutcomeSelect({
  value,
  onChange,
  label,
}: {
  value: ProjectOutcome
  onChange: (value: ProjectOutcome) => void
  label: string
}) {
  const { locale } = useI18n()
  return (
    <label className={styles.inlineField}>
      <span>{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next as ProjectOutcome)
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>
            {value === "confirmed"
              ? locale === "en"
                ? "Confirmed"
                : "已确认"
              : value === "rejected"
                ? locale === "en"
                  ? "Rejected"
                  : "已拒绝"
                : locale === "en"
                  ? "Unknown"
                  : "未知"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="confirmed">
            {locale === "en" ? "Confirmed" : "已确认"}
          </SelectItem>
          <SelectItem value="rejected">
            {locale === "en" ? "Rejected" : "已拒绝"}
          </SelectItem>
          <SelectItem value="unknown">
            {locale === "en" ? "Unknown" : "未知"}
          </SelectItem>
        </SelectContent>
      </Select>
    </label>
  )
}
export function ProjectHealthCell({
  health,
  locale,
}: {
  health: number | null
  locale: "zh-CN" | "en"
}) {
  const band = healthBand(health)
  const measurement =
    health === null
      ? locale === "en"
        ? "No health measurement recorded"
        : "尚未记录健康度测量值"
      : Math.round(health) + "%"
  return (
    <span
      className={styles.healthLabel}
      data-pm-health={band.key}
      title={measurement}
      aria-label={band.label[locale] + " · " + measurement}
    >
      {health === null || band.key === "needsupdate" ? (
        <CircleHelp aria-hidden="true" />
      ) : (
        <Activity aria-hidden="true" />
      )}
      {band.label[locale]}
    </span>
  )
}
export function ProjectOwnerCell({
  ownerId,
  locale,
}: {
  ownerId: string
  locale: "zh-CN" | "en"
}) {
  const member = pmMembers.find((candidate) => candidate.id === ownerId)
  if (!member)
    return (
      <span
        className={styles.muted}
        data-pm-owner="missing"
        title={
          locale === "en"
            ? "No owner record matches this project."
            : "没有匹配本项目的负责人记录。"
        }
      >
        <Badge tone="warning" size="sm">
          {locale === "en" ? "Unassigned" : "未分配"}
        </Badge>
      </span>
    )
  return <PmMemberIdentity member={member} />
}
export function ProjectTeamCell({
  teamId,
  teamSize,
  locale,
}: {
  teamId: string
  teamSize: number
  locale: "zh-CN" | "en"
}) {
  return (
    <span className={styles.teamCell} data-pm-team={teamId}>
      <Badge tone="info" size="sm">
        {teamId}
      </Badge>
      <span className={styles.muted}>
        {locale === "en" ? `${teamSize} members` : `${teamSize} 名成员`}
      </span>
    </span>
  )
}
export function ProjectMilestoneCell({
  projectId,
  family,
  locale,
}: {
  projectId: string
  family: ProjectsFamily
  locale: "zh-CN" | "en"
}) {
  const milestones = projectMilestones(family, projectId)
  const upcoming = [...milestones]
    .filter(
      (milestone) => milestone.dueDate && milestone.dueDate >= "2026-01-12",
    )
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
  const next =
    upcoming[0] ??
    [...milestones].sort((a, b) =>
      (b.dueDate ?? "").localeCompare(a.dueDate ?? ""),
    )[0]
  if (!next)
    return (
      <span className={styles.muted} data-pm-milestone="none">
        {locale === "en" ? "No milestone scheduled" : "未安排里程碑"}
      </span>
    )
  return (
    <span className={styles.milestoneCell} data-pm-milestone={next.id}>
      <span className={styles.milestoneTitle}>{next.title[locale]}</span>
      <span className={styles.muted}>
        {next.dueDate
          ? formatProjectDay(next.dueDate, locale)
          : locale === "en"
            ? "Date to be confirmed"
            : "日期待确认"}
      </span>
    </span>
  )
}
function Metric({
  label,
  value,
  sub,
  tone,
  kind,
}: {
  label: string
  value: string
  sub: string
  tone?: "warning" | "danger" | "success"
  kind: "health" | "due" | "tasks" | "files"
}) {
  const Icon = { health: Gauge, due: CalendarDays, tasks: CircleCheck, files: Files }[kind]
  return (
    <div className={styles.metricCard} data-tone={tone} data-pm-metric={kind}>
      <span className={styles.metricLabel}><Icon size={14} aria-hidden="true" />{label}</span>
      <strong className={styles.metricValue}>{value}</strong>
      <span className={styles.metricSub}>{sub}</span>
    </div>
  )
}
export function ProjectMetricsStrip({
  project,
  stats,
  fileCount,
}: {
  project: ProjectCardRecord | undefined
  stats: ProjectIssueStats
  fileCount: number
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const band = healthBand(project?.health ?? null)
  const days = project?.dueDate
    ? Math.round(
        (Date.parse(`${project.dueDate}T00:00:00Z`) -
          Date.parse("2026-01-12T00:00:00Z")) /
          86400000,
      )
    : null
  return (
    <section
      className={styles.metrics}
      data-pm-project-metrics
      aria-label={en ? "Project metrics" : "项目指标"}
    >
      <Metric
        kind="health"
        label={en ? "Timeline health" : "时间线健康度"}
        value={
          project?.health === null || project?.health === undefined
            ? "—"
            : `${Math.round(project.health)}%`
        }
        sub={band.label[locale]}
        tone={band.tone === "neutral" ? undefined : band.tone}
      />
      <Metric
        kind="due"
        label={en ? "Due date" : "截止日期"}
        value={
          project?.dueDate
            ? formatProjectDay(project.dueDate, locale, {
                month: "short",
                day: "numeric",
              })
            : "—"
        }
        sub={
          days === null
            ? en
              ? "No due date set"
              : "未设置截止日期"
            : days >= 0
              ? en
                ? `${days} days left`
                : `还剩 ${days} 天`
              : en
                ? `${Math.abs(days)} days overdue`
                : `已逾期 ${Math.abs(days)} 天`
        }
        tone={days !== null && days < 0 ? "danger" : undefined}
      />
      <Metric
        kind="tasks"
        label={en ? "Tasks closed" : "已完成任务"}
        value={stats.total > 0 ? `${stats.done}/${stats.total}` : "—"}
        sub={
          stats.total > 0
            ? en
              ? `${stats.total - stats.done} open`
              : `${stats.total - stats.done} 项未完成`
            : en
              ? "No linked issues in this scene"
              : "本场景无关联 Issue"
        }
      />
      <Metric
        kind="files"
        label={en ? "Project files" : "项目文件"}
        value={fileCount > 0 ? String(fileCount) : "—"}
        sub={
          fileCount > 0
            ? en
              ? "Local fixture files"
              : "本地固定文件"
            : en
              ? "No files attached"
              : "暂无附件"
        }
      />
    </section>
  )
}
export function ProjectIssueSummary({
  stats,
  onReview,
}: {
  stats: ProjectIssueStats
  onReview: () => void
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  if (stats.total === 0)
    return (
      <p className={styles.muted} data-pm-issue-summary="empty">
        {en
          ? "No issue facts are available for this project in the current scene."
          : "当前场景中本项目没有 Issue 事实。"}
      </p>
    )
  const share = (value: number) => `${Math.round((value / stats.total) * 100)}%`
  const insight =
    stats.unassigned > 0
      ? en
        ? `${stats.unassigned} issue${stats.unassigned > 1 ? "s have" : " has"} no owner yet.`
        : `${stats.unassigned} 个 Issue 尚无负责人。`
      : stats.unscheduled > 0
        ? en
          ? `${stats.unscheduled} issue${stats.unscheduled > 1 ? "s have" : " has"} no scheduled dates.`
          : `${stats.unscheduled} 个 Issue 尚未安排日期。`
        : en
          ? "Every issue has an owner and scheduled dates."
          : "所有 Issue 均已有负责人和排期。"
  const counters: [string, number][] = [
    [en ? "Issues" : "Issue 总数", stats.total],
    [en ? "In progress" : "进行中", stats.progress],
    [en ? "In review" : "评审中", stats.review],
    [en ? "Done" : "已完成", stats.done],
    [en ? "No owner" : "无负责人", stats.unassigned],
  ]
  return (
    <section className={styles.issueSummary} data-pm-issue-summary>
      <div className={styles.counters}>
        {counters.map(([label, value]) => (
          <div key={label} className={styles.counter}>
            <span className={styles.metricLabel}>{label}</span>
            <strong className={styles.metricValue}>{value}</strong>
          </div>
        ))}
      </div>
      <div
        className={styles.shares}
        role="group"
        aria-label={en ? "Issue shares" : "Issue 占比"}
      >
        <span aria-hidden="true" />
        <Badge
          size="sm"
          aria-label={counters[1][0] + " " + share(stats.progress)}
        >
          {share(stats.progress)} →
        </Badge>
        <Badge
          size="sm"
          aria-label={counters[2][0] + " " + share(stats.review)}
        >
          {share(stats.review)} →
        </Badge>
        <Badge size="sm" aria-label={counters[3][0] + " " + share(stats.done)}>
          {share(stats.done)} →
        </Badge>
        <Badge
          size="sm"
          aria-label={counters[4][0] + " " + share(stats.unassigned)}
        >
          {share(stats.unassigned)} →
        </Badge>
      </div>
      <p className={styles.insight} role="status">
        <strong>{en ? "Insight:" : "洞察："}</strong> {insight}{" "}
        <Button variant="ghost" size="sm" onClick={onReview}>
          {en ? "Review dependency path" : "检查依赖路径"}
          <ChevronRight aria-hidden="true" />
        </Button>
      </p>
    </section>
  )
}
export function ProjectMetaChips({ project }: { project: ProjectCardRecord }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const owner = pmMembers.find((member) => member.id === project.ownerId)
  return (
    <div data-pm-meta-chips>
      <ul className={styles.chips} data-pm-project-badges>
        <li><Badge tone="info" size="sm">{statusCopy[project.status][locale]}</Badge></li>
        <li><Badge tone="neutral" size="sm"><Users size={12} aria-hidden="true" />{project.teamSize}{en ? " members" : " 名成员"}</Badge></li>
        <li><Badge tone="neutral" size="sm"><FolderKanban size={12} aria-hidden="true" />{project.teamId}</Badge></li>
      </ul>
      <ul className={styles.chips} data-pm-project-facts>
        <li><FileText size={14} aria-hidden="true" />{project.identifier}</li>
        <li><Layers size={14} aria-hidden="true" />{cycleCopy[project.cycle][locale]} {project.cycleWeeks}{en ? " weeks" : " 周"}</li>
        <li><Clock3 size={14} aria-hidden="true" /><span>{en ? "Updated" : "更新于"} {formatProjectInstant(project.updatedAt, locale)}</span></li>
        {owner && <li><PmMemberIdentity member={owner} /></li>}
      </ul>
    </div>
  )
}
export function ProjectBriefSection({
  project,
}: {
  project: ProjectCardRecord
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  return (
    <section className={styles.section} data-pm-project-brief>
      <h2 className={styles.sectionTitle}>
        {en ? "Project brief" : "项目简报"}
      </h2>
      <p className={styles.brief}>{project.description[locale]}</p>
    </section>
  )
}
type FileOutcome = {
  previewId: string | null
  failure: string | null
  retry: number
}
export function ProjectFileList({
  projectId,
  files,
  canMutate,
}: {
  projectId: string
  files: ProjectFile[]
  canMutate: boolean
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [state, setState] = usePmScenarioState<FileOutcome>(
    `file-state-${projectId}`,
    () => ({ previewId: null, failure: null, retry: 0 }),
  )
  const preview = (file: ProjectFile) =>
    setState((previous) => ({
      ...previous,
      previewId: previous.previewId === file.id ? null : file.id,
      failure: file.status === "error" ? file.id : null,
      retry: 0,
    }))
  const download = (file: ProjectFile) => {
    if (file.status === "error") {
      setState((previous) => ({ ...previous, failure: file.id, retry: 0 }))
      return
    }
    try {
      const url = URL.createObjectURL(
        new Blob([file.content[locale]], { type: "text/markdown" }),
      )
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = file.name
      anchor.click()
      URL.revokeObjectURL(url)
      setState((previous) => ({ ...previous, failure: null }))
    } catch {
      setState((previous) => ({ ...previous, failure: file.id }))
    }
  }
  if (files.length === 0)
    return (
      <p className={styles.muted} data-pm-project-files="empty">
        {en
          ? "No local files are recorded for this project."
          : "本项目没有记录任何本地文件。"}
      </p>
    )
  return (
    <section className={styles.section} data-pm-project-files>
      <h2 className={styles.sectionTitle}>
        {en ? "Project files" : "项目文件"}
      </h2>
      <ul className={styles.fileList}>
        {files.map((file) => {
          const failing = file.status === "error"
          const open = state.previewId === file.id && !failing
          return (
            <li key={file.id} className={styles.fileRow} data-pm-file={file.id}>
              <FileText aria-hidden="true" className={styles.fileIcon} />
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.fileSize} data-unavailable={failing || undefined}>
                {failing ? (en ? "Unavailable" : "不可用") : file.size}
              </span>
              <span className={styles.fileActions}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={
                          (en ? "Open actions for " : "打开文件操作 ") +
                          file.name
                        }
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => preview(file)}>
                      <Eye aria-hidden="true" />
                      {(en ? "Preview " : "预览 ") + file.name}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMutate}
                      onClick={() => download(file)}
                    >
                      <Download aria-hidden="true" />
                      {(en ? "Download " : "下载 ") + file.name}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
              {open && (
                <pre className={styles.preview} data-pm-file-preview={file.id}>
                  {file.content[locale]}
                </pre>
              )}
              {failing && state.failure === file.id && (
                <Alert tone="error" className={styles.fileFailure}>
                  <AlertTitle>
                    {en ? "File operation failed" : "文件操作失败"}
                  </AlertTitle>
                  <AlertDescription>
                    {en
                      ? `“${file.name}” reports an unavailable local source; preview and download cannot complete.`
                      : `“${file.name}” 的本地来源不可用，预览与下载无法完成。`}
                    {state.retry > 0 &&
                      (en
                        ? ` Retry ${state.retry} still reports the same error state.`
                        : ` 第 ${state.retry} 次重试仍为同一错误状态。`)}
                  </AlertDescription>
                  <Button
                    variant="outline"
                    size="sm"
                    className={styles.retryButton}
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        retry: previous.retry + 1,
                      }))
                    }
                  >
                    <RotateCcw aria-hidden="true" />
                    {en ? "Retry" : "重试"}
                  </Button>
                </Alert>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
type MetaPanelState = {
  editing: boolean
  draft: ProjectMetaDraft
  fingerprint: string | null
  simulated: ProjectOutcome
  checkReveals: "confirmed" | "rejected"
  result: "none" | ProjectOutcome | "invalid" | "stale" | "locked"
}
/** Metadata edits go through the authoritative project-write domain; drafts stay in this page cache. */
export function ProjectMetadataPanel({
  project,
  scenario,
}: {
  project: ProjectCardRecord
  scenario: PmScenario
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const heading = useId()
  const writes = useProjectWrites(scenario, `metadata:${project.id}`)
  const pending = writes.request
  const [state, setState] = usePmScenarioState<MetaPanelState>(
    `metadata-panel-${project.id}`,
    () => ({
      editing: !!pending,
      draft: projectMetaDraft(
        pending?.change.kind === "patch"
          ? { ...project, ...pending.change.patch }
          : project,
      ),
      fingerprint:
        pending?.change.kind === "patch"
          ? pending.change.baseFingerprint
          : null,
      simulated: pending ? "unknown" : "confirmed",
      checkReveals: "confirmed",
      result: pending ? "unknown" : "none",
    }),
  )
  const owner = pmMembers.find((member) => member.id === project.ownerId)
  const writable = writes.canWrite(project.id)
  const patchDraft = <K extends keyof ProjectMetaDraft>(
    key: K,
    value: ProjectMetaDraft[K],
  ) =>
    setState((previous) =>
      pending
        ? previous
        : {
            ...previous,
            draft: { ...previous.draft, [key]: value },
            result: "none",
          },
    )
  const clearDraft = (result: MetaPanelState["result"]) =>
    setState((previous) => ({
      ...previous,
      editing: false,
      draft: projectMetaDraft(project),
      fingerprint: null,
      result,
    }))
  const submit = () => {
    if (pending || !writable) return
    if (
      state.draft.dueDate &&
      !/^\d{4}-\d{2}-\d{2}$/.test(state.draft.dueDate)
    ) {
      setState((previous) => ({ ...previous, result: "invalid" }))
      return
    }
    const result = writes.submit(
      {
        kind: "patch",
        projectId: project.id,
        patch: {
          dueDate: state.draft.dueDate || null,
          cycle: state.draft.cycle,
          status: state.draft.status,
        },
        baseFingerprint: state.fingerprint ?? projectWriteFingerprint(project),
      },
      state.simulated,
    )
    if (result.status === "confirmed") clearDraft("confirmed")
    else setState((previous) => ({ ...previous, result: result.status }))
  }
  const check = () => {
    if (!pending) return
    const result = writes.reconcile(state.checkReveals)
    if (result.status === "confirmed") clearDraft("confirmed")
    else setState((previous) => ({ ...previous, result: result.status }))
  }
  const fields: [string, ReactNode][] = [
    [en ? "Status" : "状态", statusCopy[project.status][locale]],
    [
      en ? "Owner" : "负责人",
      owner ? (
        <PmMemberIdentity member={owner} detail />
      ) : en ? (
        "Unassigned"
      ) : (
        "未分配"
      ),
    ],
    [
      en ? "Health" : "健康度",
      project.health === null
        ? en
          ? "Not measured"
          : "未测量"
        : `${Math.round(project.health)}%`,
    ],
    [
      en ? "Due date" : "截止日期",
      project.dueDate
        ? formatProjectDay(project.dueDate, locale, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : en
          ? "No due date"
          : "无截止日期",
    ],
    [en ? "Cycle" : "周期", cycleCopy[project.cycle][locale]],
    [
      en ? "Team" : "团队",
      `${project.teamId} · ${project.teamSize}${en ? " members" : " 名成员"}`,
    ],
    [en ? "Updated" : "更新", formatProjectInstant(project.updatedAt, locale)],
  ]
  const message = projectOutcomeMessage(state.result, en)
  return (
    <div className={styles.metaPanel} data-pm-project-meta>
      <div className={styles.metaHeader}>
        <h2 id={heading} tabIndex={-1} className={styles.sectionTitle}>
          {en ? "Project metadata" : "项目元数据"}
        </h2>
        {!state.editing && (
          <Button
            variant="outline"
            size="sm"
            disabled={!writable}
            onClick={() =>
              setState((previous) => ({
                ...previous,
                editing: true,
                draft:
                  previous.fingerprint === null
                    ? projectMetaDraft(project)
                    : previous.draft,
                fingerprint:
                  previous.fingerprint ?? projectWriteFingerprint(project),
                result: "none",
              }))
            }
          >
            {en ? "Update" : "更新"}
          </Button>
        )}
      </div>
      <dl className={styles.metaFields}>
        {fields.map(([label, value]) => (
          <div key={label} className={styles.metaField}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {state.editing && (
        <div className={styles.metaForm}>
          <label className={styles.metaField}>
            <span>{en ? "Due date" : "截止日期"}</span>
            <input
              type="date"
              className={styles.dateInput}
              aria-label={en ? "Draft due date" : "草稿截止日期"}
              value={state.draft.dueDate}
              disabled={!!pending}
              onChange={(event) => patchDraft("dueDate", event.target.value)}
            />
          </label>
          <label className={styles.metaField}>
            <span>{en ? "Cycle" : "周期"}</span>
            <Select
              value={state.draft.cycle}
              onValueChange={(value) => {
                if (value !== null) patchDraft("cycle", value as ProjectCycle)
              }}
              disabled={!!pending}
            >
              <SelectTrigger aria-label={en ? "Draft cycle" : "草稿周期"}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["improvement", "launch", "fix", "maintenance"] as const).map(
                  (value) => (
                    <SelectItem key={value} value={value}>
                      {cycleCopy[value][locale]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </label>
          <label className={styles.metaField}>
            <span>{en ? "Status" : "状态"}</span>
            <Select
              value={state.draft.status}
              onValueChange={(value) => {
                if (value !== null) patchDraft("status", value as ProjectStatus)
              }}
              disabled={!!pending}
            >
              <SelectTrigger aria-label={en ? "Draft status" : "草稿状态"}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["active", "paused", "completed"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusCopy[value][locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className={styles.metaActions}>
            {state.result === "stale" && (
              <Button
                variant="outline"
                size="sm"
                disabled={!writable || !!pending}
                onClick={() =>
                  setState((previous) => ({
                    ...previous,
                    fingerprint: projectWriteFingerprint(project),
                    result: "none",
                  }))
                }
              >
                {en ? "Acknowledge reviewed revision" : "已核对当前修订"}
              </Button>
            )}
            <OutcomeSelect
              value={state.simulated}
              onChange={(value) =>
                setState((previous) => ({
                  ...previous,
                  simulated: value,
                  result: "none",
                }))
              }
              label={en ? "Simulated result" : "模拟结果"}
            />
            {pending ? (
              <>
                <OutcomeSelect
                  value={
                    state.checkReveals === "confirmed"
                      ? "confirmed"
                      : "rejected"
                  }
                  onChange={(value) =>
                    setState((previous) => ({
                      ...previous,
                      checkReveals:
                        value === "unknown" ? previous.checkReveals : value,
                    }))
                  }
                  label={en ? "Check reveals" : "检查结果为"}
                />
                <Button variant="outline" size="sm" onClick={check}>
                  {en ? "Check result" : "检查结果"}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={!writable || state.result === "stale"}
                onClick={submit}
              >
                {en ? "Submit change" : "提交更改"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!!pending}
              onClick={() =>
                setState((previous) => ({
                  ...previous,
                  editing: false,
                  result: "none",
                }))
              }
            >
              {en ? "Cancel · keep draft" : "取消 · 保留草稿"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!pending}
              title={
                pending
                  ? en
                    ? "A pending unknown request must be checked before the draft can reset."
                    : "存在待查的未知请求时不能重置草稿。"
                  : undefined
              }
              onClick={() =>
                setState((previous) =>
                  pending
                    ? previous
                    : {
                        ...previous,
                        draft: projectMetaDraft(project),
                        fingerprint: projectWriteFingerprint(project),
                        result: "none",
                      },
                )
              }
            >
              <RotateCcw aria-hidden="true" />
              {en ? "Reset draft" : "重置草稿"}
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p
          role="status"
          className={styles.result}
          data-pm-meta-result={state.result}
        >
          {message}
        </p>
      )}
      {pending && (
        <p className={styles.muted} data-pm-meta-request={pending.id}>
          {en
            ? `Pending request ${pending.id} is retained in the shared write domain; no automatic replay.`
            : `请求 ${pending.id} 保留在共享写入域中；不会自动重放。`}
        </p>
      )}
    </div>
  )
}
export function ProjectOverviewPanel({
  project,
  family,
}: {
  project: ProjectCardRecord
  family: ProjectsFamily
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const overview = projectOverview(family, project.id)
  const milestones = projectMilestones(family, project.id)
  if (!overview)
    return (
      <p className={styles.muted}>
        {en
          ? "No overview record exists for this project."
          : "本项目没有概览记录。"}
      </p>
    )
  return (
    <div className={styles.panelStack} data-pm-overview-panel>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{en ? "Outcomes" : "目标成果"}</h2>
        <ul className={styles.bullets} data-pm-project-outcomes>
          {overview.outcomes.map((outcome) => (
            <li key={outcome.en}>{outcome[locale]}</li>
          ))}
        </ul>
      </section>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{en ? "Scope" : "范围"}</h2>
        <ul className={styles.chips} data-pm-project-scope>
          {overview.scope.map((item) => (
            <li key={item.label.en}>
              <span>{item.label[locale]}</span>
              <Badge
                tone={item.state === "in" ? "success" : "neutral"}
                size="sm"
              >
                {item.state === "in"
                  ? en
                    ? "In scope"
                    : "在范围内"
                  : en
                    ? "Out of scope"
                    : "范围外"}
              </Badge>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          {en ? "Health note" : "健康度备注"}
        </h2>
        <p className={styles.brief}>{overview.healthNote[locale]}</p>
      </section>
      <details className={styles.section} data-pm-project-milestones>
        <summary className={styles.sectionTitle}>{en ? "Milestones" : "里程碑"}</summary>
        {milestones.length === 0 ? (
          <p className={styles.muted}>{en ? "No milestones" : "无里程碑"}</p>
        ) : (
          <ul className={styles.bullets}>
            {milestones.map((milestone) => (
              <li key={milestone.id}>
                {milestone.title[locale]} ·{" "}
                {milestone.dueDate
                  ? formatProjectDay(milestone.dueDate, locale, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })
                  : en
                    ? "Date to be confirmed"
                    : "日期待确认"}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}
export function ProjectSummaryRow({
  project,
  stats,
  selected,
  onOpen,
  onSelect,
}: {
  project: ProjectCardRecord
  stats: ProjectIssueStats
  selected: boolean
  onOpen: () => void
  onSelect?: () => void
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  return (
    <li className={styles.summaryItem} data-selected={selected || undefined}>
      <button
        type="button"
        className={styles.summaryRow}
        data-pm-summary-row={project.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect ?? onOpen}
      >
        <span className={styles.summaryMain}>
          <span className={styles.summaryTitle}>
            <span
              className={styles.projectDot}
              data-health={healthBand(project.health).key}
              aria-hidden="true"
            />
            {project.identifier}
            <span className={styles.muted}>/</span>
            <span className={styles.summaryName} title={project.title[locale]}>
              {project.title[locale]}
            </span>
          </span>
          <span className={styles.summaryDescriptionLine}>
            <span
              className={styles.summaryDesc}
              title={project.description[locale]}
            >
              {project.description[locale]}
            </span>
            <span className={styles.muted}>
              · {formatProjectInstant(project.updatedAt, locale)}
            </span>
          </span>
        </span>
        <Badge size="sm">
          {stats.total > 0
            ? stats.total + (en ? " issues" : " 个 Issue")
            : en
              ? "No linked issues"
              : "无关联 Issue"}
        </Badge>
      </button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={
          (en ? "Open project " : "打开项目 ") + project.title[locale]
        }
        onClick={onOpen}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </li>
  )
}
type CommentComposerState = {
  draft: string
  simulated: ProjectOutcome
  checkReveals: "confirmed" | "rejected"
  sequence: number
  request: { id: string; projectId: string; body: string } | null
  result: "none" | ProjectOutcome | "invalid"
}
export function ProjectCommentsPanel({
  projectId,
  comments,
  canMutate,
  onAppend,
}: {
  projectId: string
  comments: ProjectComment[]
  canMutate: boolean
  onAppend: (comment: ProjectComment) => void
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [state, setState] = usePmDomainState<CommentComposerState>(
    `project-comment-composer-${projectId}`,
    () => ({
      draft: "",
      simulated: "confirmed",
      checkReveals: "confirmed",
      sequence: 0,
      request: null,
      result: "none",
    }),
  )
  const author = pmMembers[0]
  const build = (id: string, body: string): ProjectComment => ({
    id,
    projectId,
    authorId: author.id,
    body: { en: body, "zh-CN": body },
    createdAt: new Date(
      Date.parse("2026-01-12T09:00:00Z") + state.sequence * 1000,
    ).toISOString(),
  })
  const submit = () => {
    if (state.request || !canMutate) return
    if (!state.draft.trim()) {
      setState((previous) => ({ ...previous, result: "invalid" }))
      return
    }
    const sequence = state.sequence + 1
    const body = state.draft.trim()
    if (state.simulated === "confirmed") {
      onAppend({
        ...build(`project-comment-local-${projectId}-${sequence}`, body),
        createdAt: new Date(
          Date.parse("2026-01-12T09:00:00Z") + sequence * 1000,
        ).toISOString(),
      })
      setState({
        draft: "",
        simulated: state.simulated,
        checkReveals: state.checkReveals,
        sequence,
        request: null,
        result: "confirmed",
      })
      return
    }
    if (state.simulated === "rejected") {
      setState((previous) => ({ ...previous, sequence, result: "rejected" }))
      return
    }
    setState((previous) => ({
      ...previous,
      sequence,
      request: {
        id: `pm-project-comment-request-${projectId}-${sequence}`,
        projectId,
        body,
      },
      result: "unknown",
    }))
  }
  const check = () => {
    if (!state.request || !canMutate || state.request.projectId !== projectId)
      return
    if (state.checkReveals === "confirmed") {
      onAppend({
        ...build(
          `project-comment-local-${projectId}-${state.sequence}`,
          state.request.body,
        ),
        createdAt: new Date(
          Date.parse("2026-01-12T09:00:00Z") + state.sequence * 1000,
        ).toISOString(),
      })
      setState({
        draft: "",
        simulated: state.simulated,
        checkReveals: state.checkReveals,
        sequence: state.sequence,
        request: null,
        result: "confirmed",
      })
      return
    }
    setState((previous) => ({ ...previous, request: null, result: "rejected" }))
  }
  const message =
    state.result === "invalid"
      ? en
        ? "Enter a comment before submitting."
        : "请先输入评论内容再提交。"
      : projectOutcomeMessage(state.result, en)
  return (
    <div className={styles.panelStack} data-pm-comments-panel>
      <section className={styles.section} data-pm-comment-list>
        <h2 className={styles.sectionTitle}>{en ? "Comments" : "评论"}</h2>
        {comments.length === 0 ? (
          <p className={styles.muted}>
            {en ? "No comments yet." : "暂无评论。"}
          </p>
        ) : (
          <ul className={styles.commentList}>
            {comments.map((comment) => {
              const member = pmMembers.find((m) => m.id === comment.authorId)
              return (
                <li key={comment.id} className={styles.comment}>
                  <div className={styles.commentMeta}>
                    {member && <PmMemberIdentity member={member} />}
                    <time className={styles.muted} dateTime={comment.createdAt}>
                      {formatProjectInstant(comment.createdAt, locale)}
                    </time>
                  </div>
                  <p className={styles.commentBody}>{comment.body[locale]}</p>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section className={styles.composer} data-pm-comment-composer>
        <span className={styles.metricLabel}>
          {en
            ? `Posting as ${author.name} (local simulation)`
            : `以 ${author.name} 身份发布（本地模拟）`}
        </span>
        <Textarea
          aria-label={en ? "Add a comment" : "添加评论"}
          value={state.draft}
          disabled={!canMutate || !!state.request}
          placeholder={en ? "Add a comment..." : "添加评论…"}
          onChange={(event) =>
            setState((previous) => ({
              ...previous,
              draft: event.target.value,
              result: "none",
            }))
          }
        />
        <div className={styles.metaActions}>
          <OutcomeSelect
            value={state.simulated}
            onChange={(value) =>
              setState((previous) => ({
                ...previous,
                simulated: value,
                result: "none",
              }))
            }
            label={en ? "Simulated result" : "模拟结果"}
          />
          {state.request ? (
            <>
              <OutcomeSelect
                value={
                  state.checkReveals === "confirmed" ? "confirmed" : "rejected"
                }
                onChange={(value) =>
                  setState((previous) => ({
                    ...previous,
                    checkReveals:
                      value === "unknown" ? previous.checkReveals : value,
                  }))
                }
                label={en ? "Check reveals" : "检查结果为"}
              />
              <Button variant="outline" size="sm" onClick={check}>
                {en ? "Check result" : "检查结果"}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={!canMutate} onClick={submit}>
              <Upload aria-hidden="true" />
              {en ? "Submit comment" : "提交评论"}
            </Button>
          )}
        </div>
        {message && (
          <p
            role="status"
            className={styles.result}
            data-pm-comment-result={state.result}
          >
            {message}
          </p>
        )}
        {state.request && (
          <p
            className={styles.muted}
            data-pm-comment-request={state.request.id}
          >
            {en
              ? `Pending request ${state.request.id} retained; text is preserved and never replayed automatically.`
              : `请求 ${state.request.id} 保留待查；文本保留且不会自动重放。`}
          </p>
        )}
      </section>
    </div>
  )
}

import {
  useState,
  useRef,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react"
import {
  AlertTriangle,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  RotateCcw,
  SquareCheck,
  X,
} from "lucide-react"
import { useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Avatar } from "@/components/ui/avatar"
import { Field } from "@/components/ui/field"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterToolbar } from "@/components/blocks/filter-toolbar"
import {
  WorkItemAssigneePicker,
  WorkItemPriorityPicker,
  WorkItemProperties,
  WorkItemStatePicker,
} from "@/components/blocks/work-item-properties"
import { WorkItemRow, WorkItemMutationNotice } from "@/components/blocks/work-item"
import { MessageContent } from "@/components/blocks/message-content"
import {
  filterValues,
  isMutationLocked,
  withFilterValues,
} from "@/lib/work-items-model"
import type {
  MutationState,
  WorkItemCapabilities,
  WorkItemCatalog,
  WorkItemPatch,
  WorkItemProperty,
  WorkItemRecord,
  WorkItemsViewState,
} from "@/lib/work-items-model"
import { useI18n } from "@/lib/i18n-provider"
import type { PmScenario } from "./model"
import { PmSearch, usePmScenarioState } from "./shared"
import type { ProjectCardRecord } from "./project-list-1-fixtures"
import { patchIssueDomain, reconcileIssueDomain } from "./issue-domain"
import type { PmIssue, PmIssueDomain } from "./issue-domain"
import {
  createIssueEditorStore,
  createIssueCreateDraft,
  createIssueListUi,
  issueCommentState,
  issueDraftChanges,
  issueDraftDirty,
  issueDraftFrom,
  issueOutcomes,
  issueToday,
  settleIssueComment,
  submitIssueComment,
  submitIssueCreate,
  type IssueCommentStore,
  type IssueCreateDraft,
  type IssueDraft,
  type IssueEditorStore,
  type IssueListUi,
  type IssueOutcome,
} from "./issues-controller"
import styles from "./issues-views.module.css"

type Updater<T> = Dispatch<SetStateAction<T>>

function useText() {
  const { locale } = useI18n()
  const en = locale === "en"
  return {
    locale,
    en,
    text: (zh: string, english: string) => (en ? english : zh),
  }
}

// ---------------------------------------------------------------------------
// Outcome simulation + explicit result check
// ---------------------------------------------------------------------------

export function IssueOutcomeSelect({
  value,
  onChange,
  disabled = false,
  label,
  compact = false,
}: {
  value: IssueOutcome
  onChange: (value: IssueOutcome) => void
  disabled?: boolean
  label: string
  compact?: boolean
}) {
  const { text } = useText()
  const labels: Record<IssueOutcome, string> = {
    confirmed: text("模拟成功", "Simulated confirm"),
    rejected: text("模拟拒绝", "Simulated reject"),
    unknown: text("模拟未知", "Simulated unknown"),
  }
  return (
    <Select
      value={value}
      items={issueOutcomes.map((outcome) => ({
        value: outcome,
        label: labels[outcome],
      }))}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as IssueOutcome)
      }}
    >
      <SelectTrigger
        aria-label={label}
        className={compact ? styles.outcomeCompact : styles.outcome}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {issueOutcomes.map((outcome) => (
          <SelectItem key={outcome} value={outcome}>
            {labels[outcome]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Two-sided check for a locked unknown request; nothing replays on its own. */
export function IssueResultCheck({
  operationId,
  disabled = false,
  onConfirm,
  onReject,
}: {
  operationId: string
  disabled?: boolean
  onConfirm: () => void
  onReject: () => void
}) {
  const { text } = useText()
  return (
    <span className={styles.resultCheck} data-pm-result-check={operationId}>
      <span className={styles.resultText}>
        {text("结果未知，需要显式核对：", "Result unknown, explicit check: ")}
        <code>{operationId}</code>
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={onConfirm}
      >
        {text("确认已应用", "Confirm applied")}
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onReject}>
        {text("确认未应用", "Confirm rejected")}
      </Button>
    </span>
  )
}

export function IssueMutationStatus({
  mutation,
  disabled = false,
  onConfirm,
  onReject,
}: {
  mutation?: MutationState
  disabled?: boolean
  onConfirm: () => void
  onReject: () => void
}) {
  const { text } = useText()
  if (!mutation) return null
  if (mutation.status === "confirmed" && !mutation.error) return null
  const unknown =
    mutation.status === "unknown" ? mutation.operationId : undefined
  return (
    <div
      className={styles.mutation}
      role={
        mutation.status === "rejected" || mutation.error ? "alert" : "status"
      }
      data-mutation={mutation.status}
    >
      <AlertTriangle className={styles.mutationIcon} aria-hidden="true" />
      <span>
        {mutation.status === "rejected"
          ? text("更改被拒绝，草稿已保留。", "Change rejected; draft retained.")
          : mutation.status === "pending"
            ? text("请求进行中。", "Request in progress.")
            : mutation.status === "unknown"
              ? text("结果未知。", "Result unknown.")
              : text("更改被拒绝。", "Change rejected.")}
      </span>
      {mutation.error && <span>{mutation.error}</span>}
      {unknown && (
        <IssueResultCheck
          operationId={unknown}
          disabled={disabled}
          onConfirm={onConfirm}
          onReject={onReject}
        />
      )}
    </div>
  )
}

export function IssueResultCheckDialog({
  open,
  onOpenChange,
  itemId,
  domain,
  setDomain,
  writable,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string | null
  domain: PmIssueDomain
  setDomain: Updater<PmIssueDomain>
  writable: boolean
}) {
  const { text } = useText()
  const request = itemId ? domain.requests[itemId] : undefined
  const close = () => onOpenChange(false)
  return (
    <Dialog open={open && !!request} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-pm-result-dialog>
        <DialogTitle>
          {text("核对未知结果", "Check unknown result")}
        </DialogTitle>
        <DialogDescription>
          {text(
            "该请求不会自动重放；只有显式选择后才更新或保留草稿。",
            "The request never replays automatically; only an explicit choice applies it or keeps the draft.",
          )}
        </DialogDescription>
        <DialogBody>
          <dl className={styles.facts}>
            <div>
              <dt>{text("操作", "Operation")}</dt>
              <dd>
                <code>{request?.operationId}</code>
              </dd>
            </div>
            <div>
              <dt>{text("对象", "Item")}</dt>
              <dd>
                <code>{itemId}</code>
              </dd>
            </div>
            <div>
              <dt>{text("基准版本", "Base revision")}</dt>
              <dd>{request?.baseRevision}</dd>
            </div>
          </dl>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={!writable || !itemId}
            onClick={() => {
              if (!itemId) return
              setDomain((state) =>
                reconcileIssueDomain(state, itemId, "rejected"),
              )
              close()
            }}
          >
            {text("确认未应用", "Confirm rejected")}
          </Button>
          <Button
            disabled={!writable || !itemId}
            onClick={() => {
              if (!itemId) return
              setDomain((state) =>
                reconcileIssueDomain(state, itemId, "confirmed"),
              )
              close()
            }}
          >
            {text("确认已应用", "Confirm applied")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// List toolbar: search / status / priority / assignee / sort / outcome
// ---------------------------------------------------------------------------

function ClearFiltersButton({
  view,
  onViewChange,
}: {
  view: WorkItemsViewState
  onViewChange: (view: WorkItemsViewState) => void
}) {
  const { text } = useText()
  const active = !!view.query || view.filters.length > 0
  if (!active) return null
  return (
    <Button
      size="sm"
      variant="ghost"
      data-pm-clear-filters
      onClick={() =>
        onViewChange({
          ...view,
          query: "",
          filters: [],
        })
      }
    >
      {text("清除筛选", "Clear filters")}
    </Button>
  )
}

function CompactSelectFilter({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string[]
  options: readonly { id: string; label: string }[]
  onChange: (value: string[]) => void
  disabled?: boolean
}) {
  const { text } = useText()
  return (
    <Select
      value={value[0] ?? "all"}
      items={[
        { value: "all", label: text("全部", "All") },
        ...options.map((option) => ({
          value: option.id,
          label: option.label,
        })),
      ]}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next === "all" ? [] : [next])
      }}
    >
      <SelectTrigger aria-label={label} className={styles.compactFilter}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{text("全部", "All")}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
export function IssueProjectNavigation() {
  const { text } = useText()
  return (
    <nav className={styles.projectNavigation} aria-label={text("项目区域", "Project sections")}>
      <span className={styles.currentSection} aria-current="page">{text("问题", "Issues")}</span>
      {[["周期", "Cycles"], ["模块", "Modules"], ["视图", "Views"], ["页面", "Pages"]].map(([zh, english]) => (
        <Button key={english} variant="ghost" disabled title={text("此区域不在本地问题示例的能力范围内", "This section is outside the local issue showcase capabilities")}>
          {text(zh, english)}
        </Button>
      ))}
    </nav>
  )
}


export function IssueRowActions({ item, catalog, properties, mutation, capabilities, canMutate, scenario, detailSlug, onOpen, onPatchItem }: {
  item: WorkItemRecord
  catalog: WorkItemCatalog
  properties: readonly WorkItemProperty[]
  mutation?: MutationState
  capabilities: WorkItemCapabilities
  canMutate: boolean
  scenario: PmScenario
  detailSlug: "issue-detail-1" | "issue-detail-2"
  onOpen: (item: WorkItemRecord) => void
  onPatchItem: (item: WorkItemRecord, patch: WorkItemPatch) => void
}) {
  const { text } = useText()
  const params = useParams()
  const trigger = useRef<HTMLButtonElement>(null)
  const [dialog, setDialog] = useState<"properties" | "link" | null>(null)
  const [link, setLink] = useState<{ value: string; copied: boolean } | null>(null)
  const stateIndex = catalog.states.findIndex((state) => state.id === item.stateId)
  const nextState = stateIndex >= 0 ? catalog.states[stateIndex + 1] : undefined
  const copyLink = async () => {
    const url = new URL(window.location.href)
    const workspaceSlug = params.workspaceSlug ?? "execra-ai"
    url.pathname = `/lab/pm/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(item.projectId)}/issues/${encodeURIComponent(item.id)}`
    url.searchParams.set("view", detailSlug === "issue-detail-2" ? "detail2" : "detail1")
    url.searchParams.set("scenario", scenario)
    url.searchParams.delete("entity")
    let copied = false
    try { await navigator.clipboard.writeText(url.href); copied = true } catch { /* Show the actual link for manual copy; never claim a failed write succeeded. */ }
    setLink({ value: url.href, copied })
    setDialog("link")
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button ref={trigger} variant="ghost" size="icon" className={styles.rowMore} aria-label={text("更多操作：" + item.title, "More actions for " + item.title)} />}><MoreHorizontal aria-hidden="true" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onOpen(item)}>{text("打开问题", "Open issue")}</DropdownMenuItem>
          <DropdownMenuItem onClick={copyLink}>{text("复制问题链接", "Copy issue link")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canMutate || !nextState} onClick={() => { if (canMutate && nextState) onPatchItem(item, { stateId: nextState.id }) }}>{text("移到下一状态", "Move to next status")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("properties")}>{text("更多属性", "More properties")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <DialogContent finalFocus={trigger} data-pm-row-properties>
          <DialogTitle>{dialog === "properties" ? text("问题属性", "Issue properties") : link?.copied ? text("链接已复制", "Link copied") : text("无法复制链接", "Copy unavailable")}</DialogTitle>
          <DialogDescription>{dialog === "properties" ? text("本地 fixture 属性；修改使用所选的模拟结果。", "Local fixture fields; edits use the selected simulated result.") : text("本地示例链接；新建记录仅存在于当前 PM 内存会话。", "Local showcase link; created records only exist in the current PM memory session.")}</DialogDescription>
          <DialogBody>
            {dialog === "properties" ? <>
              <WorkItemProperties item={item} catalog={catalog} visibleProperties={properties} layout="detail" capabilities={capabilities} mutation={mutation} onPatchItem={onPatchItem} today={issueToday} />
              <WorkItemMutationNotice mutation={mutation} />
              {mutation?.status === "unknown" && <p className={styles.formNote}>{text("关闭此对话框后，在该行显式核对原请求。", "Close this dialog to explicitly check the original request in its row.")}</p>}
            </> : <div className={styles.linkFeedback}>
              <p role="status">{link?.copied ? text("浏览器剪贴板写入已完成。", "The browser clipboard write completed.") : text("剪贴板不可用。请选择下方链接后手动复制。", "Clipboard unavailable. Select the link below to copy manually.")}</p>
              <Input readOnly value={link?.value ?? ""} aria-label={text("本地问题链接", "Local issue link")} onFocus={(event) => event.target.select()} />
            </div>}
          </DialogBody>
          <DialogFooter><Button variant="secondary" onClick={() => setDialog(null)}>{text("关闭", "Close")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}


export function IssueListToolbar({
  variant,
  view,
  onViewChange,
  outcome,
  onOutcomeChange,
  catalog,
  summary,
  actions,
  selectedCount = 0,
  onClearSelection,
  disabled = false,
  canMutate,
}: {
  variant: "full" | "compact"
  view: WorkItemsViewState
  onViewChange: (view: WorkItemsViewState) => void
  outcome: IssueOutcome
  onOutcomeChange: (outcome: IssueOutcome) => void
  catalog: WorkItemCatalog
  summary?: ReactNode
  actions?: ReactNode
  selectedCount?: number
  onClearSelection?: () => void
  disabled?: boolean
  canMutate: boolean
}) {
  const { text } = useText()
  const patch = (changes: Partial<WorkItemsViewState>) =>
    onViewChange({ ...view, ...changes })
  const sortChoices: { value: WorkItemsViewState["sort"]; label: string }[] = [
    { value: "manual", label: text("原始顺序", "Manual order") },
    { value: "title", label: text("按标题", "By title") },
    { value: "dueDate", label: text("按截止日期", "By due date") },
    { value: "priority", label: text("按优先级", "By priority") },
  ]
  const filterControls = (
    <>
      {variant === "full" ? (
        <>
          <WorkItemAssigneePicker
            label={text("状态筛选", "Filter by state")}
            value={filterValues(view.filters, "state")}
            options={catalog.states}
            disabled={disabled}
            onChange={(state) =>
              patch({ filters: withFilterValues(view.filters, "state", state) })
            }
          />
          <WorkItemAssigneePicker
            label={text("优先级筛选", "Filter by priority")}
            value={filterValues(view.filters, "priority")}
            options={catalog.priorities}
            disabled={disabled}
            onChange={(priority) =>
              patch({
                filters: withFilterValues(view.filters, "priority", priority),
              })
            }
          />
          <WorkItemAssigneePicker
            label={text("负责人筛选", "Filter by assignee")}
            value={filterValues(view.filters, "assignees")}
            options={catalog.assignees}
            disabled={disabled}
            onChange={(assignees) =>
              patch({
                filters: withFilterValues(
                  view.filters,
                  "assignees",
                  assignees,
                ),
              })
            }
          />
        </>
      ) : (
        <>
          <CompactSelectFilter
            label={text("状态筛选", "Filter by state")}
            value={filterValues(view.filters, "state")}
            options={catalog.states}
            disabled={disabled}
            onChange={(state) =>
              patch({ filters: withFilterValues(view.filters, "state", state) })
            }
          />
          <CompactSelectFilter
            label={text("优先级筛选", "Filter by priority")}
            value={filterValues(view.filters, "priority")}
            options={catalog.priorities}
            disabled={disabled}
            onChange={(priority) =>
              patch({
                filters: withFilterValues(view.filters, "priority", priority),
              })
            }
          />
          <CompactSelectFilter
            label={text("负责人筛选", "Filter by assignee")}
            value={filterValues(view.filters, "assignees")}
            options={catalog.assignees}
            disabled={disabled}
            onChange={(assignees) =>
              patch({
                filters: withFilterValues(
                  view.filters,
                  "assignees",
                  assignees,
                ),
              })
            }
          />
        </>
      )}
      <ClearFiltersButton view={view} onViewChange={onViewChange} />
    </>
  )
  return (
    <div className={styles.summaryStrip}>
      <span className={styles.summaryCount}>{summary}</span>
      {selectedCount > 0 && (
        <span className={styles.selectionCount}>
          {text(`已选 ${selectedCount} 项`, `${selectedCount} selected`)}
          <Button size="sm" variant="ghost" aria-label={text("清除选择", "Clear selection")} onClick={onClearSelection}><X className="size-3.5" aria-hidden="true" /></Button>
        </span>
      )}
      <span className={styles.groupingLabel}>{text("按状态分组", "Grouped by status")}</span>
      <Popover>
        <PopoverTrigger render={<Button variant="secondary" size="icon" className={styles.filterTrigger} disabled={disabled} aria-label={text("筛选问题", "Filter issues")} />}>
          <SlidersHorizontal aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent className={styles.filterPopover} align="end">
          <FilterToolbar
      className={styles.toolbar}
      label={text("问题筛选工具栏", "Issue filter toolbar")}
      search={
        <PmSearch
          value={view.query}
          onChange={(query) => patch({ query })}
          label={text("搜索问题", "Search issues")}
        />
      }
      filters={filterControls}
      sort={
        <>
          <Select
            value={view.sort}
            items={sortChoices}
            disabled={disabled}
            onValueChange={(next) => {
              if (next !== null)
                patch({ sort: next as WorkItemsViewState["sort"] })
            }}
          >
            <SelectTrigger
              aria-label={text("排序方式", "Sort by")}
              className={styles.sortSelect}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortChoices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="secondary"
            size="icon"
            aria-label={
              view.sortDirection === "asc"
                ? text("升序，切换为降序", "Ascending, switch to descending")
                : text("降序，切换为升序", "Descending, switch to ascending")
            }
            aria-pressed={view.sortDirection === "desc"}
            disabled={disabled}
            onClick={() =>
              patch({
                sortDirection: view.sortDirection === "asc" ? "desc" : "asc",
              })
            }
          >
            <ArrowDownUp aria-hidden="true" />
          </Button>
        </>
      }
      actions={
        <>
          <IssueOutcomeSelect
            compact
            value={outcome}
            disabled={disabled || !canMutate}
            label={text("模拟提交结果", "Simulated result")}
            onChange={onOutcomeChange}
          />
          {actions}
        </>
      }
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create dialog with stable domain ids and full local result semantics
// ---------------------------------------------------------------------------

export function IssueChildCreate({ item, catalog, domain, setDomain, projects, writable, label, mode = "sheet" }: {
  item: PmIssue
  catalog: WorkItemCatalog
  domain: PmIssueDomain
  setDomain: Updater<PmIssueDomain>
  projects: readonly ProjectCardRecord[]
  writable: boolean
  label: string
  mode?: "sheet" | "inline"
}) {
  const { text } = useText()
  const trigger = useRef<HTMLButtonElement>(null)
  const [forms, setForms] = usePmScenarioState<Record<string, IssueListUi>>("issue-child-create-forms", () => ({}))
  const initial = () => ({
    ...createIssueListUi(),
    createDraft: { ...createIssueCreateDraft("todo", item.projectId), parentId: item.id },
  })
  const ui = forms[item.id] ?? initial()
  const setUi: Updater<IssueListUi> = (action) => setForms((previous) => {
    const current = previous[item.id] ?? initial()
    return { ...previous, [item.id]: typeof action === "function" ? action(current) : action }
  })
  const pending = Object.values(domain.requests).find((request) => request?.createItem)
  const locked = !writable || isMutationLocked(domain.mutations[item.id]) || !!(pending && pending.createItem?.parentId !== item.id)
  const close = () => {
    setUi((previous) => ({ ...previous, createOpen: false }))
    trigger.current?.focus()
  }
  const finish = () => {
    setUi((previous) => ({ ...previous, createOpen: false, createDraft: { ...previous.createDraft, title: "" } }))
    trigger.current?.focus()
  }
  const settle = (outcome: "confirmed" | "rejected") => {
    if (!pending || !writable) return
    const next = reconcileIssueDomain(domain, pending.itemId, outcome)
    setDomain(next)
    if (next.mutations[pending.itemId]?.status === "confirmed") finish()
  }
  return (
    <>
      <Button ref={trigger} variant="secondary" disabled={locked} data-pm-add-subissue onClick={() => {
        if (locked) return
        setUi((previous) => ({ ...previous, createOpen: true }))
      }}><Plus className="size-4" aria-hidden="true" />{label}</Button>
      {mode === "inline" ? ui.createOpen && (
        <form className={styles.inlineChildForm} data-pm-inline-child-create aria-label={label} onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close() }
        }} onSubmit={(event) => {
          event.preventDefault()
          if (locked || pending) return
          const result = submitIssueCreate(domain, ui.createDraft, ui.outcome)
          setDomain(result.domain)
          setUi((previous) => ({ ...previous, lastCreatedId: result.id ?? previous.lastCreatedId }))
          if (result.status === "confirmed") finish()
        }}>
          <Input autoFocus value={ui.createDraft.title} aria-label={text("子任务标题", "Subtask title")} placeholder={text("子任务标题", "Subtask title")} disabled={locked || !!pending} onChange={(event) => setUi((previous) => ({ ...previous, createDraft: { ...previous.createDraft, title: event.target.value } }))} />
          <Button type="submit" disabled={locked || !!pending || !ui.createDraft.title.trim()}>{text("添加", "Add")}</Button>
          <Button type="button" variant="ghost" onClick={close}>{text("取消", "Cancel")}</Button>
          <div className={styles.inlineChildResult}>
            <IssueOutcomeSelect value={ui.outcome} disabled={locked || !!pending} label={text("模拟创建结果", "Simulated create result")} onChange={(outcome) => setUi((previous) => ({ ...previous, outcome }))} />
            <IssueMutationStatus mutation={ui.lastCreatedId ? domain.mutations[ui.lastCreatedId] : undefined} disabled={!writable} onConfirm={() => settle("confirmed")} onReject={() => settle("rejected")} />
          </div>
        </form>
      ) : (
        <IssueCreateDialog finalFocus={trigger} open={ui.createOpen} onOpenChange={(open) => setUi((previous) => ({ ...previous, createOpen: open }))}
          ui={ui} setUi={setUi} domain={domain} setDomain={setDomain} catalog={catalog}
          projects={projects.filter((project) => project.id === item.projectId)} writable={writable} />
      )}
    </>
  )
}



export function IssueCreateDialog({
  open,
  onOpenChange,
  ui,
  setUi,
  domain,
  setDomain,
  catalog,
  projects,
  writable,
  finalFocus,
  lockPendingDismissal = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  ui: IssueListUi
  setUi: Updater<IssueListUi>
  domain: PmIssueDomain
  setDomain: Updater<PmIssueDomain>
  catalog: WorkItemCatalog
  projects: readonly ProjectCardRecord[]
  writable: boolean
  finalFocus: ComponentProps<typeof SheetContent>["finalFocus"]
  lockPendingDismissal?: boolean
}) {
  const { text } = useText()
  const [error, setError] = useState("")
  const pendingCreateId =
    Object.entries(domain.requests).find(
      ([, request]) => request?.createItem,
    )?.[0] ?? null
  const submitted = pendingCreateId ? domain.requests[pendingCreateId]?.createItem : undefined
  // Pending requests own their submitted payload, even after a scene UI reset.
  const draft: IssueCreateDraft = submitted ? {
    title: submitted.title, description: submitted.description ?? "",
    stateId: submitted.stateId, priorityId: submitted.priorityId,
    assigneeIds: [...submitted.assigneeIds], projectId: submitted.projectId,
    parentId: submitted.parentId, startDate: submitted.startDate ?? null, dueDate: submitted.dueDate,
  } : ui.createDraft
  const setDraft = (changes: Partial<IssueCreateDraft>) => {
    if (!writable || pendingCreateId) return
    setUi((previous) => ({
      ...previous,
      createDraft: { ...previous.createDraft, ...changes },
    }))
  }
  const close = () => {
    if (lockPendingDismissal && pendingCreateId) return
    setError("")
    onOpenChange(false)
  }
  const submit = () => {
    if (!writable) return
    if (pendingCreateId) {
      setError(
        text(
          "已有创建结果等待核对，先确认后才能再次创建。",
          "A create result is still being checked; settle it before creating again.",
        ),
      )
      return
    }
    const result = submitIssueCreate(domain, draft, ui.outcome)
    if (result.domain !== domain) setDomain(result.domain)
    if (result.status === "confirmed") {
      setError("")
      setUi((previous) => ({
        ...previous,
        createOpen: false,
        lastCreatedId: result.id ?? null,
        createDraft: { ...previous.createDraft, title: "" },
      }))
      return
    }
    setError(
      result.error ??
        (result.status === "unknown"
          ? text("结果未知，草稿已保留。", "Result unknown; draft retained.")
          : text(
              "创建被拒绝，草稿已保留。",
              "Create rejected; draft retained.",
            )),
    )
  }
  const settle = (outcome: "confirmed" | "rejected") => {
    if (!pendingCreateId || !writable) return
    setDomain((state) => reconcileIssueDomain(state, pendingCreateId, outcome))
    if (outcome === "confirmed") {
      setError("")
      setUi((previous) => ({
        ...previous,
        createOpen: false,
        lastCreatedId: pendingCreateId,
        createDraft: { ...previous.createDraft, title: "" },
      }))
    } else {
      setUi((previous) => ({ ...previous, createDraft: draft }))
      setError(
        text(
          "创建未落地，草稿已保留。",
          "Create did not land; draft retained.",
        ),
      )
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && lockPendingDismissal && pendingCreateId) {
          // Controlled open state: refusing close() keeps the sheet open,
          // the Radix equivalent of Base UI details.cancel().
          return
        }
        if (next) onOpenChange(next)
        else close()
      }}
    >
      <SheetContent size={576} finalFocus={finalFocus} data-pm-create-issue>
        <SheetHeader className={styles.createHeader}>
          <SheetTitle>{draft.parentId ? text("新建子问题", "Create sub-issue") : text("新建问题", "Create issue")}</SheetTitle>
        <SheetDescription>
          {text(
            "本地 fixture 创建，使用稳定 ID 与明确结果模拟。",
            "Local fixture creation with stable ids and explicit simulated results.",
          )}
          {draft.parentId && <span> {text("父问题", "Parent issue")}: {domain.items.find((entry) => entry.id === draft.parentId)?.identifier ?? draft.parentId}</span>}
        </SheetDescription>
        </SheetHeader>
        <form className={styles.createForm} onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}>
        <SheetBody className={styles.createBody}>
            <Field label={text("标题", "Title")} error={error || undefined}>
              {(control) => (
                <Input
                  {...control}
                  data-pm-create-title
                  autoFocus
                  value={draft.title}
                  aria-label={text("问题标题", "Issue title")}
                  disabled={!writable || !!pendingCreateId}
                  onChange={(event) => setDraft({ title: event.target.value })}
                />
              )}
            </Field>
            <Field label={text("描述", "Description")}>
              {(control) => <Textarea {...control} rows={5} aria-label={text("问题描述", "Issue description")} value={draft.description ?? ""} disabled={!writable || !!pendingCreateId} onChange={(event) => setDraft({ description: event.target.value })} />}
            </Field>
            <div className={styles.createGrid}>
              <label className={styles.createField}>
                <span className={styles.fieldLabel}>
                  {text("状态", "State")}
                </span>
                <WorkItemStatePicker
                  value={draft.stateId}
                  options={catalog.states}
                  disabled={!writable || !!pendingCreateId}
                  onChange={(stateId) => setDraft({ stateId })}
                />
              </label>
              <Field label={text("优先级", "Priority")} className={styles.createField}>
                {(control) => (
                  <WorkItemPriorityPicker
                    {...control}
                    label={text("优先级", "Priority")}
                    value={draft.priorityId}
                    options={catalog.priorities}
                    disabled={!writable || !!pendingCreateId}
                    onChange={(priorityId) => setDraft({ priorityId })}
                  />
                )}
              </Field>
            </div>
            <details className={styles.moreFields}>
              <summary>{text("更多属性", "More properties")}</summary>
              <div className={styles.createGrid}>
              <label className={styles.createField}>
                <span className={styles.fieldLabel}>
                  {text("负责人", "Assignee")}
                </span>
                <WorkItemAssigneePicker
                  value={draft.assigneeIds}
                  options={catalog.assignees}
                  disabled={!writable || !!pendingCreateId}
                  onChange={(assigneeIds) => setDraft({ assigneeIds })}
                />
              </label>
              <label className={styles.createField}>
                <span className={styles.fieldLabel}>
                  {text("项目", "Project")}
                </span>
                <Select
                  value={draft.projectId}
                  items={projects.map((project) => ({
                    value: project.id,
                    label: project.identifier,
                  }))}
                  disabled={!writable || !!pendingCreateId || !projects.length}
                  onValueChange={(next) => {
                    if (next !== null) setDraft({ projectId: next })
                  }}
                >
                  <SelectTrigger aria-label={text("项目", "Project")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.identifier}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className={styles.createField}>
                <span className={styles.fieldLabel}>{text("开始日期", "Start date")}</span>
                <Input type="date" aria-label={text("开始日期", "Start date")} value={draft.startDate ?? ""} disabled={!writable || !!pendingCreateId} onChange={(event) => setDraft({ startDate: event.target.value || null })} />
              </label>
              <label className={styles.createField}>
                <span className={styles.fieldLabel}>
                  {text("截止日期", "Due date")}
                </span>
                <Input
                  type="date"
                  value={draft.dueDate ?? ""}
                  aria-label={text("截止日期", "Due date")}
                  disabled={!writable || !!pendingCreateId}
                  onChange={(event) =>
                    setDraft({ dueDate: event.target.value || null })
                  }
                />
              </label>
            </div>
            </details>
            <div className={styles.createOutcome}>
              <span className={styles.fieldLabel}>
                {text("模拟结果", "Simulated result")}
              </span>
              <IssueOutcomeSelect
                value={ui.outcome}
                disabled={!writable || !!pendingCreateId}
                label={text("模拟创建结果", "Simulated create result")}
                onChange={(outcome) =>
                  setUi((previous) => ({ ...previous, outcome }))
                }
              />
            </div>
            {!writable && (
              <p className={styles.formNote}>
                {text(
                  "当前场景为只读或加载中，创建不会提交。",
                  "This scene is read-only or loading; creates are not submitted.",
                )}
              </p>
            )}
            {!!pendingCreateId && (
              <p
                className={styles.formError}
                role="status"
                data-pm-create-pending
              >
                {text(
                  "已有创建结果未知，等待显式核对。",
                  "A create result is unknown and waits for an explicit check.",
                )}
              </p>
            )}
            {!!error && !pendingCreateId && (
              <p className={styles.formError} role="alert">
                {error}
              </p>
            )}
            {!!pendingCreateId && (
              <IssueResultCheck
                operationId={pendingCreateId}
                disabled={!writable}
                onConfirm={() => settle("confirmed")}
                onReject={() => settle("rejected")}
              />
            )}
        </SheetBody>
        <SheetFooter className={styles.createFooter}>
          <Button type="button" variant="secondary" disabled={lockPendingDismissal && !!pendingCreateId} onClick={close}>{text("取消", "Cancel")}</Button>
          <Button type="submit" data-pm-create-submit disabled={!writable || !!pendingCreateId || !draft.title.trim() || !projects.length}>{text("创建问题", "Create issue")}</Button>
        </SheetFooter>
          </form>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Created-but-filtered notice (list pages)
// ---------------------------------------------------------------------------

export function IssueCreatedNotice({
  createdId,
  onClearFilters,
  onDismiss,
}: {
  createdId: string
  onClearFilters: () => void
  onDismiss: () => void
}) {
  const { text } = useText()
  return (
    <p className={styles.createdNotice} role="status" data-pm-created-hidden>
      <span>
        {text(
          `已创建 ${createdId}，但当前筛选/搜索把它隐藏了。`,
          `Created ${createdId}, but current filters hide it.`,
        )}
      </span>
      <Button size="sm" variant="secondary" onClick={onClearFilters}>
        {text("清除筛选查看", "Clear filters to show")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={text("忽略提示", "Dismiss notice")}
        onClick={onDismiss}
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </p>
  )
}

// ---------------------------------------------------------------------------
// Project scope from the injected entity (Dashboard drilldown contract)
// ---------------------------------------------------------------------------

export function IssueProjectScopeBar({
  label,
  projectId,
  onShowAll,
}: {
  label: string
  projectId: string
  onShowAll: () => void
}) {
  const { text } = useText()
  return (
    <p className={styles.createdNotice} role="status" data-pm-project-scope>
      <span>
        {text(`项目范围：${label}`, `Project scope: ${label}`)}
        <code> {projectId}</code>
      </span>
      <Button size="sm" variant="secondary" onClick={onShowAll}>
        {text("查看全部问题", "Show all issues")}
      </Button>
    </p>
  )
}

export function IssueMissingReferenceNotice({
  referenceId,
  onShowAll,
}: {
  referenceId: string
  onShowAll: () => void
}) {
  const { text } = useText()
  return (
    <p className={styles.identityNote} role="alert" data-pm-missing-reference>
      <AlertTriangle className={styles.mutationIcon} aria-hidden="true" />
      <span>
        {text(
          `引用的项目 ${referenceId} 不在本场景内，未显示任何问题；确认引用或查看全部。`,
          `Referenced project ${referenceId} is not in this scene, so no issues are shown; check the reference or show all.`,
        )}
      </span>
      <Button size="sm" variant="ghost" onClick={onShowAll}>
        {text("查看全部问题", "Show all issues")}
      </Button>
    </p>
  )
}

// ---------------------------------------------------------------------------
// Identity: injected entity id with first-record fallback
// ---------------------------------------------------------------------------

export function IssueIdentityNotice({
  entityId,
  resolved,
  found,
}: {
  entityId: string | null
  resolved: PmIssue | null
  found: boolean
}) {
  const { text } = useText()
  if (!resolved || (entityId && found)) return null
  return (
    <p
      className={styles.identityNote}
      role="status"
      data-pm-identity="fallback"
    >
      <AlertTriangle className={styles.mutationIcon} aria-hidden="true" />
      <span>
        {entityId
          ? text(
              `地址中的问题 ${entityId} 不在本场景内，已显示首条 ${resolved.identifier}。`,
              `Issue ${entityId} from the address is not in this scene; showing the first record ${resolved.identifier}.`,
            )
          : text(
              `地址未指定问题，已显示首条 ${resolved.identifier}。`,
              `The address does not select an issue; showing the first record ${resolved.identifier}.`,
            )}
      </span>
    </p>
  )
}

// ---------------------------------------------------------------------------
// Shared entity editor: retained draft, cancel keeps payload, explicit apply
// ---------------------------------------------------------------------------

export type IssueEntityEditor = {
  editing: boolean
  draft: IssueDraft | null
  dirty: boolean
  mutation: MutationState | undefined
  locked: boolean
  open: () => void
  cancel: () => void
  discard: () => void
  patch: (changes: Partial<IssueDraft>) => void
  apply: () => void
  reconcile: (result: "confirmed" | "rejected") => void
}

export function useIssueEntityEditor({
  item,
  domain,
  setDomain,
  outcome,
  writable,
  onClosed,
}: {
  item: PmIssue | null
  domain: PmIssueDomain
  setDomain: Updater<PmIssueDomain>
  outcome: IssueOutcome
  writable: boolean
  onClosed?: () => void
}): IssueEntityEditor {
  const [store, setStore] = usePmScenarioState<IssueEditorStore>(
    "issue-editor-store",
    createIssueEditorStore,
  )
  const editing = !!item && store.editingId === item.id
  const draft = item ? (store.drafts[item.id] ?? issueDraftFrom(item)) : null
  const mutation = item ? domain.mutations[item.id] : undefined
  const locked = isMutationLocked(mutation)
  const clearApplied = () =>
    setStore((previous) => {
      if (!item) return previous
      const drafts = { ...previous.drafts }
      delete drafts[item.id]
      return { editingId: null, drafts }
    })
  return {
    editing,
    draft,
    dirty: !!item && !!draft && issueDraftDirty(item, draft),
    mutation,
    locked,
    open: () => {
      if (!item || !writable) return
      setStore((previous) => ({
        editingId: item.id,
        drafts: {
          ...previous.drafts,
          [item.id]: previous.drafts[item.id] ?? issueDraftFrom(item),
        },
      }))
    },
    // Cancel closes the editor but keeps the typed payload for resume.
    cancel: () => {
      setStore((previous) => ({ ...previous, editingId: null }))
      onClosed?.()
    },
    discard: () => {
      clearApplied()
      onClosed?.()
    },
    patch: (changes) => {
      if (!item) return
      setStore((previous) => {
        const current = previous.drafts[item.id] ?? issueDraftFrom(item)
        return {
          ...previous,
          drafts: {
            ...previous.drafts,
            [item.id]: { ...current, ...changes },
          },
        }
      })
    },
    apply: () => {
      if (!item || !writable || locked) return
      const current = store.drafts[item.id]
      if (!current) return
      const changes = issueDraftChanges(item, current)
      if (!changes) {
        setStore((previous) => ({ ...previous, editingId: null }))
        onClosed?.()
        return
      }
      const next = patchIssueDomain(
        domain,
        item.id,
        changes,
        outcome,
        current.baseRevision,
      )
      setDomain(next)
      // Only an actually applied result clears the draft; rejected/unknown
      // keep the payload and the captured base revision.
      if (next.mutations[item.id]?.status === "confirmed") {
        clearApplied()
        onClosed?.()
      }
    },
    reconcile: (result) => {
      if (!item || !writable) return
      const next = reconcileIssueDomain(domain, item.id, result)
      setDomain(next)
      if (
        result === "confirmed" &&
        next.mutations[item.id]?.status === "confirmed"
      ) {
        clearApplied()
        onClosed?.()
      }
    },
  }
}

export function IssueTitleField({
  draft,
  editing,
  onPatch,
  disabled,
  error,
}: {
  draft: IssueDraft
  editing: boolean
  onPatch: (changes: Partial<IssueDraft>) => void
  disabled?: boolean
  error?: string
}) {
  const { text } = useText()
  if (!editing) return null
  return (
    <Field label={text("标题", "Title")} error={error}>
      {(control) => (
        <Input
          {...control}
          data-pm-draft-title
          value={draft.title}
          aria-label={text("问题标题", "Issue title")}
          disabled={disabled}
          onChange={(event) => onPatch({ title: event.target.value })}
        />
      )}
    </Field>
  )
}

export function IssueDescriptionField({
  draft,
  editing,
  onPatch,
  disabled,
  rows = 10,
  error,
}: {
  draft: IssueDraft
  editing: boolean
  onPatch: (changes: Partial<IssueDraft>) => void
  disabled?: boolean
  rows?: number
  error?: string
}) {
  const { text } = useText()
  if (!editing) return null
  return (
    <div className={styles.draftForm} data-pm-draft-form>
      <Field label={text("描述", "Description")} error={error}>
        {(control) => (
          <Textarea
            {...control}
            data-pm-draft-description
            rows={rows}
            value={draft.description}
            aria-label={text("问题描述", "Issue description")}
            disabled={disabled}
            onChange={(event) => onPatch({ description: event.target.value })}
          />
        )}
      </Field>
      <p className={styles.formNote}>
        {text(
          `基准版本 ${draft.baseRevision}；取消保留草稿，确认后仅清除已应用草稿。`,
          `Base revision ${draft.baseRevision}; cancel keeps the draft, confirming clears only the applied draft.`,
        )}
      </p>
    </div>
  )
}

export function IssueEditControls({
  editing,
  dirty,
  disabled,
  onEdit,
  onCancel,
  onDiscard,
  onApply,
  editRef,
}: {
  editing: boolean
  dirty: boolean
  disabled?: boolean
  onEdit: () => void
  onCancel: () => void
  onDiscard: () => void
  onApply: () => void
  editRef?: Ref<HTMLButtonElement>
}) {
  const { text } = useText()
  if (!editing)
    return (
      <Button
        ref={editRef}
        variant="secondary"
        data-pm-edit-toggle
        disabled={disabled}
        onClick={onEdit}
      >
        {text("编辑问题", "Edit issue")}
      </Button>
    )
  return (
    <span className={styles.editControls}>
      <Button data-pm-apply disabled={disabled || !dirty} onClick={onApply}>
        {text("应用更改", "Apply changes")}
      </Button>
      <Button
        variant="secondary"
        data-pm-cancel
        disabled={disabled}
        onClick={onCancel}
      >
        {text("取消编辑", "Cancel")}
      </Button>
      <Button
        variant="ghost"
        data-pm-discard
        disabled={disabled}
        onClick={onDiscard}
      >
        <RotateCcw className="size-3.5" aria-hidden="true" />
        {text("清除草稿", "Discard draft")}
      </Button>
      {dirty && (
        <Badge tone="warning" data-pm-draft-dirty>
          {text("未应用草稿", "Unapplied draft")}
        </Badge>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Attachments with preview and error state
// ---------------------------------------------------------------------------

export function IssueAttachments({
  attachments,
  variant = "grid",
}: {
  attachments: PmIssue["attachments"]
  variant?: "grid" | "panel"
}) {
  const { text } = useText()
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({})
  if (!attachments.length)
    return (
      <p className={styles.emptyNote}>
        {text("本场景没有附件。", "No attachments in this scene.")}
      </p>
    )
  return (
    <ul
      className={
        variant === "grid" ? styles.attachments : styles.attachmentsPanel
      }
      data-pm-attachment-list
    >
      {attachments.map((file) => {
        const open = !!openIds[file.id]
        const unavailable = file.status === "error"
        return (
          <li
            key={file.id}
            className={styles.attachment}
            data-attachment={file.id}
          >
            <div className={styles.attachmentRow}>
              <FileText className={styles.attachmentIcon} aria-hidden="true" />
              <span className={styles.attachmentName} title={file.name}>
                {file.name}
              </span>
              <Badge shape="pill" size="sm">
                {file.name.split(".").pop()?.toUpperCase() || "FILE"}
              </Badge>
              {unavailable ? (
                <span className={styles.attachmentError} role="status">
                  {text("预览不可用", "Preview unavailable")}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={open}
                  aria-label={
                    open
                      ? text(`收起 ${file.name}`, `Hide ${file.name}`)
                      : text(`预览 ${file.name}`, `Preview ${file.name}`)
                  }
                  onClick={() =>
                    setOpenIds((previous) => ({
                      ...previous,
                      [file.id]: !previous[file.id],
                    }))
                  }
                >
                  {open ? (
                    <ChevronDown className="size-4" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-4" aria-hidden="true" />
                  )}
                  {text("预览", "Preview")}
                </Button>
              )}
            </div>
            {unavailable && open && (
              <p className={styles.attachmentBody} role="alert">
                {text(
                  "本地场景无法读取该文件内容，未模拟下载。",
                  "This scene cannot read the file content; download is not simulated.",
                )}
              </p>
            )}
            {!unavailable && open && (
              <div className={styles.attachmentBody} data-pm-attachment-preview>
                <MessageContent content={file.content} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Sub-issues / subtasks
// ---------------------------------------------------------------------------

export function IssueSubissueList({
  items,
  catalog,
  onOpen,
}: {
  items: WorkItemRecord[]
  catalog: WorkItemCatalog
  onOpen: (item: WorkItemRecord) => void
}) {
  const { text } = useText()
  if (!items.length)
    return (
      <p className={styles.emptyNote}>
        {text("没有子问题。", "No sub-issues.")}
      </p>
    )
  return (
    <ul className={styles.subList}>
      {items.map((item) => (
        <li key={item.id}>
          <WorkItemRow
            item={item}
            catalog={catalog}
            visibleProperties={["state", "counts", "dueDate"]}
            onOpen={onOpen}
          />
        </li>
      ))}
    </ul>
  )
}

export function IssueSubtasksSection({
  items,
  catalog,
  disabled,
  onToggle,
}: {
  items: WorkItemRecord[]
  catalog: WorkItemCatalog
  disabled?: boolean
  onToggle: (item: WorkItemRecord, next: "done" | "todo") => void
}) {
  const { text } = useText()
  const done = items.filter((item) => item.stateId === "done").length
  const total = items.length
  const percent = total ? Math.round((done / total) * 100) : 0
  const stateLabel = (id: string) =>
    catalog.states.find((state) => state.id === id)?.label ?? id
  return (
    <div data-pm-issue-subtasks>
      <div className={styles.subtasksHeader}>
        <h2 className={styles.sectionTitle}>{text("子任务", "Subtasks")}</h2>
        {total > 0 && (
          <span className={styles.progressLabel} data-pm-subtask-progress>
            {done} / {total} · {percent}%
          </span>
        )}
      </div>
      {total === 0 ? (
        <p className={styles.emptyNote}>
          {text(
            "本问题没有子任务（fixture 未创建子任务）。",
            "This issue has no subtasks in the fixture.",
          )}
        </p>
      ) : (
        <ul className={styles.subtasks}>
          {items.map((item) => {
            const checked = item.stateId === "done"
            return (
              <li key={item.id} className={styles.subtask}>
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  aria-label={
                    checked
                      ? text(
                          `标记未完成：${item.title}`,
                          `Mark incomplete: ${item.title}`,
                        )
                      : text(
                          `标记完成：${item.title}`,
                          `Mark complete: ${item.title}`,
                        )
                  }
                  onCheckedChange={() =>
                    onToggle(item, checked ? "todo" : "done")
                  }
                />
                <span
                  className={styles.subtaskTitle}
                  data-done={checked || undefined}
                >
                  {item.title}
                </span>
                <span className={styles.subtaskState}>
                  <SquareCheck className="size-3.5" aria-hidden="true" />
                  {stateLabel(item.stateId)}
                </span>
                <span className={styles.subtaskMeta}>
                  {item.dueDate ?? text("无截止", "No due date")}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Activity + comments (page-local, no service sends)
// ---------------------------------------------------------------------------

export type IssueActivityEntry = {
  id: string
  kind: "comment" | "update"
  actor: string
  text: string
  at: string
}

export function IssueActivityList({
  entries,
  emptyText,
}: {
  entries: IssueActivityEntry[]
  emptyText: string
}) {
  const { text } = useText()
  if (!entries.length) return <p className={styles.emptyNote}>{emptyText}</p>
  return (
    <ol className={styles.activity} data-pm-activity-list>
      {entries.map((entry) => (
        <li key={`${entry.kind}-${entry.id}`} className={styles.activityEntry}>
          <Avatar name={entry.actor} size={24} />
          <div className={styles.activityBody}>
            <p className={styles.activityHead}>
              <span className={styles.activityActor}>{entry.actor}</span>
              <Badge shape="pill" size="sm">
                {entry.kind === "comment"
                  ? text("评论", "commented")
                  : text("更新", "updated")}
              </Badge>
              <span className={styles.activityTime}>
                <Clock3 className="size-3.5" aria-hidden="true" />
                {entry.at}
              </span>
            </p>
            <p className={styles.activityText}>{entry.text}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

export function IssueCommentsSection({
  itemId,
  store,
  setStore,
  disabled,
  author,
}: {
  itemId: string
  store: IssueCommentStore
  setStore: Updater<IssueCommentStore>
  disabled?: boolean
  author: string
}) {
  const { text } = useText()
  const state = issueCommentState(store, itemId)
  const draft = state.draft
  const entries =
    state.sort === "oldest" ? state.entries : [...state.entries].reverse()
  const setDraft = (changes: Partial<typeof draft>) =>
    setStore((previous) => {
      const current = issueCommentState(previous, itemId)
      return {
        ...previous,
        [itemId]: { ...current, draft: { ...current.draft, ...changes } },
      }
    })
  const toggleSort = () =>
    setStore((previous) => {
      const current = issueCommentState(previous, itemId)
      return {
        ...previous,
        [itemId]: {
          ...current,
          sort: current.sort === "oldest" ? "newest" : "oldest",
        },
      }
    })
  return (
    <div data-pm-issue-comments>
      <div className={styles.subtasksHeader}>
        <h2 className={styles.sectionTitle}>{text("讨论", "Comments")}</h2>
        <Badge tone="info" size="sm">
          {state.entries.length}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className={styles.sortButton}
          data-pm-comment-sort
          onClick={toggleSort}
        >
          {state.sort === "oldest"
            ? text("最早在前", "Oldest")
            : text("最新在前", "Newest")}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {entries.length ? (
        <ol className={styles.comments}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.comment}>
              <Avatar name={entry.author} size={24} />
              <div>
                <p className={styles.activityHead}>
                  <span className={styles.activityActor}>{entry.author}</span>
                  <span className={styles.activityTime}>{entry.at}</span>
                </p>
                <p className={styles.activityText}>{entry.text}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.emptyNote}>
          {text("还没有评论。", "No comments yet.")}
        </p>
      )}
      <div className={styles.composer} data-pm-comment-composer>
        <Textarea
          rows={3}
          value={draft.text}
          aria-label={text("添加评论", "Add your comment")}
          placeholder={text("添加评论…", "Add your comment...")}
          disabled={disabled || draft.status === "unknown"}
          onChange={(event) => setDraft({ text: event.target.value })}
        />
        <div className={styles.composerActions}>
          <IssueOutcomeSelect
            compact
            value={draft.outcome}
            disabled={disabled || draft.status === "unknown"}
            label={text("模拟评论结果", "Simulated comment result")}
            onChange={(outcome) => setDraft({ outcome })}
          />
          <Button
            data-pm-comment-submit
            disabled={
              disabled || draft.status === "unknown" || !draft.text.trim()
            }
            onClick={() =>
              setStore(
                (previous) =>
                  submitIssueComment(previous, itemId, author).store,
              )
            }
          >
            {text("发表评论", "Comment")}
          </Button>
        </div>
        {draft.status === "unknown" && draft.operationId && (
          <IssueResultCheck
            operationId={draft.operationId}
            disabled={disabled}
            onConfirm={() =>
              setStore((previous) =>
                settleIssueComment(previous, itemId, "confirmed", author),
              )
            }
            onReject={() =>
              setStore((previous) =>
                settleIssueComment(previous, itemId, "rejected", author),
              )
            }
          />
        )}
        {draft.status === "rejected" && draft.error && (
          <p className={styles.formError} role="alert">
            {draft.error}
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Properties pane shared by both details
// ---------------------------------------------------------------------------

export function IssuePropertiesPane({
  item,
  catalog,
  visibleProperties,
  editing,
  draft,
  onPatch,
  mutation,
  capabilities,
  facts,
}: {
  item: PmIssue
  catalog: WorkItemCatalog
  visibleProperties: readonly WorkItemProperty[]
  editing: boolean
  draft: IssueDraft | null
  onPatch: (changes: Partial<IssueDraft>) => void
  mutation?: MutationState
  capabilities?: WorkItemCapabilities
  facts?: ReactNode
}) {
  const { text } = useText()
  const active = editing && !!draft
  const sink = (record: WorkItemRecord, patch: WorkItemPatch) => {
    if (!draft || record.id !== item.id) return
    onPatch({
      ...(patch.title !== undefined
        ? { title: patch.title ?? draft.title }
        : {}),
      ...(patch.description !== undefined
        ? { description: patch.description ?? draft.description }
        : {}),
      ...(patch.stateId !== undefined ? { stateId: patch.stateId } : {}),
      ...(patch.priorityId !== undefined
        ? { priorityId: patch.priorityId }
        : {}),
      ...(patch.assigneeIds !== undefined
        ? { assigneeIds: [...patch.assigneeIds] }
        : {}),
      ...(patch.labelIds !== undefined
        ? { labelIds: [...patch.labelIds] }
        : {}),
      ...(patch.startDate !== undefined
        ? { startDate: patch.startDate ?? null }
        : {}),
      ...(patch.dueDate !== undefined
        ? { dueDate: patch.dueDate ?? null }
        : {}),
    })
  }
  // Editing routes property edits into the retained draft; view mode is read-only.
  const effective: PmIssue =
    draft && editing
      ? {
          ...item,
          title: draft.title,
          description: draft.description,
          stateId: draft.stateId,
          priorityId: draft.priorityId,
          assigneeIds: draft.assigneeIds,
          labelIds: draft.labelIds,
          startDate: draft.startDate,
          dueDate: draft.dueDate,
        }
      : item
  return (
    <div className={styles.propertiesPane} data-pm-issue-properties>
      <h2 className={styles.sectionTitle}>{text("属性", "Properties")}</h2>
      <WorkItemProperties
        item={effective}
        catalog={catalog}
        visibleProperties={visibleProperties}
        layout="detail"
        capabilities={active ? capabilities : undefined}
        mutation={active ? mutation : undefined}
        onPatchItem={active ? sink : undefined}
        today={issueToday}
      />
      {facts && <div className={styles.factsBlock} data-pm-issue-facts-block>{facts}</div>}
      {!active && (
        <p className={styles.formNote}>
          {text(
            "属性为只读；点击“编辑问题”修改。",
            "Properties are read-only; use Edit issue to change them.",
          )}
        </p>
      )}
    </div>
  )
}

export function IssueFacts({
  rows,
}: {
  rows: { label: string; value: ReactNode }[]
}) {
  return (
    <dl className={styles.facts} data-pm-issue-facts>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

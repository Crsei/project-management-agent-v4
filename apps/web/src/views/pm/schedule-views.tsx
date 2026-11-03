import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react"
import { Circle, Ellipsis, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field } from "@/components/ui/field"
import {
  WorkItemAssigneePicker,
  WorkItemPriorityPicker,
  WorkItemStatePicker,
} from "@/components/blocks/work-item-properties"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useI18n } from "@/lib/i18n-provider"
import styles from "./schedule-views.module.css"
import type {
  MutationState,
  WorkItemCapabilities,
  WorkItemCatalog,
  WorkItemPatch,
  WorkItemProperty,
  WorkItemRecord,
} from "@/lib/work-items-model"
import type {
  DateBucketSnapshot,
  ScheduleChangeIntent,
  ScheduleViewport,
} from "@/lib/schedule-view-model"
import {
  scheduleDates,
  type ScheduleDates,
} from "@/lib/schedule-date-utils"
import { useIssueDomain } from "./use-issue-domain"
import { usePmNavigation } from "./domain-session"
import {
  addIssueDomain,
  issueCatalog,
  issueRecord,
  patchIssueDomain,
  reconcileIssueDomain,
  type PmIssue,
  type PmIssueDomain,
  type PmIssueOutcome,
  type PmIssuePatch,
} from "./issue-domain"
import { pmMembers, type PmScenario } from "./model"
import { usePmScenarioState } from "./shared"
import { RadixSelect } from "@/components/ui/radix-select"

export type ScheduleOutcome = PmIssueOutcome
export type ScheduleCheckOutcome = Exclude<PmIssueOutcome, "unknown">
export const scheduleQueryKey = (pageKey: string) => `pm-issues:${pageKey}`

export type SchedulePageState = {
  outcome: ScheduleOutcome
  checkOutcome: ScheduleCheckOutcome
  selectedIds: string[]
  activeItemId: string | null
  collapsedGroupIds: string[]
  proposedDates: Record<string, ScheduleDates | undefined>
  baseRevisions: Record<string, number | undefined>
}

function initialPageState(): SchedulePageState {
  return {
    outcome: "confirmed",
    checkOutcome: "confirmed",
    selectedIds: [],
    activeItemId: null,
    collapsedGroupIds: [],
    proposedDates: {},
    baseRevisions: {},
  }
}

/** Shared schedule-family page contract: domain items, simulated outcome routing,
 * draft baseRevision capture, unknown replay lock and explicit reconcile. */
export interface ScheduleIssuePage {
  locale: "en" | "zh-CN"
  scenario: PmScenario
  readonly: boolean
  loading: boolean
  blocked: boolean
  domain: PmIssueDomain
  setDomain: Dispatch<SetStateAction<PmIssueDomain>>
  items: PmIssue[]
  catalog: WorkItemCatalog
  queryKey: string
  capabilities: WorkItemCapabilities
  interaction: {
    selectedIds: string[]
    activeItemId: string | null
    collapsedGroupIds: string[]
  }
  ui: SchedulePageState
  setUi: Dispatch<SetStateAction<SchedulePageState>>
  outcome: ScheduleOutcome
  checkOutcome: ScheduleCheckOutcome
  hasUnknownRequest: boolean
  getPresentation: (item: WorkItemRecord) => {
    catalog: WorkItemCatalog
    visibleProperties: readonly WorkItemProperty[]
    capabilities: WorkItemCapabilities
    mutation?: MutationState
    onPatchItem?: (item: WorkItemRecord, patch: WorkItemPatch) => void
    onOpen: (item: WorkItemRecord) => void
    onReconcile: () => void
    today: string
  }
  onSelectionChange: (selectedIds: string[]) => void
  captureDraft: (item: WorkItemRecord, dates: ScheduleDates) => void
  submitPatch: (
    itemId: string,
    patch: PmIssuePatch,
    baseRevision?: number,
  ) => PmIssueOutcome
  submitScheduleIntent: (intent: ScheduleChangeIntent) => void
  reconcile: (itemId: string) => PmIssueOutcome
  mutationFor: (itemId: string) => MutationState | undefined
  addIssue: (input: {
    title: string
    stateId: string
    priorityId: string
    assigneeIds: readonly string[]
    description?: string
    startDate?: string | null
    dueDate?: string | null
  }) => { status: PmIssueOutcome; error?: string; requestId?: string }
  reconcileCreate: (requestId: string) => PmIssueOutcome
}

/** Shared write-path plumbing for the schedule family: draft baseRevision capture,
 * simulated outcome routing, unknown replay lock and explicit reconcile. */
export function useScheduleIssuePage(
  scenario: PmScenario,
  pageKey: string,
): ScheduleIssuePage {
  const { locale } = useI18n()
  const { navigate } = usePmNavigation()
  const [domain, setDomain] = useIssueDomain(scenario)
  const [ui, setUi] = usePmScenarioState<SchedulePageState>(
    `${pageKey}:schedule-ui`,
    initialPageState,
  )
  const readonly = scenario === "readonly"
  const loading = scenario === "loading"
  const blocked = readonly || loading
  const items = useMemo(
    () => domain.items.map((item) => issueRecord(item, locale)),
    [domain.items, locale],
  )
  const catalog = useMemo(() => issueCatalog(locale), [locale])
  const queryKey = scheduleQueryKey(pageKey)
  const capabilities = useMemo<WorkItemCapabilities>(
    () => ({
      canCreate: !blocked,
      canEditField: () => !blocked,
      canMove: () => !blocked,
      reason: readonly
        ? "Read-only scene / 只读场景"
        : loading
          ? "Scene still loading / 场景加载中"
          : undefined,
    }),
    [blocked, readonly, loading],
  )
  const captureDraft = useCallback(
    (item: WorkItemRecord, dates: ScheduleDates) => {
      if (blocked) return
      setUi((previous) => ({
        ...previous,
        proposedDates: { ...previous.proposedDates, [item.id]: dates },
        baseRevisions: {
          ...previous.baseRevisions,
          [item.id]: previous.baseRevisions[item.id] ?? item.revision,
        },
      }))
    },
    [blocked, setUi],
  )
  const clearDraft = useCallback(
    (itemId: string) =>
      setUi((previous) => {
        if (
          previous.proposedDates[itemId] === undefined &&
          previous.baseRevisions[itemId] === undefined
        )
          return previous
        const proposedDates = { ...previous.proposedDates }
        const baseRevisions = { ...previous.baseRevisions }
        proposedDates[itemId] = undefined
        baseRevisions[itemId] = undefined
        return { ...previous, proposedDates, baseRevisions }
      }),
    [setUi],
  )
  const submitPatch = useCallback(
    (itemId: string, patch: PmIssuePatch, baseRevision?: number) => {
      if (blocked) return "rejected" as const
      const revision =
        baseRevision ??
        domain.items.find((item) => item.id === itemId)?.revision
      const next = patchIssueDomain(domain, itemId, patch, ui.outcome, revision)
      setDomain(next)
      const mutationStatus = next.mutations[itemId]?.status
      const status: PmIssueOutcome =
        mutationStatus === "confirmed" || mutationStatus === "unknown"
          ? mutationStatus
          : "rejected"
      if (status === "confirmed") clearDraft(itemId)
      return status
    },
    [blocked, domain, setDomain, ui.outcome, clearDraft],
  )
  const submitScheduleIntent = useCallback(
    (intent: ScheduleChangeIntent) => {
      if (blocked) return
      submitPatch(
        intent.itemId,
        {
          startDate: intent.nextDates.startDate,
          dueDate: intent.nextDates.dueDate,
        },
        ui.baseRevisions[intent.itemId] ?? intent.baseRevision,
      )
    },
    [blocked, submitPatch, ui.baseRevisions],
  )
  const reconcile = useCallback(
    (itemId: string) => {
      if (blocked) return "rejected" as const
      const next = reconcileIssueDomain(domain, itemId, ui.checkOutcome)
      setDomain(next)
      const mutationStatus = next.mutations[itemId]?.status
      const status: PmIssueOutcome =
        mutationStatus === "confirmed" || mutationStatus === "unknown"
          ? mutationStatus
          : "rejected"
      if (ui.checkOutcome === "confirmed" && status === "confirmed")
        clearDraft(itemId)
      return status
    },
    [blocked, domain, setDomain, ui.checkOutcome, clearDraft],
  )
  const mutationFor = useCallback(
    (itemId: string): MutationState | undefined => domain.mutations[itemId],
    [domain.mutations],
  )
  const onPatchItem = useCallback(
    (item: WorkItemRecord, patch: PmIssuePatch) => {
      submitPatch(item.id, patch)
    },
    [submitPatch],
  )
  const getPresentation = useCallback(
    (item: WorkItemRecord) => ({
      catalog,
      visibleProperties: [
        "state",
        "priority",
        "assignees",
        "labels",
        "startDate",
        "dueDate",
      ] as const,
      capabilities,
      mutation: domain.mutations[item.id],
      onPatchItem: blocked ? undefined : onPatchItem,
      onOpen: (target: WorkItemRecord) => navigate("issue-detail-1", target.id),
      onReconcile: () => reconcile(item.id),
      today: "2026-01-12",
    }),
    [
      catalog,
      capabilities,
      domain.mutations,
      blocked,
      onPatchItem,
      navigate,
      reconcile,
    ],
  )
  const interaction = useMemo(
    () => ({
      selectedIds: ui.selectedIds,
      activeItemId: ui.activeItemId,
      collapsedGroupIds: ui.collapsedGroupIds,
    }),
    [ui.selectedIds, ui.activeItemId, ui.collapsedGroupIds],
  )
  const onSelectionChange = useCallback(
    (selectedIds: string[]) => setUi((p) => ({ ...p, selectedIds })),
    [setUi],
  )
  const hasUnknownRequest = useMemo(
    () => Object.values(domain.requests).some((request) => !!request),
    [domain.requests],
  )
  const addIssue = useCallback(
    (input: {
      title: string
      stateId: string
      priorityId: string
      assigneeIds: readonly string[]
      description?: string
      startDate?: string | null
      dueDate?: string | null
    }) => {
      if (blocked) return { status: "rejected" as const }
      const pendingCreate = Object.values(domain.requests).find(
        (request) => request?.createItem,
      )
      if (pendingCreate)
        return {
          status: "unknown" as const,
          requestId: pendingCreate.itemId,
          error:
            "An existing create request needs explicit reconciliation / 现有创建请求需要显式核对",
        }
      const next = addIssueDomain(
        domain,
        { ...input, projectId: "project-rev-241" },
        ui.outcome,
      )
      setDomain(next)
      const id = `issue-local-${next.sequence}`
      const mutation = next.mutations[id]
      const mutationStatus = mutation?.status
      const status: PmIssueOutcome =
        mutationStatus === "rejected" || mutationStatus === "unknown"
          ? mutationStatus
          : mutationStatus === "pending"
            ? "unknown"
            : "confirmed"
      return {
        status,
        error: mutation?.error,
        requestId: id,
      }
    },
    [blocked, domain, setDomain, ui.outcome],
  )
  const reconcileCreate = useCallback(
    (requestId: string): PmIssueOutcome => {
      if (blocked) return "rejected"
      const next = reconcileIssueDomain(domain, requestId, ui.checkOutcome)
      setDomain(next)
      const status = next.mutations[requestId]?.status
      return status === "confirmed" || status === "unknown"
        ? status
        : "rejected"
    },
    [blocked, domain, setDomain, ui.checkOutcome],
  )
  return {
    locale,
    scenario,
    readonly,
    loading,
    blocked,
    domain,
    setDomain,
    items,
    catalog,
    queryKey,
    capabilities,
    interaction,
    ui,
    setUi,
    outcome: ui.outcome,
    checkOutcome: ui.checkOutcome,
    hasUnknownRequest,
    getPresentation,
    onSelectionChange,
    captureDraft,
    submitPatch,
    submitScheduleIntent,
    reconcile,
    mutationFor,
    addIssue,
    reconcileCreate,
  }
}

export function ScheduleOutcomeField({
  id,
  page,
  disabled = false,
}: {
  id: string
  page: Pick<
    ScheduleIssuePage,
    "setUi" | "outcome" | "checkOutcome" | "hasUnknownRequest"
  >
  disabled?: boolean
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  return (
    <div className="flex flex-wrap items-center gap-3" data-pm-outcome-field>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {en ? "Fixture outcome (simulated)" : "本地 fixture 结果（模拟）"}
        <RadixSelect
          id={`${id}-outcome`}
          aria-label={en ? "Simulated fixture outcome" : "模拟本地结果"}
          className="h-8 rounded-md border bg-surface px-2 text-sm"
          value={page.outcome}
          disabled={disabled}
          onChange={(event) =>
            page.setUi((previous) => ({
              ...previous,
              outcome: event.target.value as ScheduleOutcome,
            }))
          }
        >
          <option value="confirmed">confirmed · 已确认</option>
          <option value="rejected">rejected · 已拒绝</option>
          <option value="unknown">unknown · 结果未知</option>
        </RadixSelect>
      </label>
      {page.hasUnknownRequest && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {en ? "Result check returns" : "显式结果检查的返回值"}
          <RadixSelect
            id={`${id}-check-outcome`}
            aria-label={
              en ? "Simulated result-check outcome" : "模拟结果检查返回值"
            }
            className="h-8 rounded-md border bg-surface px-2 text-sm"
            value={page.checkOutcome}
            disabled={disabled}
            onChange={(event) =>
              page.setUi((previous) => ({
                ...previous,
                checkOutcome: event.target.value as ScheduleCheckOutcome,
              }))
            }
          >
            <option value="confirmed">confirmed</option>
            <option value="rejected">rejected</option>
          </RadixSelect>
        </label>
      )}
      {page.hasUnknownRequest && (
        <p className="text-xs text-muted-foreground">
          {en
            ? "Unknown results are locked; reconcile explicitly."
            : "unknown 请求已锁定重放，请显式核对结果。"}
        </p>
      )}
    </div>
  )
}

/** Fixture configuration is supporting Lab UI, not part of the issue toolbar. */
export function ScheduleFixtureControls({
  id,
  page,
  children,
  variant = "standard",
}: {
  id: string
  page: ScheduleIssuePage
  children?: ReactNode
  variant?: "standard" | "options"
}) {
  const { locale } = useI18n()
  const label = locale === "en" ? "Local fixture settings" : "本地场景设置"
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant={variant === "options" ? "ghost" : "outline"}
            size="icon"
            aria-label={label}
          />
        }
      >
        {variant === "options" ? (
          <Ellipsis aria-hidden="true" />
        ) : (
          <SlidersHorizontal aria-hidden="true" />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] p-4">
        <PopoverTitle className="mb-3 text-sm font-medium">
          {label}
        </PopoverTitle>
        <ScheduleOutcomeField id={id} page={page} disabled={page.blocked} />
        {children}
        {Object.values(page.domain.requests)
          .filter((request) => request?.createItem)
          .map(
            (request) =>
              request && (
                <div className="mt-3 grid gap-2 text-sm" key={request.itemId}>
                  <p>
                    {locale === "en"
                      ? "Unresolved local creation"
                      : "未核对的本地创建"}
                    : {request.createItem?.title}
                  </p>
                  <Button
                    size="sm"
                    disabled={page.blocked}
                    onClick={() => page.reconcileCreate(request.itemId)}
                  >
                    {locale === "en" ? "Check result" : "核对结果"}
                  </Button>
                </div>
              ),
          )}
      </PopoverContent>
    </Popover>
  )
}

export function ScheduleStatusFilter({
  catalog,
  value,
  onChange,
  variant = "icon",
}: {
  catalog: WorkItemCatalog
  value: readonly string[] | null
  onChange: (value: string[] | null) => void
  variant?: "icon" | "label"
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const label =
    variant === "icon"
      ? en
        ? "Filter issues"
        : "筛选任务"
      : en
        ? "Display statuses"
        : "显示状态"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size={variant === "icon" ? "icon" : "sm"}
            aria-label={label}
          />
        }
      >
        {variant === "icon" ? (
          <SlidersHorizontal aria-hidden="true" />
        ) : (
          <>
            <Circle aria-hidden="true" />
            {en ? "Status" : "状态"}
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
            {en ? "Visible statuses" : "显示状态"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {catalog.states.map((state) => (
            <DropdownMenuCheckboxItem
              key={state.id}
              checked={value === null || value.includes(state.id)}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                const current =
                  value ?? catalog.states.map((option) => option.id)
                onChange(
                  checked
                    ? [...new Set([...current, state.id])]
                    : current.filter((id) => id !== state.id),
                )
              }}
            >
              {state.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type AddIssueDraft = {
  title: string
  stateId: string
  priorityId: string
  assigneeId: string
  description?: string
  startDate?: string | null
  dueDate?: string | null
}

export function emptyAddIssueDraft(catalog: WorkItemCatalog): AddIssueDraft {
  return {
    title: "",
    description: "",
    startDate: null,
    stateId: catalog.states[1]?.id ?? catalog.states[0].id,
    priorityId: catalog.priorities[2]?.id ?? catalog.priorities[0].id,
    assigneeId: pmMembers[0].id,
  }
}

/** Shared local create overlay; reference field hierarchy, retained payload and explicit result checks. */
export function ScheduleAddIssueDialog({
  open,
  onOpenChange,
  page,
  draft,
  setDraft,
  presetDueDate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  page: ScheduleIssuePage
  draft: AddIssueDraft | null
  setDraft: (draft: AddIssueDraft | null) => void
  presetDueDate?: string | null
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [result, setResult] = usePmScenarioState<{
    status: "confirmed" | "rejected" | "unknown"
    error?: string
    requestId?: string
  } | null>(`${page.queryKey}:create-result`, () => null)
  const unknown = result?.status === "unknown"
  const blocked = page.blocked || unknown
  function close(next: boolean) {
    if (!next && unknown) return
    onOpenChange(next)
    if (!next) setResult(null)
  }
  function submit() {
    if (!draft || blocked) return
    const outcome = page.addIssue({
      title: draft.title,
      description: draft.description,
      stateId: draft.stateId,
      priorityId: draft.priorityId,
      assigneeIds: draft.assigneeId ? [draft.assigneeId] : [],
      startDate: draft.startDate ?? null,
      dueDate:
        draft.dueDate !== undefined ? draft.dueDate : (presetDueDate ?? null),
    })
    setResult(outcome)
    if (outcome.status === "confirmed") {
      onOpenChange(false)
      setDraft(null)
      setResult(null)
    }
  }
  function check() {
    if (!result?.requestId || page.blocked) return
    const status = page.reconcileCreate(result.requestId)
    if (status === "confirmed") {
      onOpenChange(false)
      setDraft(null)
      setResult(null)
    } else setResult({ status, requestId: result.requestId })
  }
  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent size={576} className={styles.createSheet}>
        <SheetHeader className={styles.createHeader}>
          <SheetTitle className="text-lg font-semibold">
            {en ? "Create issue" : "创建任务"}
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            {en
              ? "Capture issue details in this local fixture. No network service is called."
              : "在本地场景中录入任务详情，不调用网络服务。"}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className={styles.createBody}>
          {draft && (
            <div className="grid gap-6">
              <Field label={en ? "Issue title" : "任务标题"}>
                {(control) => (
                  <Input
                    {...control}
                    aria-label={en ? "Issue title" : "任务标题"}
                    placeholder={
                      en
                        ? "Summarize the work that needs to happen"
                        : "概括需要完成的工作"
                    }
                    value={draft.title}
                    disabled={blocked}
                    onChange={(event) =>
                      setDraft({ ...draft, title: event.target.value })
                    }
                  />
                )}
              </Field>
              <Field label={en ? "Description" : "描述"}>
                {(control) => (
                  <Textarea
                    {...control}
                    aria-label={en ? "Description" : "描述"}
                    placeholder={
                      en
                        ? "Issue context, expected behavior and handoff notes"
                        : "任务上下文、预期行为与交接说明"
                    }
                    rows={4}
                    value={draft.description ?? ""}
                    disabled={blocked}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                  />
                )}
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label={en ? "Status" : "状态"}>
                  {(control) => (
                    <WorkItemStatePicker
                      {...control}
                      label={en ? "Status" : "状态"}
                      value={draft.stateId}
                      options={page.catalog.states}
                      disabled={blocked}
                      onChange={(stateId) => setDraft({ ...draft, stateId })}
                    />
                  )}
                </Field>
                <Field label={en ? "Priority" : "优先级"}>
                  {(control) => (
                    <WorkItemPriorityPicker
                      {...control}
                      label={en ? "Priority" : "优先级"}
                      value={draft.priorityId}
                      options={page.catalog.priorities}
                      disabled={blocked}
                      onChange={(priorityId) => setDraft({ ...draft, priorityId })}
                    />
                  )}
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={en ? "Start date" : "开始日期"}>
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      aria-label={en ? "Start date" : "开始日期"}
                      value={draft.startDate ?? ""}
                      disabled={blocked}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          startDate: event.target.value || null,
                        })
                      }
                    />
                  )}
                </Field>
                <Field label={en ? "Target date" : "目标日期"}>
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      aria-label={en ? "Target date" : "目标日期"}
                      value={
                        draft.dueDate !== undefined
                          ? (draft.dueDate ?? "")
                          : (presetDueDate ?? "")
                      }
                      disabled={blocked}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          dueDate: event.target.value || null,
                        })
                      }
                    />
                  )}
                </Field>
              </div>
              <Field
                label={en ? "Assignee · local fixture" : "负责人 · 本地场景"}
              >
                {(control) => (
                  <WorkItemAssigneePicker
                    {...control}
                    multiple={false}
                    label={en ? "Assignee" : "负责人"}
                    value={draft.assigneeId}
                    options={[
                      { id: "", label: en ? "No owner" : "无负责人" },
                      ...page.catalog.assignees,
                    ]}
                    disabled={blocked}
                    onChange={(assigneeId) => setDraft({ ...draft, assigneeId })}
                  />
                )}
              </Field>
              {result?.status === "rejected" && (
                <p role="alert" className="text-sm text-destructive">
                  {result.error ??
                    (en
                      ? "Create rejected. Draft retained."
                      : "创建被拒绝，草稿保留。")}
                </p>
              )}
              {unknown && (
                <div className="grid gap-2">
                  <p role="status" className="text-sm">
                    {en
                      ? "Outcome unknown: no replay. Check the original local request explicitly."
                      : "结果未知，不重放请求。请显式核对原始本地请求。"}
                  </p>
                  {result.error && (
                    <p className="text-xs text-muted-foreground">
                      {result.error}
                    </p>
                  )}
                  <label className="grid gap-1 text-xs">
                    {en
                      ? "Simulated result-check outcome"
                      : "模拟结果检查返回值"}
                    <RadixSelect
                      aria-label={
                        en
                          ? "Simulated result-check outcome"
                          : "模拟结果检查返回值"
                      }
                      value={page.checkOutcome}
                      disabled={page.blocked}
                      className="h-8 w-full rounded-md border bg-surface px-3 text-sm"
                      onChange={(event) =>
                        page.setUi((previous) => ({
                          ...previous,
                          checkOutcome: event.target
                            .value as ScheduleCheckOutcome,
                        }))
                      }
                    >
                      <option value="confirmed">confirmed</option>
                      <option value="rejected">rejected</option>
                    </RadixSelect>
                  </label>
                  <Button size="sm" disabled={page.blocked} onClick={check}>
                    {en ? "Check result" : "核对结果"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetBody>
        <SheetFooter className={styles.createFooter}>
          <Button
            variant="ghost"
            disabled={unknown}
            onClick={() => close(false)}
          >
            {en ? "Cancel · keep draft" : "取消 · 保留草稿"}
          </Button>
          <Button disabled={blocked || !draft?.title.trim()} onClick={submit}>
            {en ? "Create issue" : "创建任务"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function dueDateBuckets(
  items: readonly WorkItemRecord[],
  dates: readonly string[],
  queryKey: string,
): DateBucketSnapshot[] {
  return dates.map((date) => {
    const ids = items
      .filter((item) => item.dueDate === date)
      .map((item) => item.id)
    return {
      date,
      queryKey,
      itemIds: ids,
      loadedCount: ids.length,
      totalCount: ids.length,
      hasMore: false,
      dataState: "success" as const,
    }
  })
}

export function unscheduledSnapshot(
  items: readonly WorkItemRecord[],
  queryKey: string,
  kind: "calendar" | "timeline",
): Omit<DateBucketSnapshot, "date"> {
  const ids = items
    .filter((item) =>
      kind === "calendar" ? !item.dueDate : !item.startDate && !item.dueDate,
    )
    .map((item) => item.id)
  return {
    queryKey,
    itemIds: ids,
    loadedCount: ids.length,
    totalCount: ids.length,
    hasMore: false,
    dataState: "success",
  }
}

export { scheduleDates }
export type { PmIssue, ScheduleDates, ScheduleViewport }

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody } from "@/components/ui/sheet"
import { WorkItemDateRangeField } from "@/components/blocks/work-item-date-range-field"
import { WorkItemProperties } from "@/components/blocks/work-item-properties"
import { MessageContent } from "@/components/blocks/message-content"
import { groupWorkItems } from "@/lib/work-items-view"
import { isMutationLocked } from "@/lib/work-items-model"
import type { MoveIntent, MutationState } from "@/lib/work-items-model"
import { calendarViewport, normalizeCalendar, normalizeTimeline } from "@/lib/schedule-view-model"
import { scheduleDates } from "@/lib/schedule-date-utils"
import { useI18n } from "@/lib/i18n-provider"
import { IssueCollectionView } from "./issue-collection"
import { BoardsDraftDetail } from "./boards-views"
import { boardStats } from "./boards-controller"
import { usePmScenarioState } from "./shared"
import { usePmControlsReady, usePmDomainState, usePmNavigation } from "./domain-session"
import { createProjectList1Fixtures } from "./project-list-1-fixtures"
import { issueRecord, moveIssueDomain, patchIssueDomain, type PmIssueDomain } from "./issue-domain"
import { createIssueListUi, issueCapabilities, issueListGroups, selectVisibleIssues, issueToday, scenarioWritable, type IssueListUi, type IssueDrilldown } from "./issues-controller"
import { IssueCreateDialog, IssueResultCheckDialog, IssueOutcomeSelect, IssueProjectNavigation, IssueCreatedNotice, IssueProjectScopeBar, IssueMissingReferenceNotice, IssueTitleField, IssueDescriptionField, IssueEditControls, IssueMutationStatus, useIssueEntityEditor } from "./issues-views"
import { dueDateBuckets, unscheduledSnapshot, useScheduleIssuePage } from "./schedule-views"
import { fixtureCatalogProjection, fixtureIssueProjection, useFixtureReadState } from "./fixture-projections"
import type { IssueCollectionInteraction, IssueCollectionViewProps, ControlledIssuePatch } from "./controlled-contracts"
import type { PmPageProps } from "./model"

const slugs = { list1: "issue-list-1", list2: "issue-list-2", board1: "issue-kanban-1", board2: "issue-kanban-2", board3: "issue-kanban-3", calendar1: "issue-calendar-1", gantt1: "issue-gantt-1", spreadsheet1: "issue-spreadsheet-1" } as const
const layoutSlugs: Record<IssueCollectionInteraction["view"]["layout"], string> = {
  list: "issue-list-1", board: "issue-kanban-1", table: "issue-spreadsheet-1",
  timeline: "issue-gantt-1", calendar: "issue-calendar-1",
}
/** Explicit fixture controller. Every layout still renders IssueCollectionView. */
export function FixtureIssueCollection({ scenario, variant }: PmPageProps & { variant: IssueCollectionViewProps["variant"] }) {
  const slug = slugs[variant]
  const page = useScheduleIssuePage(scenario, slug)
  const { locale } = useI18n()
  const en = locale === "en"
  const interactive = usePmControlsReady()
  const { entityId, navigate } = usePmNavigation()
  const [projects] = usePmDomainState("projects", () => createProjectList1Fixtures(scenario))
  const [ui, setUi] = usePmScenarioState<IssueListUi>("issue-collection-ui", () => createIssueListUi(variant === "list2"))
  const scheduled = variant === "calendar1" || variant === "gantt1" || variant === "spreadsheet1"
  const today = scheduled ? "2026-01-12" : issueToday
  const layout = variant.startsWith("board") ? "board" : variant === "calendar1" ? "calendar" : variant === "gantt1" ? "timeline" : variant === "spreadsheet1" ? "table" : "list"
  const [cachedInteraction, setInteraction] = usePmScenarioState<IssueCollectionInteraction>("issue-collection-interaction", () => ({ view: { ...ui.view, layout }, selectedIds: ui.selectedIds, activeItemId: ui.activeId, collapsedGroupIds: ui.collapsedGroupIds, calendar: normalizeCalendar({ anchorDate: today, selectedDate: today, mode: "month", timeZone: "UTC", weekStartsOn: 1, showWeekends: true }), timeline: normalizeTimeline({ anchorDate: today, scale: "week", timeZone: "UTC", weekStartsOn: 1 }), scroll: { top: 0, left: 0 }, tableSort: null, columnConfig: { widths: { title: 360, state: 140, priority: 140, assignees: 160, labels: 160, startDate: 180, dueDate: 180, projectId: 180, moduleIds: 180, cycleId: 180, estimatePointId: 140, request: 240 } } }))
  const interaction: IssueCollectionInteraction = { ...cachedInteraction, view: { ...cachedInteraction.view, layout } }
  const [readingPosition, setReadingPosition] = usePmScenarioState("reading-position", () => 0)
  const [drilldown, setDrilldown] = usePmDomainState<IssueDrilldown | null>("issue-list-1:drilldown", () => null)
  const [overdueOnly, setOverdueOnly] = usePmScenarioState("issue-collection-overdue-only", () => false)
  const pendingDrilldown = variant === "list1" ? drilldown : null
  const effectiveInteraction = pendingDrilldown ? { ...interaction, view: { ...interaction.view, query: pendingDrilldown.query, filters: { state: [...pendingDrilldown.stateIds], priority: [], assignees: [], labels: [] } } } : interaction
  const effectiveOverdue = pendingDrilldown?.overdue ?? overdueOnly
  useEffect(() => {
    if (!pendingDrilldown) return
    setInteraction(previous => ({ ...previous, view: { ...previous.view, query: pendingDrilldown.query, filters: { state: [...pendingDrilldown.stateIds], priority: [], assignees: [], labels: [] } } }))
    setOverdueOnly(pendingDrilldown.overdue)
    setDrilldown(null)
  }, [pendingDrilldown, setInteraction, setOverdueOnly, setDrilldown])
  const [expandedIds, setExpandedIds] = usePmScenarioState<string[]>("issue-collection-expanded", () => [])
  const [drafts, setDrafts] = usePmScenarioState<Record<string, { title: string; description: string; baseRevision: number } | undefined>>("issue-collection-drafts", () => ({}))
  const [lastMove, setLastMove] = usePmScenarioState<{ intent: MoveIntent; operationId: string; status: MutationState["status"]; error?: string } | null>("issue-collection-last-move", () => null)
  const origin = useRef<HTMLElement | null>(null)
  const writable = scenarioWritable(scenario)
  const data = useFixtureReadState(scenario, slug)
  const catalog = fixtureCatalogProjection(page.domain.items, projects, locale)
  const all = page.domain.items.map((item) => fixtureIssueProjection(item, locale))
  const scopedProject = entityId ? projects.find((project) => project.id === entityId) : undefined
  const missingProject = !!entityId && !scopedProject
  const scopedWritable = writable && !missingProject
  const scoped = entityId ? all.filter((item) => item.projectId === entityId) : all
  const selected = selectVisibleIssues(scoped, effectiveInteraction.view, catalog, locale)
  const filtered = effectiveOverdue ? selected.filter(item => !!item.dueDate && item.dueDate < today && item.stateId !== "done") : selected
  const stats = variant.startsWith("board") ? boardStats(filtered, locale) : null
  const availableCount = (value: number | null) => ({ value: scenario === "loading" ? null : value, description: en ? "Current filtered fixture cohort" : "当前筛选后的 fixture 集合" })
  const excludedStateIds = variant.startsWith("board") && effectiveInteraction.excludedStateIds?.length ? new Set(effectiveInteraction.excludedStateIds) : null
  const visibleRecords = excludedStateIds ? filtered.filter(item => !excludedStateIds.has(item.stateId)) : filtered
  const visibleIds = new Set(visibleRecords.map((item) => item.id))
  const byId = new Map(scoped.map((item) => [item.id, item]))
  let visible = visibleRecords.map((item) => byId.get(item.id)!)
  if (interaction.tableSort) {
    const sort = interaction.tableSort
    visible = [...visible].sort((left, right) => { const a = sort.columnId === "dueDate" ? left.dueDate ?? "9999" : left.title; const b = sort.columnId === "dueDate" ? right.dueDate ?? "9999" : right.title; return a.localeCompare(b, locale) * (sort.direction === "asc" ? 1 : -1) })
  }
  const queryKey = page.queryKey
  const groups = variant.startsWith("board") ? groupWorkItems(visible, catalog, effectiveInteraction.view, queryKey) : issueListGroups(visible, catalog, effectiveInteraction.view, queryKey)
  const activeId = interaction.activeItemId ?? (interaction.selectedIds.length === 1 ? interaction.selectedIds[0] : null)
  const active = activeId ? all.find((item) => item.id === activeId) : undefined
  const activeDraft = active ? drafts[active.id] ?? { title: active.title, description: active.description ?? "", baseRevision: active.revision } : null
  const capabilities = { ...issueCapabilities(scopedWritable, missingProject ? en ? "Resolve the project reference before editing." : "请先恢复有效项目范围，再进行修改。" : en ? "Read-only or loading scene." : "只读或加载中的场景。"), canEditRelation: () => false }
  const scheduleEditor = useIssueEntityEditor({
    item: scheduled && active ? issueRecord(page.domain.items.find((item) => item.id === active.id)!, locale) : null,
    domain: page.domain, setDomain: page.setDomain, outcome: ui.outcome, writable: scopedWritable,
    onClosed: () => setInteraction((previous) => ({ ...previous, activeItemId: null, selectedIds: [] })),
  })
  const patch = (item: typeof all[number], change: ControlledIssuePatch) => {
    if (!scopedWritable || isMutationLocked(page.domain.mutations[item.id])) return
    const { moduleIds: _modules, estimatePointId: _estimate, projectId: _project, parentId: _parent, cycleId: _cycle, ...base } = change
    const draftSave = base.title !== undefined || base.description !== undefined
    const next = patchIssueDomain(page.domain, item.id, base, ui.outcome, draftSave ? drafts[item.id]?.baseRevision ?? item.revision : item.revision)
    page.setDomain(next)
    const fresh = next.items.find((entry) => entry.id === item.id)
    if (next.mutations[item.id]?.status === "confirmed" && fresh) setDrafts((previous) => {
      const retained = previous[item.id]
      if (!retained) return previous
      const updated = { title: base.title !== undefined ? fresh.title : retained.title, description: base.description !== undefined ? fresh.description ?? "" : retained.description, baseRevision: fresh.revision }
      const current = { ...previous }
      if (updated.title === fresh.title && updated.description === (fresh.description ?? "")) delete current[item.id]
      else current[item.id] = updated
      return current
    })
  }
  const updateDomain: Dispatch<SetStateAction<PmIssueDomain>> = (action) => page.setDomain((previous) => {
    const next = typeof action === "function" ? action(previous) : action
    for (const [itemId, request] of Object.entries(previous.requests)) {
      if (!request || next.requests[itemId] || next.mutations[itemId]?.status !== "confirmed" || next.mutations[itemId]?.operationId !== request.operationId || (request.patch.title === undefined && request.patch.description === undefined)) continue
      const fresh = next.items.find((item) => item.id === itemId)
      if (!fresh) continue
      setDrafts((retained) => {
        const draft = retained[itemId]
        if (!draft) return retained
        const updated = { title: request.patch.title !== undefined ? fresh.title : draft.title, description: request.patch.description !== undefined ? fresh.description ?? "" : draft.description, baseRevision: fresh.revision }
        const current = { ...retained }
        if (updated.title === fresh.title && updated.description === (fresh.description ?? "")) delete current[itemId]
        else current[itemId] = updated
        return current
      })
    }
    if (lastMove) {
      const mutation = next.mutations[lastMove.intent.itemId]
      if (mutation?.operationId === lastMove.operationId) setLastMove((current) => current ? { ...current, status: mutation.status, error: mutation.error } : current)
    }
    return next
  })
  const hiddenCreated = !!ui.lastCreatedId && !visibleIds.has(ui.lastCreatedId) && all.some((item) => item.id === ui.lastCreatedId)
  const inspector = variant.startsWith("board") && ((active && activeDraft) || lastMove) ? <>
    {active && activeDraft && <BoardsDraftDetail item={active} draft={activeDraft} hasDraft={!!drafts[active.id]} catalog={catalog} capabilities={capabilities} mutation={page.domain.mutations[active.id]} editable={writable} today={today} discardLabel={en ? "Discard local draft" : "放弃本地草稿"} onEdit={(field, value) => setDrafts((previous) => ({ ...previous, [active.id]: { ...activeDraft, [field]: value } }))} onSave={(field) => patch(active, { [field]: activeDraft[field] })} onDiscard={() => setDrafts((previous) => { const next = { ...previous }; delete next[active.id]; return next })} onPatch={(record, change) => { const item = all.find((candidate) => candidate.id === record.id); if (item) patch(item, change) }} onReconcile={() => setUi((previous) => ({ ...previous, resultCheckId: active.id }))} />}
    {lastMove && <section data-boards-move-panel><h2 className="text-sm font-medium">{en ? "Local operation result" : "本地操作结果"}</h2><dl data-boards-last-intent className="grid gap-2 text-xs">{Object.entries(lastMove.intent).map(([field, value]) => <div key={field}><dt>{field}</dt><dd data-pm-move-field={field}>{String(value)}</dd></div>)}</dl><p data-boards-last-status data-status={lastMove.status}>{lastMove.status}</p>{lastMove.error && <p role="alert" className="text-xs text-destructive">{lastMove.error}</p>}</section>}
  </> : undefined
  const updateInteraction: Dispatch<SetStateAction<IssueCollectionInteraction>> = (action) => {
    const next = typeof action === "function" ? action(effectiveInteraction) : action
    setInteraction(next)
    setUi((current) => ({ ...current, view: next.view, selectedIds: [...next.selectedIds], activeId: next.activeItemId, collapsedGroupIds: [...next.collapsedGroupIds] }))
    if (next.view.layout !== layout) navigate(layoutSlugs[next.view.layout], entityId ?? undefined)
  }
  return <IssueCollectionView variant={variant} interactive={interactive} pageId={`pm-${slug}`} readingPosition={readingPosition} onReadingPositionChange={setReadingPosition} titleSuffix={<IssueProjectNavigation />} toolbarExtension={<>{effectiveOverdue && <Button variant="ghost" onClick={() => setOverdueOnly(false)}>{en ? "Clear overdue filter" : "清除逾期筛选"}</Button>}<IssueOutcomeSelect value={ui.outcome} label={en ? "Write outcome" : "写入结果"} disabled={!scopedWritable} onChange={(outcome) => { setUi((previous) => ({ ...previous, outcome })); page.setUi((previous) => ({ ...previous, outcome })) }} /></>} readModel={{ title: scopedProject ? scopedProject.title[locale] : en ? "Workspace issues" : "工作区问题", description: en ? "Local fixture · retained filters, selection and drafts; no backend connected." : "本地 fixture · 筛选、选择与草稿保留，未连接后端服务。", items: missingProject || scenario === "loading" ? [] : visible, catalog, groups, queryKey, announcement: lastMove ? lastMove.status === "confirmed" ? `${en ? "Moved" : "已将"} ${lastMove.intent.itemId} → ${lastMove.intent.targetGroup}` : lastMove.status === "rejected" ? `${en ? "Move rejected" : "移动被拒绝"}: ${lastMove.error ?? lastMove.intent.itemId}` : lastMove.status === "unknown" ? (en ? "Move outcome unknown; check the original request." : "移动结果未知；请核对原请求。") : lastMove.status : undefined, data: { ...data, state: data.state === "success" && visible.length === 0 && !variant.startsWith("board") ? "empty" : data.state }, today, mutations: page.domain.mutations, dateDrafts: page.ui.proposedDates, buckets: dueDateBuckets(visible, scheduleDates(calendarViewport(interaction.calendar).rangeStart, calendarViewport(interaction.calendar).rangeEnd), queryKey), unscheduled: unscheduledSnapshot(visible, queryKey, "calendar"), cohort: stats ? { open: availableCount(stats.open), active: availableCount(stats.active), attention: availableCount(stats.attention), completion: availableCount(stats.completion) } : undefined, stateDistribution: variant === "board3" && stats ? stats.statuses.map(state => ({ stateId: state.key, label: state.label, color: state.color, count: availableCount(state.count) })) : undefined, counts: { total: { value: visible.length, description: en ? "Current fixture filter" : "当前 fixture 筛选" }, completed: { value: visible.filter((item) => item.stateId === "done").length, description: en ? "Current fixture filter" : "当前 fixture 筛选" }, overdue: { value: visible.filter((item) => !!item.dueDate && item.dueDate < today && item.stateId !== "done").length, description: en ? "Fixture reference date" : "fixture 参考日期" }, assigned: { value: visible.filter((item) => item.assigneeIds.length > 0).length, description: en ? "Current fixture filter" : "当前 fixture 筛选" } } }} interaction={effectiveInteraction} capabilities={capabilities} actions={{ setInteraction: updateInteraction, create: (defaults, trigger) => { if (!scopedWritable) return; origin.current = trigger; setUi((previous) => ({ ...previous, createOpen: true, createDraft: { ...previous.createDraft, stateId: defaults.groupKey ?? previous.createDraft.stateId, projectId: scopedProject?.id ?? previous.createDraft.projectId, dueDate: defaults.date ?? previous.createDraft.dueDate } })) }, open: (item) => { if (variant.startsWith("board") || scheduled) { setInteraction((previous) => ({ ...previous, activeItemId: item.id })); if (variant.startsWith("board")) setDrafts((previous) => previous[item.id] ? previous : { ...previous, [item.id]: { title: item.title, description: item.description ?? "", baseRevision: item.revision } }) } else navigate(variant === "list2" ? "issue-detail-2" : "issue-detail-1", item.id) }, patch, move: (intent) => { const item = all.find((entry) => entry.id === intent.itemId); if (!item || !scopedWritable || isMutationLocked(page.domain.mutations[item.id])) return; const request = { ...intent, operationId: `board-${page.domain.sequence + 1}`, baseRevision: intent.baseRevision ?? item.revision }; const next = moveIssueDomain(page.domain, request, ui.outcome); page.setDomain(next); const mutation = next.mutations[item.id]; if (mutation) setLastMove({ intent: request, operationId: mutation.operationId, status: mutation.status, error: mutation.error }) }, schedule: page.submitScheduleIntent, dateDraftChange: page.captureDraft, reconcile: (itemId) => setUi((previous) => ({ ...previous, resultCheckId: itemId })) }} hierarchy={variant === "list1" ? { expandedIds, onExpandedChange: setExpandedIds } : undefined} inspector={inspector} feedback={<>{missingProject && entityId ? <IssueMissingReferenceNotice referenceId={entityId} onShowAll={() => navigate(slug)} /> : scopedProject && <IssueProjectScopeBar label={scopedProject.title[locale]} projectId={scopedProject.id} onShowAll={() => navigate(slug)} />}{hiddenCreated && ui.lastCreatedId && <IssueCreatedNotice createdId={ui.lastCreatedId} onDismiss={() => setUi((previous) => ({ ...previous, lastCreatedId: null }))} onClearFilters={() => setInteraction((previous) => ({ ...previous, view: { ...previous.view, query: "", filters: { state: [], priority: [], assignees: [], labels: [] } } }))} />}</>} createDialog={<>
      <IssueCreateDialog lockPendingDismissal={scheduled} open={ui.createOpen} onOpenChange={(createOpen) => setUi((previous) => ({ ...previous, createOpen }))} ui={ui} setUi={setUi} domain={page.domain} setDomain={page.setDomain} catalog={catalog} projects={projects} writable={scopedWritable} finalFocus={() => origin.current?.isConnected ? origin.current : null} />
      <IssueResultCheckDialog open={!!ui.resultCheckId} onOpenChange={(open) => { if (!open) setUi((previous) => ({ ...previous, resultCheckId: null })) }} itemId={ui.resultCheckId} domain={page.domain} setDomain={updateDomain} writable={scopedWritable} />
      {scheduled && <Sheet open={!!active} onOpenChange={(open) => { if (!open) scheduleEditor.cancel() }}>
        <SheetContent size={576}>
          <SheetHeader>
            <SheetTitle>{active?.identifier} · {active?.title}</SheetTitle>
            <SheetDescription>{en ? "Schedule and inspect this shared fixture issue." : "排期并查看共享 fixture 任务。"}</SheetDescription>
          </SheetHeader>
          <SheetBody>{active && <>
            <IssueEditControls editing={scheduleEditor.editing} dirty={scheduleEditor.dirty} disabled={!writable || scheduleEditor.locked} onEdit={scheduleEditor.open} onApply={scheduleEditor.apply} onCancel={scheduleEditor.cancel} onDiscard={scheduleEditor.discard} />
            {scheduleEditor.editing && scheduleEditor.draft ? <>
              <IssueTitleField draft={scheduleEditor.draft} editing onPatch={scheduleEditor.patch} disabled={!writable || scheduleEditor.locked} error={scheduleEditor.mutation?.fieldErrors?.title} />
              <IssueDescriptionField draft={scheduleEditor.draft} editing onPatch={scheduleEditor.patch} disabled={!writable || scheduleEditor.locked} error={scheduleEditor.mutation?.fieldErrors?.description} />
            </> : <MessageContent content={active.description ?? ""} />}
            <IssueMutationStatus mutation={scheduleEditor.mutation} disabled={!writable} onConfirm={() => scheduleEditor.reconcile("confirmed")} onReject={() => scheduleEditor.reconcile("rejected")} />
            <WorkItemProperties item={active} catalog={catalog} capabilities={capabilities} mutation={page.domain.mutations[active.id]} visibleProperties={["state", "priority", "assignees", "labels"]} onPatchItem={(_record, change) => patch(active, change)} />
            <WorkItemDateRangeField item={active} queryKey={queryKey} capabilities={capabilities} mutation={page.domain.mutations[active.id]} proposedDates={page.ui.proposedDates[active.id]} onDraftChange={(dates) => page.captureDraft(active, dates)} onChange={page.submitScheduleIntent} />
            <Button variant="ghost" onClick={() => navigate("issue-detail-1", active.id)}>{en ? "Open full detail" : "打开完整详情"}</Button>
          </>}</SheetBody>
        </SheetContent>
      </Sheet>}
    </>} />
}

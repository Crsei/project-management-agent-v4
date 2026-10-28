"use client"

import { useLayoutEffect, useRef, useState, type PointerEvent } from "react"
import { ArrowDownToLine, Braces, CalendarDays, Check, Columns3, Layers, ListFilter, Maximize2, Minimize2, Monitor, Moon, RefreshCw, Search, Sun, X } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@easyuse-ui/ui/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@easyuse-ui/ui/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@easyuse-ui/ui/components/ui/table"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@easyuse-ui/ui/components/ui/accordion"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { ExecutionTraceTree } from "@easyuse-ui/ui/components/blocks/execution-trace-tree"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import { createTraceState, exportTrace, refreshTraces, resizeInspector, selectSpan, selectTrace, toggleColumn, toggleRealtime, traceContext, updateContext, visibleSpans, visibleTraces, type StatusFilter, type TraceColumn } from "./controller"
import { traceHistory, type Copy } from "./fixtures"
import styles from "./trace-explorer.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => locale === "en" ? en : zh
  const copy = (value: Copy) => value[locale]
  const [state, setState] = useRemainingPageState(`agent-traces:${scenario}`, () => createTraceState(scenario))
  const [filterOpen, setFilterOpen] = useState(false)
  const [downloadError, setDownloadError] = useState(false)
  const screen = useRef<HTMLDivElement>(null)
  const table = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const traceSearch = useRef<HTMLInputElement>(null)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  const records = visibleTraces(state)
  const record = state.records.find(item => item.id === state.selectedId)
  const context = traceContext(state)
  const spans = record ? visibleSpans(record, context.query) : []
  const timelineSpans = spans.filter(span => span.timeline)
  const columns: { id: TraceColumn; name: string; width: string }[] = [
    { id: "id", name: label("运行 ID", "Run ID"), width: "12%" },
    { id: "task", name: label("任务", "Task"), width: "20%" },
    { id: "request", name: label("请求", "Request"), width: "28%" },
    { id: "outcome", name: label("结果", "Outcome"), width: "28%" },
    { id: "started", name: label("开始时间", "Started"), width: "12%" },
  ]
  const filterOptions: { id: StatusFilter; name: string }[] = [
    { id: "all", name: label("全部状态", "All statuses") },
    { id: "success", name: label("成功", "Success") },
    { id: "errors", name: label("错误", "Errors") },
  ]
  const key = `agent-traces:${scenario}`
  const readingKey = `${key}:${state.selectedId}:${context.presentation}:scroll`
  const loading = state.dataState === "loading"
  const history = state.range === "today" ? traceHistory.slice(-4) : traceHistory
  const total = history.reduce((count, bar) => count + bar.success + bar.error, 0)

  useLayoutEffect(() => {
    if (!active) return
    if (table.current) table.current.scrollTop = Number(cache.get(`${key}:table-scroll`) ?? 0)
    if (transcript.current) transcript.current.scrollTop = Number(cache.get(readingKey) ?? 0)
    if (timeline.current) timeline.current.scrollTop = Number(cache.get(`${key}:${state.selectedId}:timeline-scroll`) ?? 0)
  }, [active, cache, key, readingKey, state.selectedId, state.inspectorOpen, locale, host.resolvedTheme])

  useLayoutEffect(() => {
    const region = screen.current
    const handle = region?.querySelector<HTMLElement>('[role="separator"]')
    if (!active || !region || !handle) return
    const updateMaximum = () => handle.setAttribute("aria-valuemax", String(Math.max(280, region.clientWidth - 320)))
    updateMaximum()
    const observer = new ResizeObserver(updateMaximum)
    observer.observe(region)
    return () => observer.disconnect()
  }, [active, state.inspectorOpen, state.maximized])

  function closeInspector() {
    setState(previous => ({ ...previous, inspectorOpen: false, maximized: false }))
    requestAnimationFrame(() => {
      const rowButton = table.current?.querySelector<HTMLButtonElement>(`button[data-run-id="${state.selectedId}"]`)
      if (rowButton && rowButton.getBoundingClientRect().height) rowButton.focus({ preventScroll: true })
      else search.current?.focus({ preventScroll: true })
    })
  }
  function inspectSpan(id: string) {
    setState(previous => selectSpan(previous, id))
    if (context.presentation === "transcript") requestAnimationFrame(() => {
      const target = transcript.current?.querySelector<HTMLElement>(`[data-span-id="${id}"]`)
      if (target && transcript.current) {
        const position = target.getBoundingClientRect().top - transcript.current.getBoundingClientRect().top + transcript.current.scrollTop
        transcript.current.scrollTop = position
      }
    })
  }
  function resizeMove(event: PointerEvent<HTMLDivElement>) {
    if (!resizeStart.current || !screen.current) return
    setState(previous => resizeInspector(previous, resizeStart.current!.width + resizeStart.current!.x - event.clientX, screen.current!.clientWidth))
  }
  function download() {
    if (!record) return
    try {
      const url = URL.createObjectURL(new Blob([exportTrace(record, locale)], { type: "application/json" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${record.id}.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setDownloadError(false)
    } catch {
      setDownloadError(true)
    }
  }

  return (
    <section className={styles.page} data-agent-traces data-locale={locale} aria-busy={loading || undefined}><header className={styles.pageHeader}>
      <span>{label("Agent 执行追踪", "Agent traces")}</span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label={label("切换主题", "Toggle theme")} />}>
          {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => host.setTheme("light")}><Sun />{label("浅色", "Light")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => host.setTheme("dark")}><Moon />{label("深色", "Dark")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => host.setTheme("system")}><Monitor />{label("跟随系统", "System")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
    <div ref={screen} className={styles.screen} data-maximized={state.maximized} onKeyDown={event => {
      if (active && !event.defaultPrevented && event.key === "Escape" && !filterOpen && state.inspectorOpen && !(event.target as HTMLElement).closest('[role="dialog"], [role="listbox"], [role="menu"]')) {
        event.preventDefault()
        closeInspector()
      }
    }}>
      <section className={styles.explorer} aria-label={label("执行追踪浏览器", "Trace explorer")}>
        <div className={styles.explorerHeader}><h1>{label("执行记录", "Executions")}</h1><span>{label("客户运营", "Customer operations")}</span></div>
        <div className={styles.controls}>
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger render={<Button variant="outline" />}><ListFilter />{label("添加筛选", "Add filter")}</PopoverTrigger>
            <PopoverContent className={styles.filterPopup}>
              <PopoverTitle>{label("执行状态", "Execution status")}</PopoverTitle>
              {filterOptions.map(option => <Button key={option.id} variant="ghost" onClick={() => { setState(previous => ({ ...previous, filter: option.id })); setFilterOpen(false) }} aria-pressed={state.filter === option.id}>{option.name}{state.filter === option.id && <Check />}</Button>)}
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" />}><Columns3 />{label("列", "Columns")}</PopoverTrigger>
            <PopoverContent className={styles.filterPopup}>
              <PopoverTitle>{label("显示列", "Visible columns")}</PopoverTitle>
              {columns.map(column => <label className={styles.columnOption} key={column.id}><Checkbox checked={state.columns.includes(column.id)} disabled={column.id === "task"} onCheckedChange={() => setState(previous => toggleColumn(previous, column.id))} />{column.name}</label>)}
            </PopoverContent>
          </Popover>
          <Select value={state.filter} onValueChange={value => { if (value) setState(previous => ({ ...previous, filter: value as StatusFilter })) }}>
            <SelectTrigger className={styles.savedView} aria-label={label("保存的视图", "Saved view")}><SelectValue>{state.filter === "all" ? label("默认视图", "Default view") : state.filter === "errors" ? label("失败的执行", "Failed executions") : label("成功的执行", "Successful executions")}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{label("默认视图", "Default view")}</SelectItem>
              <SelectItem value="errors">{label("失败的执行", "Failed executions")}</SelectItem>
              <SelectItem value="success">{label("成功的执行", "Successful executions")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={state.range} onValueChange={value => { if (value) setState(previous => ({ ...previous, range: value as "14-days" | "today" })) }}>
            <SelectTrigger className={styles.timeRange} aria-label={label("时间范围", "Time range")}><CalendarDays /><SelectValue>{state.range === "today" ? label("今天", "Today") : label("14 天", "14 days")}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="14-days">{label("14 天", "14 days")}</SelectItem><SelectItem value="today">{label("今天", "Today")}</SelectItem></SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setState(refreshTraces)}><RefreshCw />{loading ? label("读取示例", "Load sample") : label("刷新", "Refresh")}</Button>
          <Button variant="outline" aria-pressed={state.realtime} disabled={state.readonly || loading} title={state.readonly ? label("只读场景不允许开启自动读取", "Automatic reads are unavailable in the read-only scenario") : undefined} onClick={() => setState(toggleRealtime)}><span className={styles.switchTrack} data-on={state.realtime}><span /></span>{label("实时", "Realtime")}</Button>
        </div>
        {(state.dataState === "refresh-error" || state.readonly || state.realtime || state.readRevision > 0) && <div className={styles.notice} role={state.dataState === "refresh-error" ? "alert" : "status"}>{state.dataState === "refresh-error" ? label("刷新失败，保留最后已知执行记录。点击刷新重新读取本地示例。", "Refresh failed; last-known executions are retained. Refresh to read the local sample again.") : state.readonly ? label("只读执行记录：可筛选、查看和导出，不能开启实时模式。", "Read-only traces: filter, inspect and export; realtime mode is unavailable.") : state.realtime ? label("实时视图已开启（本地 fixture，不连接运行服务）。", "Realtime view enabled (local fixture; no runtime connection).") : label(`已重新读取本地快照 · ${state.readRevision}`, `Local snapshot read · ${state.readRevision}`)}</div>}
        <div className={styles.search}>
          <Search aria-hidden="true" />
          <Input ref={search} aria-label={label("搜索执行记录", "Search traces")} placeholder={label("搜索任务、Agent 或运行 ID…", "Search tasks, agents, or run IDs…")} value={state.query} onChange={event => setState(previous => ({ ...previous, query: event.target.value }))} />
          {state.query && <Button variant="ghost" size="icon-sm" aria-label={label("清除搜索", "Clear search")} onClick={() => { setState(previous => ({ ...previous, query: "" })); search.current?.focus() }}><X /></Button>}
        </div>
        <section className={styles.chart} aria-label={label("执行历史统计", "Execution history")}> 
          <div className={styles.plot}>
            <div className={styles.axis} aria-hidden="true">{[20,15,10,5,0].map(value => <span key={value}>{value}</span>)}</div>
            {history.map(bar => <Button key={bar.id} variant="ghost" className={styles.bar} style={{ height: `${state.records.length ? (bar.success + bar.error) / 20 * 100 : 0}%` }} title={label(`${bar.success} 次成功，${bar.error} 次错误`, `${bar.success} successes, ${bar.error} errors`)} aria-label={label(`按${bar.error ? "错误" : "成功"}状态筛选。${bar.success} 次成功，${bar.error} 次错误`, `Filter by ${bar.error ? "error" : "success"} status. ${bar.success} successes, ${bar.error} errors`)} disabled={!state.records.length} onClick={() => setState(previous => ({ ...previous, filter: bar.error ? "errors" : "success" }))}><span className={styles.successBar} style={{ flex: bar.success }} /><span className={styles.errorBar} style={{ flex: bar.error }} /></Button>)}
          </div>
          <div className={styles.dates}>{(state.range === "today" ? ["Sep 18"] : ["Sep 06","Sep 07","Sep 09","Sep 11","Sep 13","Sep 15","Sep 18"]).map(date => <span key={date}>{locale === "en" ? date : date.replace("Sep ", "9 月 ")}</span>)}</div>
          <div className={styles.legend}><span>{label(`总计：${state.records.length ? total : 0}`, `Total: ${state.records.length ? total : 0}`)}</span><span><i className={styles.successDot} />{label("成功", "success")}</span><span><i className={styles.errorDot} />{label("错误", "error")}</span></div>
        </section>
        <TableContainer ref={table} className={styles.tableWrap} aria-label={label("执行列表", "Execution list")} onScroll={event => { if (active) cache.set(`${key}:table-scroll`, event.currentTarget.scrollTop) }}>
          <DataRegion state={loading ? "loading" : records.length ? "success" : "empty"} hasContent={records.length > 0} rowHeight={46} emptyTitle={label("没有匹配的执行记录", "No matching executions")} emptyDescription={state.records.length ? label("调整时间范围或清除筛选查看执行记录。", "Adjust the time range or clear filters to see executions.") : label("本地场景尚未读取执行记录。", "No execution records have been read in this local scenario.")} emptyAction={<Button variant="outline" onClick={() => state.records.length ? setState(previous => ({ ...previous, query: "", filter: "all", range: "14-days" })) : setState(refreshTraces)}>{state.records.length ? label("清除筛选", "Clear filters") : label("读取本地示例", "Load local sample")}</Button>}>
            <Table className={styles.table}>
              <colgroup><col style={{ width: 20 }} />{columns.filter(column => state.columns.includes(column.id)).map(column => <col key={column.id} style={{ width: column.width }} />)}</colgroup>
              <TableHeader><TableRow><TableHead><span className="sr-only">{label("状态", "Status")}</span></TableHead>{columns.filter(column => state.columns.includes(column.id)).map(column => <TableHead key={column.id}>{column.name}</TableHead>)}</TableRow></TableHeader>
              <TableBody>{records.map(item => <TableRow key={item.id} data-selected={item.id === state.selectedId}>
                <TableCell><span className={styles.statusBar} data-state={item.status}><span className="sr-only"><RuntimeStatusBadge status={item.status} /></span></span></TableCell>
                {state.columns.includes("id") && <TableCell><code title={item.id}>{item.id}</code></TableCell>}
                <TableCell><Button className={styles.taskButton} variant="ghost" data-run-id={item.id} title={copy(item.task)} aria-pressed={item.id === state.selectedId && state.inspectorOpen} onClick={() => setState(previous => selectTrace(previous, item.id))}><span className={styles.typeIcon}><Braces /></span><span>{copy(item.task)}</span></Button></TableCell>
                {state.columns.includes("request") && <TableCell><code title={copy(item.request)}>“{copy(item.request)}”</code></TableCell>}
                {state.columns.includes("outcome") && <TableCell><code title={copy(item.outcome)}>{copy(item.outcome)}</code></TableCell>}
                {state.columns.includes("started") && <TableCell>{locale === "en" ? `Sep ${item.day}, ${item.time}` : `9 月 ${item.day} 日 ${item.time}`}</TableCell>}
              </TableRow>)}</TableBody>
            </Table>
          </DataRegion>
        </TableContainer>
        <footer className={styles.footer}><span>{label(`已加载 ${records.length} 条记录`, `${records.length} traces loaded`)}</span><span>{label("本地示例 · 项目活动抽样", "Local fixture · sampled project activity")}</span></footer>
      </section>
      {state.inspectorOpen && record && <aside className={styles.inspector} style={{ width: state.maximized ? "100%" : state.inspectorWidth }} aria-label={label("执行详情检查器", "Trace inspector")}>
        {!state.maximized && <div className={styles.resize} role="separator" aria-label={label("调整详情宽度", "Resize trace inspector")} aria-orientation="vertical" tabIndex={0} aria-valuemin={280} aria-valuenow={state.inspectorWidth} onPointerDown={event => { resizeStart.current = { x: event.clientX, width: state.inspectorWidth }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={resizeMove} onPointerUp={event => { resizeStart.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { resizeStart.current = null }} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !screen.current) return
          event.preventDefault()
          const width = event.key === "Home" ? 280 : event.key === "End" ? screen.current.clientWidth - 320 : state.inspectorWidth + (event.key === "ArrowLeft" ? 16 : -16)
          setState(previous => resizeInspector(previous, width, screen.current!.clientWidth))
        }} />}
        <div className={styles.inspectorHeader}><span><Layers />{label("执行详情", "Execution details")}</span><Button size="icon-sm" variant="ghost" aria-label={state.maximized ? label("收起详情", "Collapse inspector") : label("展开详情", "Expand inspector")} aria-pressed={state.maximized} onClick={() => setState(previous => ({ ...previous, maximized: !previous.maximized }))}>{state.maximized ? <Minimize2 /> : <Maximize2 />}</Button><Button size="icon-sm" variant="ghost" aria-label={label("导出执行记录", "Export trace")} onClick={download}><ArrowDownToLine /></Button><Button size="icon-sm" variant="ghost" aria-label={label("关闭详情", "Close inspector")} onClick={closeInspector}><X /></Button></div>
        <div className={styles.runSummary}><h2>{copy(record.task)}</h2><div className={styles.runIdentity}><span>{copy(record.agent)}</span><span aria-hidden="true">·</span><code>{record.id}</code></div><div className={styles.runMetadata}><RuntimeStatusBadge status={record.status} /><span>{label("开始于", "Started")} {locale === "en" ? `Sep ${record.day}, ${record.time}` : `9 月 ${record.day} 日 ${record.time}`}</span></div></div>
        {downloadError && <p className={styles.notice} role="alert">{label("浏览器未能生成下载文件，请再次尝试。", "The browser could not create the download. Try again.")}</p>}
        <div className={`${styles.search} ${styles.traceSearch}`}><Search aria-hidden="true" /><Input ref={traceSearch} aria-label={label("搜索执行步骤", "Search within trace")} placeholder={label("搜索步骤和消息…", "Search steps and messages…")} value={context.query} onChange={event => setState(previous => updateContext(previous, { query: event.target.value }))} />{context.query && <Button size="icon-sm" variant="ghost" aria-label={label("清除步骤搜索", "Clear trace search")} onClick={() => { setState(previous => updateContext(previous, { query: "" })); traceSearch.current?.focus() }}><X /></Button>}</div>
        <section className={styles.timeline} aria-label={label("执行时间线", "Execution timeline")}>
          <div className={styles.timelineHeader}><h3>{label("执行时间线", "Execution timeline")}</h3><span>{label(`${record.spans.filter(span => span.timeline).length - 1} 个步骤 · 已用 ${record.elapsed} 秒`, `${record.spans.filter(span => span.timeline).length - 1} steps · ${record.elapsed}s elapsed`)}</span></div>
          <div className={styles.timelineColumns}><span>{label("步骤", "Step")}</span><div><span>0s</span><span>{record.elapsed / 2}s</span><span>{record.elapsed}s</span></div><span>{label("状态", "State")}</span></div>
          <div ref={timeline} className={styles.timelineRows} onScroll={event => { if (active) cache.set(`${key}:${record.id}:timeline-scroll`, event.currentTarget.scrollTop) }}>
            {timelineSpans.map(span => <Button key={span.id} variant="ghost" className={styles.timelineRow} aria-label={`${label("查看步骤", "Inspect span")} ${copy(span.name)} ${span.id}`} aria-pressed={context.selectedSpan === span.id} onClick={() => inspectSpan(span.id)}><span className={styles.timelineName} title={copy(span.name)}>{copy(span.name)}</span><span className={styles.timelineLane}>{span.duration ? <span className={styles.timelineBar} data-state={span.status} style={{ left: `${span.start / record.elapsed * 100}%`, width: `${span.duration / record.elapsed * 100}%` }} /> : <span className={styles.pendingTrack} />}</span><span className={styles.timelineResult}>{span.status === "completed" ? `${span.duration.toFixed(1)}s` : span.status === "running" ? label("执行中", "Running") : span.status === "waiting" ? label("受阻", "Blocked") : span.status === "failed" ? label("失败", "Failed") : span.status === "paused" ? label("审核", "Review") : label("等待", "Waiting")}</span></Button>)}
            {!timelineSpans.length && <p className={styles.noSpans}>{label("没有匹配的步骤", "No matching steps")}</p>}
          </div>
        </section>
        <div className={styles.transcriptToolbar}><Select value={context.presentation} onValueChange={value => { if (value) setState(previous => updateContext(previous, { presentation: value as "transcript" | "tree" })) }}><SelectTrigger aria-label={label("追踪展示方式", "Trace presentation")}><SelectValue>{context.presentation === "tree" ? label("步骤树", "Span tree") : label("执行记录", "Transcript")}</SelectValue></SelectTrigger><SelectContent><SelectItem value="transcript">{label("执行记录", "Transcript")}</SelectItem><SelectItem value="tree">{label("步骤树", "Span tree")}</SelectItem></SelectContent></Select><span>{record.elapsed.toFixed(2)}s</span><span>{(record.tokens / 1000).toFixed(1)}K {label("令牌", "tokens")}</span><span>${record.cost.toFixed(2)}</span></div>
        <div ref={transcript} className={styles.transcript} role="region" aria-label={label("步骤明细", "Span details")} onScroll={event => { if (active) cache.set(readingKey, event.currentTarget.scrollTop) }}>
          <div className={styles.inputBlock}><h3>{label("输入", "Input")}</h3><p>{copy(record.task)}</p><p>{copy(record.request)}</p></div>
          {context.presentation === "tree" ? <ExecutionTraceTree steps={spans.map(span => ({ stepId: span.id, parentStepId: span.parentId, name: copy(span.name), status: span.status, summary: copy(span.output) }))} selectedStepId={context.selectedSpan} onSelect={id => setState(previous => selectSpan(previous, id))} expandedIds={context.treeExpanded} onExpandedChange={ids => setState(previous => updateContext(previous, { treeExpanded: ids }))} /> : <Accordion multiple value={context.expanded} onValueChange={value => setState(previous => updateContext(previous, { expanded: value as string[] }))}>
            {spans.map(span => <AccordionItem key={span.id} value={span.id} data-span-id={span.id} className={styles.spanCard}><AccordionTrigger className={styles.spanHeader} onClick={() => setState(previous => updateContext(previous, { selectedSpan: span.id }))}><strong>{copy(span.name)}</strong><span>{span.duration ? `${span.duration.toFixed(2)}s` : label("尚未开始", "Not started")}</span></AccordionTrigger><AccordionContent className={styles.spanBody}><div><h4>{label("输入", "Input")}</h4><p>{copy(span.input)}</p></div><div><h4>{label("输出", "Output")}</h4><p>{copy(span.output)}</p></div>{span.status === "failed" && <RuntimeStatusBadge status="failed" />}</AccordionContent></AccordionItem>)}
          </Accordion>}
          {!spans.length && <p className={styles.noSpans}>{label("没有匹配的步骤或消息。请清除步骤搜索。", "No matching steps or messages. Clear the trace search.")}</p>}
        </div>
      </aside>}
    </div></section>
  )
}

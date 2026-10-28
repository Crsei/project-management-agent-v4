"use client"

import { useLayoutEffect, useRef, type CSSProperties } from "react"
import { ArrowUpRight, Check, CheckCircle2, ChevronDown, Circle, CircleAlert, FileText, LoaderCircle, LockKeyhole, Monitor, Moon, Play, RotateCcw, Search, ShieldCheck, Sun, X } from "lucide-react"
import { ActivityTimeline } from "@easyuse-ui/ui/components/blocks/activity-timeline"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@easyuse-ui/ui/components/ui/collapsible"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@easyuse-ui/ui/components/ui/select"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@easyuse-ui/ui/components/ui/sheet"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import { advanceRuns, createActivityState, decideReview, isAttention, loadDemo, openPanel, retryStep, reviseDiscount, setFilter, toggleRun, visibleRuns, type Period, type StatusFilter } from "./controller"
import { runtimeByStatus, statusLabels, type ActivityRun, type RunStatus } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
const statusToken: Record<RunStatus, string> = { running: "--status-info", review: "--status-waiting", blocked: "--status-error", completed: "--status-success", failed: "--status-error", cancelled: "--status-neutral" }

function RunProgress({ run }: { run: ActivityRun }) {
  const completed = run.steps.filter(step => step.status === "completed").length
  if (completed === run.steps.length) return <CheckCircle2 className={styles.progress} aria-hidden="true" style={{ color: "var(--status-success)" }} strokeWidth={1.5} />
  const circumference = 2 * Math.PI * 12
  const segment = circumference / run.steps.length
  return <svg viewBox="0 0 32 32" className={styles.progress} aria-hidden="true">
    <circle cx="16" cy="16" r="12" stroke="var(--border)" strokeWidth="2" fill="none" />
    {run.steps.map((step, index) => <circle key={step.id} cx="16" cy="16" r="12" stroke={step.status === "completed" ? "var(--status-success)" : step.status === "waiting" || step.status === "cancelled" ? "var(--border)" : `var(${statusToken[run.status]})`} strokeWidth="2" strokeLinecap="round" fill="none" strokeDasharray={`${segment - 5} ${circumference}`} transform={`rotate(${-90 + index * 360 / run.steps.length} 16 16)`} />)}
    <circle cx="16" cy="16" r="2" fill={`var(${statusToken[run.status]})`} />
  </svg>
}

export function RemainingPageView({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en
  const [state, setState] = useRemainingPageState(`agent-activity:${scenario}`, () => createActivityState(scenario))
  const scroller = useRef<HTMLDivElement>(null)
  const panelScroller = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const noteInput = useRef<HTMLTextAreaElement>(null)
  const discountInput = useRef<HTMLInputElement>(null)
  const runs = visibleRuns(state)
  const panelRun = state.records.find(run => run.id === state.panelRunId)
  const counts = { running: state.records.filter(run => run.status === "running").length, attention: state.records.filter(run => isAttention(run.status)).length, completed: state.records.filter(run => run.status === "completed").length }
  const periodLabels = { hour: text("最近 1 小时", "Last hour"), day: text("最近 24 小时", "Last 24 hours"), week: text("最近 7 天", "Last 7 days") }
  const statusFilterLabel = state.status === "all" ? text("状态", "Status") : state.status === "attention" ? text("需要关注", "Needs attention") : statusLabels[state.status][locale]
  useLayoutEffect(() => {
    if (active && scroller.current) scroller.current.scrollTop = state.scrollTop
  }, [active, state.scrollTop, locale])
  useLayoutEffect(() => {
    if (active && panelScroller.current) panelScroller.current.scrollTop = state.panelScrollTop
  }, [active, state.panel, state.panelScrollTop, locale])
  useLayoutEffect(() => {
    if (state.error === "reason") noteInput.current?.focus()
    if (state.error === "discount") discountInput.current?.focus()
  }, [state.error])

  function showPanel(panel: "review" | "rule" | "output", runId: string, element: HTMLElement) {
    opener.current = element
    setState(previous => openPanel(previous, panel, runId))
  }
  function downloadOutput() {
    if (!panelRun?.output) return
    const url = URL.createObjectURL(new Blob([panelRun.output.content], { type: "text/csv;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = panelRun.output.filename
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <Sheet open={active && Boolean(state.panel && panelRun)} onOpenChange={open => { if (!open && active) setState(previous => openPanel(previous, null, null)) }}>
    <section className={styles.page} data-page-id="agent-activity" aria-label={text("Agent 运行活动", "Agent activity")}>
      <header className={styles.workspaceHeader}>
        <span>{text("Agent 活动", "Agent activity")}</span>
        <div className={styles.headerActions}>
          <span>{text("演示工作区", "Demo workspace")}</span>
          <Button variant="ghost" disabled={state.readonly} aria-label={text("重置活动", "Reset activity")} onClick={() => setState(createActivityState(scenario))}><RotateCcw />{text("重置", "Reset")}</Button>
          <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={text("切换主题", "Toggle theme")} />}>{host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}</DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => host.setTheme("light")}><Sun />{text("浅色", "Light")}</DropdownMenuItem><DropdownMenuItem onClick={() => host.setTheme("dark")}><Moon />{text("深色", "Dark")}</DropdownMenuItem><DropdownMenuItem onClick={() => host.setTheme("system")}><Monitor />{text("跟随系统", "System")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>
      </header>
      <div className={styles.overview} id={host.mainContentId}>
        <div className={styles.contentWidth}>
          <div className={styles.intro}>
            <div><h1>{text("活动", "Activity")}</h1><p>{text("每一次 Agent 运行，从第一步到最终结果。", "Every agent run, from first step to outcome.")}</p></div>
            <div className={styles.summary} aria-label={text("运行汇总", "Run summary")}>
              <span><i style={{ background: "var(--status-info)" }} />{counts.running} {text("运行中", "running")}</span>
              <Button variant="ghost" size="sm" className={styles.attentionFilter} aria-pressed={state.status === "attention"} onClick={() => setState(previous => setFilter(previous, "status", previous.status === "attention" ? "all" : "attention"))}><i style={{ background: "var(--status-waiting)" }} />{counts.attention} {text("需要关注", "need attention")}</Button>
              <span><i style={{ background: "var(--status-success)" }} />{counts.completed} {text("已完成", "completed")}</span>
            </div>
          </div>
          <div role="search" aria-label={text("筛选 Agent 活动", "Filter agent activity")} className={styles.filters}>
            <div className={styles.search}><Search aria-hidden="true" /><Input aria-label={text("搜索运行或 ID", "Search runs or IDs")} placeholder={text("搜索运行或 ID", "Search runs or IDs")} value={state.query} onChange={event => setState(previous => setFilter(previous, "query", event.target.value))} />{state.query && <Button size="icon-sm" variant="ghost" aria-label={text("清除搜索", "Clear search")} onClick={() => setState(previous => setFilter(previous, "query", ""))}><X /></Button>}</div>
            <Select value={state.period} onValueChange={value => { if (value) setState(previous => setFilter(previous, "period", value)) }}><SelectTrigger className={styles.select} aria-label={text("时间范围", "Time period")}>{periodLabels[state.period]}<ChevronDown /></SelectTrigger><SelectContent>{(["hour", "day", "week"] as Period[]).map(value => <SelectItem key={value} value={value}>{periodLabels[value]}</SelectItem>)}</SelectContent></Select>
            <Select value={state.status} onValueChange={value => { if (value) setState(previous => setFilter(previous, "status", value)) }}><SelectTrigger className={styles.select} aria-label={text("运行状态", "Run status")}>{statusFilterLabel}<ChevronDown /></SelectTrigger><SelectContent>{(["all", "attention", "running", "review", "blocked", "completed", "failed", "cancelled"] as StatusFilter[]).map(value => <SelectItem key={value} value={value}>{value === "all" ? text("状态", "Status") : value === "attention" ? text("需要关注", "Needs attention") : statusLabels[value][locale]}</SelectItem>)}</SelectContent></Select>
            <Button size="lg" className={styles.primaryAction} disabled={state.readonly || !counts.running} aria-describedby={state.readonly ? "activity-readonly" : undefined} onClick={() => setState(advanceRuns)}><Play />{text("继续", "Resume")}</Button>
          </div>
        </div>
      </div>
      <div ref={scroller} className={styles.scroll} role="region" tabIndex={0} aria-label={text("Agent 运行", "Agent runs")} onScroll={event => { const scrollTop = event.currentTarget.scrollTop; setState(previous => previous.scrollTop === scrollTop ? previous : { ...previous, scrollTop }) }}>
        <div className={styles.timelineContent}>
          {state.readonly && <p id="activity-readonly" className={styles.notice}>{text("只读场景：可筛选、展开和查看详情；不能推进或修改运行。", "Read-only scenario: filter, expand, and inspect runs; execution and changes are disabled.")}</p>}
          {state.notice && <p role="status" className={styles.notice}>{state.notice[locale]}</p>}
          <DataRegion state={state.dataState === "loading" ? "loading" : state.dataState === "error" ? "error" : runs.length ? "success" : "empty"} hasContent={runs.length > 0} rowHeight={80} loadingLabel={text("正在加载本地演示活动", "Loading local demo activity")} emptyTitle={state.records.length ? text("没有匹配的运行", "No matching runs") : text("暂无运行活动", "No agent activity yet")} emptyDescription={state.records.length ? text("调整搜索、时间范围或状态。", "Adjust search, time period, or status.") : text("载入固定演示记录以检查运行与步骤。", "Load fixed demo records to inspect runs and steps.")} emptyAction={<Button variant="outline" onClick={() => setState(previous => state.records.length ? { ...previous, query: "", period: "day", status: "all", scrollTop: 0 } : loadDemo(previous))}>{state.records.length ? text("清除筛选", "Clear filters") : text("载入演示活动", "Load demo activity")}</Button>} error={{ category: "network", message: text("活动刷新失败", "Activity refresh failed"), reason: text("保留上次可用记录与当前草稿；重试只载入本地数据。", "Last available records and drafts are preserved; retry loads only local data.") }} onRetry={() => setState(loadDemo)}>
            {runs.length > 0 && <><div className={styles.dateHeading}>{text("今天", "Today")}</div><ol className={styles.timeline} aria-label={text("运行时间线", "Run timeline")}>
              {runs.map(run => <li key={run.id} className={styles.row} data-run-id={run.id} style={{ "--run-color": `var(${statusToken[run.status]})` } as CSSProperties}>
                <div className={styles.timeMeta}><div className={styles.time}><p>{run.time}</p><span>{run.relative[locale]}</span></div><div className={styles.agent}><p title={run.agent[locale]}>{run.agent[locale]}</p><code>{run.id}</code></div><i aria-hidden="true" /></div>
                <Collapsible className={styles.run} open={state.expanded.includes(run.id)} onOpenChange={() => setState(previous => toggleRun(previous, run.id))} data-open={state.expanded.includes(run.id) || undefined}>
                  <CollapsibleTrigger render={<Button variant="ghost" className={styles.runTrigger} aria-label={`${state.expanded.includes(run.id) ? text("收起", "Collapse") : text("展开", "Expand")} ${run.title[locale]}`} />}><RunProgress run={run} /><div className={styles.runTitle}><h2>{run.title[locale]}</h2><p>{run.integrations}</p></div><div className={styles.runStatus}><div><RuntimeStatusBadge status={runtimeByStatus[run.status]} iconOnly className={styles.statusDot} /><span>{statusLabels[run.status][locale]}</span><span className={styles.duration}>{run.duration}</span></div><p>{text(`已完成 ${run.steps.filter(step => step.status === "completed").length} / ${run.steps.length}`, `${run.steps.filter(step => step.status === "completed").length} of ${run.steps.length} completed`)}</p></div><ChevronDown className={styles.chevron} /></CollapsibleTrigger>
                  <CollapsibleContent className={styles.details}><div className={styles.stepSurface}><ol aria-label={text(`${run.title[locale]}的步骤`, `Steps for ${run.title[locale]}`)} className={styles.steps}>
                    {run.steps.map(step => {
                      const Icon = step.status === "completed" ? CheckCircle2 : step.status === "running" ? LoaderCircle : step.status === "failed" || step.status === "blocked" ? CircleAlert : step.status === "review" ? ShieldCheck : Circle
                      const color = step.status === "completed" ? "var(--status-success)" : step.status === "running" ? "var(--status-info)" : step.status === "failed" || step.status === "blocked" ? "var(--status-error)" : step.status === "review" ? "var(--status-waiting)" : "var(--text-muted)"
                      return <li key={step.id} className={styles.step} data-step-status={step.status}><Icon className={step.status === "running" ? styles.spinning : undefined} style={{ color }} aria-hidden="true" /><div className={styles.stepText}><p>{step.title[locale]}</p><span>{step.tool === "Internal tool" ? text("内部工具", "Internal tool") : step.tool}<span className={styles.separator}>·</span>{step.detail[locale]}</span><span className="sr-only">{step.status}</span></div>{step.action === "review" && <Button className={styles.darkButton} onClick={event => showPanel("review", run.id, event.currentTarget)}>{text("审核", "Review")}<ArrowUpRight /></Button>}{step.action === "rule" && <Button variant="outline" onClick={event => showPanel("rule", run.id, event.currentTarget)}>{text("查看规则", "View rule")}</Button>}{step.action === "retry" && <Button variant="outline" disabled={state.readonly} onClick={() => setState(previous => retryStep(previous, run.id))}><RotateCcw />{text("重试步骤", "Retry step")}</Button>}</li>
                    })}
                  </ol>{run.output && <Button variant="ghost" className={styles.outputButton} onClick={event => showPanel("output", run.id, event.currentTarget)}><FileText />{text("查看输出", "View output")}</Button>}</div></CollapsibleContent>
                </Collapsible>
              </li>)}
            </ol><p className={styles.caughtUp}>{text("此时间范围内的活动已全部显示。", "You’re all caught up for this period.")}</p></>}
          </DataRegion>
          {state.dataState === "loading" && <Button variant="outline" onClick={() => setState(loadDemo)}>{text("完成演示加载", "Complete demo loading")}</Button>}
        </div>
      </div>
    </section>
    {panelRun && <SheetContent size={512} className={styles.sheet} finalFocus={() => opener.current}>
      <SheetHeader className={styles.sheetHeader}>
        {state.panel !== "output" && <p className={styles.panelEyebrow} style={{ color: `var(${statusToken[panelRun.status]})` }}><i />{state.panel === "review" ? text("需要批准", "Approval required") : text("被策略阻止", "Blocked by policy")}</p>}
        <SheetTitle className={styles.sheetTitle}>{state.panel === "review" ? text("审核客户导出", "Review customer export") : state.panel === "rule" ? text("审核折扣请求", "Review discount request") : text("运行输出", "Run output")}</SheetTitle>
        <SheetDescription>{state.panel === "output" ? panelRun.output?.filename : `${panelRun.agent[locale]} · ${panelRun.id}`}</SheetDescription>
      </SheetHeader>
      <SheetBody ref={panelScroller} className={styles.sheetBody} onScroll={event => { const panelScrollTop = event.currentTarget.scrollTop; setState(previous => ({ ...previous, panelScrollTop })) }}>
        {state.panel !== "output" && <section className={styles.requestSummary} aria-label={text("请求摘要", "Request summary")}>
          <div className={styles.requestIdentity}><p>{panelRun.title[locale]}</p><span>{state.panel === "review" ? text("客户报告工作区", "Customer reporting workspace") : text("Harborline Apps · 年度团队套餐", "Harborline Apps · annual team plan")}</span></div>
          <dl className={styles.metrics}><div><dt>{state.panel === "review" ? text("导出记录数", "Records to export") : text("请求折扣", "Requested discount")}</dt><dd>{state.panel === "review" ? "3,120" : "35%"}</dd></div><div><dt>{state.panel === "review" ? text("无需审核", "Without review") : text("策略上限", "Policy limit")}</dt><dd>{state.panel === "review" ? "700" : "20%"}</dd></div></dl>
          <p className={styles.summaryNote}><ShieldCheck />{state.panel === "review" ? text("2,420 条记录超过自动导出上限。您的批准仅适用于本次运行。", "2,420 records above the automatic export limit. Your approval applies to this run only.") : text("请求折扣超过上限。修订本次请求以继续；策略保持不变。", "The requested discount exceeds the limit. Revise this request to continue; the policy stays unchanged.")}</p>
        </section>}
        {state.panel === "review" && <>
          <section className={styles.manifest} aria-label={text("导出清单", "Export manifest")}><header><FileText /><div><h3>{text("客户健康报告", "Customer health report")}</h3><p>{text("导出清单 · 3,120 个活跃账户", "Export manifest · 3,120 active accounts")}</p></div></header><dl><div><dt>{text("发送到", "Send to")}</dt><dd>Tableau <span>/ {text("收入工作区", "Revenue workspace")}</span></dd></div><div><dt>{text("包含", "Include")}</dt><dd><ul>{[text("账户名称", "Account name"), text("套餐", "Plan"), text("收入", "Revenue"), text("续约日期", "Renewal date"), text("健康分数", "Health score")].map(field => <li key={field}><Check />{field}</li>)}</ul></dd></div><div><dt>{text("排除", "Exclude")}</dt><dd className={styles.muted}><LockKeyhole />{text("付款详情和个人联系字段", "Payment details and personal contact fields")}</dd></div><div><dt>{text("然后通知", "Then notify")}</dt><dd>{text("仪表板负责人", "Dashboard owner")} <span>{text("通过 Slack", "via Slack")}</span></dd></div></dl></section>
          <label className={styles.fieldLabel} htmlFor="activity-review-note">{text("审核备注", "Review note")} <span>{text("（批准时可选）", "(optional for approval)")}</span></label><Textarea ref={noteInput} id="activity-review-note" placeholder={text("添加决定备注供 Agent 参考…", "Add a decision note for the agent…")} value={state.reviewNote} disabled={state.readonly} aria-invalid={state.error === "reason"} aria-describedby="activity-review-help" onChange={event => setState(previous => ({ ...previous, reviewNote: event.target.value, error: null }))} /><p id="activity-review-help" className={state.error === "reason" ? styles.fieldError : styles.fieldHelp}>{text("拒绝时需要说明原因，以便 Agent 知道如何调整。", "A rejection needs a reason so the agent knows what to change.")}</p>
        </>}
        {state.panel === "rule" && <><section className={styles.destination} aria-label={text("目标", "Destination")}><span>{text("更新目标", "Update destination")}</span><div><p>Salesforce</p><span>{text("交易 #9031 · Harborline Apps", "Deal #9031 · Harborline Apps")}</span></div></section><label className={styles.fieldLabel} htmlFor="activity-discount">{text("修订折扣 (%)", "Revised discount (%)")}</label><Input ref={discountInput} id="activity-discount" type="number" min={0} max={20} step="any" value={state.discount} disabled={state.readonly} aria-invalid={state.error === "discount"} aria-describedby="activity-discount-help" onChange={event => setState(previous => ({ ...previous, discount: event.target.value, error: null }))} /><p id="activity-discount-help" className={state.error === "discount" ? styles.fieldError : styles.fieldHelp}>{state.error === "discount" ? text("请输入 0 到 20 之间的折扣。", "Enter a discount between 0 and 20.") : text("策略保持不变。只修订此交易的请求。", "The policy stays unchanged. Only this deal’s request will be revised.")}</p></>}
        {state.panel === "output" && <><pre className={styles.output}>{panelRun.output?.content}</pre><ActivityTimeline compact events={panelRun.steps.map(step => ({ id: step.id, time: panelRun.time, type: step.tool, action: step.title[locale], target: step.detail[locale], status: step.status }))} /></>}
        {state.readonly && <p className={styles.fieldHelp}>{text("只读场景，决定与修改已禁用。", "Read-only scenario; decisions and changes are disabled.")}</p>}
      </SheetBody>
      <SheetFooter className={styles.sheetFooter}>{state.panel === "review" && <><Button variant="outline" disabled={state.readonly} onClick={() => setState(previous => decideReview(previous, "reject"))}>{text("拒绝请求", "Reject request")}</Button><Button className={styles.darkButton} disabled={state.readonly} onClick={() => setState(previous => decideReview(previous, "approve"))}><Check />{text("批准本次运行", "Approve this run")}</Button></>}{state.panel === "rule" && <Button className={styles.darkButton} disabled={state.readonly} onClick={() => setState(reviseDiscount)}>{text("修订并继续", "Revise and continue")}<ArrowUpRight /></Button>}{state.panel === "output" && <Button className={styles.darkButton} onClick={downloadOutput}><FileText />{text("下载输出", "Download output")}</Button>}</SheetFooter>
    </SheetContent>}
  </Sheet>
}

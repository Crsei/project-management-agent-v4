"use client"

import { useLayoutEffect, useRef } from "react"
import { ChevronDown, Download, Monitor, Moon, RotateCcw, Sun } from "lucide-react"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@easyuse-ui/ui/components/ui/collapsible"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@easyuse-ui/ui/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@easyuse-ui/ui/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@easyuse-ui/ui/components/ui/toggle-group"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import { automationNames, type AutomationId, type RunOutcome } from "./fixtures"
import { clearRunFilters, createRunHistoryState, expandRun, inspectSavedOutput, loadRunHistory, replayDemoEvent, runResponse, savedOutput, selectRunTab, setRunFilter, visibleRuns, type HistoryTab } from "./controller"
import styles from "./history.module.css"

export const pageScenarios = remainingPageScenarios
const runtimeByOutcome: Record<RunOutcome, string> = { success: "completed", error: "failed", blocked: "waiting" }
const automationIds: AutomationId[] = ["weekly-brief", "support-digest", "document-review"]
const outcomeIds: RunOutcome[] = ["success", "error", "blocked"]

export function RemainingPageView({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en
  const [state, setState] = useRemainingPageState(`automation-run-history:${scenario}`, () => createRunHistoryState(scenario))
  const scroller = useRef<HTMLDivElement>(null)
  const filtered = visibleRuns(state)
  const successfulRuns = filtered.reduce((count, run) => count + Number(run.outcome === "success"), 0)
  const outputRun = state.records.find(run => run.id === state.outputId)
  const outcomeLabel = (outcome: RunOutcome) => ({
    success: text("成功", "Success"), error: text("错误", "Error"), blocked: text("已阻止", "Blocked"),
  })[outcome]
  useLayoutEffect(() => {
    if (active && scroller.current) scroller.current.scrollTop = state.scrollTop
  }, [active, state.scrollTop])

  function downloadOutput(id: string) {
    const content = savedOutput(state, id, locale)
    if (content === null) return
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${id}-output.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)

  }

  return (
    <Dialog open={active && Boolean(outputRun?.output)} onOpenChange={open => { if (!open && active) setState(previous => inspectSavedOutput(previous, null)) }}>
      <section className={styles.page} data-page-id="automation-run-history" aria-label={text("自动化运行历史", "Automation history")}>
        <header className={styles.header}>
          <span>{text("自动化历史", "Automation history")}</span>
          <div className={styles.headerActions}>
            <Badge size="sm">{text("演示事件", "Demo events")}</Badge>
            <Button variant="ghost" size="icon-lg" aria-label={text("重置运行历史", "Reset run history")} aria-describedby={state.readonly ? "automation-history-readonly" : undefined} disabled={state.readonly} onClick={() => setState(createRunHistoryState(scenario))}><RotateCcw /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={text("切换主题", "Toggle theme")} />}>
                {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => host.setTheme("light")}><Sun />{text("浅色", "Light")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => host.setTheme("dark")}><Moon />{text("深色", "Dark")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => host.setTheme("system")}><Monitor />{text("跟随系统", "System")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div className={styles.scroll} ref={scroller} id={host.mainContentId} tabIndex={0} role="region" aria-label={text("运行历史内容", "Run history content")} onScroll={event => {
          const scrollTop = event.currentTarget.scrollTop
          setState(previous => previous.scrollTop === scrollTop ? previous : { ...previous, scrollTop })
        }}>
          <div className={styles.content}>
            <div className={styles.intro}>
              <p className={styles.eyebrow}>{text("自动化可观测性", "Automation observability")}</p>
              <h1>{text("每次触发都有记录。", "Every trigger leaves a record.")}</h1>
              <p className={styles.description}>{text("检查结果、追溯捕获的输入，并重放失败的演示事件。", "Inspect outcomes, trace captured inputs and replay a failed demo event.")}</p>
            </div>
            <ToggleGroup className={styles.automationFilters} aria-label={text("筛选自动化", "Filter automation")} value={[state.automation]} onValueChange={values => { if (values[0]) setState(previous => setRunFilter(previous, "automation", values[0] as AutomationId | "all")) }}>
              <ToggleGroupItem className={styles.filter} value="all">{text("全部自动化", "All automations")}</ToggleGroupItem>
              {automationIds.map(id => <ToggleGroupItem key={id} className={styles.filter} value={id}>{automationNames[id][locale]}</ToggleGroupItem>)}
            </ToggleGroup>
            <div className={styles.outcomeToolbar}>
              <ToggleGroup className={styles.outcomeFilters} aria-label={text("筛选运行结果", "Filter run outcome")} value={[state.outcome]} onValueChange={values => { if (values[0]) setState(previous => setRunFilter(previous, "outcome", values[0] as RunOutcome | "all")) }}>
                <ToggleGroupItem className={styles.filter} value="all">{text("全部结果", "All outcomes")}</ToggleGroupItem>
                {outcomeIds.map(outcome => <ToggleGroupItem key={outcome} className={styles.filter} value={outcome}>{outcomeLabel(outcome)}</ToggleGroupItem>)}
              </ToggleGroup>
              <p className={styles.summary}>{state.dataState === "loading" && !state.records.length ? text("正在读取运行数量…", "Reading run totals…") : text(`${filtered.length} 次运行 · ${successfulRuns} 次成功`, `${filtered.length} runs · ${successfulRuns} successful`)}</p>
            </div>
            <h2 className={styles.dateHeading}>{text("2026 年 9 月 6 日 · 演示历史", "September 6, 2026 · Demo history")}</h2>
            {state.readonly && <p className={styles.notice} id="automation-history-readonly">{text("只读模式：可筛选和查看记录，不能重放或重置历史。", "Read only: inspect and filter records; replay and reset are unavailable.")}</p>}
            {state.dataState === "loading" && <Button className={styles.load} size="sm" variant="secondary" onClick={() => setState(loadRunHistory)}>{text("加载演示历史", "Load demo history")}</Button>}
            <DataRegion state={state.dataState === "loading" ? "loading" : state.dataState === "refresh-error" ? "error" : filtered.length ? "success" : "empty"} hasContent={state.records.length > 0} rowHeight={78} loadingLabel={text("正在读取演示运行历史", "Reading demo run history")} updatedAt="2026-09-06 09:00" error={{ category: "network", message: text("无法刷新运行历史。", "Could not refresh run history."), reason: text("演示连接中断。已有记录和检查上下文已保留。", "The demo connection was interrupted. Existing records and inspection context are preserved.") }} onRetry={() => setState(loadRunHistory)} emptyTitle={state.records.length ? text("没有符合筛选条件的运行。", "No runs match these filters.") : text("暂无运行记录。", "No run history yet.")} emptyDescription={state.records.length ? text("清除筛选以查看所有捕获的事件。", "Clear filters to inspect all captured events.") : text("加载本地演示历史以查看触发事件及结果。", "Load local demo history to inspect triggers and outcomes.")} emptyAction={<Button size="sm" variant="secondary" onClick={() => setState(state.records.length ? clearRunFilters : loadRunHistory)}>{state.records.length ? text("清除筛选", "Clear filters") : text("加载演示历史", "Load demo history")}</Button>}>
              <ol className={styles.runList} aria-label={text("自动化运行记录", "Automation runs")}>
                {filtered.map(run => (
                  <li key={run.id} className={styles.runRow} data-run-id={run.id}>
                    <time className={styles.time} dateTime={`2026-09-06T${run.time}:00`}>{run.time}</time>
                    <Collapsible className={styles.run} open={state.expandedIds.includes(run.id)} onOpenChange={open => setState(previous => expandRun(previous, run.id, open))}>
                      <CollapsibleTrigger render={<Button variant="ghost" className={styles.runTrigger} aria-label={`${run.title[locale]} ${outcomeLabel(run.outcome)} ${run.id} · ${run.event} ${run.duration}`} />}>
                        <RuntimeStatusBadge status={runtimeByOutcome[run.outcome]} iconOnly className={styles.runIcon} />
                        <span className={styles.runIdentity}>
                          <span className={styles.titleLine}><span className={styles.runTitle} title={run.title[locale]}>{run.title[locale]}</span><Badge size="sm" className={styles.outcomeBadge}>{outcomeLabel(run.outcome)}</Badge></span>
                          <span className={styles.runMeta}>{run.id} · {run.event}</span>
                        </span>
                        <span className={styles.duration}>{run.duration}</span>
                        <ChevronDown className={styles.chevron} aria-hidden="true" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className={styles.details}>
                        <p className={styles.message}>{run.message[locale]}</p>
                        {run.replayOf && <p className={styles.replayOrigin}>{text("本地演示重放，源记录", "Local demo replay of")} {run.replayOf}</p>}
                        <Tabs value={state.tabs[run.id] ?? "response"} onValueChange={value => setState(previous => selectRunTab(previous, run.id, value as HistoryTab))}>
                          <TabsList className={styles.tabsList} aria-label={`${run.id} ${text("详情", "details")}`}>
                            <TabsTab value="response" className={styles.tab}>{text("响应", "Response")}</TabsTab>
                            <TabsTab value="event" className={styles.tab}>{text("捕获的事件", "Captured event")}</TabsTab>
                          </TabsList>
                          <TabsPanel value="response" className={styles.tabPanel} keepMounted><pre className={styles.json}>{JSON.stringify(runResponse(run, locale), null, 2)}</pre></TabsPanel>
                          <TabsPanel value="event" className={styles.tabPanel} keepMounted><pre className={styles.json}>{JSON.stringify(run.capturedEvent, null, 2)}</pre></TabsPanel>
                        </Tabs>
                        <div className={styles.runActions}>
                          {run.outcome === "success" && run.output && <><DialogTrigger render={<Button size="sm" variant="ghost" />} onClick={() => setState(previous => inspectSavedOutput(previous, run.id))}>{text("查看保存的输出", "View saved output")}</DialogTrigger><Button size="sm" variant="ghost" onClick={() => downloadOutput(run.id)}><Download />{text("下载", "Download")}</Button></>}
                          {run.outcome === "error" && <Button size="sm" variant="secondary" disabled={state.readonly} aria-describedby={state.readonly ? "automation-history-readonly" : undefined} onClick={() => setState(previous => replayDemoEvent(previous, run.id))}><RotateCcw />{text("重放演示事件", "Replay demo event")}</Button>}
                          {run.outcome === "blocked" && <p className={styles.blocked}>{text("必须调整授权范围，此事件才能运行。", "Scope must be revised before this event can run.")}</p>}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                ))}
              </ol>
            </DataRegion>
            {state.replayedFrom && <p className={styles.notice} role="status">{text("已从捕获的事件生成新的本地演示记录。原始失败记录保持不变。", "A new local demo record was generated from the captured event. The original failure is unchanged.")}</p>}
            <p className={styles.footer}>{text("重放使用捕获的本地样例，不发送 Webhook，也不更改任何计划。", "Replay uses the captured local fixture. No webhook is sent and no schedule is changed.")}</p>
          </div>
        </div>
      </section>
      {outputRun?.output && <DialogContent className={styles.outputDialog}><DialogTitle>{outputRun.title[locale]}</DialogTitle><DialogDescription>{text("已保存的演示输出", "Saved demo output")} · {outputRun.id}</DialogDescription><div className={styles.savedOutput}>{outputRun.output[locale]}</div></DialogContent>}
    </Dialog>
  )
}

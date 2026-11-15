import { useRef, useState } from "react"
import { Columns3, Plus, Terminal } from "lucide-react"
import { Board } from "@/components/blocks/work-items-board-base"
import { FilterToolbar } from "@/components/blocks/filter-toolbar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { RadixSelect } from "@/components/ui/radix-select"
import { Segmented, SegmentedItem } from "@/components/ui/segmented"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import type { GroupSnapshot } from "@/lib/grouped-items-model"
import { useI18n } from "@/lib/i18n-provider"
import workItemStyles from "@/components/blocks/work-items.module.css"
import { AgentRunCard } from "./agent-run-card"
import { PmPage } from "./presentation-page"
import boardStyles from "./boards-views.module.css"
import styles from "./agent-run-board.module.css"

type Copy = readonly [zh: string, en: string]
type Status = "queued" | "running" | "waiting" | "attention" | "ended"
type DemoRun = {
  id: string
  title: Copy
  agent: string
  provider: string
  model: string
  project: string
  branch: string
  status: Status
  elapsed: string
  step: Copy
  output: Copy
}
const columns = [
  { id: "queued", label: ["排队", "Queued"] },
  { id: "running", label: ["运行中", "Running"] },
  { id: "waiting", label: ["等待处理", "Needs input"] },
  { id: "attention", label: ["异常", "Needs attention"] },
  { id: "ended", label: ["已结束", "Ended"] },
] as const

// Deliberately independent of RemoteThread, providers and any service store.
const runs: readonly DemoRun[] = [
  { id: "DEMO-101", title: ["梳理登录流程的边界用例", "Map login edge cases"], agent: "Test planner", provider: "Claude", model: "Sonnet", project: "Dovspace", branch: "test/auth-boundaries", status: "queued", elapsed: "—", step: ["等待可用执行位", "Waiting for an execution slot"], output: ["已整理示例任务上下文。\n下一步：列出会话过期、重复提交与撤权场景。", "Example task context prepared.\nNext: session expiry, duplicate submission and revoked access."] },
  { id: "DEMO-102", title: ["整理本周版本变更", "Draft release notes"], agent: "Release writer", provider: "Codex", model: "GPT-6", project: "Docs", branch: "docs/release-notes", status: "queued", elapsed: "—", step: ["等待前置评审结束", "Waiting for the preceding review"], output: ["示例依赖：交互评审。\n尚未开始生成变更记录。", "Example dependency: interaction review.\nRelease notes have not started."] },
  { id: "DEMO-103", title: ["实现统一运行面板的卡片布局", "Build run board cards"], agent: "UI builder", provider: "Codex", model: "GPT-6", project: "Dovspace", branch: "feat/run-board", status: "running", elapsed: "04:32", step: ["调整卡片间距与窄屏布局", "Refining spacing and narrow layouts"], output: ["读取现有 Kanban 的布局约定。\n对齐卡片标题、状态标签与底部信息。\n正在检查窄屏横向滚动。", "Read the existing Kanban layout conventions.\nAlign card titles, state labels and metadata.\nChecking horizontal scrolling on narrow screens."] },
  { id: "DEMO-104", title: ["核对任务状态转换的回归用例", "Review task transition regressions"], agent: "QA reviewer", provider: "Claude", model: "Sonnet", project: "RunLedger", branch: "test/task-transitions", status: "running", elapsed: "02:18", step: ["检查失败与恢复的边界", "Checking failure and recovery boundaries"], output: ["已读取示例验收条件。\n正在比对中断、重试与最终结果的状态转换。\n尚无最终评审结论。", "Read the example acceptance criteria.\nComparing interrupted, retried and terminal transitions.\nNo final review conclusion yet."] },
  { id: "DEMO-105", title: ["确认运行详情的交互方向", "Confirm run detail interaction"], agent: "UX reviewer", provider: "Claude", model: "Opus", project: "Dovspace", branch: "design/run-inspector", status: "waiting", elapsed: "06:05", step: ["待回答：右侧抽屉还是独立页面？", "Question: side drawer or separate page?"], output: ["示例问题：详情优先使用右侧抽屉吗？\n建议保留看板上下文，并在抽屉中展示输出。\n此处仅预览，不会向 Agent 发送回答。", "Example question: should details use a side drawer?\nSuggestion: preserve the board context and show output in the drawer.\nThis preview does not send a response to an Agent."] },
  { id: "DEMO-106", title: ["补齐文档导出的验收条件", "Complete document export criteria"], agent: "Requirement analyst", provider: "OpenCode", model: "Configured model", project: "Docs", branch: "docs/export-criteria", status: "waiting", elapsed: "03:47", step: ["待补充：需要保留哪些附件？", "Question: which attachments must be retained?"], output: ["导出范围在示例需求中尚未明确。\n需要确认附件与相对链接的处理方式。", "The example requirements do not define the export scope.\nAttachment handling and relative links need clarification."] },
  { id: "DEMO-107", title: ["执行隔离环境的构建检查", "Run an isolated build check"], agent: "Build verifier", provider: "Codex", model: "GPT-6", project: "RunLedger", branch: "chore/build-check", status: "attention", elapsed: "01:12", step: ["示例错误：检查命令返回非零退出码", "Example error: check exited with a nonzero code"], output: ["$ pnpm check\n示例输出：依赖检查未通过，退出码 1。\n需要核对原始输出；未自动重试。", "$ pnpm check\nExample output: dependency check failed, exit code 1.\nInspect the original output; no automatic retry."] },
  { id: "DEMO-108", title: ["整理看板交互评审意见", "Summarize board interaction feedback"], agent: "Review summarizer", provider: "Claude", model: "Sonnet", project: "Dovspace", branch: "docs/board-review", status: "ended", elapsed: "05:26", step: ["示例摘要已生成，等待人工验收", "Example summary generated; awaiting human review"], output: ["示例摘要：保留状态列、搜索与详情抽屉。\n运行已结束，业务任务尚未标记完成。\n最终验收仍由既有业务规则决定。", "Example summary: retain state columns, search and the detail drawer.\nThe run ended; the business task is not marked complete.\nFinal acceptance still follows existing business rules."] },
]
const projects = [...new Set(runs.map(run => run.project))]
const providers = [...new Set(runs.map(run => run.provider))]

export default function AgentRunBoardDemo() {
  const en = useI18n().locale === "en"
  const text = (copy: Copy) => copy[en ? 1 : 0]
  const [query, setQuery] = useState("")
  const [project, setProject] = useState("")
  const [provider, setProvider] = useState("")
  const [needsInput, setNeedsInput] = useState(false)
  const [selected, setSelected] = useState<DemoRun | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const search = query.trim().toLocaleLowerCase()
  const filtered = runs.filter(run => (!project || run.project === project) && (!provider || run.provider === provider)
    && (!needsInput || run.status === "waiting" || run.status === "attention")
    && (!search || [run.id, ...run.title, run.agent, run.provider, run.model, run.project, run.branch].some(value => value.toLocaleLowerCase().includes(search))))
  const hasFilters = !!query || !!project || !!provider || needsInput
  const selectedColumn = columns.find(column => column.id === selected?.status)
  const unavailable = text(["Demo 未接入执行服务", "Execution is not connected in this Demo"])
  const groups: GroupSnapshot[] = columns.map(column => {
    const itemIds = filtered.filter(run => run.status === column.id).map(run => run.id)
    return {
      key: column.id,
      label: text(column.label),
      itemIds,
      loadedCount: itemIds.length,
      totalCount: itemIds.length,
      dataState: "success",
      queryKey: "agent-run-static-demo",
    }
  })

  return <div className={styles.root} data-testid="agent-run-board-demo">
    <PmPage
      pageId="agent-run-board-demo"
      className={boardStyles.root}
      contentClassName={styles.content}
      title={text(["统一运行面板", "Agent run board"])}
      titleSuffix={<span className={styles.demoBadge}>Demo</span>}
      description={text(["静态示例 · 搜索、筛选与详情仅在本页预览，未连接真实 Agent。", "Static examples · Search, filters and details are page-local previews, not live Agents."])}
      actions={<Button disabled title={unavailable}><Plus aria-hidden="true" />{text(["新建运行", "New run"])}</Button>}
      toolbar={
        <FilterToolbar
          className={workItemStyles.toolbar}
          label={text(["筛选示例运行", "Filter example runs"])}
          search={<>
            <Segmented value="board" aria-label={text(["运行展示方式", "Run layout"])}>
              <SegmentedItem value="board" className={styles.layoutLabel}><Columns3 size={14} aria-hidden="true" />{text(["看板", "Board"])}</SegmentedItem>
            </Segmented>
            <Input className={styles.search} type="search" aria-label={text(["搜索示例运行", "Search example runs"])} placeholder={text(["搜索任务、Agent、分支…", "Search tasks, Agents, branches…"])} value={query} onChange={event => setQuery(event.target.value)} />
          </>}
          filters={<>
            <RadixSelect className={styles.select} aria-label={text(["筛选示例项目", "Filter example projects"])} value={project} onChange={event => setProject(event.target.value)}>
              <option value="">{text(["全部项目", "All projects"])}</option>
              {projects.map(value => <option key={value} value={value}>{value}</option>)}
            </RadixSelect>
            <RadixSelect className={styles.select} aria-label={text(["筛选示例 Provider", "Filter example providers"])} value={provider} onChange={event => setProvider(event.target.value)}>
              <option value="">{text(["全部 Provider", "All providers"])}</option>
              {providers.map(value => <option key={value} value={value}>{value}</option>)}
            </RadixSelect>
            <label className={styles.attentionFilter}>
              <Checkbox checked={needsInput} onCheckedChange={setNeedsInput} />
              {text(["需要我处理", "Needs my attention"])}
            </label>
          </>}
          actions={<>
            {hasFilters && <Button variant="ghost" onClick={() => { setQuery(""); setProject(""); setProvider(""); setNeedsInput(false) }}>{text(["清除筛选", "Clear filters"])}</Button>}
            <span className={styles.total} aria-live="polite">{filtered.length} / {runs.length} {text(["个示例运行", "example runs"])}</span>
          </>}
        />
      }
    >
      {!filtered.length && <p className={styles.emptyResults} role="status">{text(["没有匹配的示例运行，请调整或清除筛选。", "No matching example runs. Adjust or clear the filters."])}</p>}
      <div className={boardStyles.workArea}>
        <div className={`${boardStyles.viewport} ${styles.viewport}`} role="region" aria-label={text(["运行看板，可横向滚动", "Run board, horizontally scrollable"])} tabIndex={0}>
          <Board<DemoRun>
            className={`${boardStyles.board} ${styles.board}`}
            groups={groups}
            items={filtered}
            queryKey="agent-run-static-demo"
            manualOrder={false}
            getItemId={run => run.id}
            getItemLabel={run => text(run.title)}
            getGroupIcon={status => <span className={styles.statusDot} data-status={status} aria-hidden="true" />}
            renderItem={(run, group) => <AgentRunCard
              id={run.id}
              title={text(run.title)}
              agent={run.agent}
              provider={run.provider}
              model={run.model}
              folder={run.project}
              branch={run.branch}
              status={run.status}
              statusLabel={group.label}
              metadata={run.elapsed}
              metadataLabel={`${text(["示例耗时", "Example duration"])}: ${run.elapsed}`}
              step={text(run.step)}
              previewLabel={`${text(["预览示例", "Preview example"])}：${text(run.title)}`}
              onOpen={trigger => { opener.current = trigger; setSelected(run) }}
            />}
          />
        </div>
      </div>
    </PmPage>
    <Sheet open={!!selected} onOpenChange={open => { if (!open) setSelected(null) }}>
      {selected && selectedColumn && <SheetContent size={480} finalFocus={opener} className={styles.detail}>
        <header className={styles.detailHeader}>
          <span className={styles.detailEyebrow}>{selected.id}<span className={styles.demoBadge}>Demo</span></span>
          <SheetTitle className={styles.detailTitle}>{text(selected.title)}</SheetTitle>
          <SheetDescription className={styles.detailDescription}>{text(["示例运行详情，不连接真实会话；运行结束不代表业务任务完成。", "Example run details, not a live session. An ended run is not a completed task."])}</SheetDescription>
        </header>
        <dl className={styles.facts}>{[
          [text(["运行状态", "Run status"]), text(selectedColumn.label)], ["Agent", selected.agent], ["Provider", selected.provider], [text(["模型", "Model"]), selected.model], [text(["示例耗时", "Example duration"]), selected.elapsed], [text(["项目", "Project"]), selected.project], [text(["分支", "Branch"]), selected.branch],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <section><h3>{text(["当前步骤", "Current step"])}</h3><p className={styles.step}>{text(selected.step)}</p></section>
        <section><h3><Terminal size={14} aria-hidden="true" />{text(["输出预览 · 示例片段", "Output preview · example excerpt"])}</h3><pre className={styles.output}>{text(selected.output)}</pre></section>
        <div className={styles.detailActions}><Button variant="outline" disabled title={unavailable}>{text(["打开会话", "Open session"])}</Button><Button variant="outline" disabled title={unavailable}>{text(["停止运行", "Stop run"])}</Button><Button variant="outline" disabled title={unavailable}>{text(["重试", "Retry"])}</Button></div>
        <p className={styles.detailNote}>{text(["执行操作尚未接入。Demo 不发送消息、不启动进程，也不保存或改变业务任务状态。", "Execution is not connected. The Demo sends no messages, starts no processes, and does not save or change business task state."])}</p>
      </SheetContent>}
    </Sheet>
  </div>
}

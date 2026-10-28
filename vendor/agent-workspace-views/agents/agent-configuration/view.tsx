"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react"

import { Bot, CheckCheck, ChevronDown, Code2, Copy, FileSearch, GitBranch, History, Monitor, Play, RotateCcw, Save, Square, Terminal, Wrench } from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@easyuse-ui/ui/components/ui/select"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@easyuse-ui/ui/components/ui/tabs"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import { FormSection } from "@easyuse-ui/ui/components/blocks/form-section"
import { ToolCall } from "@easyuse-ui/ui/components/blocks/tool-call"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { configurationJson, configurationTransition, createConfigurationState, isDirty, previewResponse, validateConfig, type ConfigurationAction } from "./controller"
import { environments, models, tools } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><AgentConfiguration key={props.scenario} {...props} /></RemainingPageStateProvider>
}
function AgentConfiguration({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n(); const id = useId()
  const l = (zh: string, en: string) => locale === "en" ? en : zh
  const [state, setState] = useRemainingPageState("agent-configuration:" + scenario, () => createConfigurationState(scenario))
  const [saveOpen, setSaveOpen] = useState(false)
  const [summary, setSummary] = useState("")
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle")
  const frame = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const versionButton = useRef<HTMLButtonElement | null>(null)
  const locked = state.readonly || state.data === "loading"
  const run = state.run
  const running = run?.status === "running" || run?.status === "waiting"
  const dirty = isDirty(state)
  const selectedVersion = state.versions.find((v) => v.number === state.selectedVersion)
  const json = configurationJson(state.config)
  const dispatch = (action: ConfigurationAction) => { if (action.type !== "scroll") setCopyState("idle"); setState((s) => configurationTransition(s, action)) }
  const error = (key: keyof typeof state.errors) => state.errors[key] ? key === "maxTurns" ? l("请输入 1 到 50 之间的整数。", "Enter a whole number from 1 to 50.") : l("请填写此项。", "Please complete this field.") : undefined

  useEffect(() => {
    if (!active || !run || run.status !== "running") return
    const timer = window.setTimeout(() => setState((s) => configurationTransition(s, { type: "tick", id: run.id, step: run.step })), 450)
    return () => window.clearTimeout(timer)
  }, [active, run, setState])
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = state.scroll
    const saved = cache.get("agent-configuration:" + scenario + ":text") as { id: string; start: number; end: number; scroll: number } | undefined
    if (saved) {
      const input = frame.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-draft="${saved.id}"]`)
      input?.setSelectionRange(saved.start, saved.end)
      if (input) input.scrollTop = saved.scroll
    }
    // A mounted scene keeps its native editor and scroll nodes through theme/locale changes.
    // Restore only on scene activation, never on each controlled edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cache, scenario])
  const rememberText = (event: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const e = event.currentTarget
    cache.set("agent-configuration:" + scenario + ":text", { id: e.dataset.draft, start: e.selectionStart, end: e.selectionEnd, scroll: e.scrollTop })
  }
  function saveDraft() {
    const errors = validateConfig(state.config)
    if (Object.keys(errors).length) {
      dispatch({ type: "save", summary: "", savedAt: "" })
      requestAnimationFrame(() => frame.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
    } else { setSummary(""); setSaveOpen(true) }
  }
  function startTest() {
    dispatch({ type: "run" })
    if (Object.keys(validateConfig(state.config)).length || !state.testMessage.trim()) requestAnimationFrame(() => frame.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
  }
  async function copyConfig() {
    try { await navigator.clipboard.writeText(json); setCopyState("copied") } catch { setCopyState("error") }
  }
  function closeVersion() {
    dispatch({ type: "select-version", number: null })
    requestAnimationFrame(() => versionButton.current?.focus())
  }
  const select = (field: "model" | "environment" | "output", label: string, options: readonly { value: string; label: string }[]) => (
    <Field label={label} className={styles.field}>{(p) => <Select value={state.config[field]} items={options} disabled={locked} onValueChange={(v) => { if (v !== null) dispatch({ type: field, value: v }) }}><SelectTrigger {...p} aria-label={l("Agent " + label, "Agent " + label.toLowerCase())} className={styles.select}><SelectValue /><ChevronDown size={16} aria-hidden="true" /></SelectTrigger><SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>}</Field>
  )
  return (
    <div className={styles.page} ref={frame} data-agent-configuration>
      <header className={styles.workspaceHeader}><span>{l("Agent 配置", "Agent configuration")}</span><div><Badge size="sm">{l("演示工作区", "Demo workspace")}</Badge><Button variant="ghost" size="icon" aria-label={l("切换主题", "Toggle theme")} onClick={() => host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")}><Monitor size={16} /></Button></div></header>
      <div ref={scroll} className={styles.scroll} data-configuration-scroll onScroll={(e) => dispatch({ type: "scroll", value: e.currentTarget.scrollTop })}>
        <section className={styles.content} ><header className={styles.pageHeader}><div><h1>{l("Agent 配置", "Agent configuration")}</h1><p>{l("定义 Agent 的思考方式、工具使用，以及如何向你交付工作。", "Shape how your agent thinks, uses tools, and hands work back to you.")}</p></div><div className={styles.actions}><Badge size="sm">{dirty ? l("未保存的更改", "Unsaved changes") : l("版本 ", "Version ") + (state.versions[0]?.number ?? 0)}</Badge><Button variant="outline" disabled={!dirty || locked} onClick={() => dispatch({ type: "discard" })}><RotateCcw size={16} />{l("放弃更改", "Discard")}</Button><Button ref={saveButton} disabled={!dirty || locked} onClick={saveDraft}><Save size={16} />{l("保存版本", "Save version")}</Button></div></header>
        {state.readonly && <p className={styles.notice} role="status">{l("只读配置。可查看历史和运行本地脚本预览，但不能保存或还原版本。", "Read-only configuration. Inspect history and run the local scripted preview; saving and restoring are unavailable.")}</p>}
        {state.notice && <p className={styles.notice} role="status">{state.notice === "saved" ? l("版本已保存在当前内存会话中。", "Version saved in this in-memory session.") : state.notice === "restored" ? l("历史配置已还原为草稿；尚未保存。", "Previous configuration restored as a draft; not saved yet.") : l("草稿已还原为已保存的版本。", "Draft reset to the saved version.")}</p>}
        <DataRegion state={state.data} hasContent={state.data !== "loading"} loadingLabel={l("加载 Agent 配置", "Loading agent configuration")} error={{ category: "network", message: l("配置刷新失败。", "Configuration refresh failed."), reason: l("本地失败场景；当前草稿和历史版本均已保留。", "Local failure scenario; the current draft and version history are preserved.") }} onRetry={() => dispatch({ type: "recover" })}>
          <div className={styles.grid}>
            <section className={styles.editor} aria-label={l("Agent 编辑器", "Agent editor")}>
              <Tabs value={state.section} onValueChange={(value) => dispatch({ type: "section", value: value as typeof state.section })}>
                <TabsList className={styles.tabs} aria-label={l("Agent 编辑分区", "Agent editor sections")}><TabsTab className={styles.tab} value="configuration">{l("配置", "Configuration")}</TabsTab><TabsTab className={styles.tab} value="tools">{l("工具", "Tools")} <span className={styles.count}>{state.config.tools.length}</span></TabsTab><TabsTab className={styles.tab} value="versions">{l("版本", "Versions")}</TabsTab></TabsList>
                <TabsPanel value="configuration" keepMounted className={styles.panel}>
                  <div className={styles.card}>
                    <div className={styles.identity}><span className={styles.agentIcon}><Bot size={20} /></span><div><h2 title={state.config.name}>{state.config.name || l("未命名 Agent", "Untitled agent")}</h2><p>{l("支持助手", "Support copilot")} · agent_support_triage</p></div></div>
                    <div className={styles.form}>
                      <Field className={styles.field} label={l("名称", "Name")} error={error("name")}>{(p) => <Input {...p} data-draft="name" value={state.config.name} disabled={locked} onSelect={rememberText} onChange={(e) => dispatch({ type: "field", field: "name", value: e.target.value })} />}</Field>
                      <Field className={styles.field} label={l("描述", "Description")}>{(p) => <Input {...p} data-draft="description" value={state.config.description} disabled={locked} onSelect={rememberText} onChange={(e) => dispatch({ type: "field", field: "description", value: e.target.value })} />}</Field>
                      <div className={styles.twoColumns}>{select("model", l("模型", "Model"), models.map((m) => ({ value: m, label: m })))}{select("environment", l("环境", "Environment"), environments.map((e) => ({ value: e.value, label: e.label[locale === "en" ? "en" : "zh-CN"] })))}</div>
                      <Field className={styles.field} label={<span className={styles.labelLine}><span>{l("指令", "Instructions")}</span><span aria-hidden="true">{state.config.instructions.length} {l("字符", "characters")}</span></span>} description={l("定义目标、边界，以及何时需要向人工求助。", "Define the goal, boundaries, and when to ask a person for help.")} error={error("instructions")}>{(p) => <Textarea {...p} className={styles.instructions} data-draft="instructions" disabled={locked} value={state.config.instructions} onSelect={rememberText} onScroll={rememberText} onChange={(e) => dispatch({ type: "field", field: "instructions", value: e.target.value })} />}</Field>
                      <div className={styles.twoColumns}>{select("output", l("输出格式", "Output format"), [{ value: "text", label: l("文本", "Text") }, { value: "json", label: "JSON" }])}<Field className={styles.field} label={l("最大轮数", "Maximum turns")} error={error("maxTurns")}>{(p) => <Input {...p} type="number" min={1} max={50} step={1} value={state.config.maxTurns} disabled={locked} onChange={(e) => dispatch({ type: "field", field: "maxTurns", value: e.target.value })} />}</Field></div>
                    </div>
                  </div>
                </TabsPanel>
                <TabsPanel value="tools" keepMounted className={styles.panel}>
                  <div className={styles.card}><div className={styles.cardHeading}><h2>{l("工具与权限", "Tools & permissions")}</h2><p>{l("Agent 只能使用已启用的工具。", "Only enabled tools are available to this agent.")}</p></div>
                    <FormSection className={styles.toolSection} title={l("已连接的工具", "Connected tools")}>
                      {tools.map((tool, index) => { const Icon = [FileSearch, Wrench, Terminal][index]; return <div className={styles.toolRow} key={tool.id}><Checkbox id={id + "-" + tool.id} checked={state.config.tools.includes(tool.id)} disabled={locked} aria-label={tool.name[locale === "en" ? "en" : "zh-CN"]} onCheckedChange={(checked) => dispatch({ type: "tool", id: tool.id, checked })} /><div><label className={styles.toolName} htmlFor={id + "-" + tool.id}><Icon size={16} aria-hidden="true" />{tool.name[locale === "en" ? "en" : "zh-CN"]}</label><p>{tool.description[locale === "en" ? "en" : "zh-CN"]}</p><span>{tool.permission[locale === "en" ? "en" : "zh-CN"]}</span></div></div> })}
                    </FormSection>
                    <div className={styles.approval}><div><label htmlFor={id + "-approval"}>{l("写操作需要审批", "Require approval for writes")}</label><p>{l("创建工单或修改外部数据前暂停。", "Pause before creating a ticket or changing external data.")}</p></div><Switch id={id + "-approval"} checked={state.config.approval} disabled={locked} onCheckedChange={(checked) => dispatch({ type: "approval", checked })} /></div>
                  </div>
                </TabsPanel>
                <TabsPanel value="versions" keepMounted className={styles.panel}>
                  <div className={styles.card}><div className={styles.cardHeading}><h2>{l("版本历史", "Version history")}</h2><p>{l("查看历史指令，并将它们还原为草稿。", "Review earlier instructions and restore them as a draft.")}</p></div>{state.versions.length === 0 ? <DataRegion state="empty" emptyTitle={l("暂无保存的版本", "No saved versions")} emptyDescription={l("填写配置并保存第一个版本。", "Complete the configuration and save the first version.")} /> : <div className={styles.versions}>{state.versions.map((version, index) => <Button key={version.number} className={styles.versionRow} variant="outline" onClick={(e) => { versionButton.current = e.currentTarget; dispatch({ type: "select-version", number: version.number }) }}><span className={styles.versionIcon}><GitBranch size={16} /></span><span><span className={styles.versionTitle}>{l("版本 ", "Version ")}{version.number}{index === 0 && <Badge size="sm">{l("当前", "Current")}</Badge>}</span><span className={styles.versionSummary}>{version.summary}</span><span className={styles.metadata}>Alex Morgan · {version.savedAt}</span></span><History className={styles.historyIcon} size={16} /></Button>)}</div>}</div>
                </TabsPanel>
              </Tabs>
            </section>
            <aside className={styles.preview} aria-label={l("预览", "Preview")}>
              <div className={styles.previewHeading}><div><h2>{l("预览", "Preview")}</h2><Badge size="sm">{l("脚本化测试", "Scripted test")}</Badge></div><p>{l("使用当前配置体验账单问题场景。", "Try the billing scenario with your current configuration.")}</p></div>
              <Tabs value={state.previewMode} onValueChange={(value) => dispatch({ type: "preview-mode", value: value as typeof state.previewMode })}>
                <TabsList className={styles.tabs} aria-label={l("Agent 预览模式", "Agent preview mode")}><TabsTab className={styles.tab} value="test">{l("测试 Agent", "Test agent")}</TabsTab><TabsTab className={styles.tab} value="json"><Code2 size={14} />{l("配置 JSON", "Configuration JSON")}</TabsTab></TabsList>
                <TabsPanel value="test" keepMounted className={styles.previewPanel}>
                  <div className={styles.previewMeta}><span>{run?.config.model ?? state.config.model}</span><span>{run?.config.tools.length ?? state.config.tools.length} {l("个工具已启用", "tools enabled")}</span></div>
                  {!run ? <div className={styles.previewEmpty}><Bot size={28} /><h3>{l("查看 Agent 的处理方式", "See your agent’s approach")}</h3><p>{l("运行示例场景，预览工具选择、审批和响应格式。", "Run the sample scenario to preview tool choices, approvals, and the response format.")}</p></div> : <div className={styles.run} aria-live="polite" data-scripted-run={run.id}>
                    <div className={styles.runHeading}><span>{l("本地脚本预览", "Local scripted preview")}</span><RuntimeStatusBadge status={run.status} /></div>
                    <p className={styles.prompt}>{run.prompt}</p>
                    {run.step >= 1 && <p>{l("识别到高优先级账单问题。核查重复扣款，避免承诺无法执行的退款。", "Identified a high-priority billing issue. Check duplicate charges without promising a refund the agent cannot perform.")}</p>}
                    {run.step >= 2 && (run.config.tools.includes("file_search") ? <ToolCall call={{ id: `preview-${run.id}-search`, name: "file_search", status: "completed", arguments: { query: "duplicate subscription charge" }, output: { source: "Help center · Duplicate subscription charges", guidance: "Verify settled charges, then escalate to billing.", simulated: true } }} /> : <p className={styles.metadata}>{l("知识搜索未启用；此预览不会检索帮助中心。", "Knowledge search is disabled; this preview does not search the help center.")}</p>)}
                    {run.step >= 3 && run.config.tools.includes("code_interpreter") && <ToolCall call={{ id: `preview-${run.id}-code`, name: "code_interpreter", status: "completed", output: { simulated: true, attached_csv: false, result: "No CSV attachment; no analysis performed." } }} />}
                    {run.step >= 3 && run.config.tools.includes("create_ticket") && <ToolCall defaultExpanded call={{ id: `preview-${run.id}-ticket`, name: "create_ticket", status: run.ticket === "waiting" ? (run.status === "cancelled" ? "cancelled" : "waiting") : run.ticket === "rejected" ? "cancelled" : "completed", arguments: { team: "billing", subject: "Duplicate subscription charge", simulated: true }, output: run.ticket === "waiting" ? undefined : { simulated: true, decision: run.ticket, external_write: false } }} actions={run.status === "waiting" ? <div className={styles.decision}><Button size="sm" onClick={() => dispatch({ type: "decision", id: run.id, approved: true })}>{l("批准模拟", "Approve simulation")}</Button><Button size="sm" variant="outline" onClick={() => dispatch({ type: "decision", id: run.id, approved: false })}>{l("拒绝", "Reject")}</Button></div> : undefined} />}
                    {run.status === "completed" && <div className={styles.response}><h3>{l("示例响应", "Example response")}</h3>{run.config.output === "json" ? <CodePreview identity={`agent-configuration-result-${run.id}`} code={previewResponse(run, locale)} path="response.json" ariaLabel={l("示例 JSON 响应", "Example JSON response")} /> : <p>{previewResponse(run, locale)}</p>}</div>}
                    {run.status === "failed" && <p role="alert">{l("脚本预览已达到最大轮数。增加轮数后可重新运行。", "The scripted preview reached the maximum turns. Increase the limit before rerunning.")}</p>}
                    {run.status === "cancelled" && <p>{l("预览已停止；已展示的步骤仍保留。", "Preview stopped; the steps already shown are preserved.")}</p>}
                  </div>}
                  <Field className={styles.field} label={l("测试消息", "Test message")} error={error("testMessage")}>{(p) => <Textarea {...p} className={styles.testMessage} data-draft="test-message" value={state.testMessage} disabled={state.data === "loading" || running} onSelect={rememberText} onScroll={rememberText} onChange={(e) => dispatch({ type: "test-message", value: e.target.value })} />}</Field>
                  <div className={styles.previewActions}><Button variant="ghost" onClick={() => dispatch({ type: "clear" })}>{l("清空预览", "Clear preview")}</Button>{running ? <Button variant="outline" onClick={() => dispatch({ type: "cancel" })}><Square size={16} />{l("停止预览", "Stop preview")}</Button> : <Button onClick={startTest}><Play size={16} />{l("运行测试", "Run test")}</Button>}</div>
                </TabsPanel>
                <TabsPanel value="json" keepMounted className={styles.jsonPanel}><div className={styles.jsonHeading}><span>agent.config.json</span><Button size="icon-sm" variant="ghost" aria-label={l("复制 Agent 配置", "Copy agent configuration")} onClick={copyConfig}><Copy size={14} /></Button></div><CodePreview identity="agent-configuration-json" code={json} path="agent.config.json" ariaLabel={l("Agent 配置 JSON", "Agent configuration JSON")} maximumLines={200} />{copyState !== "idle" && <p role="status">{copyState === "copied" ? l("配置已复制。", "Configuration copied.") : l("无法访问剪贴板，请从预览中选择并复制。", "Clipboard unavailable; select and copy from the preview.")}</p>}</TabsPanel>
              </Tabs>
              <div className={styles.previewFooter}><CheckCheck size={16} aria-hidden="true" /><p>{l("此预览演示固定的账单场景。模型、工具、输出格式和审批设置会影响示例；指令不会被执行。", "The preview demonstrates a fixed billing scenario. Model, tools, output format, and approval settings shape the example; instructions are not executed.")}</p></div>
            </aside>
          </div>
        </DataRegion>
        {state.data === "loading" && <Button variant="outline" onClick={() => dispatch({ type: "recover" })}>{l("载入本地配置", "Load local configuration")}</Button>}</section>
      </div>
      <Dialog open={saveOpen && active} onOpenChange={(open) => { setSaveOpen(open); if (!open) requestAnimationFrame(() => saveButton.current?.focus()) }}><DialogContent><DialogTitle>{l("保存新版本", "Save a new version")}</DialogTitle><DialogDescription>{l("为配置更改添加说明。此版本仅保存在当前内存会话。", "Add a note about your changes. This version is saved only in this in-memory session.")}</DialogDescription><Field label={l("更改说明", "Change summary")} className={styles.dialogField}>{(p) => <Input {...p} value={summary} onChange={(e) => setSummary(e.target.value)} />}</Field><DialogFooter><DialogClose render={<Button variant="outline" />}>{l("取消", "Cancel")}</DialogClose><Button onClick={() => { dispatch({ type: "save", summary, savedAt: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date()) }); setSaveOpen(false); requestAnimationFrame(() => saveButton.current?.focus()) }}>{l("保存版本", "Save version")}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={Boolean(selectedVersion) && active} onOpenChange={(open) => { if (!open) closeVersion() }}><DialogContent><DialogTitle>{l("版本 ", "Version ")}{selectedVersion?.number}</DialogTitle><DialogDescription>{selectedVersion?.summary} · {selectedVersion?.savedAt}</DialogDescription><div className={styles.versionInstructions}>{selectedVersion?.config.instructions}</div><DialogFooter><Button variant="outline" onClick={closeVersion}>{l("关闭", "Close")}</Button><Button disabled={locked} onClick={() => { if (selectedVersion) dispatch({ type: "restore", number: selectedVersion.number }); requestAnimationFrame(() => frame.current?.querySelector<HTMLInputElement>('[data-draft="name"]')?.focus()) }}>{l("还原为草稿", "Restore as draft")}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  )
}

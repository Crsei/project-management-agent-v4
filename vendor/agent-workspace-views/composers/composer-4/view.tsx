"use client"

import { useId, type ReactNode } from "react"
import { Bot, Check, FileText, Figma, Github, Library, Link2, Mic, Plus, Search, Settings2, Slack, SquarePen, Users, Workflow, X } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@easyuse-ui/ui/components/ui/tabs"
import { ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
import { ComposerInput } from "../../composer-input"
import { ComposerWorkspaceView } from "../../composer-workspace-view"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { useComposer4Controller } from "./controller"
import { toolItems, workflowItems, type ToolId, type WorkspaceAgent } from "./fixtures"
import styles from "./composer-4.module.css"

export const pageScenarios = remainingPageScenarios

function ToolMark({ id }: { id: ToolId }) {
  const icons = { github: Github, notion: FileText, slack: Slack, figma: Figma }
  const Icon = icons[id]
  return <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
}
function AgentMark({ agent }: { agent: WorkspaceAgent }) {
  const Icon = agent.kind === "review" ? Bot : agent.kind === "release" ? Workflow : Search
  return <span className={styles.agentMark} data-kind={agent.kind}><Icon aria-hidden="true" size={24} strokeWidth={1.75} /></span>
}

function Composer4Page(props: RemainingPageProps) {
  const controller = useComposer4Controller(props)
  const { copy, label, state, setState, configuration, panel, setPanel, canEdit, scroll: scrollRef, history: historyRef } = controller
  const prefix = useId()
  const [builder, setBuilder] = useRemainingPageState(`composer-4:${props.scenario}:builder`, () => ({ name: "", description: "", tools: [] as ToolId[], error: false }))
  const [transcript, setTranscript] = useRemainingPageState(`composer-4:${props.scenario}:transcript`, () => "")
  const selectedAgent = state.agents.find((agent) => agent.id === configuration.agentId)
  const close = () => setPanel(null)
  const open = (target: NonNullable<typeof panel>) => setPanel(target)
  const tool = (name: string, icon: ReactNode, action: () => void) => <Button variant="ghost" size="icon" aria-label={name} onClick={action} disabled={!canEdit}>{icon}</Button>
  const agentCard = (agent: WorkspaceAgent) => (
    <Button key={agent.id} variant="ghost" className={styles.agentCard} aria-pressed={configuration.agentId === agent.id} disabled={!canEdit} onClick={() => controller.chooseAgent(agent)}>
      <AgentMark agent={agent} />
      <strong>{copy(agent.name)}</strong>
      <span>{copy(agent.description)}</span>
      {panel === "library" && <small>{agent.tools.map((id) => toolItems.find((item) => item.id === id)!.name).join(" · ")}</small>}
    </Button>
  )
  const navigation = (
    <Tabs value={state.sidebarTab} onValueChange={(value) => setState((previous) => ({ ...previous, sidebarTab: value as "create" | "activity" }))} className={styles.sidebar}>
      <TabsList className={styles.sidebarTabs} aria-label={label("工作区视图", "Workspace views")}>
        <TabsTab value="create">{label("创建", "Create")}</TabsTab>
        <TabsTab value="activity">{label("动态", "Activity")}{state.unread > 0 && <span className={styles.count}>{state.unread}</span>}</TabsTab>
      </TabsList>
      <TabsPanel value="create" className={styles.sidebarPanel}>
        <div className={styles.navActions}>
          <Button variant="ghost" onClick={() => controller.newSession()} disabled={!canEdit}><SquarePen />{label("新会话", "New session")}</Button>
          <Button variant="ghost" onClick={() => open("library")}><Library />{label("Agent 库", "Agent library")}</Button>
          <Button variant="ghost" onClick={() => open("connections")}><Link2 />{label("连接", "Connections")}</Button>
          <Button variant="ghost" onClick={() => open("workflow")}><Workflow />{label("工作流", "Workflows")}</Button>
          <Button variant="ghost" onClick={() => open("deliverables")}><FileText />{label("交付物", "Deliverables")}</Button>
        </div>
        <section className={styles.navGroup} aria-label={label("Agents", "Agents")}>
          <h2>{label("Agents", "Agents")}</h2>
          {state.agents.slice(0, 3).map((agent) => <Button key={agent.id} variant="ghost" disabled={!canEdit} aria-pressed={configuration.agentId === agent.id} onClick={() => controller.chooseAgent(agent)}><Users /><span>{copy(agent.shortName)}</span></Button>)}
        </section>
        <section className={styles.navGroup} aria-label={label("对话", "Chats")}>
          <h2>{label("对话", "Chats")}</h2>
          {controller.chats.map((chat) => <Button key={chat.id} variant="ghost" title={controller.sessionTitle(chat)} aria-pressed={controller.selectedId === chat.id} onClick={() => { controller.rememberPosition(); controller.selectSession(chat) }}><span>{controller.sessionTitle(chat)}</span></Button>)}
          {!controller.chats.length && <p>{label("尚无对话", "No conversations yet")}</p>}
        </section>
      </TabsPanel>
      <TabsPanel value="activity" className={styles.sidebarPanel}>
        <div className={styles.activityHeading}><h2>{label("最近动态 · 示例", "Recent activity · Example")}</h2><Button variant="ghost" size="sm" disabled={!state.unread} onClick={() => setState((previous) => ({ ...previous, unread: 0 }))}>{label("标为已读", "Mark read")}</Button></div>
        <div className={styles.navActions}>
          <Button variant="ghost" onClick={() => open("library")}>{label("界面审查规划示例", "Screen Review planning example")}</Button>
          <Button variant="ghost" onClick={() => open("connections")}>{label("查看本地工具选择", "Review local tool selections")}</Button>
          <Button variant="ghost" onClick={() => open("workflow")}>{label("设计审查工作流模板", "Design review workflow template")}</Button>
        </div>
      </TabsPanel>
    </Tabs>
  )
  const input = (
    <div className={styles.inputBlock}>
      {(selectedAgent || configuration.tools.length > 0 || configuration.workflowId) && <div className={styles.configuration} aria-label={label("任务组合", "Task combination")}>
        {selectedAgent && <span><Bot size={14} />{copy(selectedAgent.name)}<Button variant="ghost" size="icon-sm" aria-label={label("移除 Agent", "Remove agent")} disabled={!canEdit} onClick={() => controller.updateConfiguration({ ...configuration, agentId: null })}><X /></Button></span>}
        {configuration.tools.map((id) => <span key={id}><ToolMark id={id} />{toolItems.find((item) => item.id === id)!.name}<Button variant="ghost" size="icon-sm" aria-label={`${label("移除工具", "Remove tool")}: ${id}`} disabled={!canEdit} onClick={() => controller.toggleTool(id)}><X /></Button></span>)}
        {configuration.workflowId && <span><Workflow size={14} />{copy(workflowItems.find((item) => item.id === configuration.workflowId)!.name)}<Button variant="ghost" size="icon-sm" aria-label={label("移除工作流", "Remove workflow")} disabled={!canEdit} onClick={() => controller.updateConfiguration({ ...configuration, workflowId: null })}><X /></Button></span>}
      </div>}
      <ComposerInput controller={controller} helpId={`${prefix}-help`} options={{
        hideSuggestion: true, showBlocksControl: false, readOnly: !canEdit,
        formLabel: { "zh-CN": "AI 工作区输入", en: "AI workspace composer" },
        inputLabel: { "zh-CN": "描述你想构建的内容", en: "Describe what you want to build" },
        placeholder: { "zh-CN": "分配任务、提出问题，或描述要构建的内容", en: "Assign a task, ask a question, or describe what to build" },
        tools: <>{tool(label("连接工具", "Connect a tool"), <Link2 />, () => open("connections"))}{tool(label("配置任务", "Configure task"), <Settings2 />, () => open("configure"))}</>,
        trailingTools: tool(label("使用语音输入", "Use voice input"), <Mic />, () => open("voice")),
      }} />
      <div className={styles.connectionStrip}>
        <span><Link2 size={14} />{label("连接工具至 AI Admin Kit", "Connect tools to AI Admin Kit")}</span>
        <div>{toolItems.map((item) => <Button key={item.id} variant="ghost" size="icon-sm" aria-label={item.name} aria-pressed={configuration.tools.includes(item.id)} onClick={() => open("connections")}><ToolMark id={item.id} /></Button>)}</div>
      </div>
    </div>
  )
  const body = (
    <div ref={scrollRef} className={styles.body} data-composer4-region="body" onScroll={controller.rememberPosition}>
      <div className={styles.content}>
        {state.refreshFailed && <div className={styles.notice} role="alert"><span>{label("推荐刷新失败，保留上次内容和草稿。", "Recommendations could not refresh. Previous content and your draft are preserved.")}</span><Button variant="outline" onClick={controller.loadFixtures}>{label("重新加载本地示例", "Reload local example")}</Button></div>}
        {!canEdit && <div className={styles.notice} role="status">{controller.readonly ? label("只读预览；可查看工具、模板和会话，不可修改任务。", "Read-only preview; inspect tools, templates, and conversations without changing the task.") : label("正在等待本地示例数据；不会连接真实服务。", "Waiting for local example data; no real service will be connected.")}</div>}
        {!controller.hasMessages ? <div className={styles.welcome}><span className={styles.welcomeMark} aria-hidden="true"><Bot size={22} /></span><h1>{label("你想构建什么？", "What do you want to build?")}</h1></div> : <div className={styles.history} ref={historyRef} role="region" aria-label={label("对话记录", "Conversation history")}>
          {controller.selected.messages.map((message) => <ChatMessage key={message.id} id={message.id} role={message.role === "user" ? "user" : "agent"} author={message.role === "user" ? label("你", "You") : label("本地规划示例", "Local planning example")} content={copy(message.text)}>{message.contexts?.length ? <small>{message.contexts.join(" · ")}</small> : null}</ChatMessage>)}
        </div>}
        {input}
        {!controller.hasMessages && <>
          <section className={styles.actions} aria-label={label("开始构建", "Get started")}>
            <article><Bot size={20} strokeWidth={1.75} aria-hidden="true" /><h2>{label("构建 Agent", "Build Agent")}</h2><p>{label("从零开始设计你的 AI 队友。", "Design your AI teammate from scratch.")}</p><Button className={styles.actionButton} onClick={() => open("build")} disabled={!canEdit}>{label("构建", "Build")}</Button></article>
            <article><div className={styles.toolStack}><ToolMark id="github" /><ToolMark id="slack" /><ToolMark id="figma" /></div><h2>{label("连接工具", "Connect tools")}</h2><p>{label("快速连接你最喜欢的应用。", "Link your favorite apps in minutes.")}</p><Button className={styles.actionButton} onClick={() => open("connections")}>{label("连接", "Connect")}</Button></article>
            <article><Workflow size={20} strokeWidth={1.75} aria-hidden="true" /><h2>{label("启用工作流", "Activate Workflow")}</h2><p>{label("端到端自动化任务，释放双手。", "Automate tasks end to end, hands-free.")}</p><Button className={styles.actionButton} onClick={() => open("workflow")}>{label("工作流", "Workflow")}</Button></article>
          </section>
          <section className={styles.agents} aria-label="Agents">
            <div className={styles.sectionHeading}><h2>Agents</h2><Button variant="ghost" size="sm" onClick={() => open("library")}>{label("查看全部", "View all")}</Button></div>
            {!state.loaded ? <div className={styles.loading} aria-busy="true"><div className={styles.skeleton} /><div className={styles.skeleton} /><Button variant="outline" onClick={controller.loadFixtures}>{label("加载本地示例", "Load local example")}</Button></div> : state.agents.length ? <div className={styles.agentGrid}>{state.agents.slice(0, 2).map(agentCard)}</div> : <div className={styles.empty}><Bot /><p>{label("尚无 Agent。构建一个新的 AI 队友。", "No agents yet. Build a new AI teammate.")}</p><Button variant="outline" onClick={() => open("build")}>{label("构建 Agent", "Build Agent")}</Button></div>}
          </section>
        </>}
      </div>
    </div>
  )
  const titles = { connections: label("连接工具", "Connect tools"), configure: label("配置任务", "Configure task"), build: label("构建 Agent", "Build Agent"), library: label("Agent 库", "Agent library"), workflow: label("启用工作流", "Activate Workflow"), voice: label("语音输入", "Voice input"), deliverables: label("交付物", "Deliverables") }
  return <>
    <ComposerWorkspaceView controller={controller} host={props.host} presentation={{ id: "composer-4", title: { "zh-CN": "Composer 4", en: "Composer 4" }, welcome: { title: { "zh-CN": "你想构建什么？", en: "What do you want to build?" }, description: { "zh-CN": "", en: "" } }, workspaceNavigation: navigation, renderBody: () => body }} />
    <Dialog open={panel !== null} onOpenChange={(isOpen) => { if (!isOpen) close() }}>
      <DialogContent className={styles.dialog}>
        <DialogTitle>{panel ? titles[panel] : ""}</DialogTitle>
        <DialogDescription>{label("本地内存示例；不会授权外部应用、上传文件或执行真实 Agent。", "Local in-memory example; no external authorization, file upload, or real agent execution.")}</DialogDescription>
        {panel === "connections" && <div className={styles.dialogList}>{toolItems.map((item) => <Button key={item.id} variant="outline" className={styles.toolOption} aria-pressed={configuration.tools.includes(item.id)} disabled={!canEdit} onClick={() => controller.toggleTool(item.id)}><ToolMark id={item.id} /><span><strong>{item.name}</strong><small>{copy(item.description)}</small></span>{configuration.tools.includes(item.id) ? <Check /> : <Plus />}</Button>)}<p className={styles.help}>{label("选择仅添加到当前任务，不代表真实连接。", "Selections apply only to this task; they are not real connections.")}</p><Button onClick={close}>{label("完成", "Done")}</Button></div>}
        {panel === "configure" && <div className={styles.dialogList}><h3>{label("任务模式", "Task mode")}</h3><div className={styles.modeButtons}><Button variant="outline" aria-pressed={configuration.mode === "plan"} disabled={!canEdit} onClick={() => controller.updateConfiguration({ ...configuration, mode: "plan" })}>{label("规划", "Plan")}</Button><Button variant="outline" aria-pressed={configuration.mode === "review"} disabled={!canEdit} onClick={() => controller.updateConfiguration({ ...configuration, mode: "review" })}>{label("审查", "Review")}</Button></div><h3>{label("推荐 Agent 组合", "Recommended agent combinations")}</h3>{state.agents.map(agentCard)}<Button onClick={close}>{label("完成", "Done")}</Button></div>}
        {panel === "library" && <div className={styles.dialogList}><Input value={controller.libraryQuery} aria-label={label("搜索 Agent", "Search agents")} placeholder={label("搜索 Agent…", "Search agents...")} onChange={(event) => controller.setLibraryQuery(event.target.value)} />{state.agents.filter((agent) => `${copy(agent.name)} ${copy(agent.description)}`.toLocaleLowerCase().includes(controller.libraryQuery.toLocaleLowerCase())).map(agentCard)}{!state.agents.some((agent) => `${copy(agent.name)} ${copy(agent.description)}`.toLocaleLowerCase().includes(controller.libraryQuery.toLocaleLowerCase())) && <p className={styles.help}>{label("没有匹配的 Agent。", "No matching agents.")}</p>}<Button variant="outline" disabled={!canEdit} onClick={() => open("build")}>{label("构建 Agent", "Build Agent")}</Button></div>}
        {panel === "workflow" && <div className={styles.dialogList}>{workflowItems.map((workflow) => <Button variant="outline" key={workflow.id} className={styles.toolOption} disabled={!canEdit} aria-pressed={configuration.workflowId === workflow.id} onClick={() => controller.chooseWorkflow(workflow.id)}><Workflow /><span><strong>{copy(workflow.name)}</strong><small>{copy(workflow.description)}</small><small>{workflow.tools.map((id) => toolItems.find((item) => item.id === id)!.name).join(" · ")}</small></span></Button>)}<p className={styles.help}>{label("选择模板只准备任务；不会发布或运行工作流。", "Selecting a template prepares the task; it does not publish or run a workflow.")}</p></div>}
        {panel === "build" && <form className={styles.dialogList} onSubmit={(event) => { event.preventDefault(); const valid = controller.addAgent(builder.name, builder.description, builder.tools); setBuilder((previous) => ({ ...previous, error: !valid, ...(valid ? { name: "", description: "", tools: [] } : {}) })) }}>
          <label htmlFor={`${prefix}-name`}>{label("Agent 名称", "Agent name")}</label><Input id={`${prefix}-name`} value={builder.name} readOnly={!canEdit} aria-invalid={builder.error && !builder.name.trim()} onChange={(event) => setBuilder((previous) => ({ ...previous, name: event.target.value, error: false }))} />
          <label htmlFor={`${prefix}-instructions`}>{label("职责与指令", "Responsibilities and instructions")}</label><Textarea id={`${prefix}-instructions`} value={builder.description} readOnly={!canEdit} rows={3} aria-invalid={builder.error && !builder.description.trim()} onChange={(event) => setBuilder((previous) => ({ ...previous, description: event.target.value, error: false }))} />
          <h3>{label("工具组合", "Tool combination")}</h3><div className={styles.modeButtons}>{toolItems.map((item) => <Button key={item.id} variant="outline" disabled={!canEdit} aria-pressed={builder.tools.includes(item.id)} onClick={() => setBuilder((previous) => ({ ...previous, tools: previous.tools.includes(item.id) ? previous.tools.filter((id) => id !== item.id) : [...previous.tools, item.id] }))}><ToolMark id={item.id} />{item.name}</Button>)}</div>
          {builder.error && <p role="alert">{label("请填写名称和职责；草稿已保留。", "Enter a name and responsibilities; your draft is preserved.")}</p>}
          <div className={styles.dialogFooter}><Button variant="outline" onClick={close}>{label("取消", "Cancel")}</Button><Button type="submit" disabled={!canEdit}>{label("创建本地 Agent", "Create local agent")}</Button></div>
        </form>}
        {panel === "voice" && <div className={styles.dialogList}><p className={styles.help}>{label("此预览未启用麦克风。可编辑本地转录文本并追加到草稿。", "Microphone capture is not enabled in this preview. Edit a local transcript and append it to the draft.")}</p><label htmlFor={`${prefix}-transcript`}>{label("本地转录文本", "Local transcript")}</label><Textarea id={`${prefix}-transcript`} value={transcript} onChange={(event) => setTranscript(event.target.value)} rows={4} /><Button disabled={!canEdit || !transcript.trim()} onClick={() => { controller.updateDraft({ text: [controller.draft.text, transcript.trim()].filter(Boolean).join("\n") }); setTranscript(""); close(); controller.focusComposer() }}>{label("追加到草稿", "Append to draft")}</Button></div>}
        {panel === "deliverables" && <div className={styles.dialogList}><p className={styles.help}>{label("本页没有真实执行产物。会话内容可作为本地文本导出。", "This page has no real execution artifacts. Conversation content can be exported as local text.")}</p><Button variant="outline" disabled={!controller.hasMessages} onClick={controller.exportConversation}>{label("导出当前会话", "Export current conversation")}</Button><Button variant="outline" onClick={close}>{label("返回任务", "Back to task")}</Button></div>}
      </DialogContent>
    </Dialog>
  </>
}

export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><Composer4Page key={props.scenario} {...props} /></RemainingPageStateProvider>
}

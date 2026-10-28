"use client"

import { useId } from "react"
import { Link2, UserRound, Workflow, Check } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { ComposerWorkspaceView } from "../../composer-workspace-view"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider } from "../../showcase/state"
import { useComposer3Controller } from "./controller"
import { tools, workflows } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><Composer3Content {...props} /></RemainingPageStateProvider>
}

function Composer3Content({ scenario, active, host, cache }: RemainingPageProps) {
  const controller = useComposer3Controller(scenario, active, cache)
  const { label, copy, directory, setDirectory, editable, openShortcut, applyShortcut } = controller
  const id = useId()
  const shortcuts = [
    { id: "agent" as const, title: label("建立 Agent", "Build an agent"), description: label("创建一位专注的 UI 队友。", "Create a focused UI teammate."), Icon: UserRound },
    { id: "tools" as const, title: label("连接工具", "Connect tools"), description: label("添加团队正在使用的应用。", "Add the apps used by your team."), Icon: Link2 },
    { id: "workflow" as const, title: label("启动流程", "Run a workflow"), description: label("自动化一项可重复的任务。", "Automate a repeatable task."), Icon: Workflow },
  ]
  const workflow = workflows.find((item) => item.id === directory.workflowId) ?? workflows[0]
  const error = directory.error === "agent-name"
    ? label("请输入 Agent 名称。", "Enter an agent name.")
    : directory.error === "agent-goal"
      ? label("请描述 Agent 的目标。", "Describe the agent goal.")
      : directory.error === "workflow-goal"
        ? label("请描述流程的任务范围。", "Describe the workflow scope.")
        : null
  const notice = directory.notice === "agent"
    ? label("Agent 草案已加入输入框；尚未创建或部署远程 Agent。", "Agent brief added to the composer; no remote agent created or deployed.")
    : directory.notice === "tools"
      ? label("本地工具配置已更新；没有连接外部应用。", "Local tool configuration updated; no external apps connected.")
      : directory.notice === "workflow"
        ? label("流程计划已加入输入框；尚未执行。", "Workflow plan added to the composer; not executed.")
        : directory.notice === "loaded"
          ? label("本地目录已载入，草稿保持不变。", "Local directory loaded; your draft is preserved.")
          : null
  if (!active) return null

  return <div className={styles.page} data-composer3-view data-scenario={scenario}>
    <ComposerWorkspaceView controller={controller} host={host} presentation={{
      id: "composer-3",
      title: { "zh-CN": "Composer 3", en: "Composer 3" },
      welcome: {
        title: { "zh-CN": "你想构建什么？", en: "What do you want to build?" },
        description: { "zh-CN": "建立 Agent、连接工具，或自动化一个工作流程。", en: "Start an agent, connect a tool, or automate a workflow." },
      },
      beforeInput: <>
        {directory.readState !== "ready" && <div className={styles.notice} role={directory.readState === "refresh-error" ? "alert" : "status"} aria-busy={directory.readState === "loading" || undefined}>
          <span>{directory.readState === "loading" ? label("本地工具目录加载中；仍可编辑草稿。", "Loading the local tool directory; drafts remain editable.") : label("目录刷新失败，保留上一次本地数据与草稿。", "Directory refresh failed; previous local data and drafts are retained.")}</span>
          <Button variant="outline" size="sm" onClick={() => setDirectory((previous) => ({ ...previous, readState: "ready", notice: "loaded" }))}>{label("载入本地目录", "Load local directory")}</Button>
        </div>}
        {scenario === "readonly" && <p className={styles.notice} role="status">{label("只读示例：可以编辑草稿和查看历史，但不能配置入口或发送消息。", "Read-only example: edit drafts and inspect history; configuration and sending are unavailable.")}</p>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
      </>,
      afterInput: !controller.hasMessages && <div className={styles.shortcuts} role="group" aria-label={label("快速开始", "Quick start")}>
        {shortcuts.map(({ id, title, description, Icon }) => <Button key={id} variant="outline" className={styles.shortcut} disabled={!editable} onClick={() => openShortcut(id)} aria-label={title}>
          <Icon aria-hidden="true" />
          <span className={styles.shortcutText}><strong>{title}</strong><span>{description}</span></span>
        </Button>)}
      </div>,
      input: {
        hideSuggestion: true,
        showBlocksControl: false,
        placeholder: { "zh-CN": "分配任务或提出任何问题", en: "Assign a task or ask anything" },
        inputLabel: { "zh-CN": "Agent 主页编辑器", en: "Agent home composer" },
        formLabel: { "zh-CN": "Agent 主页编辑器", en: "Agent home composer" },
        tools: <>
          <Button variant="ghost" size="icon-sm" aria-label={label("连接工具", "Connect tools")} disabled={!editable} onClick={() => openShortcut("tools")}><Link2 /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={label("配置流程", "Configure workflow")} disabled={!editable} onClick={() => openShortcut("workflow")}><Workflow /></Button>
        </>,
      },
    }} />

    <Dialog open={directory.dialog !== null} onOpenChange={(open) => { if (!open) setDirectory((previous) => ({ ...previous, dialog: null, error: null })) }}>
      <DialogContent className={styles.dialog} finalFocus={() => controller.shortcutReturnFocus.current ?? false}>
        <DialogTitle>{directory.dialog === "agent" ? label("建立 Agent", "Build an agent") : directory.dialog === "tools" ? label("连接工具", "Connect tools") : label("启动流程", "Run a workflow")}</DialogTitle>
        <DialogDescription>{label("仅配置本地草案。没有外部连接、凭据、部署或流程执行。", "Configure a local brief only. No external connections, credentials, deployment, or workflow execution.")}</DialogDescription>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); applyShortcut() }}>
          {directory.dialog === "agent" && <>
            <label className={styles.field} htmlFor={`${id}-agent-name`}><span>{label("Agent 名称", "Agent name")}</span><Input id={`${id}-agent-name`} value={directory.agent.name} aria-invalid={directory.error === "agent-name" || undefined} aria-describedby={directory.error === "agent-name" ? `${id}-error` : undefined} onChange={(event) => setDirectory((previous) => ({ ...previous, agent: { ...previous.agent, name: event.target.value }, error: null }))} placeholder={label("例如：UI 审阅助手", "e.g. UI review teammate")} /></label>
            <label className={styles.field} htmlFor={`${id}-agent-goal`}><span>{label("目标与职责", "Goal and responsibilities")}</span><Textarea id={`${id}-agent-goal`} rows={4} value={directory.agent.goal} aria-invalid={directory.error === "agent-goal" || undefined} aria-describedby={directory.error === "agent-goal" ? `${id}-error` : undefined} onChange={(event) => setDirectory((previous) => ({ ...previous, agent: { ...previous.agent, goal: event.target.value }, error: null }))} placeholder={label("描述它需要完成什么任务…", "Describe what it should accomplish…")} /></label>
          </>}
          {directory.dialog === "tools" && <ul className={styles.toolList} aria-label={label("可配置的工具", "Available tools")}>
            {tools.map((tool) => <li key={tool.id}><Button type="button" variant="ghost" className={styles.toolRow} aria-pressed={directory.toolIds.includes(tool.id)} onClick={() => setDirectory((previous) => ({ ...previous, toolIds: previous.toolIds.includes(tool.id) ? previous.toolIds.filter((id) => id !== tool.id) : [...previous.toolIds, tool.id] }))}>
              <Link2 aria-hidden="true" /><span><strong>{tool.name}</strong><small>{copy(tool.description)}</small></span><span className={styles.toolSelection}>{directory.toolIds.includes(tool.id) ? <Check aria-hidden="true" /> : label("添加", "Add")}</span>
            </Button></li>)}
          </ul>}
          {directory.dialog === "workflow" && <>
            <fieldset className={styles.workflowChoices}><legend>{label("选择流程模板", "Choose a workflow template")}</legend>{workflows.map((item) => <Button type="button" key={item.id} variant="outline" aria-pressed={directory.workflowId === item.id} onClick={() => setDirectory((previous) => ({ ...previous, workflowId: item.id, error: null }))}>{copy(item.name)}</Button>)}</fieldset>
            <div className={styles.preview}><strong>{copy(workflow.name)}</strong><p>{copy(workflow.description)}</p><ol>{copy(workflow.steps).split(" → ").map((step) => <li key={step}>{step}</li>)}</ol></div>
            <label className={styles.field} htmlFor={`${id}-workflow-goal`}><span>{label("任务范围", "Task scope")}</span><Textarea id={`${id}-workflow-goal`} rows={3} value={directory.workflowGoal} aria-invalid={directory.error === "workflow-goal" || undefined} aria-describedby={directory.error === "workflow-goal" ? `${id}-error` : undefined} onChange={(event) => setDirectory((previous) => ({ ...previous, workflowGoal: event.target.value, error: null }))} placeholder={label("项目、时间范围与期望产物…", "Project, time range, and expected deliverable…")} /></label>
          </>}
          {error && <p className={styles.error} id={`${id}-error`} role="alert">{error}</p>}
          <div className={styles.actions}><Button type="button" variant="outline" onClick={() => setDirectory((previous) => ({ ...previous, dialog: null, error: null }))}>{label("取消", "Cancel")}</Button><Button type="submit" disabled={!editable}>{directory.dialog === "tools" ? label("应用工具配置", "Apply tool configuration") : label("加入草稿", "Add to draft")}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>
}

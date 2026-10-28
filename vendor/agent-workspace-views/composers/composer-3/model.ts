import type { Draft } from "../../model"
import { tools, workflows } from "./fixtures.ts"

export type AgentBrief = { name: string; goal: string }
export type Shortcut = "agent" | "tools" | "workflow" | null
export type DirectoryState = {
  dialog: Shortcut
  agent: AgentBrief
  preparedAgentName: string
  toolIds: string[]
  workflowId: string
  workflowGoal: string
  error: "agent-name" | "agent-goal" | "workflow-goal" | null
  readState: "ready" | "loading" | "refresh-error"
  notice: "agent" | "tools" | "workflow" | "loaded" | null
}

export function initialDirectoryState(scenario: string): DirectoryState {
  return {
    dialog: null,
    agent: { name: "", goal: "" },
    preparedAgentName: "",
    toolIds: [],
    workflowId: workflows[0].id,
    workflowGoal: "",
    error: null,
    readState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "refresh-error" : "ready",
    notice: null,
  }
}

export function prepareAgent(draft: Draft, agent: AgentBrief, locale: "zh-CN" | "en"): { draft: Draft; error: DirectoryState["error"] } {
  if (!agent.name.trim()) return { draft, error: "agent-name" }
  if (!agent.goal.trim()) return { draft, error: "agent-goal" }
  const instruction = locale === "en"
    ? `Prepare an agent brief for ${agent.name.trim()}.\nGoal: ${agent.goal.trim()}\nDefine responsibilities, required tools, and review checkpoints before deployment.`
    : `为 ${agent.name.trim()} 编写 Agent 草案。\n目标：${agent.goal.trim()}\n明确职责、所需工具与部署前的审核节点。`
  return { draft: { ...draft, text: draft.text ? `${draft.text}\n\n${instruction}` : instruction, contextIds: draft.contextIds.includes("agent-brief") ? draft.contextIds : [...draft.contextIds, "agent-brief"] }, error: null }
}

export function configureTools(draft: Draft, selected: string[]): Draft {
  const toolIds = tools.map((tool) => tool.id)
  const selectedIds = tools.filter((tool) => selected.includes(tool.id)).map((tool) => tool.id)
  return { ...draft, contextIds: [...draft.contextIds.filter((id) => !toolIds.includes(id)), ...selectedIds] }
}

export function prepareWorkflow(draft: Draft, workflowId: string, goal: string, locale: "zh-CN" | "en"): { draft: Draft; error: DirectoryState["error"] } {
  const workflow = workflows.find((item) => item.id === workflowId)
  if (!workflow || !goal.trim()) return { draft, error: "workflow-goal" }
  const instruction = locale === "en"
    ? `Prepare ${workflow.name.en} for review.\nScope: ${goal.trim()}\n${workflow.steps.en}\nDo not perform external writes without approval.`
    : `准备「${workflow.name["zh-CN"]}」流程供审核。\n范围：${goal.trim()}\n${workflow.steps["zh-CN"]}\n未经授权不要执行外部写入。`
  const flowIds = workflows.map((item) => item.id)
  return { draft: { ...draft, text: draft.text ? `${draft.text}\n\n${instruction}` : instruction, contextIds: [...draft.contextIds.filter((id) => !flowIds.includes(id)), workflowId] }, error: null }
}

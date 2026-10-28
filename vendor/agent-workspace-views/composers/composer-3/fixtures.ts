import { createComposerFixture } from "../../fixtures.ts"
import type { ComposerDemoSource } from "../../demo-source"
import type { ContextItem, Copy } from "../../model"

export const tools = [
  { id: "tool-github", name: "GitHub", description: { "zh-CN": "代码仓库、议题与拉取请求", en: "Repositories, issues, and pull requests" } },
  { id: "tool-linear", name: "Linear", description: { "zh-CN": "项目、任务与团队进度", en: "Projects, tasks, and team progress" } },
  { id: "tool-slack", name: "Slack", description: { "zh-CN": "团队频道与工作消息", en: "Team channels and work messages" } },
  { id: "tool-notion", name: "Notion", description: { "zh-CN": "知识库与项目文档", en: "Knowledge bases and project documents" } },
] satisfies { id: string; name: string; description: Copy }[]

export const workflows = [
  { id: "workflow-status", name: { "zh-CN": "每周项目汇总", en: "Weekly project summary" }, description: { "zh-CN": "收集任务进度，整理风险，起草团队汇报。", en: "Collect task progress, identify risks, and draft a team update." }, steps: { "zh-CN": "收集项目进度 → 整理风险与阻塞 → 起草周报", en: "Collect project progress → Identify risks and blockers → Draft a weekly update" } },
  { id: "workflow-triage", name: { "zh-CN": "议题分流", en: "Issue triage" }, description: { "zh-CN": "汇总未分类议题，建议优先级与负责团队。", en: "Review untriaged issues and suggest priorities and owners." }, steps: { "zh-CN": "读取待分类议题 → 建议标签与优先级 → 生成待审核分派清单", en: "Read untriaged issues → Suggest labels and priorities → Prepare assignments for review" } },
  { id: "workflow-launch", name: { "zh-CN": "上线检查清单", en: "Launch checklist" }, description: { "zh-CN": "检查发布准备情况，生成可审核的上线计划。", en: "Review release readiness and prepare a launch plan for review." }, steps: { "zh-CN": "核对发布范围 → 检查依赖与验收 → 生成上线清单", en: "Confirm release scope → Check dependencies and acceptance → Draft a launch checklist" } },
] satisfies { id: string; name: Copy; description: Copy; steps: Copy }[]

export function directoryContexts(agentName = "Agent brief"): ContextItem[] {
  return [
    ...tools.map((tool) => ({ ...tool, kind: { "zh-CN": "本地工具配置", en: "Local tool configuration" } })),
    ...workflows.map((workflow) => ({ id: workflow.id, name: workflow.name.en, description: workflow.description, kind: { "zh-CN": "流程模板", en: "Workflow template" } })),
    { id: "agent-brief", name: agentName, description: { "zh-CN": "待审核的 Agent 目标与职责；尚未部署。", en: "An agent goal and responsibilities for review; not deployed." }, kind: { "zh-CN": "Agent 草案", en: "Agent brief" } },
  ]
}

export function createComposer3Fixture(scenario: string): ComposerDemoSource {
  const source = createComposerFixture(scenario === "long-content" ? "long-context" : "empty")
  source.contextItems = [...source.contextItems, ...directoryContexts()]
  source.reply = {
    "zh-CN": "这是固定的本地示例回复。已整理你的任务和配置引用，供后续审核。没有创建远程 Agent、连接外部应用或运行工作流；实际执行需要宿主提供服务与授权。",
    en: "This is a fixed local example response. Your task and configuration references are ready for review. No remote agent was created, external app connected, or workflow executed; execution requires host services and authorization.",
  }
  if (scenario === "empty") source.sessions = [source.sessions[0]]
  if (scenario === "readonly") source.canSend = false
  return source
}

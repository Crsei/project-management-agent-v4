import type { ComposerDemoSource } from "../../demo-source"
import type { Copy } from "../../model"

export type ToolId = "github" | "notion" | "slack" | "figma"
export type WorkspaceAgent = {
  id: string
  name: Copy
  shortName: Copy
  description: Copy
  tools: ToolId[]
  prompt: Copy
  kind: "review" | "release" | "research"
}

export const toolItems: { id: ToolId; name: string; description: Copy }[] = [
  { id: "github", name: "GitHub", description: { "zh-CN": "代码仓库、问题和拉取请求", en: "Repositories, issues, and pull requests" } },
  { id: "notion", name: "Notion", description: { "zh-CN": "产品文档和知识库", en: "Product documents and knowledge bases" } },
  { id: "slack", name: "Slack", description: { "zh-CN": "团队讨论和通知", en: "Team conversations and notifications" } },
  { id: "figma", name: "Figma", description: { "zh-CN": "设计稿和组件库", en: "Design files and component libraries" } },
]

export const agentItems: WorkspaceAgent[] = [
  { id: "screen-review", name: { "zh-CN": "界面审查 Agent", en: "Screen Review Agent" }, shortName: { "zh-CN": "界面审查", en: "Screen Review" }, description: { "zh-CN": "审查层级、可访问性和组件一致性。", en: "Reviews hierarchy, accessibility, and component consistency." }, tools: ["figma", "github"], prompt: { "zh-CN": "请界面审查 Agent 帮我", en: "Ask Screen Review Agent to " }, kind: "review" },
  { id: "release-planner", name: { "zh-CN": "发布规划师", en: "Release Planner" }, shortName: { "zh-CN": "发布规划师", en: "Release Planner" }, description: { "zh-CN": "将产品变更整理为清晰的发布清单。", en: "Turns product changes into a clear launch checklist." }, tools: ["github", "slack"], prompt: { "zh-CN": "请发布规划师帮我", en: "Ask Release Planner to " }, kind: "release" },
  { id: "research-assistant", name: { "zh-CN": "研究助手", en: "Research Assistant" }, shortName: { "zh-CN": "研究助手", en: "Research Assistant" }, description: { "zh-CN": "从文档中收集证据，并整理研究简报。", en: "Collects evidence from documents and organizes a research brief." }, tools: ["notion", "slack"], prompt: { "zh-CN": "请研究助手帮我", en: "Ask Research Assistant to " }, kind: "research" },
]

export const workflowItems = [
  { id: "design-review", name: { "zh-CN": "设计审查接收流程", en: "Design review intake" }, description: { "zh-CN": "接收 Figma 设计稿，准备审查清单并汇总到 Slack。", en: "Receive Figma designs, prepare a review checklist, and summarize for Slack." }, tools: ["figma", "slack"] as ToolId[], prompt: { "zh-CN": "为新设计稿准备设计审查接收流程。", en: "Prepare a design review intake workflow for the new screens." } },
  { id: "release-checklist", name: { "zh-CN": "发布检查清单", en: "Release checklist" }, description: { "zh-CN": "根据 GitHub 变更准备发布检查清单。", en: "Prepare a launch checklist from GitHub changes." }, tools: ["github", "notion"] as ToolId[], prompt: { "zh-CN": "根据产品变更准备发布检查清单。", en: "Prepare a release checklist from the product changes." } },
]

export function createComposer4Source(scenario: string): ComposerDemoSource {
  const titles: Copy[] = [
    { "zh-CN": "构建界面审查 Agent", en: "Build a screen review agent" },
    { "zh-CN": "连接产品工具栈", en: "Connect the product stack" },
    { "zh-CN": "自动化设计审查接收", en: "Automate design review intake" },
    { "zh-CN": "规划发布工作流", en: "Plan the release workflow" },
  ]
  const source: ComposerDemoSource = {
    sessions: [
      { id: "welcome", projectId: "easyuse", title: { "zh-CN": "新会话", en: "New session" }, messages: [] },
      ...titles.map((title, index) => ({ id: `chat-${index}`, projectId: "easyuse", title, messages: [{ id: `fixture-${index}`, role: "assistant" as const, text: { "zh-CN": "这是本地会话示例。继续描述任务，选择 Agent 和工具组合。", en: "This is a local conversation example. Describe the task and select an agent and tool combination." } }] })),
    ],
    selectedId: "welcome",
    projectId: "easyuse",
    drafts: { welcome: { text: "", contextIds: [], model: "5.6 Sol", blocks: false } },
    projects: [{ id: "easyuse", name: "EasyuseUI" }, { id: "design", name: "Design team" }],
    contextItems: [
      { id: "composer", name: "ai-chat-composer.tsx", description: { "zh-CN": "共享输入原语和键盘提交行为。", en: "Shared composer primitives and keyboard submit behavior." }, kind: { "zh-CN": "组件", en: "Component" } },
      { id: "package", name: "package.json", description: { "zh-CN": "项目脚本、依赖和运行环境要求。", en: "Project scripts, dependencies, and runtime requirements." }, kind: { "zh-CN": "项目文件", en: "Project file" } },
      { id: "frontend", name: "Frontend agent", description: { "zh-CN": "专注 UI 实现和视觉核验。", en: "Delegate focused UI implementation and visual verification." }, kind: { "zh-CN": "Agent", en: "Agent" } },
      { id: "design", name: "Design guidelines", description: { "zh-CN": "间距、排版、可访问性和交互标准。", en: "Spacing, typography, accessibility, and interaction standards." }, kind: { "zh-CN": "文档", en: "Document" } },
    ],
    models: ["5.6 Sol", "5.6 Terra", "5.6 Luna"],
    suggestions: [],
    reply: { "zh-CN": "任务已记录到本地会话。以下仅为本地规划示例：确认目标和引用材料，检查已选择的 Agent 与工具组合，再准备执行步骤。没有连接外部工具，也没有执行真实 Agent。", en: "The task is recorded in this local conversation. This is a local planning example: confirm the goal and references, review the selected agent and tools, and prepare the steps. No external tool was connected and no real agent was executed." },
    canSend: scenario !== "readonly" && scenario !== "loading",
  }
  if (scenario === "empty" || scenario === "loading") source.sessions = source.sessions.slice(0, 1)
  if (scenario === "readonly") source.drafts.welcome.text = "Review the product screens without changing the original files."
  if (scenario === "long-content") source.drafts.welcome.text = "Review the onboarding screens for hierarchy, accessibility, and component consistency. Include keyboard paths, empty states, error recovery, and recommendations. Preserve the original files and provide a structured checklist.\n\n".repeat(5)
  return source
}

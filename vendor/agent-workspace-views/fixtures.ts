import type {
  ComposerSession,
  ContextItem,
  Copy,
} from "./model.ts"
import type { ComposerDemoSource } from "./demo-source"
export const projects = [
  { id: "admin", name: "AI Admin Kit" },
  { id: "commerce", name: "Commerce Kit" },
  { id: "payment", name: "Payment Kit" },
]

export const contextItems: ContextItem[] = [
  {
    id: "composer",
    name: "agent-composer.tsx",
    description: {
      "zh-CN": "输入框组合、模型选择与键盘提交行为。",
      en: "Composer primitives, model selection, and keyboard submit behavior.",
    },
    kind: { "zh-CN": "组件参考", en: "Component reference" },
  },
  {
    id: "project",
    name: "package.json",
    description: {
      "zh-CN": "项目脚本、依赖和运行环境的示例引用。",
      en: "An example reference to project scripts, dependencies, and runtime.",
    },
    kind: { "zh-CN": "项目参考", en: "Project reference" },
  },
  {
    id: "design",
    name: "Design guidelines",
    description: {
      "zh-CN": "间距、字体、可访问性与交互规范。",
      en: "Spacing, typography, accessibility, and interaction standards.",
    },
    kind: { "zh-CN": "设计参考", en: "Design reference" },
  },
]

export const models = ["5.6 Sol", "5.6 Terra", "5.6 Luna"]
export const suggestions: Copy[] = [
  {
    "zh-CN": "帮我规划新工作空间的项目上线流程",
    en: "Help me plan a project launch for our new workspace",
  },
  {
    "zh-CN": "设计一个清晰的任务审批界面",
    en: "Design a clear task approval interface",
  },
  {
    "zh-CN": "比较两种设置页面的布局",
    en: "Compare two settings page layouts",
  },
]
export const exampleReply: Copy = {
  "zh-CN":
    "可以先从页面目标、主要操作和信息层级开始：\n\n1. 明确用户需要完成的任务和默认状态。\n2. 用现有组件组织导航、内容和操作区域。\n3. 补齐键盘操作、空状态与错误反馈。\n\n这是本地示例回复。当前页面用于预览对话与组件组合，没有连接模型服务。",
  en: "Start with the page goal, primary actions, and information hierarchy:\n\n1. Define the user task and default state.\n2. Compose navigation, content, and actions from existing components.\n3. Include keyboard support, empty states, and error feedback.\n\nThis is a local example response. This page previews chat interactions and component composition without a connected model service.",
}

export const initialSessions: ComposerSession[] = [
  {
    id: "approval",
    projectId: "admin",
    title: { "zh-CN": "优化审批流程", en: "Refine the approval flow" },
    messages: [
      {
        id: "approval-user",
        role: "user",
        text: {
          "zh-CN": "帮我优化任务审批流程。",
          en: "Help me refine the task approval flow.",
        },
      },
      { id: "approval-assistant", role: "assistant", text: exampleReply },
    ],
  },
  {
    id: "settings",
    projectId: "admin",
    title: { "zh-CN": "比较设置页面布局", en: "Compare settings layouts" },
    messages: [
      {
        id: "settings-user",
        role: "user",
        text: {
          "zh-CN": "比较设置页面的两种布局。",
          en: "Compare two settings page layouts.",
        },
      },
      { id: "settings-assistant", role: "assistant", text: exampleReply },
    ],
  },
  {
    id: "billing",
    projectId: "admin",
    title: { "zh-CN": "规划账单工作空间", en: "Plan a billing workspace" },
    messages: [
      {
        id: "billing-user",
        role: "user",
        text: {
          "zh-CN": "规划一个账单管理工作空间。",
          en: "Plan a billing management workspace.",
        },
      },
      { id: "billing-assistant", role: "assistant", text: exampleReply },
    ],
  },
  {
    id: "states",
    projectId: "admin",
    title: { "zh-CN": "审阅界面状态", en: "Review interface states" },
    messages: [
      {
        id: "states-user",
        role: "user",
        text: {
          "zh-CN": "检查界面的空状态和错误反馈。",
          en: "Review the interface empty states and error feedback.",
        },
      },
      { id: "states-assistant", role: "assistant", text: exampleReply },
    ],
  },
]

export const composerScenarios = [
  { id: "empty", name: { "zh-CN": "空会话", en: "Empty" } },
  { id: "conversation", name: { "zh-CN": "已有对话", en: "Conversation" } },
  { id: "long-context", name: { "zh-CN": "长上下文", en: "Long context" } },
  { id: "waiting", name: { "zh-CN": "等待确认", en: "Waiting" } },
  { id: "failed", name: { "zh-CN": "失败", en: "Failed" } },
  { id: "disconnected", name: { "zh-CN": "断线", en: "Disconnected" } },
] as const
export type ComposerScenario = (typeof composerScenarios)[number]["id"]
export function isComposerScenario(value: string): value is ComposerScenario {
  return composerScenarios.some((scenario) => scenario.id === value)
}
export function createComposerFixture(
  scenario: ComposerScenario = "empty",
): ComposerDemoSource {
  const initial: ComposerSession = {
    id: "initial",
    projectId: "admin",
    title: { "zh-CN": "新会话", en: "New session" },
    messages: [],
  }
  const source: ComposerDemoSource = {
    sessions: [initial, ...structuredClone(initialSessions)],
    selectedId: scenario === "empty" ? "initial" : "approval",
    projectId: "admin",
    drafts: {},
    projects: structuredClone(projects),
    contextItems: structuredClone(contextItems),
    models: [...models],
    suggestions: structuredClone(suggestions),
    reply: { ...exampleReply },
    canSend: true,
  }
  if (scenario === "long-context") {
    source.sessions[1].messages = Array.from({ length: 60 }, (_, index) => ({
      id: `long-${index}`,
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      text: {
        "zh-CN": `记录 ${index + 1}：检查页面组件、交互与恢复路径。\n${"这是一段固定的长内容，用于验证滚动与输入区域。".repeat(8)}`,
        en: `Entry ${index + 1}: Review components, interactions and recovery.\n${"Fixed long content to check scrolling and the composer. ".repeat(8)}`,
      },
    }))
    source.drafts.approval = {
      text: "",
      contextIds: ["composer", "project", "design"],
      model: models[0],
      blocks: true,
    }
  }
  if (scenario === "waiting")
    source.runtime = {
      status: "waiting",
      message: {
        "zh-CN": "示例任务正在等待人工确认；此场景不提供审批操作。",
        en: "The example task awaits confirmation; approval is unavailable in this scenario.",
      },
    }
  if (scenario === "failed")
    source.runtime = {
      status: "failed",
      message: {
        "zh-CN": "示例任务失败，已有对话与草稿保留；此场景不会重试执行。",
        en: "The example task failed. Conversation and drafts remain; no execution retry is available.",
      },
    }
  if (scenario === "disconnected")
    source.runtime = {
      status: "unknown",
      message: {
        "zh-CN": "示例连接已断开，执行结果未知；可继续编辑草稿。",
        en: "The example connection is lost and the outcome is unknown. Drafts remain editable.",
      },
    }
  if (source.runtime) source.canSend = false
  return source
}

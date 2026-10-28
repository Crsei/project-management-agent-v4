import type { Copy } from "../../model"

export type NodeId =
  | "schedule"
  | "event"
  | "channels"
  | "memory"
  | "agent"
  | "tools"
  | "skills"
  | "subagents"
export type Choice = { id: string; label: Copy }
export const text = (en: string, zh: string): Copy => ({ en, "zh-CN": zh })
export const nodes: {
  id: NodeId
  title: Copy
  description: Copy
  x: number
  y: number
  width: number
}[] = [
  {
    id: "schedule",
    title: text("Schedule", "定时计划"),
    description: text(
      "Set when the agent checks for new signals. Times are in UTC.",
      "设置代理检查新反馈的时间。所有时间均为 UTC。",
    ),
    x: 24,
    y: 76,
    width: 200,
  },
  {
    id: "event",
    title: text("Event trigger", "事件触发器"),
    description: text(
      "Choose the event and condition that start a run.",
      "选择启动任务的事件与条件。",
    ),
    x: 24,
    y: 214,
    width: 200,
  },
  {
    id: "channels",
    title: text("Channels", "交付渠道"),
    description: text(
      "Choose where the agent delivers its results.",
      "选择代理交付结果的位置。",
    ),
    x: 24,
    y: 374,
    width: 200,
  },
  {
    id: "memory",
    title: text("Memory", "记忆"),
    description: text(
      "Maintain the context this agent carries between runs.",
      "维护代理在任务间保留的上下文。",
    ),
    x: 24,
    y: 548,
    width: 200,
  },
  {
    id: "agent",
    title: text("Agent instructions", "代理指令"),
    description: text(
      "Define its purpose, model, and working instructions.",
      "定义代理的目标、模型与工作指令。",
    ),
    x: 274,
    y: 194,
    width: 248,
  },
  {
    id: "tools",
    title: text("Tools", "工具"),
    description: text(
      "Select the resources this agent can read.",
      "选择代理可读取的资源。",
    ),
    x: 572,
    y: 76,
    width: 204,
  },
  {
    id: "skills",
    title: text("Skills", "技能"),
    description: text(
      "Attach reusable ways of working.",
      "添加可复用的工作方式。",
    ),
    x: 572,
    y: 294,
    width: 204,
  },
  {
    id: "subagents",
    title: text("Sub-agents", "子代理"),
    description: text(
      "Choose specialists available for delegated work.",
      "选择可接受委派任务的专家代理。",
    ),
    x: 572,
    y: 505,
    width: 204,
  },
]
export const choices: Record<
  "tools" | "skills" | "subagents" | "repeat" | "event" | "channel" | "model",
  Choice[]
> = {
  tools: [
    {
      id: "zendesk",
      label: text("Zendesk · Search tickets", "Zendesk · 搜索工单"),
    },
    { id: "notion", label: text("Notion · Read pages", "Notion · 读取页面") },
    { id: "slack", label: text("Slack · Read threads", "Slack · 读取讨论") },
    { id: "github", label: text("GitHub · Read issues", "GitHub · 读取议题") },
    {
      id: "drive",
      label: text("Google Drive · Search files", "Google Drive · 搜索文件"),
    },
  ],
  skills: [
    { id: "clustering", label: text("Signal clustering", "反馈聚类") },
    { id: "verification", label: text("Source verification", "来源验证") },
    { id: "scoring", label: text("Opportunity scoring", "机会评分") },
    { id: "writing", label: text("Concise writing", "简洁写作") },
  ],
  subagents: [
    { id: "researcher", label: text("Evidence researcher", "证据研究员") },
    { id: "editor", label: text("Brief editor", "简报编辑") },
    { id: "coordinator", label: text("Support coordinator", "支持协调员") },
  ],
  repeat: [
    { id: "monday", label: text("Every Monday", "每周一") },
    { id: "weekday", label: text("Every weekday", "每个工作日") },
    { id: "daily", label: text("Every day", "每天") },
    { id: "manual", label: text("Manual only", "仅手动") },
  ],
  event: [
    { id: "support", label: text("New support conversation", "新的支持会话") },
    { id: "issue", label: text("Issue updated", "议题已更新") },
    { id: "document", label: text("Document added", "文档已添加") },
    { id: "manual", label: text("Manual trigger", "手动触发") },
  ],
  channel: [
    { id: "slack", label: text("Slack", "Slack") },
    { id: "email", label: text("Email", "电子邮件") },
    { id: "workspace", label: text("Workspace inbox", "工作区收件箱") },
  ],
  model: [
    { id: "GPT-4.1", label: text("GPT-4.1", "GPT-4.1") },
    {
      id: "Claude Sonnet 4",
      label: text("Claude Sonnet 4", "Claude Sonnet 4"),
    },
    {
      id: "Gemini 2.5 Flash",
      label: text("Gemini 2.5 Flash", "Gemini 2.5 Flash"),
    },
  ],
}
export type AgentConfig = {
  name: string
  purpose: string
  instructions: string
  model: string
  repeat: string
  time: string
  event: string
  condition: string
  channel: string
  destination: string
  approval: boolean
  memory: { id: string; name: string; content: string }[]
  tools: string[]
  skills: string[]
  subagents: string[]
}
export const fixtureCopy = [
  text("Customer signal analyst", "客户反馈分析师"),
  text(
    "Turn customer feedback into the next right decision.",
    "把客户反馈转化为下一个正确决策。",
  ),
  text(
    "Read the latest customer signals and group them by underlying need. Support every finding with a source. Prioritize recurring issues and separate evidence from assumptions. Prepare a brief for human review; never contact customers directly.",
    "阅读最新客户反馈，按潜在需求分组。为每项发现提供来源，优先关注反复出现的问题，区分证据与假设。准备供人工审核的简报；不要直接联系客户。",
  ),
  text("Product priorities", "产品优先事项"),
  text("Previous findings", "历史发现"),
  text(
    "Focus on onboarding, collaboration, and reliable exports this quarter. Prioritize friction that prevents teams from reaching their first shared outcome.",
    "本季度重点关注引导、协作与可靠导出。优先处理阻碍团队完成首次共同成果的问题。",
  ),
  text(
    "Bulk invitations were raised in the previous review. Track new evidence before recommending a second initiative.",
    "上次审核中提到了批量邀请。建议新的举措前，请先收集新的证据。",
  ),
]
export function displayText(value: string, locale: "en" | "zh-CN") {
  return fixtureCopy.find((copy) => copy.en === value)?.[locale] ?? value
}
export function createConfig(scenario: string): AgentConfig {
  const config: AgentConfig = {
    name: fixtureCopy[0].en,
    purpose: fixtureCopy[1].en,
    instructions: fixtureCopy[2].en,
    model: "GPT-4.1",
    repeat: "monday",
    time: "09:00",
    event: "support",
    condition: "priority = high",
    channel: "slack",
    destination: "#customer-insights",
    approval: true,
    memory: [
      { id: "memory-1", name: fixtureCopy[3].en, content: fixtureCopy[5].en },
      { id: "memory-2", name: fixtureCopy[4].en, content: fixtureCopy[6].en },
    ],
    tools: ["zendesk", "notion", "slack"],
    skills: ["clustering", "verification", "scoring"],
    subagents: ["researcher", "editor"],
  }
  if (scenario === "empty")
    return {
      ...config,
      name: "",
      purpose: "",
      instructions: "",
      memory: [],
      tools: [],
      skills: [],
      subagents: [],
    }
  if (scenario === "long-content") {
    config.name =
      "Customer signal analyst · Enterprise onboarding and collaboration research"
    config.instructions +=
      "\n\n" +
      Array.from(
        { length: 8 },
        (_, i) =>
          `Evidence rule ${i + 1}: preserve source attribution, distinguish customer requests from assumptions, and include conflicting reports in the human-review brief.`,
      ).join("\n")
    config.memory.push({
      id: "memory-3",
      name: "Enterprise onboarding decisions and unresolved stakeholder questions",
      content:
        "Review all available context before presenting a recommendation. ".repeat(
          12,
        ),
    })
  }
  return config
}

import type { Copy } from "../../model"

export type Category =
  | "models"
  | "development"
  | "design"
  | "knowledge"
  | "planning"
  | "communication"
  | "support"
  | "monitoring"
export type Integration = {
  id: string
  name: string
  description: Copy
  category: Category
  recommended: boolean
  connected: boolean
  resources: string[]
}
export const categories: { id: Category; name: Copy }[] = [
  { id: "models", name: { "zh-CN": "模型", en: "Models" } },
  { id: "development", name: { "zh-CN": "开发", en: "Development" } },
  { id: "design", name: { "zh-CN": "设计", en: "Design" } },
  { id: "knowledge", name: { "zh-CN": "知识", en: "Knowledge" } },
  { id: "planning", name: { "zh-CN": "规划", en: "Planning" } },
  { id: "communication", name: { "zh-CN": "沟通", en: "Communication" } },
  { id: "support", name: { "zh-CN": "客户支持", en: "Customer support" } },
  { id: "monitoring", name: { "zh-CN": "监控", en: "Monitoring" } },
]
export const integrationFixtures: Integration[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: {
      "zh-CN": "运行推理和语言模型",
      en: "Run reasoning and language models",
    },
    category: "models",
    recommended: true,
    connected: false,
    resources: ["Reasoning model sample", "Language model sample"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: {
      "zh-CN": "在 Agent 运行中使用 Claude",
      en: "Bring Claude into agent runs",
    },
    category: "models",
    recommended: true,
    connected: false,
    resources: ["Claude response sample"],
  },
  {
    id: "github",
    name: "GitHub",
    description: {
      "zh-CN": "读取仓库并审阅拉取请求",
      en: "Read repositories and review pull requests",
    },
    category: "development",
    recommended: true,
    connected: true,
    resources: ["Northstar / workspace", "Pull request #128"],
  },
  {
    id: "slack",
    name: "Slack",
    description: {
      "zh-CN": "搜索频道并发送团队动态",
      en: "Search channels and deliver team updates",
    },
    category: "communication",
    recommended: true,
    connected: true,
    resources: ["#product-updates", "#customer-signals"],
  },
  {
    id: "figma",
    name: "Figma",
    description: {
      "zh-CN": "检查设计文件和组件库",
      en: "Inspect design files and component libraries",
    },
    category: "design",
    recommended: true,
    connected: true,
    resources: ["Northstar design system", "Workspace explorations"],
  },
  {
    id: "notion",
    name: "Notion",
    description: {
      "zh-CN": "查找团队知识和项目笔记",
      en: "Find team knowledge and project notes",
    },
    category: "knowledge",
    recommended: true,
    connected: true,
    resources: ["Product knowledge", "Weekly brief"],
  },
  {
    id: "linear",
    name: "Linear",
    description: {
      "zh-CN": "跟踪问题、迭代与产品决策",
      en: "Track issues, cycles, and product decisions",
    },
    category: "planning",
    recommended: true,
    connected: false,
    resources: ["Cycle 24", "Workspace backlog"],
  },
  {
    id: "vercel",
    name: "Vercel",
    description: {
      "zh-CN": "检查部署和预览构建",
      en: "Inspect deployments and preview builds",
    },
    category: "development",
    recommended: true,
    connected: false,
    resources: ["Preview deployment", "Production deployment"],
  },
  {
    id: "drive",
    name: "Google Drive",
    description: {
      "zh-CN": "在所选文件夹中搜索文档",
      en: "Search documents in selected folders",
    },
    category: "knowledge",
    recommended: false,
    connected: true,
    resources: ["Customer research", "Roadmap documents"],
  },
  {
    id: "gmail",
    name: "Gmail",
    description: {
      "zh-CN": "阅读邮件并准备回复草稿",
      en: "Read threads and prepare draft replies",
    },
    category: "communication",
    recommended: false,
    connected: false,
    resources: ["Customer feedback thread"],
  },
  {
    id: "calendar",
    name: "Google Calendar",
    description: {
      "zh-CN": "读取日程并寻找会议时间",
      en: "Read events and find a time to meet",
    },
    category: "planning",
    recommended: false,
    connected: false,
    resources: ["Product review", "Weekly planning"],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: {
      "zh-CN": "在工作区使用多模态模型",
      en: "Use multimodal models in your workspace",
    },
    category: "models",
    recommended: false,
    connected: false,
    resources: ["Multimodal response sample"],
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: {
      "zh-CN": "审阅合并请求和流水线结果",
      en: "Review merge requests and pipeline results",
    },
    category: "development",
    recommended: false,
    connected: false,
    resources: ["Merge request !42", "Pipeline #301"],
  },
  {
    id: "jira",
    name: "Jira",
    description: {
      "zh-CN": "查找工单并跟踪 Sprint 进度",
      en: "Find tickets and follow sprint progress",
    },
    category: "planning",
    recommended: false,
    connected: false,
    resources: ["NORTH-128", "Sprint 24"],
  },
  {
    id: "zendesk",
    name: "Zendesk",
    description: {
      "zh-CN": "发现客户对话中的共性",
      en: "Surface patterns in customer conversations",
    },
    category: "support",
    recommended: false,
    connected: true,
    resources: ["Ticket #2048", "Customer signals"],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: {
      "zh-CN": "读取错误并调查受影响的发布",
      en: "Read errors and investigate affected releases",
    },
    category: "monitoring",
    recommended: false,
    connected: false,
    resources: ["Release 2.4", "Issue NORTH-19"],
  },
]
export const permissionCopy = {
  read: { "zh-CN": "读取所选资源", en: "Read selected resources" },
  drafts: { "zh-CN": "创建草稿", en: "Create drafts" },
  approvedWrite: {
    "zh-CN": "人工批准后写入",
    en: "Write after human approval",
  },
} satisfies Record<string, Copy>

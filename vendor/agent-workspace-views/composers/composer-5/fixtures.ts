import type { ComposerDemoSource } from "../../demo-source"
import type { Copy } from "../../model.ts"

export type AppId = "notion" | "slack" | "linear" | "drive"
export type WorkspaceReference = {
  id: string
  app: AppId
  name: string
  description: Copy
  kind: Copy
  content: Copy
}
export const apps: { id: AppId; name: string }[] = [
  { id: "notion", name: "Notion" },
  { id: "slack", name: "Slack" },
  { id: "linear", name: "Linear" },
  { id: "drive", name: "Google Drive" },
]
export const prompts = [
  { id: "csv", label: { "zh-CN": "导入 CSV", en: "Import a CSV" }, prompt: { "zh-CN": "导入 CSV 并汇总客户账户", en: "Import a CSV and summarize the customer accounts" } },
  { id: "project", label: { "zh-CN": "询问项目", en: "Ask about a project" }, prompt: { "zh-CN": "总结 Atlas 迁移项目的当前进展", en: "Summarize the current state of the Atlas migration project" } },
  { id: "followup", label: { "zh-CN": "起草跟进邮件", en: "Draft a follow-up" }, prompt: { "zh-CN": "为我最近的客户会议起草跟进邮件", en: "Draft a follow-up for my last customer meeting" } },
  { id: "meeting", label: { "zh-CN": "回顾会议", en: "Recap a meeting" }, prompt: { "zh-CN": "回顾昨天的产品评审并列出后续事项", en: "Recap yesterday’s product review and list the next steps" } },
  { id: "brief", label: { "zh-CN": "撰写简报", en: "Write a brief" }, prompt: { "zh-CN": "结合产品文档和会议记录撰写发布简报", en: "Write a launch brief from the product documents and meeting notes" } },
] as const
export const references: WorkspaceReference[] = [
  { id: "meeting", app: "notion", name: "Customer meeting · Acme", kind: { "zh-CN": "会议记录", en: "Meeting notes" }, description: { "zh-CN": "最近的客户会议、决策和跟进事项。", en: "The latest customer meeting, decisions, and follow-ups." }, content: { "zh-CN": "Acme 客户会议 · 10 月 12 日\n客户确认先迁移分析仪表板，再接入账户同步。Maya 将在周五发送安全问卷；Alex 在下周二提供迁移时间表。跟进邮件应确认这两项承诺，并邀请客户参加下周三的演示。", en: "Acme customer meeting · October 12\nThe customer agreed to migrate analytics dashboards before account sync. Maya will send the security questionnaire on Friday; Alex will share the migration timeline next Tuesday. Confirm both commitments and invite the customer to Wednesday’s demo." } },
  { id: "project", app: "linear", name: "Atlas migration", kind: { "zh-CN": "项目", en: "Project" }, description: { "zh-CN": "迁移里程碑、阻塞项和负责人。", en: "Migration milestones, blockers, and owners." }, content: { "zh-CN": "Atlas 迁移\n已完成 12/16 项任务，数据导入和仪表板验证通过。剩余：权限映射（Alex）、安全审查（Maya）、上线演练（Sam）和账户同步（Priya）。安全审查尚未完成；上线日期为 10 月 23 日，需在评审后确认。", en: "Atlas migration\n12 of 16 tasks are complete; data import and dashboard validation are done. Remaining: permission mapping (Alex), security review (Maya), launch rehearsal (Sam), and account sync (Priya). Security review is still pending. The October 23 launch date requires confirmation after review." } },
  { id: "discussion", app: "slack", name: "#product-launch", kind: { "zh-CN": "讨论", en: "Discussion" }, description: { "zh-CN": "产品评审中的决策与待办。", en: "Product review decisions and action items." }, content: { "zh-CN": "产品评审 · 10 月 12 日\n团队决定先向试点客户发布分析仪表板。Priya 整理帮助文档，Sam 更新发布检查表。账户同步不会包含在首次发布中。下一次检查在周四。", en: "Product review · October 12\nThe team decided to release analytics dashboards to pilot customers first. Priya owns the help docs; Sam updates the launch checklist. Account sync is excluded from the first release. The next checkpoint is Thursday." } },
  { id: "brief", app: "drive", name: "Product launch brief", kind: { "zh-CN": "文档", en: "Document" }, description: { "zh-CN": "发布目标、受众和范围。", en: "Launch goals, audience, and scope." }, content: { "zh-CN": "发布简报\n目标：为试点客户提供统一分析仪表板。受众：Acme 与两家设计合作客户。范围：数据导入、分析视图和权限映射。首次发布不包含账户同步；安全审查是上线前置条件。", en: "Launch brief\nGoal: unified analytics dashboards for pilot customers. Audience: Acme and two design partners. Scope: data import, analytics views, and permission mapping. Account sync is not in the first release; security review is a launch prerequisite." } },
]
const sessionTitles: Copy[] = [
  { "zh-CN": "准备续约跟进", en: "Prepare renewal follow-ups" },
  { "zh-CN": "总结产品访谈", en: "Summarize product interviews" },
  { "zh-CN": "审阅销售漏斗异常", en: "Review pipeline exceptions" },
  { "zh-CN": "起草发布简报", en: "Draft launch brief" },
  { "zh-CN": "整理客户笔记", en: "Organize customer notes" },
  { "zh-CN": "比较每周预测", en: "Compare weekly forecasts" },
  { "zh-CN": "规划合作伙伴联系", en: "Plan partner outreach" },
  { "zh-CN": "审阅入门反馈", en: "Audit onboarding feedback" },
  { "zh-CN": "审阅支持升级事项", en: "Review support escalations" },
  { "zh-CN": "准备季度业务评审", en: "Prepare quarterly business review" },
  { "zh-CN": "总结营销活动结果", en: "Summarize campaign results" },
  { "zh-CN": "检查迁移里程碑", en: "Check migration milestones" },
  { "zh-CN": "起草客户案例", en: "Draft customer case study" },
  { "zh-CN": "审阅账户健康状况", en: "Review account health" },
  { "zh-CN": "规划下一次发布", en: "Plan the next release" },
  { "zh-CN": "核对用量报告", en: "Reconcile usage reports" },
  { "zh-CN": "分析试用转化", en: "Analyze trial conversions" },
  { "zh-CN": "准备团队复盘", en: "Prepare team retrospective" },
  { "zh-CN": "审阅集成请求", en: "Review integration requests" },
  { "zh-CN": "归档已完成项目", en: "Archive completed projects" },
]
export function createFixture(scenario: string, locale: "zh-CN" | "en"): ComposerDemoSource {
  const source: ComposerDemoSource = {
    sessions: [
      { id: "welcome", projectId: "workspace", title: { "zh-CN": "新会话", en: "New session" }, messages: [] },
      ...sessionTitles.map((title, i) => ({ id: `session-${i}`, projectId: "workspace", title, messages: [{ id: `entry-${i}`, role: "assistant" as const, text: references[i % references.length].content }] })),
    ],
    selectedId: "welcome", projectId: "workspace", projects: [{ id: "workspace", name: "EasyuseUI" }],
    drafts: { welcome: { text: scenario === "empty" ? "" : prompts[2].prompt[locale], contextIds: [], blocks: false, model: "5.6 Sol" } },
    contextItems: references, models: ["5.6 Sol", "5.6 Terra", "5.6 Luna", "Daybreak Blue", "Daybreak Red"],
    suggestions: prompts.map(p => p.prompt), reply: { "zh-CN": "本地示例；没有调用模型或外部应用。", en: "Local example; no model or external app was called." },
    canSend: scenario !== "readonly" && scenario !== "loading",
  }
  if (scenario === "empty") source.sessions = source.sessions.slice(0, 1)
  if (scenario === "long-content") {
    source.selectedId = "session-0"
    source.sessions[1].messages = Array.from({ length: 40 }, (_, i) => ({ id: `long-${i}`, role: i % 2 ? "assistant" : "user", text: i % 2 ? references[i % references.length].content : sessionTitles[i % sessionTitles.length], contexts: i % 2 ? [references[i % references.length].name] : [] }))
    source.initialReadingPosition = "start"
  }
  return source
}

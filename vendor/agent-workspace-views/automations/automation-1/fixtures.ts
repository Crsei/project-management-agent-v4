import type { AutomationDraft, AutomationState, TriggerKind } from "./controller"
import type { Copy } from "../../model"

export const triggerCopy: Record<TriggerKind, { title: Copy; description: Copy }> = {
  hourly: { title: { "zh-CN": "每小时运行", en: "Every hour" }, description: { "zh-CN": "使用当前时区", en: "Uses your current timezone" } },
  daily: { title: { "zh-CN": "每天 9:00", en: "Every day at 9:00" }, description: { "zh-CN": "使用当前时区", en: "Uses your current timezone" } },
  weekly: { title: { "zh-CN": "每周一 9:00", en: "Every Monday at 9:00" }, description: { "zh-CN": "使用当前时区", en: "Uses your current timezone" } },
  custom: { title: { "zh-CN": "自定义计划", en: "Custom schedule" }, description: { "zh-CN": "使用当前时区", en: "Uses your current timezone" } },
  once: { title: { "zh-CN": "在指定时间运行一次", en: "Run once at a specific time" }, description: { "zh-CN": "使用当前时区", en: "Uses your current timezone" } },
  test: { title: { "zh-CN": "运行一次", en: "Run once" }, description: { "zh-CN": "用于测试自动化", en: "Test this automation" } },
  webhook: { title: { "zh-CN": "收到外部事件时", en: "When an external event arrives" }, description: { "zh-CN": "连接的应用发送事件时运行", en: "Runs when a connected app sends an event" } },
}
export const models = ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna", "GPT Daybreak Blue", "GPT Daybreak Red"]
export const projects = ["admin-console", "design-system", "customer-portal"]
export const branches = ["main", "release/august", "feat/automation"]
export const conversations: { value: string; label: Copy }[] = [
  { value: "new", label: { "zh-CN": "新会话", en: "New conversation" } },
  { value: "product-review", label: { "zh-CN": "继续产品审查", en: "Continue product review" } },
  { value: "release-planning", label: { "zh-CN": "继续发布计划", en: "Continue release planning" } },
]
export const agents: { value: string; label: Copy }[] = [
  { value: "workspace", label: { "zh-CN": "工作空间 Agent", en: "Workspace agent" } },
  { value: "review", label: { "zh-CN": "审查 Agent", en: "Review agent" } },
  { value: "research", label: { "zh-CN": "研究 Agent", en: "Research agent" } },
]
export const efforts: { value: string; label: Copy }[] = [
  { value: "low", label: { "zh-CN": "低", en: "Low" } },
  { value: "medium", label: { "zh-CN": "中", en: "Medium" } },
  { value: "high", label: { "zh-CN": "高", en: "High" } },
]
const defaultDraft: AutomationDraft = {
  name: { "zh-CN": "完善新收到的产品故事", en: "Refine incoming product story" },
  instructions: { "zh-CN": "审查新创建的产品故事，明确预期结果与验收标准，并应用 PRODUCT_REVIEW.md 中的指导。", en: "Review the newly created product story, clarify its outcome and acceptance criteria, and apply the guidance in PRODUCT_REVIEW.md." },
  enabled: true, project: "admin-console", branch: "main", conversation: "new", model: models[0], effort: "high", agent: "workspace", trigger: null, checks: true, repairs: "1", minutes: "30",
}
export function createAutomationState(scenario: string): AutomationState {
  const newDraft = { ...defaultDraft }
  if (scenario === "empty") { newDraft.name = ""; newDraft.instructions = "" }
  if (scenario === "long-content") {
    newDraft.name = { "zh-CN": "跨团队产品故事与发布验收审查：保留用户研究、可访问性、迁移约束及所有依赖上下文", en: "Cross-team product story and release acceptance review with research, accessibility, migration constraints, and dependency context" }
    newDraft.instructions = Array.from({ length: 18 }, (_, index) => `${index + 1}. Review the product story, preserve the evidence and existing constraints, and verify acceptance criteria before proposing a change.`).join("\n")
  }
  const saved = [
    { id: "product-story", draft: { ...defaultDraft } },
    { id: "release-notes", draft: { ...defaultDraft, name: { "zh-CN": "审查每周发布说明", en: "Review weekly release notes" }, instructions: { "zh-CN": "审查本周发布说明，标记不清楚的客户影响，并准备简洁且可直接发布的摘要。", en: "Review this week's release notes, flag unclear customer impact, and prepare a concise publish-ready summary." } } },
    { id: "support-triage", draft: { ...defaultDraft, name: { "zh-CN": "分类升级的支持请求", en: "Triage support escalations" }, instructions: { "zh-CN": "审查升级的支持请求，整理相关上下文，并建议下一步负责人和行动。", en: "Review incoming support escalations, collect the relevant context, and suggest the next owner and action." } } },
  ]
  const drafts = Object.fromEntries(saved.map(record => [record.id, { ...record.draft }]))
  drafts.new = newDraft
  return { selected: "new", drafts, saved: scenario === "empty" ? [] : saved, baseline: Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, { ...draft }])), sequence: 0, data: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "refresh-error" : "ready", readonly: scenario === "readonly", settingsOpen: false, sidebarVisible: true, notice: null }
}

import type { ComposerDemoSource } from "../../demo-source"
import type { ContextItem, Copy } from "../../model"
import { createComposerFixture } from "../../fixtures.ts"

export type ShortcutItem = {
  id: string
  title: Copy
  description: Copy
  trailing: Copy
  kind: "command" | "component" | "file" | "agent" | "document"
}

export const commands: ShortcutItem[] = [
  { id: "review", title: { "zh-CN": "审阅改动", en: "Review changes" }, description: { "zh-CN": "检查当前差异中的回归和缺失测试。", en: "Inspect the current diff for regressions and missing tests." }, trailing: { "zh-CN": "/review", en: "/review" }, kind: "command" },
  { id: "test", title: { "zh-CN": "运行相关测试", en: "Run relevant tests" }, description: { "zh-CN": "为这次改动选择最小且有效的验证集。", en: "Choose the smallest useful verification set for this change." }, trailing: { "zh-CN": "/test", en: "/test" }, kind: "command" },
  { id: "explain", title: { "zh-CN": "解释选中内容", en: "Explain selection" }, description: { "zh-CN": "解释选中的代码及其设计决策。", en: "Describe the selected code and the decisions behind it." }, trailing: { "zh-CN": "/explain", en: "/explain" }, kind: "command" },
  { id: "fix", title: { "zh-CN": "修复问题", en: "Fix an issue" }, description: { "zh-CN": "诊断问题，实现最小修复，并进行验证。", en: "Diagnose a bug, implement the smallest fix, and verify it." }, trailing: { "zh-CN": "/fix", en: "/fix" }, kind: "command" },
]

export const contexts: ShortcutItem[] = [
  { id: "composer", title: { "zh-CN": "ai-chat-composer.tsx", en: "ai-chat-composer.tsx" }, description: { "zh-CN": "共用输入原语和键盘提交行为。", en: "Shared composer primitives and keyboard submit behavior." }, trailing: { "zh-CN": "组件", en: "Component" }, kind: "component" },
  { id: "project", title: { "zh-CN": "package.json", en: "package.json" }, description: { "zh-CN": "项目脚本、依赖和运行环境要求。", en: "Project scripts, dependencies, and runtime requirements." }, trailing: { "zh-CN": "项目文件", en: "Project file" }, kind: "file" },
  { id: "frontend", title: { "zh-CN": "前端 Agent", en: "Frontend agent" }, description: { "zh-CN": "委派专注的 UI 实现和视觉验证。", en: "Delegate focused UI implementation and visual verification." }, trailing: { "zh-CN": "Agent", en: "Agent" }, kind: "agent" },
  { id: "design", title: { "zh-CN": "设计规范", en: "Design guidelines" }, description: { "zh-CN": "间距、字体、可访问性和交互标准。", en: "Spacing, typography, accessibility, and interaction standards." }, trailing: { "zh-CN": "文档", en: "Document" }, kind: "document" },
]

const chatTitles: Copy[] = [
  { "zh-CN": "梳理 Agent 审批状态", en: "Map agent approval states" },
  { "zh-CN": "审阅产品表格密度", en: "Review product table density" },
  { "zh-CN": "选择活动方向", en: "Choose campaign direction" },
  { "zh-CN": "总结每周启动会", en: "Summarize weekly kickoff" },
  { "zh-CN": "构建收入概览", en: "Build revenue overview" },
  { "zh-CN": "预览营销页面", en: "Preview marketing page" },
  { "zh-CN": "综合录音内容", en: "Synthesize recording" },
  { "zh-CN": "规划账单 Webhook 迁移", en: "Plan billing webhook migration" },
  { "zh-CN": "研究批量操作反馈", en: "Research bulk action feedback" },
  { "zh-CN": "生成管理端批量操作", en: "Generate admin bulk actions" },
  { "zh-CN": "验证生成的批量操作", en: "Verify generated bulk actions" },
  { "zh-CN": "排队产品审阅后续任务", en: "Queue product review follow-ups" },
  { "zh-CN": "审阅并提交已验证改动", en: "Review and commit verified changes" },
  { "zh-CN": "分流支持积压任务", en: "Triage support backlog" },
  { "zh-CN": "比较回复版本", en: "Compare response versions" },
  { "zh-CN": "审阅发布阻塞项", en: "Review release blockers" },
  { "zh-CN": "审阅组件归属", en: "Review component ownership" },
  { "zh-CN": "恢复账单重试会话", en: "Recover billing retry session" },
  { "zh-CN": "压缩结账迁移上下文", en: "Compact checkout migration context" },
]

export function createFixture(scenario: string): ComposerDemoSource {
  const source = createComposerFixture("empty")
  const contextItems: ContextItem[] = contexts.map((item) => ({ id: item.id, name: item.title.en, description: item.description, kind: item.trailing }))
  if (scenario === "long-content") contextItems.push({ id: "long-file", name: "packages/agent-workspace-views/composers/composer-7/command-context-and-shell-interaction-review-with-accessibility-evidence.tsx", description: { "zh-CN": "用于验证长引用的完整名称与横向滚动。", en: "A long reference for full-name and horizontal scrolling checks." }, kind: { "zh-CN": "组件", en: "Component" } })
  source.contextItems = contextItems
  source.sessions = [source.sessions[0], ...chatTitles.map((title, index) => ({ id: `reference-chat-${index}`, projectId: "admin", title, messages: [{ id: `reference-message-${index}`, role: "assistant" as const, text: { "zh-CN": "这是本地会话记录。可继续编辑草稿；没有连接模型或执行服务。", en: "This is a local conversation record. Continue editing a draft; no model or execution service is connected." } }] }))]
  const text = scenario === "empty" ? "" : scenario === "context" ? "@" : scenario === "shell" ? "!" : scenario === "long-content" ? "Review keyboard behavior and preserve this unsent draft.\n".repeat(9) : "/"
  source.drafts.initial = { text, contextIds: scenario === "long-content" ? ["composer", "design", "long-file"] : [], model: source.models[0], blocks: false }
  source.canSend = scenario !== "readonly" && scenario !== "loading"
  source.suggestions = []
  return source
}

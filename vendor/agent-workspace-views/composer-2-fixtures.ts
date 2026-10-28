import type { AttachmentStatus } from "@easyuse-ui/ui/components/ui/attachment"
import { createComposerFixture } from "./fixtures"
import type { ComposerDemoSource } from "./demo-source"
import type { Copy } from "./model"

export type Composer2Attachment = {
  id: string
  name: string
  kind: "document" | "image" | "folder" | "area" | "element"
  description: Copy
  summary: Copy
  status: AttachmentStatus
  error?: Copy
}
export type Composer2Source = ComposerDemoSource & {
  attachmentItems: Composer2Attachment[]
}

export const composer2Scenarios = [
  { id: "default", name: { "zh-CN": "默认附件", en: "Attachments" } },
  { id: "conversation", name: { "zh-CN": "已有对话", en: "Conversation" } },
  { id: "long-context", name: { "zh-CN": "长内容与文件名", en: "Long content" } },
  { id: "loading", name: { "zh-CN": "解析中", en: "Processing" } },
  { id: "failed", name: { "zh-CN": "引用失效", en: "Failed reference" } },
  { id: "unknown", name: { "zh-CN": "状态未知", en: "Unknown" } },
] as const
export type Composer2Scenario = (typeof composer2Scenarios)[number]["id"]
export function isComposer2Scenario(value: string): value is Composer2Scenario {
  return composer2Scenarios.some((scenario) => scenario.id === value)
}

const attachments: Composer2Attachment[] = [
  {
    id: "audit",
    name: "admin-audit-brief.pdf",
    kind: "document",
    description: { "zh-CN": "PDF · 2.3 MB · 93 行", en: "PDF · 2.3 MB · 93 lines" },
    summary: {
      "zh-CN": "管理界面审阅：导航层级、输入区密度、交互状态，以及从对话进入 Agent 工作流的路径。这是固定示例摘要。",
      en: "Admin screen audit: navigation hierarchy, composer density, interaction states, and the transition from chat to agent workflows. This is a fixed example summary.",
    },
    status: "done",
  },
  {
    id: "image",
    name: "composer-reference.png",
    kind: "image",
    description: { "zh-CN": "PNG · 640 KB · 示例图片描述", en: "PNG · 640 KB · Example image descriptor" },
    summary: {
      "zh-CN": "输入框参考：附件位于输入区顶部，模型与发送操作保持清晰。这是示例描述，没有读取图片内容。",
      en: "Composer reference: attachments sit above the input, with clear model and send actions. This is an example descriptor; image content was not read.",
    },
    status: "done",
  },
  {
    id: "notes",
    name: "Navigation notes",
    kind: "folder",
    description: { "zh-CN": "文档引用 · 12 条备注", en: "Document reference · 12 notes" },
    summary: {
      "zh-CN": "导航备注：区分站点与工作空间导航，保留当前会话、未发送草稿和阅读位置。",
      en: "Navigation notes: distinguish site and workspace navigation, preserving the current session, unsent draft, and reading position.",
    },
    status: "done",
  },
]

export function createComposer2Fixture(
  scenario: Composer2Scenario = "default",
): Composer2Source {
  const base = createComposerFixture(scenario === "long-context" ? "long-context" : "empty")
  const source: Composer2Source = {
    ...base,
    attachmentItems: structuredClone(attachments),
    contextItems: [],
    reply: {
      "zh-CN": "我会按引用摘要检查导航层级、输入区和恢复路径，再整理可执行的界面建议。\n\n这是固定的本地示例回复；没有读取文件内容、上传附件或调用模型服务。",
      en: "I will review navigation hierarchy, the composer, and recovery paths using the reference summaries, then organize actionable UI suggestions.\n\nThis is a fixed local example response. No file contents were read, attachments uploaded, or model service called.",
    },
  }
  if (scenario === "conversation" || scenario === "long-context") source.selectedId = "approval"
  const selectedId = source.selectedId
  source.drafts[selectedId] = {
    text: "",
    contextIds: source.attachmentItems.map((item) => item.id),
    model: source.models[0],
    blocks: false,
  }
  if (scenario === "conversation") {
    source.sessions.find((session) => session.id === selectedId)!.messages = [
      { id: "reference-user", role: "user", text: { "zh-CN": "结合引用材料，检查输入区与导航层级。", en: "Review the composer and navigation hierarchy using the references." }, contexts: source.attachmentItems.map((item) => item.name) },
      { id: "reference-answer", role: "assistant", text: source.reply },
    ]
  }
  if (scenario === "long-context") {
    source.attachmentItems[0].name = "admin-workspace-navigation-and-composer-accessibility-review-with-detailed-recovery-notes-2026-final.pdf"
    source.attachmentItems.push({ ...structuredClone(attachments[2]), id: "long-notes", name: "工作空间导航与输入区状态恢复检查记录-包含长文件名完整可访问名称和附件横向滚动验证.md" })
  }
  if (scenario === "loading") {
    source.attachmentItems[0].status = "processing"
    source.drafts[selectedId].text = "整理这份审阅材料的主要建议。"
  }
  if (scenario === "failed") {
    source.attachmentItems[0].status = "error"
    source.attachmentItems[0].error = { "zh-CN": "示例引用已失效。移除失效引用后可发送，草稿已保留。", en: "The example reference is unavailable. Remove it to send; your draft is preserved." }
    source.drafts[selectedId].text = "结合审阅材料，优化工作空间的导航。"
    source.runtime = { status: "failed", message: { "zh-CN": "本地示例提交失败：引用已失效；尚未执行模型请求。", en: "Local example submission failed: a reference is unavailable; no model request ran." } }
  }
  if (scenario === "unknown") {
    source.attachmentItems[0].status = "unknown"
    source.drafts[selectedId].text = "结合附件，整理下一步的界面修改建议。"
    source.runtime = { status: "unknown", message: { "zh-CN": "示例连接中断，提交结果尚未确认。先检查本地示例状态；不会自动重发。", en: "The example connection was interrupted and submission is unconfirmed. Check the local example status first; it will not resend automatically." } }
  }
  source.drafts[selectedId].contextIds = source.attachmentItems.map((item) => item.id)
  return source
}

import type { ComposerDemoSource } from "../../demo-source"
import type { ComposerSession, Copy, Draft } from "../../model"

export const chatTitle: Copy = { "zh-CN": "新聊天", en: "New chat" }
export const models = ["5.6 Sol", "5.6 Terra", "5.6 Luna", "Daybreak Blue", "Daybreak Red"]
export const exampleReply: Copy = {
  "zh-CN": "我会梳理结构、保留重要约束，并明确下一步行动。请提供草稿或来源笔记，我会给出聚焦的第一版。\n\n这是本地示例回复，没有调用模型服务。",
  en: "I’ll tighten the structure, preserve the important constraints, and make the next action obvious. Paste the draft or source notes and I’ll produce a focused first pass.\n\nThis is a local example response; no model service was called.",
}
export const suggestionItems: { id: string; title: Copy; prompt: Copy; icon: "draft" | "actions" | "compare" | "search" | "approval" | "release" }[] = [
  { id: "update", icon: "draft", title: { "zh-CN": "精简面向客户的更新", en: "Tighten a customer-facing update" }, prompt: { "zh-CN": "精简这份面向客户的更新，并保留具体的发布细节。", en: "Tighten this customer-facing update while keeping the rollout details specific." } },
  { id: "meeting", icon: "actions", title: { "zh-CN": "将会议笔记整理为明确行动", en: "Turn meeting notes into clear actions" }, prompt: { "zh-CN": "将会议笔记整理为明确的行动项，包括负责人和下一步。", en: "Turn these meeting notes into clear actions with owners and next steps." } },
  { id: "compare", icon: "compare", title: { "zh-CN": "比较两个回复方向", en: "Compare two response directions" }, prompt: { "zh-CN": "比较这两个回复方向，说明各自的取舍。", en: "Compare these two response directions and explain the tradeoffs." } },
  { id: "context", icon: "search", title: { "zh-CN": "总结最新项目背景", en: "Summarize the latest project context" }, prompt: { "zh-CN": "总结最新项目背景，区分已确认的决定和待解决的问题。", en: "Summarize the latest project context, separating confirmed decisions from open questions." } },
  { id: "approval", icon: "approval", title: { "zh-CN": "重写审批理由", en: "Rewrite an approval rationale" }, prompt: { "zh-CN": "重写这段审批理由，保留重要约束与决策边界。", en: "Rewrite this approval rationale while preserving the important constraints and decision boundary." } },
  { id: "release", icon: "release", title: { "zh-CN": "创建简短发布简报", en: "Create a short release brief" }, prompt: { "zh-CN": "创建简短的发布简报，包括变更内容、受众和下一步。", en: "Create a short release brief covering what changed, the audience, and next steps." } },
]
const recentTitles: Copy[] = [
  { "zh-CN": "精简发布更新", en: "Tighten launch update" },
  { "zh-CN": "重写客户通知", en: "Rewrite customer notice" },
  { "zh-CN": "明确迁移摘要", en: "Clarify migration summary" },
  { "zh-CN": "缩短每周简报", en: "Shorten weekly briefing" },
  { "zh-CN": "完善审批理由", en: "Refine approval rationale" },
  { "zh-CN": "润色发布说明", en: "Polish release notes" },
]
export function emptyDraft(): Draft {
  return { text: "", contextIds: [], model: models[0], blocks: false }
}
export function createComposer6Source(scenario: string): ComposerDemoSource {
  const sessions: ComposerSession[] = [{ id: "welcome", projectId: "workspace", title: chatTitle, messages: [] }]
  if (scenario !== "empty") recentTitles.forEach((title, index) => sessions.push({
    id: `recent-${index}`, projectId: "workspace", title,
    messages: [
      { id: `recent-${index}-user`, role: "user", text: index === 2 ? { "zh-CN": "明确迁移摘要，并明确保留回滚边界。", en: "Clarify the migration summary and keep the rollback boundary explicit." } : suggestionItems[index].prompt },
      { id: `recent-${index}-assistant`, role: "assistant", text: index === 2 ? { "zh-CN": "我会区分已确认的背景和待定决策，然后将其余内容精简为采取行动所需的信息。准备好后，请提供项目笔记。", en: "I’ll separate confirmed context from open decisions, then reduce the rest to the details someone needs to act. Add the project notes whenever you’re ready." } : exampleReply },
    ],
  }))
  const drafts: Record<string, Draft> = { welcome: emptyDraft() }
  if (scenario === "long-content") {
    drafts.welcome = { ...emptyDraft(), text: "请比较迁移方案，保留回滚边界与发布约束。\n".repeat(18) }
    sessions[1].title = { "zh-CN": "精简包含多个受众、发布阶段、回滚条件和审批边界的客户更新", en: "Tighten a customer update covering multiple audiences, rollout stages, rollback conditions, and approval boundaries" }
    sessions[1].messages.push(...Array.from({ length: 16 }, (_, index) => ({ id: `long-${index}`, role: "assistant" as const, text: { "zh-CN": `阶段 ${index + 1}：保留重要约束、负责人和回滚条件。\n` + "每个决定都应明确其来源与下一步，未确认的信息不应被当作事实。".repeat(12), en: `Stage ${index + 1}: Preserve important constraints, owners, and rollback conditions.\n` + "Every decision needs a source and a next step; unconfirmed information must not be treated as fact. ".repeat(12) } })))
  }
  return { sessions, selectedId: "welcome", projectId: "workspace", drafts, projects: [{ id: "workspace", name: "EasyuseUI" }], contextItems: [], models, suggestions: suggestionItems.map(item => item.title), reply: exampleReply, canSend: scenario !== "readonly" && scenario !== "loading" }
}

export const savedStartingPoints = [
  ...suggestionItems,
  { id: "audience", title: { "zh-CN": "为不同受众改写摘要", en: "Adapt a summary for different audiences" }, prompt: { "zh-CN": "为客户和内部团队分别改写这份摘要，保留一致的事实。", en: "Adapt this summary for customers and the internal team, preserving the same facts." } },
  { id: "risks", title: { "zh-CN": "列出发布风险和应对措施", en: "Outline release risks and mitigations" }, prompt: { "zh-CN": "列出发布计划的主要风险、对应措施和负责人。", en: "Outline the main risks in this release plan, with mitigations and owners." } },
  { id: "rollback", title: { "zh-CN": "明确回滚条件", en: "Clarify rollback conditions" }, prompt: { "zh-CN": "明确迁移方案的回滚条件、决策人和检查点。", en: "Clarify the migration rollback conditions, decision owner, and checkpoints." } },
  { id: "handoff", title: { "zh-CN": "整理项目交接清单", en: "Prepare a project handoff checklist" }, prompt: { "zh-CN": "将项目笔记整理为交接清单，区分已完成事项与待办。", en: "Turn these project notes into a handoff checklist, separating completed work from open items." } },
  { id: "decisions", title: { "zh-CN": "提取已确认的决策", en: "Extract confirmed decisions" }, prompt: { "zh-CN": "提取笔记中已确认的决策，标出每项的依据和时间。", en: "Extract confirmed decisions from these notes, showing the source and date for each." } },
  { id: "briefing", title: { "zh-CN": "准备领导简报", en: "Prepare a leadership briefing" }, prompt: { "zh-CN": "准备一份简短的领导简报，包括进展、风险和需要的决策。", en: "Prepare a short leadership briefing covering progress, risks, and decisions needed." } },
]

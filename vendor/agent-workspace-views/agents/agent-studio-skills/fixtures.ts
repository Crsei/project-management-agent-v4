export type Copy = { "zh-CN": string; en: string }
export type SkillType = "Research" | "Strategy" | "Engineering" | "Writing" | "Support"
export type StudioSkill = {
  id: string
  name: string
  type: SkillType
  description: Copy
  instructions: Copy
  author: string
  updated: Copy
  agentIds: string[]
}
export const skillTypeLabels: Record<SkillType, Copy> = {
  Research: { "zh-CN": "研究", en: "Research" },
  Strategy: { "zh-CN": "策略", en: "Strategy" },
  Engineering: { "zh-CN": "工程", en: "Engineering" },
  Writing: { "zh-CN": "写作", en: "Writing" },
  Support: { "zh-CN": "支持", en: "Support" },
}
export const studioAgents = [
  { id: "customer", name: { "zh-CN": "客户信号分析师", en: "Customer signal analyst" } },
  { id: "release", name: { "zh-CN": "发布审查员", en: "Release reviewer" } },
  { id: "knowledge", name: { "zh-CN": "知识策展人", en: "Knowledge curator" } },
  { id: "support", name: { "zh-CN": "支持协调员", en: "Support coordinator" } },
] as const
export const studioSkills: StudioSkill[] = [
  { id: "signal-clustering", name: "signal-clustering", type: "Research", description: { "zh-CN": "将客户反馈整理为有证据支持的主题。", en: "Group customer feedback into evidence-backed themes." }, instructions: { "zh-CN": "按潜在需求对反馈分组。将每个主题链接到来源。区分反复出现的模式和一次性请求。", en: "Group feedback by the underlying need. Link every theme to its source. Separate recurring patterns from one-off requests." }, author: "Maya", updated: { "zh-CN": "2 小时前", en: "2h ago" }, agentIds: ["customer", "support"] },
  { id: "opportunity-scoring", name: "opportunity-scoring", type: "Strategy", description: { "zh-CN": "根据覆盖范围、影响和置信度对机会排序。", en: "Rank opportunities by reach, impact, and confidence." }, instructions: { "zh-CN": "按覆盖范围、影响、置信度和投入对每个机会评分。列明假设，并展示评分依据。", en: "Score each opportunity on reach, impact, confidence, and effort. State assumptions and show the evidence behind the score." }, author: "Alex", updated: { "zh-CN": "昨天", en: "Yesterday" }, agentIds: ["customer"] },
  { id: "release-review", name: "release-review", type: "Engineering", description: { "zh-CN": "检查变更中的回归和发布风险。", en: "Review a change for regressions and rollout risks." }, instructions: { "zh-CN": "对照意图审查差异。识别回归、缺失的测试覆盖和发布风险。优先列出可执行的发现。", en: "Review the diff against its intent. Identify regressions, missing coverage, and rollout risks. Prioritize actionable findings." }, author: "Sam", updated: { "zh-CN": "3 天前", en: "3d ago" }, agentIds: ["release"] },
  { id: "source-check", name: "source-check", type: "Research", description: { "zh-CN": "对照原始资料核实论断。", en: "Verify claims against the original material." }, instructions: { "zh-CN": "对照原始来源核实每个重要论断。保留上下文并标记冲突，不默默选择一方。", en: "Check every material claim against the original source. Preserve context and flag conflicts instead of choosing silently." }, author: "Maya", updated: { "zh-CN": "4 天前", en: "4d ago" }, agentIds: ["customer", "knowledge"] },
  { id: "concise-writing", name: "concise-writing", type: "Writing", description: { "zh-CN": "将详细发现转化为清晰的决策简报。", en: "Turn detailed findings into a clear decision brief." }, instructions: { "zh-CN": "先说明决策。使用平实语言，保留不确定性，并以具体后续步骤收尾。", en: "Lead with the decision. Use plain language, preserve uncertainties, and end with concrete next steps." }, author: "Jordan", updated: { "zh-CN": "1 周前", en: "1w ago" }, agentIds: ["knowledge", "support"] },
  { id: "ticket-triage", name: "ticket-triage", type: "Support", description: { "zh-CN": "识别紧急程度并分派支持请求。", en: "Identify urgency and route support requests." }, instructions: { "zh-CN": "识别客户问题、紧急程度和下一位负责人。将账户安全和付款争议升级为人工审查。", en: "Identify the customer issue, urgency, and next owner. Escalate account security and payment disputes for human review." }, author: "Alex", updated: { "zh-CN": "1 周前", en: "1w ago" }, agentIds: ["support"] },
]
export const skillCollections = [
  { id: "customer", kind: "research", category: { "zh-CN": "研究与策略", en: "Research & strategy" }, name: { "zh-CN": "客户情报", en: "Customer intelligence" }, description: { "zh-CN": "从零散反馈到清晰的下一步。", en: "From scattered feedback to a clear next step." }, skillIds: ["signal-clustering", "opportunity-scoring", "source-check"] },
  { id: "engineering", kind: "engineering", category: { "zh-CN": "开发", en: "Development" }, name: { "zh-CN": "工程审查", en: "Engineering review" }, description: { "zh-CN": "以证据和信心交付变更。", en: "Ship changes with evidence and confidence." }, skillIds: ["release-review", "source-check"] },
  { id: "support", kind: "support", category: { "zh-CN": "客户体验", en: "Customer experience" }, name: { "zh-CN": "支持运营", en: "Support operations" }, description: { "zh-CN": "快速分流，让人工始终参与其中。", en: "Triage quickly. Keep the human in the loop." }, skillIds: ["ticket-triage", "concise-writing"] },
] as const

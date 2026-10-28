export type Copy = { "zh-CN": string; en: string }
export const initialInstructions = "You are a helpful support specialist for Acme.\n\n1. Identify the customer's issue and its urgency.\n2. Search the help center for an approved answer.\n3. Cite the article you use, and be clear about next steps.\n4. Escalate billing disputes or account security issues to a human.\n\nBe warm, concise, and never promise an action you cannot perform."
export const previousInstructions = "Answer customer questions using the help center. Keep responses concise and helpful."
export const testMessage = "A customer was charged twice for their subscription. How should we help?"
export const models = ["gpt-4.1", "claude-sonnet-4", "gemini-2.5-flash"] as const
export const environments = [
  { value: "production", label: { "zh-CN": "支持 · 生产", en: "Support · production" } },
  { value: "staging", label: { "zh-CN": "支持 · 测试", en: "Support · staging" } },
  { value: "sandbox", label: { "zh-CN": "个人沙盒", en: "Personal sandbox" } },
] as const
export const tools = [
  { id: "file_search", name: { "zh-CN": "搜索知识库", en: "Search knowledge" }, description: { "zh-CN": "在客户帮助中心查找答案。", en: "Find answers in the customer help center." }, permission: { "zh-CN": "只读", en: "Read only" } },
  { id: "create_ticket", name: { "zh-CN": "创建支持工单", en: "Create support ticket" }, description: { "zh-CN": "将未解决的问题转交支持团队。", en: "Route unresolved issues to the support team." }, permission: { "zh-CN": "需要审批", en: "Requires approval" } },
  { id: "code_interpreter", name: { "zh-CN": "代码解释器", en: "Code interpreter" }, description: { "zh-CN": "在隔离运行环境中分析附加的 CSV 文件。", en: "Analyze attached CSV files in an isolated runtime." }, permission: { "zh-CN": "沙盒", en: "Sandboxed" } },
] as const
export type ToolId = (typeof tools)[number]["id"]

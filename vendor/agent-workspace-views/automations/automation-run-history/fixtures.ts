export type AutomationId = "weekly-brief" | "support-digest" | "document-review"
export type RunOutcome = "success" | "error" | "blocked"
export type RunCopy = { "zh-CN": string; en: string }
export type AutomationRun = {
  id: string
  automationId: AutomationId
  title: RunCopy
  time: string
  event: string
  outcome: RunOutcome
  statusCode: string
  duration: string
  message: RunCopy
  capturedEvent: Record<string, string>
  output?: RunCopy
  replayOf?: string
}

export const automationNames: Record<AutomationId, RunCopy> = {
  "weekly-brief": { "zh-CN": "每周项目简报", en: "Weekly project brief" },
  "support-digest": { "zh-CN": "支持摘要", en: "Support digest" },
  "document-review": { "zh-CN": "文档审阅", en: "Document review" },
}

/** Captured reference structure; all records and replay outputs are local fixtures. */
export function createRunFixtures(longContent = false): AutomationRun[] {
  const runs: AutomationRun[] = [
    {
      id: "exec-205", automationId: "weekly-brief", title: automationNames["weekly-brief"],
      time: "09:00", event: "schedule.weekly", outcome: "success", statusCode: "200", duration: "8.2s",
      message: { "zh-CN": "简报已生成并保存到工作区。", en: "Brief prepared and saved to the workspace." },
      capturedEvent: { event: "schedule.weekly", project: "Product planning", period: "Previous week" },
      output: {
        "zh-CN": "# 每周项目简报\n\n- 已审阅入门流程证据。\n- 已准备首次会话大纲。\n- 对留存率的影响仍需验证。",
        en: "# Weekly project brief\n\n- Onboarding evidence reviewed.\n- First-session outline prepared.\n- Retention impact remains a validation question.",
      },
    },
    {
      id: "exec-204", automationId: "support-digest", title: automationNames["support-digest"],
      time: "08:45", event: "support.digest.ready", outcome: "error", statusCode: "504", duration: "10.0s",
      message: { "zh-CN": "演示投递端点在超时前未响应。", en: "The demo delivery endpoint did not respond before the timeout." },
      capturedEvent: { event: "support.digest.ready", queue: "Customer support", destination: "workspace-digest" },
    },
    {
      id: "exec-203", automationId: "document-review", title: automationNames["document-review"],
      time: "08:30", event: "document.updated", outcome: "blocked", statusCode: "Policy", duration: "0.2s",
      message: { "zh-CN": "请求的文件夹不在此自动化获准访问的范围内。", en: "The requested folder is outside this automation’s approved scope." },
      capturedEvent: { event: "document.updated", document: "Planning notes", folder: "Restricted archive" },
    },
    {
      id: "exec-202", automationId: "support-digest", title: automationNames["support-digest"],
      time: "08:00", event: "support.digest.ready", outcome: "success", statusCode: "200", duration: "4.6s",
      message: { "zh-CN": "支持主题已汇总到工作区。", en: "Support themes summarized in the workspace." },
      capturedEvent: { event: "support.digest.ready", queue: "Customer support", destination: "workspace-digest" },
      output: {
        "zh-CN": "# 支持摘要\n\n- 邀请说明不清晰是反复出现的问题。\n- 导入指南需要明确的下一步。\n- 权限问题主要集中在共享操作。",
        en: "# Support digest\n\n- Invitation clarity is a recurring theme.\n- Import guidance needs a visible next step.\n- Permission questions cluster around sharing.",
      },
    },
    {
      id: "exec-201", automationId: "document-review", title: automationNames["document-review"],
      time: "07:30", event: "document.updated", outcome: "success", statusCode: "200", duration: "3.1s",
      message: { "zh-CN": "审阅笔记已保存，包含两个待跟进的问题。", en: "Review note saved with two follow-up questions." },
      capturedEvent: { event: "document.updated", document: "Onboarding outline", folder: "Product planning" },
      output: {
        "zh-CN": "# 文档审阅\n\n大纲支持独立完成设置。请验证邀请说明的清晰度，并避免在建议中作出未经证实的留存率承诺。",
        en: "# Document review\n\nThe outline supports solo setup. Validate invitation clarity and keep retention claims out of the recommendation.",
      },
    },
  ]
  if (!longContent) return runs
  runs[1] = {
    ...runs[1],
    title: {
      "zh-CN": "支持摘要 · 跨地区客户支持反馈与工作区权限问题的完整分析记录",
      en: "Support digest · Complete cross-region customer feedback and workspace permission analysis",
    },
    capturedEvent: { ...runs[1].capturedEvent, notes: "Captured local fixture with extended review context. ".repeat(24) },
  }
  return [...runs, ...Array.from({ length: 35 }, (_, index) => ({
    ...runs[index % runs.length],
    id: `exec-${200 - index}`,
    time: `${String(7 - Math.floor(index / 12)).padStart(2, "0")}:${String(55 - (index % 12) * 5).padStart(2, "0")}`,
    capturedEvent: { ...runs[index % runs.length].capturedEvent },
  }))]
}

export type Localized = { "zh-CN": string; en: string }
export type Skill = {
  id: string
  name: Localized
  description: Localized
  instructions: Localized
  author: Localized
  category: "writing" | "analysis" | "operations"
  added: Localized
  icon: "file" | "book" | "list"
  source: "workspace" | "community" | "custom"
}

export const skillsFixture: readonly Skill[] = [
  {
    id: "decision-record",
    name: { "zh-CN": "决策记录", en: "Decision record" },
    description: { "zh-CN": "记录重要团队决策背后的背景、备选方案和权衡。", en: "Capture the context, alternatives, and trade-offs behind an important team decision." },
    instructions: { "zh-CN": "根据提供的讨论创建决策记录。使用以下章节：背景、考虑过的方案、决策、权衡和后续行动。如果尚未获得最终批准，明确标注为拟议决策。", en: "Create a decision record from the supplied discussion. Use these sections: Context, Options considered, Decision, Trade-offs, and Follow-up. Clearly mark a proposed decision if final approval has not been given." },
    author: { "zh-CN": "工作空间团队", en: "Workspace team" }, category: "writing", added: { "zh-CN": "今天", en: "Today" }, icon: "file", source: "workspace",
  },
  {
    id: "customer-feedback",
    name: { "zh-CN": "客户反馈主题", en: "Customer feedback themes" },
    description: { "zh-CN": "发现客户对话中的重复模式，并为每个主题关联支持案例。", en: "Find recurring patterns in customer conversations and link each theme to supporting examples." },
    instructions: { "zh-CN": "阅读提供的客户反馈，将相关观察归类为主题。包括支持案例并说明各主题出现的频率。区分需求与已确认的问题，不要将小样本视为具有代表性。", en: "Read the supplied customer feedback. Group related observations into themes. Include supporting examples and note how often each theme appears. Separate requests from confirmed problems and avoid treating a small sample as representative." },
    author: { "zh-CN": "Maya Chen", en: "Maya Chen" }, category: "analysis", added: { "zh-CN": "今天", en: "Today" }, icon: "book", source: "community",
  },
  {
    id: "metric-commentary",
    name: { "zh-CN": "指标解读", en: "Metric commentary" },
    description: { "zh-CN": "解释报告中的变化、可能的重要性，以及下一步需要检查的事项。", en: "Explain what changed in a report, why it might matter, and what should be checked next." },
    instructions: { "zh-CN": "比较提供的当前和上一报告周期。用绝对值和相对值描述重大变化。将观察与可能的解释分开。指出定义或样本规模的变化。", en: "Compare the supplied current and previous reporting periods. Describe material changes using absolute and relative values. Keep observations separate from possible explanations. Call out changes in definitions or sample size." },
    author: { "zh-CN": "Priya Shah", en: "Priya Shah" }, category: "analysis", added: { "zh-CN": "昨天", en: "Yesterday" }, icon: "book", source: "community",
  },
  {
    id: "project-handoff",
    name: { "zh-CN": "项目交接", en: "Project handoff" },
    description: { "zh-CN": "准备交接材料，为下一位负责人提供背景、未解决的问题和后续步骤。", en: "Prepare a handoff that gives the next owner the context, open questions, and next steps." },
    instructions: { "zh-CN": "审阅提供的项目背景。编写简明交接材料，包含目标、当前状态、关键链接、未解决的风险和后续步骤。指出缺失的权限或负责人信息，不要自行编造。", en: "Review the supplied project context. Write a concise handoff with the goal, current state, key links, unresolved risks, and next steps. Identify missing access or ownership details without inventing them." },
    author: { "zh-CN": "Alex Morgan", en: "Alex Morgan" }, category: "operations", added: { "zh-CN": "昨天", en: "Yesterday" }, icon: "list", source: "community",
  },
  {
    id: "release-notes",
    name: { "zh-CN": "发布说明", en: "Release notes" },
    description: { "zh-CN": "将工程变更转化为清晰的产品公告。", en: "Translate engineering changes into clear product announcements." },
    instructions: { "zh-CN": "使用提供的拉取请求和发布摘要。将变更分为新功能、改进和修复。用简明语言说明用户收益。不要承诺来源材料未支持的行为。", en: "Use the supplied pull requests and release summary. Group changes into new features, improvements, and fixes. Explain the user benefit in plain language. Avoid promising behavior not supported by the source material." },
    author: { "zh-CN": "Jonas Weber", en: "Jonas Weber" }, category: "writing", added: { "zh-CN": "9月13日", en: "13 Sep" }, icon: "file", source: "community",
  },
  {
    id: "meeting-follow-ups",
    name: { "zh-CN": "会议后续行动", en: "Meeting follow-ups" },
    description: { "zh-CN": "从会议记录中提取决策和明确分配的行动。", en: "Extract decisions and clearly assigned actions from meeting notes." },
    instructions: { "zh-CN": "阅读会议转录或记录。先总结决策，再列出包含负责人和截止日期的行动。如果日期或负责人尚未确定，保留不确定性。最后列出未解决的问题。", en: "Read the meeting transcript or notes. Summarize the decisions, then list actions with owners and due dates. Preserve uncertainty when a date or owner was not agreed. Finish with unresolved questions." },
    author: { "zh-CN": "工作空间团队", en: "Workspace team" }, category: "operations", added: { "zh-CN": "9月12日", en: "12 Sep" }, icon: "file", source: "workspace",
  },
  {
    id: "data-quality",
    name: { "zh-CN": "数据质量审查", en: "Data quality review" },
    description: { "zh-CN": "检查数据集中的缺失值、重复项和异常变化。", en: "Check a dataset for missing values, duplicates, and unexpected changes." },
    instructions: { "zh-CN": "审阅提供的数据结构和样本。检查完整性、唯一性和一致性。报告受影响的字段和示例记录。区分已确认的问题与需要更多数据的检查。", en: "Review the provided schema and data sample. Check completeness, uniqueness, and consistency. Report the affected fields and example records. Separate confirmed issues from checks that need more data." },
    author: { "zh-CN": "Priya Shah", en: "Priya Shah" }, category: "analysis", added: { "zh-CN": "9月11日", en: "11 Sep" }, icon: "book", source: "community",
  },
  {
    id: "weekly-brief",
    name: { "zh-CN": "每周简报", en: "Weekly brief" },
    description: { "zh-CN": "将项目更新整理为简短、便于决策的团队简报。", en: "Turn project updates into a short, decision-ready team brief." },
    instructions: { "zh-CN": "收集提供的项目更新。\n\n按进展、待决策事项和后续步骤分组。将简报控制在500词以内。后续步骤有明确负责人时写出姓名。标记缺失背景，不要猜测。", en: "Collect the supplied project updates.\n\nGroup them into progress, decisions needed, and next steps. Keep the brief under 500 words. Name an owner for each next step when one is provided. Flag missing context instead of guessing." },
    author: { "zh-CN": "工作空间团队", en: "Workspace team" }, category: "writing", added: { "zh-CN": "9月10日", en: "10 Sep" }, icon: "file", source: "workspace",
  },
]

export const initialInstalled = ["weekly-brief", "data-quality", "meeting-follow-ups", "release-notes"]
export const initialEnabled = initialInstalled.slice(0, 3)

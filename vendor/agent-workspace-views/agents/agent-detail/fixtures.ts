export type Localized = { "zh-CN": string; en: string }
export const text = (zh: string, en: string): Localized => ({ "zh-CN": zh, en })
export type AgentIdentity = {
  name: Localized
  role: Localized
  introduction: Localized
}
export type Capability = {
  id: string
  title: Localized
  description: Localized
  enabled: boolean
}
export type BackgroundTask = Capability & {
  schedule: Localized
  time: string
  days: number[]
}
export type ActivityKind = "threads" | "workflows" | "checks" | "tasks"
export type AgentActivity = {
  id: string
  time: string
  kind: ActivityKind
  title: Localized
  source: string
  duration?: string
  request: Localized
  result: Localized
  status: "completed" | "failed"
}

export const identityFixture: AgentIdentity = {
  name: text("Mira", "Mira"),
  role: text("客户运营伙伴", "Customer operations partner"),
  introduction: text(
    "跟踪客户交接、标记账户变化，并为团队准备下一步行动。",
    "Tracks customer handoffs, flags account changes, and prepares the team’s next steps.",
  ),
}

export function taskFixtures(): BackgroundTask[] {
  return [
    {
      id: "team-pulse",
      title: text("团队动态", "Team pulse"),
      description: text(
        "简明的晨间简报，汇总账户变化、待定决策和今天的交接事项。",
        "A concise morning readout of account changes, open decisions, and today's handoffs.",
      ),
      enabled: true,
      schedule: text("工作日 · 08:30", "Weekdays · 08:30"),
      time: "08:30",
      days: [0, 1, 2, 3, 4],
    },
    {
      id: "account-handoff",
      title: text("新账户交接", "New account handoff"),
      description: text(
        "检查新账户缺失的上下文，并为账户负责人准备交接说明。",
        "Checks new accounts for missing context and prepares a handoff for the account owner.",
      ),
      enabled: true,
      schedule: text("创建账户时", "When an account is created"),
      time: "event",
      days: [0, 1, 2, 3, 4],
    },
    {
      id: "signal-check",
      title: text("客户信号检查", "Customer signal check"),
      description: text(
        "将近期反馈按主题归类，并标记可能需要进一步关注的账户。",
        "Groups recent feedback into themes and flags accounts that may need a closer look.",
      ),
      enabled: true,
      schedule: text("每天 · 12:00", "Daily · 12:00"),
      time: "12:00",
      days: [0, 1, 2, 3, 4],
    },
    {
      id: "friday-wrap",
      title: text("周五总结", "Friday wrap-up"),
      description: text(
        "将本周成果和待跟进事项整理成团队共享笔记。",
        "Collects the week's outcomes and outstanding follow-ups into a shared team note.",
      ),
      enabled: false,
      schedule: text("周五 · 16:00", "Fridays · 16:00"),
      time: "16:00",
      days: [4],
    },
  ]
}

export function applicationFixtures(): Capability[] {
  return [
    {
      id: "slack",
      title: text("Slack", "Slack"),
      description: text(
        "阅读更新并起草团队消息",
        "Read updates and draft team messages",
      ),
      enabled: true,
    },
    {
      id: "linear",
      title: text("Linear", "Linear"),
      description: text(
        "阅读问题并准备跟进事项",
        "Read issues and prepare follow-ups",
      ),
      enabled: true,
    },
    {
      id: "hubspot",
      title: text("HubSpot", "HubSpot"),
      description: text(
        "读取账户记录和负责人",
        "Read account records and owners",
      ),
      enabled: true,
    },
    {
      id: "notion",
      title: text("Notion", "Notion"),
      description: text(
        "阅读和起草工作区文档",
        "Read and draft workspace documents",
      ),
      enabled: false,
    },
  ]
}

export function skillFixtures(): Capability[] {
  return [
    {
      id: "account-research",
      title: text("账户研究", "Account research"),
      description: text(
        "将账户历史、近期沟通和待解答问题整理为一份简报。",
        "Bring account history, recent conversations, and open questions into one brief.",
      ),
      enabled: true,
    },
    {
      id: "signal-synthesis",
      title: text("信号归纳", "Signal synthesis"),
      description: text(
        "发现反馈中的重复主题，同时保留来源上下文。",
        "Find recurring themes in feedback without losing the source context.",
      ),
      enabled: true,
    },
    {
      id: "handoff-writing",
      title: text("交接撰写", "Handoff writing"),
      description: text(
        "准备包含负责人、下一步行动和支持链接的清晰摘要。",
        "Prepare a clear summary with an owner, next step, and supporting links.",
      ),
      enabled: true,
    },
    {
      id: "weekly-reporting",
      title: text("每周报告", "Weekly reporting"),
      description: text(
        "对比本周和上周的进展，并突出变化。",
        "Compare this week's progress with the previous week and highlight changes.",
      ),
      enabled: false,
    },
  ]
}

export function activityFixtures(): AgentActivity[] {
  return [
    {
      id: "northstar",
      time: "10:24",
      kind: "tasks",
      title: text("准备 Northstar 交接", "Prepared the Northstar handoff"),
      source: "HubSpot",
      request: text(
        "检查新建的 Northstar 账户，并为负责人准备交接。",
        "Check the new Northstar account and prepare the owner handoff.",
      ),
      result: text(
        "账户已有负责人和启动日期。已添加实施说明，并标记一位缺失的账单联系人供审核。",
        "The account has an owner and a kickoff date. Added the implementation notes and flagged one missing billing contact for review.",
      ),
      status: "completed",
    },
    {
      id: "onboarding",
      time: "10:12",
      kind: "tasks",
      title: text("归纳入门反馈", "Grouped onboarding feedback"),
      source: "Linear",
      request: text(
        "查找今天早晨入门反馈中重复出现的阻碍。",
        "Look for recurring friction in this morning's onboarding feedback.",
      ),
      result: text(
        "八个问题中有三处提到邀请权限。已将这些示例关联到现有的入门跟进事项。",
        "Found three mentions of invite permissions across eight issues. Linked the examples to the existing onboarding follow-up.",
      ),
      status: "completed",
    },
    {
      id: "acme",
      time: "09:46",
      kind: "threads",
      title: text("回复：Acme 上线问题", "Re: Acme rollout questions"),
      source: "Slack",
      request: text(
        "Acme 上线前还有哪些未完成事项？",
        "What is still open before the Acme rollout?",
      ),
      result: text(
        "还有两项：确认工作区负责人，以及批准导入示例。两项都有指定负责人，截止日期均为周四。",
        "Two items remain: confirming the workspace owner and approving the import sample. Both have named owners and are due Thursday.",
      ),
      status: "completed",
    },
    {
      id: "pulse",
      time: "08:30",
      kind: "workflows",
      title: text("团队动态已完成", "Team pulse completed"),
      source: "Workflow",
      duration: "12.8s",
      request: text(
        "汇总账户变化、待交接事项，以及客户团队今天需要作出的决策。",
        "Summarize account changes, open handoffs, and decisions the customer team needs to make today.",
      ),
      result: text(
        "审阅了 18 条账户更新和 6 项待交接事项。两个账户需要负责人检查，一次启动会议移至周四，所有紧急跟进事项均已有负责人。简报草稿已准备好，供团队审核。",
        "Reviewed 18 account updates and 6 open handoffs. Two accounts need an owner check, one kickoff moved to Thursday, and all urgent follow-ups have an assigned owner. A draft brief is ready for the team to review.",
      ),
      status: "completed",
    },
    {
      id: "heartbeat",
      time: "08:18",
      kind: "checks",
      title: text("检查集成心跳", "Checked the integration heartbeat"),
      source: "HubSpot",
      request: text(
        "确认最新的账户同步已成功完成。",
        "Confirm the latest account sync completed successfully.",
      ),
      result: text(
        "最新同步于 08:16 完成。全部 24 条变更记录均已收到，无需重试。",
        "The latest sync finished at 08:16. All 24 changed records were received and no retry is needed.",
      ),
      status: "completed",
    },
    {
      id: "renewals",
      time: "08:05",
      kind: "tasks",
      title: text("更新续约关注列表", "Updated the renewal watchlist"),
      source: "HubSpot",
      request: text(
        "审阅未来 30 天内需要续约的账户。",
        "Review accounts renewing in the next 30 days.",
      ),
      result: text(
        "已将两个账户加入关注列表。两个账户均有近期客户沟通记录和指定的续约负责人。",
        "Added two accounts to the watchlist. Both have a recent customer conversation and an assigned renewal owner.",
      ),
      status: "completed",
    },
    {
      id: "customer-review",
      time: "07:52",
      kind: "threads",
      title: text("回复：周三客户评审", "Re: Wednesday customer review"),
      source: "Slack",
      request: text(
        "为今天的客户评审准备上下文。",
        "Prepare the context for today's customer review.",
      ),
      result: text(
        "已将账户摘要、当前里程碑和账户团队提出的三个问题整理成评审提纲。",
        "Collected the account summary, current milestones, and three questions from the account team into a review outline.",
      ),
      status: "completed",
    },
    {
      id: "context",
      time: "07:40",
      kind: "workflows",
      title: text("账户上下文已刷新", "Account context refreshed"),
      source: "Workflow",
      duration: "9.4s",
      request: text(
        "刷新晨间简报所使用的账户上下文。",
        "Refresh the account context used by the morning brief.",
      ),
      result: text(
        "已刷新 18 个活跃账户的负责人、即将到来的里程碑和未解决的升级事项。",
        "Refreshed account ownership, upcoming milestones, and open escalations for 18 active accounts.",
      ),
      status: "completed",
    },
  ]
}

export const weekDays = [
  text("周一 14", "Mon 14"),
  text("周二 15", "Tue 15"),
  text("周三 16", "Wed 16"),
  text("周四 17", "Thu 17"),
  text("周五 18", "Fri 18"),
]

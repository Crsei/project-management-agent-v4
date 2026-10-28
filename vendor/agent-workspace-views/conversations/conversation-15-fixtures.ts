import type { ComposerDemoSource } from "../demo-source"
import type { Copy } from "../model.ts"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation15Scenarios = [
  ...commonScenarios,
  { id: "unknown", name: { "zh-CN": "分派未知", en: "Unknown assignment" } },
] as const
export type Conversation15Scenario = CommonScenario | "unknown"
export type SupportTicket = {
  id: string
  subject: Copy
  priority: "urgent" | "normal"
  owner: string | null
  status: "open" | "assigned"
  account: string
  risk: number
  responseTarget?: string
}
export interface Conversation15Fixture {
  source: ComposerDemoSource
  tickets: SupportTicket[]
  trend: { day: string; helio: number; northline: number; backlog: number }[]
}
export function createConversation15Fixture(
  scenario: Conversation15Scenario,
): Conversation15Fixture {
  const tickets: SupportTicket[] = [
    {
      id: "CS-4827",
      account: "Helio Freight",
      risk: 92,
      subject: {
        "zh-CN": "导入后表格筛选丢失",
        en: "Table filters reset after import",
      },
      priority: "urgent",
      owner: null,
      status: "open",
    },
    {
      id: "CS-4819",
      account: "Northline Labs",
      risk: 87,
      subject: {
        "zh-CN": "希望增加键盘快捷入口",
        en: "Add a keyboard shortcut entry",
      },
      priority: "normal",
      owner: null,
      status: "open",
    },
    {
      id: "CS-4832",
      account: "Acme Logistics",
      risk: 76,
      subject: {
        "zh-CN": "账单重试显示不明确",
        en: "Billing retry status is unclear",
      },
      priority: "urgent",
      owner: null,
      status: "open",
    },
  ]
  return {
    source: createThreadFixture(
      "conversation-15",
      scenario,
      {
        "zh-CN":
          "审阅过去七天支持积压变化，优先处理存在 SLA 风险的账户，并让我直接在会话内分派紧急工单。",
        en: "Review the support backlog from the last seven days. Show what changed, prioritize accounts at SLA risk, and let me assign urgent issues without leaving the conversation.",
      },
      {
        "zh-CN":
          "积压在周一达到峰值后正在恢复，但仍有 17 个工单面临 SLA 风险。我将决策分成三个视图。\n\n这是固定支持数据；不会发送工单消息或修改真实支持系统。",
        en: "The backlog peaked on Monday and has started to recover, but 17 cases still carry material SLA risk. I pulled the decision into three focused views.\n\nThese are fixed support records; no ticket message is sent and no real support system is changed.",
      },
    ),
    tickets: scenario === "empty" ? [] : tickets,
    trend: [
      { day: "6d", helio: 66, northline: 71, backlog: 193 },
      { day: "5d", helio: 69, northline: 75, backlog: 191 },
      { day: "4d", helio: 76, northline: 74, backlog: 190 },
      { day: "3d", helio: 79, northline: 79, backlog: 188 },
      { day: "2d", helio: 86, northline: 83, backlog: 189 },
      { day: "1d", helio: 88, northline: 85, backlog: 188 },
      { day: "Now", helio: 92, northline: 87, backlog: 184 },
    ],
  }
}

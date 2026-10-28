import type { ChatEntry, Copy } from "../model"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures"
export const conversation19Scenarios = [
  ...commonScenarios,
  { id: "unknown", name: { "zh-CN": "恢复未知", en: "Unknown restore" } },
] as const
export type Conversation19Scenario = CommonScenario | "unknown"
export interface SessionCheckpoint {
  id: string
  title: Copy
  timestamp: string
  revision: string
  code: string
  messages: ChatEntry[]
}
export interface Conversation19Fixture {
  source: ComposerDemoSource
  checkpoints: SessionCheckpoint[]
}
export function createConversation19Fixture(
  scenario: Conversation19Scenario,
): Conversation19Fixture {
  const source = createThreadFixture(
    "conversation-19",
    scenario,
    {
      "zh-CN":
        "追踪重复发票投递，修复幂等性缺口，并在改变重试行为前保留恢复点。",
      en: "Trace the duplicate invoice deliveries, fix the idempotency gap, and keep recovery points before changing retry behavior.",
    },
    {
      "zh-CN":
        "重复路径已隔离到重试处理器与事件账本。我可以修复它而不改变重试窗口。",
      en: "The duplicate path is isolated to the retry handler and event ledger. I can fix it without touching the retry window.",
    },
  )
  const first = source.sessions[0].messages.slice(0, 2)
  const messages: ChatEntry[] = [
    ...first,
    {
      id: "conversation-19-proceed",
      role: "user",
      text: {
        "zh-CN": "继续这个小范围修复。不要改变重试窗口。",
        en: "Proceed with the narrow fix. Leave the retry window alone.",
      },
    },
    {
      id: "conversation-19-fixed",
      role: "assistant",
      text: {
        "zh-CN":
          "处理器现在在确认前记录每个发票事件。专项重播对成功、重复和延迟投递均通过。",
        en: "The handler now records each invoice event before acknowledging it. The focused replay passes for successful, duplicate, and delayed deliveries.",
      },
    },
    {
      id: "conversation-19-window",
      role: "user",
      text: {
        "zh-CN": "缩短重试窗口并重跑延迟 fixture。",
        en: "Shorten the retry window and rerun the delayed fixture.",
      },
    },
    {
      id: "conversation-19-delayed",
      role: "assistant",
      text: {
        "zh-CN":
          "8 秒窗口令延迟 fixture 间歇失败。验证过的修复仍在上方恢复点可用。此处为固定本地调查记录，未执行账单请求。",
        en: "An 8-second window made the delayed fixture intermittent. The verified fix is still available at the recovery point above. This is a fixed local investigation record; no billing request ran.",
      },
    },
  ]
  if (scenario !== "empty")
    source.sessions[0].messages =
      scenario === "long"
        ? [...messages, ...source.sessions[0].messages.slice(2)]
        : messages
  return {
    source,
    checkpoints: [
      {
        id: "cp-plan",
        title: { "zh-CN": "计划已批准", en: "Plan approved" },
        timestamp: "10:18 AM",
        revision: "v1",
        code: `export const retryDescriptor = {
  invoiceId: "invoice-demo",
  operationId: undefined,
  retryWindowSeconds: 30,
}
`,
        messages: first,
      },
      {
        id: "cp-fixed",
        title: { "zh-CN": "已验证幂等性修复", en: "Verified idempotency fix" },
        timestamp: "10:31 AM",
        revision: "v2",
        code: `export const retryDescriptor = {
  invoiceId: "invoice-demo",
  operationId: "fixture-operation-1",
  retryWindowSeconds: 30,
}
`,
        messages: messages.slice(0, 4),
      },
    ],
  }
}

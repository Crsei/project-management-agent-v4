import type { ComposerDemoSource } from "../demo-source"
import type { Copy, Draft } from "../model.ts"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation13Scenarios = [
  ...commonScenarios,
  { id: "delivery-error", name: { "zh-CN": "投递失败", en: "Delivery error" } },
  { id: "unknown", name: { "zh-CN": "投递未知", en: "Unknown delivery" } },
] as const
export type Conversation13Scenario =
  CommonScenario | "delivery-error" | "unknown"
export type QueuedRequest = {
  id: string
  description?: Copy
  attachments?: string[]
  draft: Omit<Draft, "text"> & { text: string | Copy }
}
export interface Conversation13Fixture {
  source: ComposerDemoSource
  items: QueuedRequest[]
}
export function createConversation13Fixture(
  scenario: Conversation13Scenario,
): Conversation13Fixture {
  return {
    source: createThreadFixture(
      "conversation-13",
      scenario,
      {
        "zh-CN":
          "继续完成批量操作交互审阅。工作期间我可能添加后续指令，请保持顺序，不打断当前审阅。",
        en: "Continue the final bulk-action review. I may add follow-ups while you work—keep them ordered without interrupting the current pass.",
      },
      {
        "zh-CN":
          "我会先完成当前交互审阅。新指令保留在输入框前的队列中，投递前可排序或编辑。这里只推进本地演示。",
        en: "I’ll finish the current interaction review first. New instructions stay in the composer queue, where you can reprioritize or edit them before delivery. This advances the local demo only.",
      },
    ),
    items:
      scenario === "empty"
        ? []
        : ([
            {
              id: "q1",
              description: {
                "zh-CN": "对照已批准的桌面状态检查紧凑工具栏",
                en: "Compare the compact toolbar against the approved desktop states",
              },
              attachments: ["bulk-actions-mobile.png"],
              draft: {
                text: {
                  "zh-CN": "接着审阅移动端空态与选择状态。",
                  en: "Review the mobile empty and selected states next.",
                },
                model: "5.6 Sol",
                contextIds: [],
                blocks: false,
              },
            },
            {
              id: "q2",
              description: {
                "zh-CN": "检查 Enter、Escape 和表格选择快捷键",
                en: "Check Enter, Escape, and table selection shortcuts",
              },
              draft: {
                text: {
                  "zh-CN": "审计键盘流程的冲突和缺失焦点状态。",
                  en: "Audit the keyboard flow for conflicts and missing focus states.",
                },
                model: "5.6 Sol",
                contextIds: [],
                blocks: false,
              },
            },
            {
              id: "q3",
              description: {
                "zh-CN": "仅总结已验证的行为",
                en: "Summarize only the behavior that passed verification",
              },
              attachments: ["release-notes.md"],
              draft: {
                text: {
                  "zh-CN": "审阅完成后起草简明发布说明。",
                  en: "Draft a concise release note after the review is complete.",
                },
                model: "5.6 Sol",
                contextIds: [],
                blocks: false,
              },
            },
          ] satisfies QueuedRequest[]),
  }
}

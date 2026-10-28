import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
import type { ComposerDemoSource } from "../demo-source"
import type { Copy } from "../model"
export const conversation9Scenarios = [
  ...commonScenarios,
  { id: "running", name: { "zh-CN": "执行中", en: "Running" } },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown" } },
  { id: "rejected", name: { "zh-CN": "已拒绝", en: "Rejected" } },
] as const
export type Conversation9Scenario =
  CommonScenario | "running" | "unknown" | "rejected"
export type MigrationPhase =
  "waiting" | "running" | "unknown" | "failed" | "rejected" | "completed"
export interface Conversation9Fixture {
  source: ComposerDemoSource
  phase: MigrationPhase
  steps: { id: string; title: Copy; detail: Copy }[]
}
export function createConversation9Fixture(
  scenario: Conversation9Scenario,
): Conversation9Fixture {
  const source = createThreadFixture(
    "conversation-9",
    scenario,
    {
      "zh-CN":
        "规划并演示安全迁移账单 webhook 处理器。展示每一步，在更改前停止等待审批，并保留可恢复检查点。",
      en: "Plan and execute a safe migration for the billing webhook handlers. Show me every tool call, stop before changing files, and keep a restore point in case the replay test fails.",
    },
    {
      "zh-CN":
        "我已将迁移整理为可逆的四步计划。在修改处理器之前会停在审批边界。以下操作仅更新本地演示，不编辑仓库、执行命令或授予真实权限。",
      en: "I mapped the migration into a reversible four-step plan. I will stop at the approval boundary before editing any handler. These controls only update the local demonstration: no repository edits, commands, or real permissions.",
    },
  )
  const titles: Copy[] = [
    { "zh-CN": "规划账单 webhook 迁移", en: "Plan billing webhook migration" },
    { "zh-CN": "优化仓库状态", en: "Refine repository state" },
    { "zh-CN": "追踪预览会话", en: "Trace preview session" },
    { "zh-CN": "审阅移动工作区", en: "Review mobile workspace" },
    { "zh-CN": "优化代码 Diff 输出", en: "Improve code diff output" },
  ]
  source.sessions.forEach((session, index) => {
    if (titles[index]) session.title = titles[index]
  })
  return {
    source,
    phase:
      scenario === "running"
        ? "running"
        : scenario === "unknown"
          ? "unknown"
          : scenario === "rejected"
            ? "rejected"
            : "waiting",
    steps: [
      {
        id: "inspect",
        title: {
          "zh-CN": "检查现有 webhook 路由与签名工具",
          en: "Inspect existing webhook routes and signature utilities",
        },
        detail: {
          "zh-CN":
            "只读快照：invoice.paid、invoice.failed、subscription.updated。",
          en: "Read-only snapshot: invoice.paid, invoice.failed, subscription.updated.",
        },
      },
      {
        id: "apply",
        title: {
          "zh-CN": "为三个处理器应用统一签名验证边界",
          en: "Apply one signature-verification boundary to three handlers",
        },
        detail: {
          "zh-CN": "审批后仅切换本地处理器版本快照，不写入文件。",
          en: "After approval, switch local handler revision snapshots only; no file writes.",
        },
      },
      {
        id: "replay",
        title: {
          "zh-CN": "回放失败、重复与成功账单事件",
          en: "Replay a failed, duplicate, and successful billing event",
        },
        detail: {
          "zh-CN": "固定回放记录：拒绝无效签名、忽略重复事件、接受有效事件。",
          en: "Fixed replay records: reject invalid signatures, ignore duplicate events, accept valid events.",
        },
      },
      {
        id: "record",
        title: {
          "zh-CN": "记录结果并保留迁移前检查点",
          en: "Record results and preserve the pre-migration checkpoint",
        },
        detail: {
          "zh-CN": "保留此会话消息、步骤和本地审批状态。",
          en: "Retain this conversation's messages, step, and local approval state.",
        },
      },
    ],
  }
}

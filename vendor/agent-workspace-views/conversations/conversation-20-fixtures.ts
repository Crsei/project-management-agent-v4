import type { ChatEntry, Copy } from "../model"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures"
export const conversation20Scenarios = [
  ...commonScenarios,
  {
    id: "compaction-error",
    name: { "zh-CN": "压缩失败", en: "Compaction error" },
  },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown" } },
] as const
export type Conversation20Scenario =
  CommonScenario | "compaction-error" | "unknown"
export interface ContextUsage {
  before: number
  after: number
  limit: number
  threshold: number
  roles: { name: Copy; tokens: number }[]
}
export interface Conversation20Fixture {
  source: ComposerDemoSource
  summary: Copy
  usage: ContextUsage
  archive: ChatEntry[]
  retained: { title: Copy; detail: Copy }[]
}
export function createConversation20Fixture(
  scenario: Conversation20Scenario,
): Conversation20Fixture {
  const source = createThreadFixture(
    "conversation-20",
    scenario,
    {
      "zh-CN":
        "继续结账迁移。添加键盘回退，同时保留批准的决定与已在范围内的文件。",
      en: "Continue the checkout migration. Add the keyboard fallback without losing the approved decisions or the files already in scope.",
    },
    {
      "zh-CN":
        "会话接近上下文上限。我可以先把早期消息压缩为工作摘要，再改变回退流程。",
      en: "The session is close to its context limit. I can compact the earlier turns into a working summary before changing the fallback flow.",
    },
  )
  const history: ChatEntry[] = [
    {
      id: "ctx-goal",
      role: "user",
      text: {
        "zh-CN": "迁移结账交互，不改 API。保留访客结账与现有付款提交顺序。",
        en: "Migrate checkout interactions without API changes. Preserve guest checkout and existing payment submission order.",
      },
    },
    {
      id: "ctx-decisions",
      role: "assistant",
      text: {
        "zh-CN":
          "批准决定：采用渐进增强；复用现有表单验证；提交失败恢复焦点至首个错误字段。",
        en: "Approved decisions: progressive enhancement; reuse existing form validation; restore focus to the first invalid field after failed submission.",
      },
    },
    {
      id: "ctx-files",
      role: "user",
      text: {
        "zh-CN":
          "范围仅 checkout-form.tsx、payment-methods.tsx、checkout-validation.ts 和 checkout-keyboard.test.ts。",
        en: "Scope only checkout-form.tsx, payment-methods.tsx, checkout-validation.ts, and checkout-keyboard.test.ts.",
      },
    },
    {
      id: "ctx-changes",
      role: "assistant",
      text: {
        "zh-CN":
          "固定记录：表单保留原提交入口；支付方法的单选导航已整理；验证函数未改签名；键盘测试保留 Enter 与 Escape 路径。",
        en: "Fixed record: the form retains its submit entry; payment method radio navigation is organized; validation signatures remain unchanged; keyboard tests retain Enter and Escape paths.",
      },
    },
    {
      id: "ctx-constraint",
      role: "user",
      text: {
        "zh-CN":
          "不新增依赖、不改付款权限，不触发真实订单；可用现有 fixture 验证回退交互。",
        en: "No new dependencies or payment permissions; never submit real orders. Use existing fixtures for fallback interactions.",
      },
    },
    {
      id: "ctx-open",
      role: "assistant",
      text: {
        "zh-CN":
          "待办：验证键盘回退的 Tab 顺序、付款方法箭头导航和错误后的焦点返回。此归档为本地固定记录。",
        en: "Open task: verify keyboard fallback Tab order, payment method arrow navigation, and focus return after errors. This archive is a local fixture record.",
      },
    },
  ]
  return {
    source,
    archive: [...history, ...source.sessions[0].messages],
    summary: {
      "zh-CN": `目标：完成结账迁移与键盘回退。
批准决定：渐进增强；复用现有表单验证；错误后焦点返回首个无效字段。
活动文件：checkout-form.tsx（提交入口保持）；payment-methods.tsx（单选导航）；checkout-validation.ts（签名不变）；checkout-keyboard.test.ts（Enter/Escape 路径）。
约束：不改 API、权限或依赖；保留访客结账；不发送真实订单。
未完成：验证 Tab 顺序、箭头导航与焦点返回。
续接：在本地 fixture 中审阅键盘回退。`,
      en: `Goal: complete checkout migration and keyboard fallback.
Approved decisions: progressive enhancement; reuse validation; focus the first invalid field after errors.
Active files: checkout-form.tsx (submit entry retained); payment-methods.tsx (radio navigation); checkout-validation.ts (signatures unchanged); checkout-keyboard.test.ts (Enter/Escape paths).
Constraints: no API, permission, or dependency changes; preserve guest checkout; never submit real orders.
Remaining: verify Tab order, arrow navigation, and focus return.
Continue: review keyboard fallback using local fixtures.`,
    },
    usage: {
      before: 118200,
      after: 36400,
      limit: 128000,
      threshold: 96,
      roles: [
        { name: { "zh-CN": "系统", en: "System" }, tokens: 11600 },
        { name: { "zh-CN": "用户", en: "User" }, tokens: 18400 },
        { name: { "zh-CN": "Agent", en: "Assistant" }, tokens: 49700 },
        { name: { "zh-CN": "工具", en: "Tools" }, tokens: 38500 },
      ],
    },
    retained: [
      {
        title: { "zh-CN": "决定", en: "Decisions" },
        detail: {
          "zh-CN": "3 项已批准的实现决定",
          en: "3 approved implementation decisions",
        },
      },
      {
        title: { "zh-CN": "文件", en: "Files" },
        detail: {
          "zh-CN": "4 个活动文件及最新变更",
          en: "4 active files and their latest changes",
        },
      },
      {
        title: { "zh-CN": "约束", en: "Constraints" },
        detail: {
          "zh-CN": "不改 API；保留访客结账",
          en: "No API changes; preserve guest checkout",
        },
      },
      {
        title: { "zh-CN": "待办", en: "Open task" },
        detail: {
          "zh-CN": "验证键盘回退流程",
          en: "Verify the keyboard fallback flow",
        },
      },
    ],
  }
}

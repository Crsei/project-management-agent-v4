import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
import type { CitationSource } from "./citation-model.ts"
import type { ComposerDemoSource } from "../demo-source"
export const conversation10Scenarios = [
  ...commonScenarios,
  {
    id: "missing-source",
    name: { "zh-CN": "引用失效", en: "Missing citation" },
  },
] as const
export type Conversation10Scenario = CommonScenario | "missing-source"
export interface Conversation10Fixture {
  source: ComposerDemoSource
  sources: CitationSource[]
  usage: { used: number; limit: number }
}
export function createConversation10Fixture(
  scenario: Conversation10Scenario,
): Conversation10Fixture {
  const source = createThreadFixture(
    "conversation-10",
    scenario,
    {
      "zh-CN":
        "研究批量管理操作触及外部 API 时如何展示进度。界面应即时响应，但不能在服务器确认前暗示成功。",
      en: "Research how bulk admin actions should communicate progress when they touch an external API. I want the interface to feel immediate without implying success before the server confirms it.",
    },
    {
      "zh-CN":
        "采用混合状态模型：立即确认操作员的意图，但只为权威服务确认的结果使用完成语言。",
      en: "Use a hybrid state model: acknowledge the operator immediately, but reserve completed language for server-confirmed outcomes.",
    },
  )
  source.contextItems.push({
    id: "research-object",
    name: "Admin interaction research",
    description: {
      "zh-CN": "管理交互研究 · 3 个引用来源",
      en: "Admin interaction research · 3 cited sources",
    },
    kind: { "zh-CN": "研究对象", en: "Research object" },
  })
  source.drafts["conversation-10"].contextIds = ["research-object"]
  const answer = source.sessions[0].messages.find(
    (m) => m.id === "conversation-10-answer",
  )
  if (answer) answer.contexts = ["Admin interaction research · 3 cited sources"]
  return {
    source,
    usage: { used: 4480, limit: 32000 },
    sources: [
      {
        id: "react",
        title: {
          "zh-CN": "React：状态保留与重置",
          en: "React: preserving and resetting state",
        },
        url: "https://react.dev/learn/preserving-and-resetting-state",
        excerpt: {
          "zh-CN":
            "可逆的客户端状态可以立即回应选择和排队意图；保留旧快照，以便失败时恢复。",
          en: "Reversible client state can acknowledge selection and queueing immediately. Preserve the previous snapshot for recovery.",
        },
        available: true,
      },
      {
        id: "query",
        title: {
          "zh-CN": "TanStack Query：乐观更新",
          en: "TanStack Query: optimistic updates",
        },
        url: "https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates",
        excerpt: {
          "zh-CN":
            "请求失败时回滚旧快照或显示明确错误，不保留未经确认的成功状态。",
          en: "On request failure, roll back the previous snapshot or show an explicit error; do not leave unconfirmed success in place.",
        },
        available: scenario !== "missing-source",
      },
      {
        id: "stripe",
        title: {
          "zh-CN": "Stripe：幂等请求",
          en: "Stripe: idempotent requests",
        },
        url: "https://docs.stripe.com/api/idempotent_requests",
        excerpt: {
          "zh-CN":
            "为可重试外部变更关联幂等键；结果未知时先查询，不盲目重放副作用。",
          en: "Associate idempotency keys with retryable external mutations. Query unknown outcomes rather than blindly replaying side effects.",
        },
        available: true,
      },
    ],
  }
}

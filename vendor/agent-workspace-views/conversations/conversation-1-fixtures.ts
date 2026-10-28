import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const approvalSources = [
  {
    title: {
      "zh-CN": "线程运行与审批控件",
      en: "Thread runtime and approval controls",
    },
    href: "https://github.com/assistant-ui/assistant-ui",
  },
  {
    title: {
      "zh-CN": "人工介入的 Agent 操作",
      en: "Human-in-the-loop agent actions",
    },
    href: "https://github.com/CopilotKit/CopilotKit",
  },
  {
    title: {
      "zh-CN": "工具审批与检查点模式",
      en: "Tool approval and checkpoint patterns",
    },
    href: "https://github.com/cline/cline",
  },
] as const
export const conversation1Scenarios = commonScenarios
export type Conversation1Scenario = CommonScenario
export const createConversation1Fixture = (scenario: Conversation1Scenario) =>
  createThreadFixture(
    "conversation-1",
    scenario,
    {
      "zh-CN":
        "梳理 Agent 工具的审批状态，让对话、工作流与后台任务使用一致的语言。",
      en: "Map approval states for agent tools and keep the language consistent across chat, workflows and background runs.",
    },
    {
      "zh-CN":
        "在 Agent 可以操作的所有位置复用同一审批规范。界面应区分请求、操作者的决定、执行和最终结果，让工具调用从聊天转入后台任务后仍然可追溯。\n\n## 1. 等待审阅\n\n展示工具名称、计划变更、影响资源和请求范围。主要操作是批准一次、在此工作区始终允许和拒绝。\n\n## 2. 已批准并执行\n\n保留批准者与时间。决定控件应替换为进度、耗时和停止入口，而不只是无限旋转的加载图标。批准不等于执行完成。\n\n## 3. 已确认结果\n\n明确结束于成功、拒绝、取消或失败。将原请求与决定保留在结果旁供审计；结果未知时先查询，不自动重放。",
      en: "Use one approval contract everywhere an agent can act. The interface should separate the request, the operator’s decision, execution and the final result. That keeps a tool call readable even when it moves from a chat into a background run.\n\n## 1. Awaiting review\n\nShow the tool name, intended change, affected resources and requested scope. The primary actions are approve once, always allow for this workspace and reject.\n\n## 2. Approved and running\n\nPreserve who approved the action and when. Replace decision controls with live progress, elapsed time and a stop action rather than an indeterminate spinner. Approval does not confirm execution.\n\n## 3. Resolved\n\nEnd in succeeded, rejected, cancelled or failed. Keep the original request and decision attached to the result for audit. Query unknown outcomes first; never replay automatically.",
    },
  )

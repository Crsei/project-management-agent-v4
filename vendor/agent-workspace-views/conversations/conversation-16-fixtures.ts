import type { Copy } from "../model.ts"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation16Scenarios = [
  ...commonScenarios,
  { id: "compare", name: { "zh-CN": "版本比较", en: "Compare" } },
  { id: "edit-error", name: { "zh-CN": "编辑失败", en: "Edit failure" } },
] as const
export type Conversation16Scenario = CommonScenario | "compare" | "edit-error"
export interface ResponseVersion {
  id: string
  name: Copy
  summary: Copy
  time: string
  prompt: string | Copy
  response: Copy
  emphasis?: Copy
}
export interface Conversation16Fixture {
  source: ComposerDemoSource
  versions: ResponseVersion[]
}
export function createConversation16Fixture(
  scenario: Conversation16Scenario,
): Conversation16Fixture {
  const prompt: Copy = {
    "zh-CN":
      "为更密集的产品表格提出发布建议。默认视图保持平静，需要时让批量操作易于发现。",
    en: "Give me a rollout recommendation for the denser product table. Keep the default view calm, but make bulk actions easy to discover when they are needed.",
  }
  const focused: Copy = {
    "zh-CN":
      "默认表格聚焦搜索、筛选和主要创建操作。首次选中行后才显示批量操作工具栏。\n\n筛选改变时保持选择，在操作旁显示已选数量，并让清除选择保持稳定位置。这样常用操作更快，又不让每位访客都需要理解暂时无法使用的控件。",
    en: "Keep the default table focused on search, filters, and the primary create action. Reveal the bulk-action toolbar only after the first row is selected.\n\nPreserve selection while filters change, show the selected count beside the actions, and keep Clear selection in a stable position. This gives frequent operators speed without making every visitor parse controls they cannot yet use.",
  }
  const rollout: Copy = {
    "zh-CN":
      "发布时先在运营工作区通过功能开关启用。在扩大访问之前，用五个工作日跟踪选择率、放弃选择和误操作撤销。",
    en: "For rollout, start with the operations workspace behind a feature flag. Track selection rate, abandoned selections, and accidental action reversals for five working days before expanding access.",
  }
  const versions: ResponseVersion[] = [
    {
      id: "initial",
      name: { "zh-CN": "初始建议", en: "Initial answer" },
      summary: { "zh-CN": "基础表格方向", en: "Baseline table direction" },
      time: "10:42 PM",
      prompt,
      response: {
        "zh-CN": "保留搜索和筛选，将批量操作与已选行关联。",
        en: "Keep search and filters, and connect bulk actions to selected rows.",
      },
    },
    {
      id: "focused",
      name: { "zh-CN": "聚焦建议", en: "Focused answer" },
      summary: { "zh-CN": "减少默认控件", en: "Reduced default chrome" },
      time: "10:43 PM",
      prompt,
      response: focused,
    },
    {
      id: "rollout",
      name: { "zh-CN": "发布建议", en: "Rollout answer" },
      summary: {
        "zh-CN": "增加验证和发布护栏",
        en: "Adds validation and release guardrails",
      },
      time: "10:44 PM",
      prompt,
      response: {
        "zh-CN":
          "默认表格聚焦搜索、筛选和主要创建操作。首次选中行后才显示批量操作工具栏。\n\n筛选改变时保持选择，在操作旁显示已选数量，并让清除选择保持稳定位置。",
        en: "Keep the default table focused on search, filters, and the primary create action. Reveal the bulk-action toolbar only after the first row is selected.\n\nPreserve selection while filters change, show the selected count beside the actions, and keep Clear selection in a stable position.",
      },
      emphasis: rollout,
    },
  ]
  return {
    source: createThreadFixture("conversation-16", scenario, prompt, focused),
    versions: scenario === "empty" ? [] : versions,
  }
}

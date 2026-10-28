import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation3Scenarios = [
  ...commonScenarios,
  { id: "selected", name: { "zh-CN": "已有选择", en: "Selected" } },
  { id: "submit-error", name: { "zh-CN": "提交失败", en: "Submit error" } },
  { id: "submitted", name: { "zh-CN": "已提交", en: "Submitted" } },
  { id: "dismissed", name: { "zh-CN": "已略过", en: "Dismissed" } },
] as const
export type Conversation3Scenario =
  CommonScenario | "selected" | "submit-error" | "submitted" | "dismissed"
export function createConversation3Fixture(scenario: Conversation3Scenario) {
  return createThreadFixture(
    "conversation-3",
    scenario,
    {
      "zh-CN":
        "为新的管理界面模板规划上线宣传，先确定最合适的定位，再起草内容。",
      en: "Plan the launch campaign for a new admin template collection. Choose the strongest positioning before drafting assets.",
    },
    {
      "zh-CN":
        "在生成宣传简报与创意素材之前，请选择决定标题、证明要点和行动号召的叙事方向。回答仅保存在当前本地宣传简报。",
      en: "Before I produce the brief and creative set, choose the narrative that should control the headline, proof points and call to action. Your answer is saved to the current local campaign brief only.",
    },
  )
}
export const campaignDirections = [
  {
    value: "speed",
    label: { "zh-CN": "更快交付", en: "Ship faster" },
    description: {
      "zh-CN": "突出可复用模式与实现效率",
      en: "Lead with reusable patterns and implementation speed",
    },
  },
  {
    value: "quality",
    label: { "zh-CN": "提升界面质量", en: "Raise UI quality" },
    description: {
      "zh-CN": "以一致性、可读性和细节为核心",
      en: "Focus on consistency, clarity and polish",
    },
  },
  {
    value: "team",
    label: { "zh-CN": "扩展团队协作", en: "Scale the team" },
    description: {
      "zh-CN": "建立共同约定，减少审阅往返",
      en: "Share conventions and reduce review cycles",
    },
  },
] as const

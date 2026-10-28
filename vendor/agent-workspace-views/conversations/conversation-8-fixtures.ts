import type { ComposerDemoSource } from "../demo-source"
import type { Copy } from "../model"
import type { LocalArtifact } from "./artifact-model"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation8Scenarios = [
  ...commonScenarios,
  { id: "media-error", name: { "zh-CN": "视频失败", en: "Video error" } },
] as const
export type Conversation8Scenario = CommonScenario | "media-error"
export interface TranscriptCue {
  id: string
  start: number
  speaker: string
  text: Copy
  references: string[]
}
export interface EditorialSource {
  id: string
  title: string
  page: number
}
export interface Conversation8Fixture {
  source: ComposerDemoSource
  cues: TranscriptCue[]
  artifacts: LocalArtifact[]
  sources: EditorialSource[]
}
export function createConversation8Fixture(
  scenario: Conversation8Scenario,
): Conversation8Fixture {
  return {
    source: createThreadFixture(
      "conversation-8",
      scenario,
      {
        "zh-CN":
          "总结这段录制，生成编辑 brief：关键要点、支撑时刻与可发表的开篇。",
        en: "Summarize this recording and create an editorial brief with key takeaways, supporting moments and a publishable opening paragraph.",
      },
      {
        "zh-CN":
          "AI 不是替代创造力，而是改变创作者投入注意力的位置。重复执行变快，方向、品味、叙事和可问责决策变得更重要。\n\n### 关键要点\n- **创意判断前移。** 少做重复变体，多定义问题并选择方向。\n- **可追溯性重要。** 生成的论断必须连接录制和支撑来源。\n- **审阅不可省略。** 更快的生产依旧需要编辑检查点与明确负责人。\n\n本页材料、4 位角色、5 份来源及 12 个引用均为固定本地合成示例；没有转录或内容生成服务。",
        en: "AI is not replacing creativity—it changes where creative professionals spend their attention. Repetitive execution becomes faster; direction, taste, storytelling and accountable decisions become more important.\n\n### Key takeaways\n- **Creative judgment moves upstream.** Spend less time producing variations and more time framing the problem and selecting a direction.\n- **Traceability matters.** Claims should stay connected to the recording and supporting sources.\n- **Review remains essential.** Faster production still needs editorial checkpoints and clear ownership.\n\nThe material, four speaker roles, five sources and twelve references are fixed local synthetic fixtures; no transcription or generation service was called.",
      },
    ),
    cues: [
      {
        id: "judgment",
        start: 18,
        speaker: "Maya Chen",
        text: {
          "zh-CN":
            "重要变化并不是 AI 替代创意判断，而是消除重复生产，让团队有更多时间确定方向。",
          en: "The important shift is not that AI replaces creative judgment. It removes repetitive production work so teams can spend more time shaping direction.",
        },
        references: ["1", "2", "3"],
      },
      {
        id: "taste",
        start: 46,
        speaker: "Jon Bell",
        text: {
          "zh-CN": "品味、问题框定与决策能力，比无休止地产生变体更加重要。",
          en: "That changes the skills we reward. Taste, framing and the ability to make a decision become more valuable than endless variations.",
        },
        references: ["4", "5", "6"],
      },
      {
        id: "trace",
        start: 81,
        speaker: "Maya Chen",
        text: {
          "zh-CN": "工具应保留源材料，让每个生成论断能够追溯到这段对话。",
          en: "The best tools should preserve source material and make every generated claim traceable back to the conversation.",
        },
        references: ["7", "8"],
      },
      {
        id: "review",
        start: 128,
        speaker: "Jon Bell",
        text: {
          "zh-CN": "明确编辑审阅点，编辑必须能够理解变更并批准结果。",
          en: "We need clear review points. Fast generation is useful only when an editor can understand what changed and approve the result.",
        },
        references: ["9", "10"],
      },
      {
        id: "ownership",
        start: 168,
        speaker: "Aisha Patel",
        text: {
          "zh-CN": "编辑 brief 必须标明负责人、证据与待核实论断。",
          en: "An editorial brief needs an owner, evidence and clearly marked claims awaiting verification.",
        },
        references: ["11"],
      },
      {
        id: "publish",
        start: 210,
        speaker: "Luca Rossi",
        text: {
          "zh-CN": "发布前审阅开篇段落，确保材料与引用一致。",
          en: "Review the opening paragraph before publication and ensure it remains consistent with the sources.",
        },
        references: ["12"],
      },
    ],
    sources: [
      { id: "recording", title: "Creative operations roundtable", page: 1 },
      { id: "judgment", title: "Creative judgment research notes", page: 3 },
      { id: "traceability", title: "Source traceability checklist", page: 5 },
      { id: "review", title: "Editorial review framework", page: 8 },
      { id: "ownership", title: "Publication ownership brief", page: 11 },
    ],
    artifacts: [
      {
        id: "brief",
        name: "creative-work-editorial-brief.md",
        title: {
          "zh-CN": "创意工作未来 — 编辑 brief",
          en: "Future of creative work — editorial brief",
        },
        available: true,
        content: {
          "zh-CN":
            "# 创意工作未来 — 编辑 brief\n\n## 开篇\n\nAI 的重要变化不是代替创造力，而是重新分配我们的注意力：从重复执行转向判断、方向和责任。\n\n## 支撑时刻\n\n- 00:18 Maya Chen：创意判断前移 [1–3]\n- 00:46 Jon Bell：品味与问题框定 [4–6]\n- 01:21 Maya Chen：可追溯性 [7–8]\n- 02:08 Jon Bell：审阅检查点 [9–10]\n- 02:48 Aisha Patel：明确负责人 [11]\n- 03:30 Luca Rossi：发布前核查 [12]\n\n## 编辑行动\n\n负责人：Content editor。核对五份本地来源，再审阅开篇和 social draft。所有材料均为固定合成示例，无真实生成或发布操作。",
          en: "# Future of creative work — editorial brief\n\n## Opening paragraph\n\nAI’s most important change is not replacing creativity but reallocating attention: from repetitive execution to judgment, direction and accountability.\n\n## Supporting moments\n\n- 00:18 Maya Chen: creative judgment [1–3]\n- 00:46 Jon Bell: taste and framing [4–6]\n- 01:21 Maya Chen: traceability [7–8]\n- 02:08 Jon Bell: review checkpoints [9–10]\n- 02:48 Aisha Patel: ownership [11]\n- 03:30 Luca Rossi: pre-publication review [12]\n\n## Editorial actions\n\nOwner: Content editor. Check the five local sources, then review the opening and social draft. All material is a fixed synthetic fixture; nothing is generated or published remotely.",
        },
      },
      {
        id: "social",
        name: "creative-work-social-draft.md",
        title: { "zh-CN": "社交内容草稿", en: "Social draft" },
        available: true,
        content: {
          "zh-CN":
            "# 社交内容草稿 · 本地示例\n\nAI 改变的不只是速度，也是我们如何分配创意判断。\n\n1. 用更少的时间重复执行\n2. 用更多时间定义方向\n3. 保持来源可追溯与编辑审阅\n\n参考：00:18、01:21、02:08。状态：待编辑审阅，未发布。",
          en: "# Social draft · local fixture\n\nAI changes more than speed: it changes where creative judgment belongs.\n\n1. Spend less time on repetitive execution\n2. Spend more time shaping direction\n3. Preserve sources and editorial review\n\nReferences: 00:18, 01:21, 02:08. Status: awaiting editorial review, not published.",
        },
      },
    ],
  }
}

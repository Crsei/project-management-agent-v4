import type { ComposerDemoSource } from "../demo-source.ts"
import type { Copy } from "../model.ts"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"

export const conversation23Scenarios = [
  ...commonScenarios,
  { id: "failed", name: { "zh-CN": "任务失败", en: "Task failure" } },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown" } },
  { id: "completed", name: { "zh-CN": "任务完成", en: "Task completed" } },
] as const
export type Conversation23Scenario =
  CommonScenario | "failed" | "unknown" | "completed"
export type TaskReconstructionPhase =
  "idle" | "running" | "stopped" | "failed" | "unknown" | "completed"
export interface ReconstructionStep {
  id: string
  title: Copy
  tool: string
  output: string
}
export interface Conversation23Fixture {
  source: ComposerDemoSource
  steps: ReconstructionStep[]
  phase: TaskReconstructionPhase
  context: Copy
}

export function createConversation23Fixture(
  scenario: Conversation23Scenario,
): Conversation23Fixture {
  return {
    source: createThreadFixture(
      "conversation-23",
      scenario,
      {
        "zh-CN":
          "审阅 staging 分支上的报价功能。重建上下文，确认准确的交接状态，并建议下一步行动。",
        en: "Review the quotation feature on the staging branch. Rebuild the context, identify the exact handoff state, and recommend what to do next.",
      },
      {
        "zh-CN":
          "我会先从分支、实现和测试记录重建 staging 上下文，再提出建议。以下命令和读取结果为固定本地记录，不会执行 Shell。",
        en: "I’ll reconstruct the staging context from the branch, implementation, and tests before making a recommendation. Commands and read results below are fixed local records, not Shell execution.",
      },
    ),
    steps: [
      {
        id: "context",
        title: {
          "zh-CN": "确认当前分支、工作区状态和相关历史",
          en: "Establish the current branch, worktree state, and relevant history",
        },
        tool: "git status --short --branch",
        output:
          "Fixture: staging/quotation; working tree retained; no command executed.",
      },
      {
        id: "files",
        title: {
          "zh-CN": "梳理应用与共享包中的实现",
          en: "Map the implementation across the app and shared packages",
        },
        tool: "Read implementation references",
        output: "Fixture: app/quotation and packages/ui/quotation reviewed.",
      },
      {
        id: "verification",
        title: {
          "zh-CN": "检查测试、未完成事项和 staging 专属差异",
          en: "Inspect tests, unfinished markers, and staging-only differences",
        },
        tool: "Read staging handoff and test notes",
        output:
          "Fixture: quotation validation and keyboard handoff notes inspected.",
      },
      {
        id: "handoff",
        title: {
          "zh-CN": "总结交接状态、缺口和建议行动",
          en: "Summarize the handoff state, gaps, and recommended next action",
        },
        tool: "Prepare local handoff",
        output: "Local handoff prepared; no commit, push or real execution.",
      },
    ],
    phase:
      scenario === "empty"
        ? "idle"
        : scenario === "failed" ||
            scenario === "unknown" ||
            scenario === "completed"
          ? scenario
          : "running",
    context: {
      "zh-CN":
        "项目：报价功能\n分支：staging/quotation（固定示例）\n范围：报价表单、共享校验和键盘交接\n约束：只读本地记录；不执行 Shell、Git 或服务写入",
      en: "Project: quotation feature\nBranch: staging/quotation (fixed fixture)\nScope: quotation form, shared validation and keyboard handoff\nConstraint: local read-only records; no Shell, Git or service writes",
    },
  }
}

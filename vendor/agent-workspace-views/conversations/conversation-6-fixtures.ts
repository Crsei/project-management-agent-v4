import type { ChangedFile } from "./resource-model"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
import { createConversation5Fixture } from "./conversation-5-fixtures.ts"
export const conversation6Scenarios = [
  ...commonScenarios,
  { id: "running", name: { "zh-CN": "记录播放中", en: "Playing record" } },
  { id: "failed", name: { "zh-CN": "记录读取失败", en: "Record failure" } },
] as const
export type Conversation6Scenario = CommonScenario | "running" | "failed"
export interface TerminalRecord {
  id: string
  command: string
  summary: string
  output: string
}
export interface Conversation6Fixture {
  source: ComposerDemoSource
  files: ChangedFile[]
  status: "running" | "failed" | "completed"
  transcript: TerminalRecord[]
}
export function createConversation6Fixture(
  scenario: Conversation6Scenario,
): Conversation6Fixture {
  const files = createConversation5Fixture("default").changes.files
  return {
    source: createThreadFixture(
      "conversation-6",
      scenario,
      {
        "zh-CN":
          "继续上次的收入概览，在终端带我审阅四个文件，尤其 chart 与共享 metric card。",
        en: "Continue the revenue overview from our last session. Walk me through the four changed files in the terminal, especially the chart and shared metric card.",
      },
      {
        "zh-CN":
          "收入概览的本地审阅快照已就绪。页面保留既有卡片，加上可选 trend，并使用共享 chart primitives 呈现六个月收入。\n\n页面仍是服务端组件，Recharts 在独立客户端组件中。formatter 单独保留；当前 dashboard 值仍为固定字符串。\n\n终端与 Files 对应同一组四文件。所有命令及结果是固定记录，不连接模型、Shell 或 PTY。",
        en: "The local revenue overview snapshot is ready for review. Existing metric cards have optional trends and a six-month chart using shared primitives.\n\nThe page stays server-rendered; Recharts is isolated in its client component. The formatter is included separately; dashboard values are still literal strings.\n\nTerminal and Files refer to the same four-file snapshot. All commands and outputs are scripted records without model, Shell or PTY connections.",
      },
    ),
    files,
    status:
      scenario === "running"
        ? "running"
        : scenario === "failed"
          ? "failed"
          : "completed",
    transcript: [
      {
        id: "diff-stat",
        command: "Bash(git diff --stat)",
        summary: "4 files changed · 61 additions · 6 deletions",
        output:
          "src/app/dashboard/page.tsx                  | 14 +12 −2\nsrc/components/dashboard/revenue-chart.tsx  | 35 +34 −1\nsrc/components/dashboard/metric-card.tsx    | 11 +8 −3\nsrc/lib/format-currency.ts                  |  7 +7\n4 files changed, 61 insertions(+), 6 deletions(-)",
      },
      ...files.map((file, i) => ({
        id: file.fileId,
        command: `Read(${file.path})`,
        summary: [
          "The route composes the existing cards and new chart.",
          "Small client component using the shared chart primitives.",
          "Optional trend keeps the existing metric card reusable.",
          "Whole-dollar USD formatting helper.",
        ][i],
        output: file.content!,
      })),
    ],
  }
}

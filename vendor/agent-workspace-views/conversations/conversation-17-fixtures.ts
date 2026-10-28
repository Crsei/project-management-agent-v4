import type { Copy } from "../model"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures"
export const conversation17Scenarios = [
  ...commonScenarios,
  { id: "running", name: { "zh-CN": "运行中", en: "Running" } },
  { id: "completed", name: { "zh-CN": "已完成", en: "Completed" } },
  { id: "failed", name: { "zh-CN": "生成失败", en: "Generation failure" } },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown" } },
  { id: "stopped", name: { "zh-CN": "已停止", en: "Stopped" } },
] as const
export type Conversation17Scenario =
  CommonScenario | "running" | "completed" | "failed" | "unknown" | "stopped"
export type ReleasePhase =
  "idle" | "streaming" | "completed" | "failed" | "unknown" | "stopped"
export interface ReleaseStep {
  title: Copy
  count: Copy
}
export interface ReleaseBlocker {
  id: string
  title: Copy
  task: Copy
  owner: Copy
}
export interface Conversation17Fixture {
  source: ComposerDemoSource
  phase: ReleasePhase
  chunks: Copy[]
  steps: ReleaseStep[]
  blockers: ReleaseBlocker[]
}
export function createConversation17Fixture(
  scenario: Conversation17Scenario,
): Conversation17Fixture {
  const chunks: Copy[] = [
    {
      "zh-CN": "三个组件正在阻碍发布：",
      en: "Three components are holding the release: ",
    },
    {
      "zh-CN": "数据表缺少移动端选择状态文档，",
      en: "the data table lacks a documented mobile selection state, ",
    },
    {
      "zh-CN": "审计抽屉仍使用废弃状态 Token，",
      en: "the audit drawer still uses a deprecated status token, ",
    },
    {
      "zh-CN": "命令菜单需要键盘验证。我已准备以下专项审阅。",
      en: "and the command menu needs keyboard verification. I prepared a focused review below.",
    },
  ]
  const phase: ReleasePhase =
    scenario === "empty"
      ? "idle"
      : scenario === "running"
        ? "streaming"
        : scenario === "failed" ||
            scenario === "unknown" ||
            scenario === "stopped"
          ? scenario
          : "completed"
  return {
    source: createThreadFixture(
      "conversation-17",
      scenario,
      {
        "zh-CN": "审计组件清单的发布阻碍。展示审阅轨迹，再汇总需要关注的事项。",
        en: "Audit the component inventory for release blockers. Show the review trace, then summarize what needs attention.",
      },
      phase === "completed"
        ? {
            "zh-CN": chunks.map((c) => c["zh-CN"]).join(""),
            en: chunks.map((c) => c.en).join(""),
          }
        : chunks[0],
    ),
    phase,
    chunks,
    steps: [
      {
        title: { "zh-CN": "索引组件记录", en: "Index component records" },
        count: { "zh-CN": "48 条记录", en: "48 records" },
      },
      {
        title: { "zh-CN": "比较发布标签", en: "Compare release labels" },
        count: { "zh-CN": "6 个界面", en: "6 surfaces" },
      },
      {
        title: {
          "zh-CN": "检查未解决审阅笔记",
          en: "Check unresolved review notes",
        },
        count: { "zh-CN": "11 条笔记", en: "11 notes" },
      },
      {
        title: { "zh-CN": "准备发布行动", en: "Prepare release actions" },
        count: { "zh-CN": "3 项阻碍", en: "3 blockers" },
      },
    ],
    blockers: [
      {
        id: "table",
        title: { "zh-CN": "数据表", en: "Data table" },
        task: {
          "zh-CN": "记录紧凑批量选择状态",
          en: "Document the compact bulk-selection state",
        },
        owner: { "zh-CN": "产品系统", en: "Product systems" },
      },
      {
        id: "drawer",
        title: { "zh-CN": "审计抽屉", en: "Audit drawer" },
        task: {
          "zh-CN": "替换废弃状态 Token",
          en: "Replace the deprecated status token",
        },
        owner: { "zh-CN": "设计系统", en: "Design systems" },
      },
      {
        id: "command",
        title: { "zh-CN": "命令菜单", en: "Command menu" },
        task: {
          "zh-CN": "验证 Enter、Escape 和焦点返回",
          en: "Verify Enter, Escape, and focus return",
        },
        owner: { "zh-CN": "交互 QA", en: "Interaction QA" },
      },
    ],
  }
}

import type { ComposerDemoSource } from "../demo-source.ts"
import type { ComposerSession, Copy } from "../model.ts"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"

export const conversation21Scenarios = [
  ...commonScenarios,
  { id: "unknown", name: { "zh-CN": "子任务未知", en: "Unknown child task" } },
] as const
export type Conversation21Scenario = CommonScenario | "unknown"
export type DelegatedTaskStatus =
  "queued" | "running" | "completed" | "failed" | "waiting"
export interface DelegatedTask {
  id: string
  title: Copy
  scope: Copy
  assignment: Copy
  answer: Copy
  status: DelegatedTaskStatus
  stage: number
  steps: Copy[]
}
export interface Conversation21Fixture {
  source: ComposerDemoSource
  childSource: ComposerDemoSource
  tasks: DelegatedTask[]
}

export function createConversation21Fixture(
  scenario: Conversation21Scenario,
): Conversation21Fixture {
  const source = createThreadFixture(
    "parent-child-conversations",
    scenario,
    {
      "zh-CN":
        "在交给工程团队之前审阅批量导入流程。请专家分别检查数据处理、可访问性和安全，再汇总他们的发现。",
      en: "Review the bulk import flow before we hand it to engineering. Have specialists check data handling, accessibility, and security, then bring their findings together.",
    },
    {
      "zh-CN":
        "我已拆成三个独立任务。打开任一子会话，查看它的工作或直接调整该任务的方向。",
      en: "I’ve split the review into three independent tasks. Open any child conversation to inspect its work or guide that agent directly.",
    },
  )
  const tasks: DelegatedTask[] = [
    {
      id: "child-data",
      title: { "zh-CN": "数据分析专家", en: "Data analyst" },
      scope: { "zh-CN": "输入校验", en: "Input validation" },
      assignment: {
        "zh-CN": "检查 CSV 解析、必填字段和重复处理；为无效行建议恢复路径。",
        en: "Review CSV parsing, required fields, and duplicate handling. Recommend a recovery path for invalid rows.",
      },
      answer: {
        "zh-CN":
          "我已检查必填字段和重复数据预览，正在追踪文件只有部分有效时的处理。\n\n主要问题是：一条无效记录会迫使用户重新开始整个上传流程。",
        en: "I’ve checked the required-field rules and the duplicate preview. I’m tracing what happens when only part of a file is valid.\n\nA single bad row currently forces the whole upload to start again.",
      },
      status: scenario === "unknown" ? "waiting" : "running",
      stage: 2,
      steps: [
        { "zh-CN": "检查文件校验", en: "Inspect file validation" },
        { "zh-CN": "检查重复处理", en: "Check duplicate handling" },
        { "zh-CN": "追踪部分失败恢复", en: "Trace partial-failure recovery" },
      ],
    },
    {
      id: "child-accessibility",
      title: { "zh-CN": "可访问性审阅专家", en: "Accessibility reviewer" },
      scope: { "zh-CN": "键盘与反馈", en: "Keyboard & feedback" },
      assignment: {
        "zh-CN":
          "保持上传控件的键盘可达性；校验失败时将焦点移到错误摘要，关联各行错误并播报导入进度。",
        en: "Keep the upload control keyboard-accessible. Move focus to the error summary, link row errors, and announce import progress.",
      },
      answer: {
        "zh-CN":
          "上传、预览和确认应保持同一键盘顺序。错误摘要需要直接定位到具体行，状态播报只在阶段变化时进行。",
        en: "Keep upload, preview and confirmation in one keyboard order. Link the error summary to individual rows and announce stage changes rather than every update.",
      },
      status: "completed",
      stage: 3,
      steps: [
        { "zh-CN": "检查键盘顺序", en: "Review keyboard order" },
        { "zh-CN": "检查错误焦点", en: "Review error focus" },
        { "zh-CN": "检查状态反馈", en: "Review status feedback" },
      ],
    },
    {
      id: "child-security",
      title: { "zh-CN": "安全审阅专家", en: "Security reviewer" },
      scope: { "zh-CN": "文件与数据边界", en: "File & data boundaries" },
      assignment: {
        "zh-CN": "检查文件类型、大小限制和导入范围；明确确认前不写入业务数据。",
        en: "Review file types, size limits and import scope. Keep business writes behind explicit confirmation.",
      },
      answer: {
        "zh-CN":
          "先解析与预览，再由用户确认具体导入范围。拒绝超出类型或大小限制的文件；不要自动重放结果未知的写入。",
        en: "Parse and preview first, then confirm the exact import scope. Reject unsupported or oversized files and do not automatically replay writes with unknown outcomes.",
      },
      status: "completed",
      stage: 3,
      steps: [
        { "zh-CN": "检查文件边界", en: "Inspect file boundaries" },
        { "zh-CN": "检查导入权限", en: "Inspect import scope" },
        { "zh-CN": "检查未知结果恢复", en: "Inspect unknown-outcome recovery" },
      ],
    },
  ]
  const sessions: ComposerSession[] = tasks.map((task) => ({
    id: task.id,
    projectId: "admin",
    title: task.title,
    messages: [
      { id: `${task.id}-assignment`, role: "user", text: task.assignment },
      { id: `${task.id}-answer`, role: "assistant", text: task.answer },
    ],
  }))
  return {
    source,
    tasks: scenario === "empty" ? [] : tasks,
    childSource: {
      ...source,
      sessions,
      selectedId: "child-data",
      drafts: {},
      initialReadingPosition: "start",
      reply: {
        "zh-CN": "已收到这条本地子会话指令，未调用真实子 Agent。",
        en: "Received this local child instruction without calling a real sub-agent.",
      },
    },
  }
}

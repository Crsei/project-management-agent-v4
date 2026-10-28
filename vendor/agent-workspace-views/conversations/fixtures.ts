import { createComposerFixture } from "../fixtures.ts"
import type { ComposerDemoSource } from "../demo-source"
import type { Copy } from "../model.ts"

export const commonScenarios = [
  { id: "default", name: { "zh-CN": "默认", en: "Default" } },
  { id: "long", name: { "zh-CN": "长内容", en: "Long thread" } },
  { id: "empty", name: { "zh-CN": "空会话", en: "Empty" } },
  { id: "loading", name: { "zh-CN": "加载中", en: "Loading" } },
  { id: "error", name: { "zh-CN": "读取失败", en: "Read error" } },
] as const
export type CommonScenario = (typeof commonScenarios)[number]["id"]
export const threadTitles = {
  "conversation-1": {
    "zh-CN": "结构化消息与 Markdown",
    en: "Typed messages with Markdown",
  },
  "conversation-2": {
    "zh-CN": "工具活动与结果",
    en: "Tool activity and results",
  },
  "conversation-3": {
    "zh-CN": "交互提问与回答",
    en: "Interactive questions and answers",
  },
  "conversation-4": {
    "zh-CN": "会议摘要与行动项",
    en: "Meeting summary and action items",
  },
  "conversation-5": {
    "zh-CN": "代码变更与仓库上下文",
    en: "Code changes and repository context",
  },
  "conversation-6": {
    "zh-CN": "会话与侧边终端",
    en: "Conversation with a side terminal",
  },
  "conversation-7": {
    "zh-CN": "会话与页面预览",
    en: "Live preview and code artifacts",
  },
  "conversation-8": {
    "zh-CN": "录音转录与文稿整理",
    en: "Recording transcript and editorial brief",
  },
  "conversation-9": {
    "zh-CN": "执行计划与审批检查点",
    en: "Agent plan execution and checkpoints",
  },
  "conversation-10": {
    "zh-CN": "来源引用与上下文用量",
    en: "Research citations and context usage",
  },
  "conversation-11": {
    "zh-CN": "生成文件树与源码产物",
    en: "Generated artifacts and code output",
  },
  "conversation-12": {
    "zh-CN": "测试执行输出与错误栈",
    en: "Code execution and verification",
  },
  "conversation-13": {
    "zh-CN": "后续指令队列与编辑排序",
    en: "Queued follow-ups and conversation steering",
  },
  "conversation-14": {
    "zh-CN": "变更审阅与提交交接",
    en: "Change review and commit handoff",
  },
  "conversation-15": {
    "zh-CN": "支持工单分析与分派",
    en: "Interactive support triage",
  },
  "conversation-16": {
    "zh-CN": "消息编辑与响应分支",
    en: "Response branching and message editing",
  },
  "conversation-17": {
    "zh-CN": "生成生命周期与停止",
    en: "Response lifecycle",
  },
  "conversation-18": {
    "zh-CN": "可配置数据工作区",
    en: "Adaptive component workspace",
  },
  "conversation-19": {
    "zh-CN": "会话检查点与恢复",
    en: "Session checkpoints and recovery",
  },
  "conversation-20": {
    "zh-CN": "上下文压缩预览与续接",
    en: "Context compaction and continuation",
  },
  "parent-child-conversations": {
    "zh-CN": "父子会话与任务委派",
    en: "Parent child conversations",
  },
  "web-answer": {
    "zh-CN": "网页研究与引用答案",
    en: "Web answer with sources",
  },
  "conversation-23": {
    "zh-CN": "任务上下文重建与阶段推进",
    en: "Task context reconstruction and progress",
  },
} satisfies Record<string, Copy>
export type ThreadPage = keyof typeof threadTitles

export function createThreadFixture(
  page: ThreadPage,
  scenario: string,
  prompt: Copy,
  response: Copy,
): ComposerDemoSource {
  const base = createComposerFixture("conversation")
  const primary = {
    id: page,
    projectId: "admin",
    title: threadTitles[page],
    messages:
      scenario === "empty"
        ? []
        : [
            { id: `${page}-user`, role: "user" as const, text: prompt },
            {
              id: `${page}-answer`,
              role: "assistant" as const,
              text: response,
            },
          ],
  }
  if (scenario === "long") {
    primary.messages.push(
      ...Array.from({ length: 18 }, (_, i) => ({
        id: `${page}-history-${i}`,
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        text:
          i % 2
            ? response
            : {
                "zh-CN": `历史问题 ${i + 1}：补充键盘与恢复约束。`,
                en: `Earlier question ${i + 1}: include keyboard and recovery constraints.`,
              },
      })),
    )
  }
  return structuredClone({
    ...base,
    initialReadingPosition: "start",
    sessions: [
      primary,
      ...base.sessions.filter((s) => s.projectId === "admin"),
    ],
    selectedId: page,
    projectId: "admin",
    drafts: {
      [page]: {
        text: "",
        contextIds: [],
        model: base.models[0],
        blocks: false,
      },
    },
    canSend: scenario !== "loading",
    runtime: undefined,
    reply: {
      "zh-CN": "已添加这条消息。这是固定本地回复，未调用模型服务。",
      en: "Your message was added. This is a fixed local reply; no model service was called.",
    },
  })
}

import type { ChangeSet } from "./resource-model"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation14Scenarios = [
  ...commonScenarios,
  {
    id: "unknown",
    name: { "zh-CN": "提交记录未知", en: "Unknown commit record" },
  },
] as const
export type Conversation14Scenario = CommonScenario | "unknown"
export interface CommitFileSummary {
  fileId: string
  path: string
  kind: "added" | "modified"
  additions: number
}
export interface Conversation14Fixture {
  source: ComposerDemoSource
  changes: ChangeSet
  summaries: CommitFileSummary[]
}
export function createConversation14Fixture(
  scenario: Conversation14Scenario,
): Conversation14Fixture {
  const summaries: CommitFileSummary[] = [
    {
      fileId: "page",
      path: "src/app/(ai)/ai-chat/conversation-13/page.tsx",
      kind: "added",
      additions: 5,
    },
    {
      fileId: "queue",
      path: "src/components/ai-elements/queue.tsx",
      kind: "added",
      additions: 267,
    },
    {
      fileId: "screen",
      path: "src/components/ai-chat/ai-chat-conversation-13-screen.tsx",
      kind: "added",
      additions: 536,
    },
    {
      fileId: "shell",
      path: "src/components/ai-chat/ai-workspace-shell.tsx",
      kind: "modified",
      additions: 4,
    },
    {
      fileId: "sidebar",
      path: "src/data/sidebar-data.tsx",
      kind: "modified",
      additions: 1,
    },
  ]
  // Inspectable local snapshots, not a claim to contain the unavailable upstream source.
  const snapshots = [
    'import { Conversation13Screen } from "@/components/ai-chat/ai-chat-conversation-13-screen"\nexport default function Page() {\n  return <Conversation13Screen />\n}\n',
    "export interface QueuedRequest { id: string; instruction: string }\nexport function moveRequest(queue: QueuedRequest[], index: number, offset: number) {\n  const target = index + offset\n  if (target < 0 || target >= queue.length) return queue\n  const next = [...queue]\n  ;[next[index], next[target]] = [next[target], next[index]]\n  return next\n}\n",
    'import { useState } from "react"\nexport function Conversation13Screen() {\n  const [working, setWorking] = useState(true)\n  return <section aria-label="Current request">\n    <p>{working ? "Working" : "Ready"}</p>\n    <button onClick={() => setWorking(false)}>Finish current</button>\n  </section>\n}\n',
    'export const conversationRoutes = [\n  "conversation-12",\n  "conversation-13",\n]\n',
    'export const queuedConversationLink = { title: "Queued follow-ups", href: "/ai-chat/conversation-13" }\n',
  ]
  const baseSnapshots = [
    "",
    "",
    "",
    'export const conversationRoutes = [\n  "conversation-12",\n]\n',
    "export const queuedConversationLink = null\n",
  ]
  const changes: ChangeSet = {
    repositoryId: "local-conversation-review",
    scope: "local source snapshots",
    base: "fixture-base",
    head: "fixture-head",
    revision: "reference-restore",
    files: summaries.map((file, index) => ({
      ...file,
      content: snapshots[index],
      baseContent: baseSnapshots[index],
      lines:
        file.fileId === "shell"
          ? [
              {
                id: "shell-0",
                kind: "context" as const,
                text: "export const conversationRoutes = [",
                oldLine: 1,
                newLine: 1,
              },
              {
                id: "shell-1",
                kind: "context" as const,
                text: '  "conversation-12",',
                oldLine: 2,
                newLine: 2,
              },
              {
                id: "shell-2",
                kind: "add" as const,
                text: '  "conversation-13",',
                newLine: 3,
              },
              {
                id: "shell-3",
                kind: "context" as const,
                text: "]",
                oldLine: 3,
                newLine: 4,
              },
            ]
          : file.fileId === "sidebar"
            ? [
                {
                  id: "sidebar-base",
                  kind: "remove" as const,
                  text: baseSnapshots[index].trimEnd(),
                  oldLine: 1,
                },
                {
                  id: "sidebar-0",
                  kind: "add" as const,
                  text: snapshots[index].trimEnd(),
                  newLine: 1,
                },
              ]
            : snapshots[index]
                .trimEnd()
                .split("\n")
                .map((text, line) => ({
                  id: `${file.fileId}-${line}`,
                  kind: "add" as const,
                  text,
                  newLine: line + 1,
                })),
    })),
  }
  return {
    summaries,
    changes,
    source: createThreadFixture(
      "conversation-14",
      scenario,
      {
        "zh-CN": "后续指令已经完成。展示最终变更集，让我在创建提交之前审阅。",
        en: "The queued follow-ups are complete. Show me the final verified change set and let me review the commit before it is created.",
      },
      {
        "zh-CN":
          "变更保持在五文件范围内。下面恢复原站提交审阅摘要；三个检查结果和 +813 是固定参考数据，不是本仓库实际检查结果。创建提交仅保存本地演示记录，不调用 Git。",
        en: "The change set stays within the five-file boundary. The review below restores the reference summary; three checks and +813 are fixed reference data, not checks run against this repository. Create commit saves a local demo record only; Git is never called.",
      },
    ),
  }
}

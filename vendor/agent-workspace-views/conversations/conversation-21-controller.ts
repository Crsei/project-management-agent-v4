"use client"
import { useRef, useState, type Dispatch, type SetStateAction } from "react"
import type { ComposerSession } from "../model"
import type { ComposerDemoController } from "../demo-controller"
import { useConversationController } from "./locale"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation21Fixture,
  Conversation21Scenario,
  DelegatedTask,
} from "./conversation-21-fixtures"

export interface QueuedChildInstruction {
  id: string
  text: string
  contexts: string[]
  model: string
}
export interface Conversation21ChildController extends ComposerDemoController {
  readState: ThreadController["readState"]
  setReadState: Dispatch<SetStateAction<ThreadController["readState"]>>
}
export interface Conversation21Controller extends ComposerDemoController {
  readState: ThreadController["readState"]
  setReadState: Dispatch<SetStateAction<ThreadController["readState"]>>
  child: Conversation21ChildController
  tasks: DelegatedTask[]
  selectedTask: DelegatedTask | undefined
  panelOpen: boolean
  setPanelOpen: Dispatch<SetStateAction<boolean>>
  commandMode: "steer" | "queue"
  setCommandMode: Dispatch<SetStateAction<"steer" | "queue">>
  queues: Record<string, QueuedChildInstruction[]>
  unknown: boolean
  unknownTaskIds: readonly string[]
  notice: string
  delegate: () => void
  advanceChild: () => void
  reconcileChild: () => void
  collectResults: () => void
  deliverQueued: () => void
  resetDemo: () => void
}

export function useConversation21Controller(
  fixture: Conversation21Fixture,
  scenario: Conversation21Scenario,
  active: boolean,
): Conversation21Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const [panelOpen, setPanelOpen] = useState(fixture.tasks.length > 0)
  const [tasks, setTasks] = useState(() => structuredClone(fixture.tasks))
  const [unknownIds, setUnknownIds] = useState(
    scenario === "unknown" ? ["child-data"] : [],
  )
  const [commandMode, setCommandMode] = useState<"steer" | "queue">("steer")
  const [queues, setQueues] = useState<
    Record<string, QueuedChildInstruction[]>
  >({})
  const [notice, setNotice] = useState("")
  const sequence = useRef(4)
  const childBase = useConversationController(
    { ...fixture.childSource, canSend: base.canSend },
    active && panelOpen && base.selectedId === fixture.source.selectedId,
    false,
  )
  const selectedTask = tasks.find((task) => task.id === childBase.selectedId)
  const unknown = unknownIds.includes(childBase.selectedId)
  const canSend =
    base.canSend &&
    !unknown &&
    (commandMode === "queue" ||
      selectedTask?.status === "running" ||
      selectedTask?.status === "queued")
  const child: Conversation21ChildController = {
    ...childBase,
    readState: base.readState,
    setReadState: base.setReadState,
    canSend,
    sendMessage: () => {
      const text = childBase.draft.text.trim()
      if (!text || !canSend) return
      if (commandMode === "queue") {
        const instruction: QueuedChildInstruction = {
          id: `child-command-${sequence.current++}`,
          text,
          contexts: childBase.activeContexts.map((context) => context.name),
          model: childBase.draft.model,
        }
        setQueues((previous) => ({
          ...previous,
          [childBase.selectedId]: [
            ...(previous[childBase.selectedId] ?? []),
            instruction,
          ],
        }))
        childBase.updateDraft({ text: "" })
        setNotice(
          base.label(
            "已加入所选子任务的本地后续队列。",
            "Added to the selected child task's local follow-up queue.",
          ),
        )
      } else {
        childBase.sendMessage()
        setTasks((previous) =>
          previous.map((task) =>
            task.id === childBase.selectedId
              ? { ...task, status: "running" }
              : task,
          ),
        )
        setNotice(
          base.label(
            "指令只作用于所选本地子会话；未启动 Agent。",
            "The instruction affects only the selected local child conversation; no Agent was started.",
          ),
        )
      }
    },
  }
  return {
    ...base,
    child,
    tasks,
    selectedTask,
    panelOpen,
    setPanelOpen,
    commandMode,
    setCommandMode,
    queues,
    unknown,
    unknownTaskIds: unknownIds,
    notice,
    delegate: () => {
      const n = sequence.current++
      const id = `child-local-${n}`
      const assignment =
        base.draft.text.trim() ||
        base.label(
          "检查批量导入的输入校验和恢复路径。",
          "Review bulk-import validation and recovery.",
        )
      const task: DelegatedTask = {
        id,
        title: { "zh-CN": `本地审阅任务 ${n}`, en: `Local review task ${n}` },
        scope: { "zh-CN": "补充审阅", en: "Additional review" },
        assignment: { "zh-CN": assignment, en: assignment },
        answer: {
          "zh-CN": "等待明确推进本地任务。",
          en: "Awaiting explicit local task advancement.",
        },
        status: "queued",
        stage: 0,
        steps: [
          { "zh-CN": "核对输入", en: "Review inputs" },
          { "zh-CN": "核对恢复", en: "Review recovery" },
          { "zh-CN": "整理发现", en: "Summarize findings" },
        ],
      }
      const session: ComposerSession = {
        id,
        projectId: "admin",
        title: task.title,
        messages: [
          { id: `${id}-assignment`, role: "user", text: assignment },
          { id: `${id}-answer`, role: "assistant", text: task.answer },
        ],
      }
      setTasks((previous) => [...previous, task])
      childBase.setSessions((previous) => [session, ...previous])
      childBase.selectSession(session)
      setPanelOpen(true)
    },
    advanceChild: () => {
      if (unknown || !selectedTask) return
      setTasks((previous) =>
        previous.map((task) => {
          if (task.id !== childBase.selectedId) return task
          if (task.status === "failed")
            return { ...task, status: "running", stage: 0 }
          if (task.status === "completed") return task
          const next = Math.min(task.stage + 1, task.steps.length)
          return {
            ...task,
            stage: next,
            status: next === task.steps.length ? "completed" : "running",
          }
        }),
      )
    },
    reconcileChild: () => {
      if (!unknown) return
      setUnknownIds((previous) =>
        previous.filter((id) => id !== childBase.selectedId),
      )
      setTasks((previous) =>
        previous.map((task) =>
          task.id === childBase.selectedId
            ? { ...task, status: "failed" }
            : task,
        ),
      )
      setNotice(
        base.label(
          "已确认所选本地子任务失败；可以明确重试。",
          "The selected local child task is confirmed failed; retry explicitly.",
        ),
      )
      childBase.focusComposer()
    },
    collectResults: () => {
      const completed = tasks.filter((task) => task.status === "completed")
      if (!completed.length) return
      const text = `${base.label("本地委派结果汇总", "Local delegated findings")}\n\n${completed.map((task) => `### ${base.copy(task.title)}\n\n${base.copy(task.answer)}`).join("\n\n")}\n\n${completed.length} / ${tasks.length} ${base.label("任务完成；未运行真实子 Agent。", "tasks complete; no real sub-agents were run.")}`
      const id = `parent-findings-${sequence.current++}`
      base.setSessions((previous) =>
        previous.map((session) =>
          session.id === fixture.source.selectedId
            ? {
                ...session,
                messages: [
                  ...session.messages,
                  { id, role: "assistant", text },
                ],
              }
            : session,
        ),
      )
      setNotice(
        base.label(
          "已将完成任务的结果加入父会话。",
          "Completed task findings were added to the parent conversation.",
        ),
      )
    },
    deliverQueued: () => {
      if (unknown || !base.canSend) return
      const next = queues[childBase.selectedId]?.[0]
      if (!next) return
      childBase.setSessions((previous) =>
        previous.map((session) =>
          session.id === childBase.selectedId
            ? {
                ...session,
                messages: [
                  ...session.messages,
                  {
                    id: `${next.id}-user`,
                    role: "user",
                    text: next.text,
                    contexts: next.contexts,
                  },
                  {
                    id: `${next.id}-answer`,
                    role: "assistant",
                    text: base.label(
                      "后续指令已投递到本地子会话；等待显式推进。",
                      "The follow-up was delivered to the local child conversation; advance explicitly.",
                    ),
                  },
                ],
              }
            : session,
        ),
      )
      setQueues((previous) => ({
        ...previous,
        [childBase.selectedId]: previous[childBase.selectedId].slice(1),
      }))
      setTasks((previous) =>
        previous.map((task) =>
          task.id === childBase.selectedId
            ? { ...task, status: "running", stage: 0 }
            : task,
        ),
      )
    },
    resetDemo: () => {
      if (unknownIds.length) return
      setTasks(structuredClone(fixture.tasks))
      setQueues({})
      childBase.setSessions(structuredClone(fixture.childSource.sessions))
      childBase.selectSession(fixture.childSource.sessions[0])
      setNotice(
        base.label(
          "本地任务已重置，父子草稿保留。",
          "Local tasks reset; parent and child drafts are preserved.",
        ),
      )
    },
  }
}

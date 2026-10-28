"use client"
import { useState, type Dispatch, type SetStateAction } from "react"
import type { ComposerDemoController } from "../demo-controller"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation23Fixture,
  Conversation23Scenario,
  ReconstructionStep,
  TaskReconstructionPhase,
} from "./conversation-23-fixtures"

export interface Conversation23Controller extends ComposerDemoController {
  readState: ThreadController["readState"]
  setReadState: Dispatch<SetStateAction<ThreadController["readState"]>>
  phase: TaskReconstructionPhase
  stage: number
  steps: ReconstructionStep[]
  contextText: string
  setContextText: Dispatch<SetStateAction<string>>
  contextOpen: boolean
  setContextOpen: Dispatch<SetStateAction<boolean>>
  planOpen: boolean
  setPlanOpen: Dispatch<SetStateAction<boolean>>
  reasoning: "low" | "medium" | "high"
  setReasoning: Dispatch<SetStateAction<"low" | "medium" | "high">>
  advance: () => void
  reset: () => void
  stop: () => void
  resume: () => void
  reconcile: () => void
}

export function useConversation23Controller(
  fixture: Conversation23Fixture,
  scenario: Conversation23Scenario,
  active: boolean,
): Conversation23Controller {
  const [phase, setPhase] = useState<TaskReconstructionPhase>(fixture.phase)
  const [stage, setStage] = useState(
    fixture.phase === "completed" ? fixture.steps.length : 0,
  )
  const base = useThreadController(fixture.source, scenario, active, {
    canSend: phase !== "running" && phase !== "unknown",
  })
  const [contextText, setContextText] = useState(() =>
    base.copy(fixture.context),
  )
  const [contextOpen, setContextOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(true)
  const [reasoning, setReasoning] = useState<"low" | "medium" | "high">("high")
  function updateMessage(next: number) {
    const text =
      next === fixture.steps.length
        ? base.label(
            "已整理报价功能的交接状态。分支、共享实现和测试记录均已核对；下一步建议补齐键盘回退验证后准备交接。以上为固定本地示例，没有执行真实命令。",
            "The quotation handoff is reconstructed. Branch, shared implementation and test records were reviewed. Complete the keyboard fallback verification before preparing the handoff. This is a fixed local example; no real commands were executed.",
          )
        : `${base.label("正在重建 staging 上下文。", "Reconstructing the staging context.")}\n\n${contextText}\n\n${base.label("已核对公开步骤", "Public steps reviewed")}: ${next} / ${fixture.steps.length}`
    base.setSessions((previous) =>
      previous.map((session) =>
        session.id === fixture.source.selectedId
          ? {
              ...session,
              messages: session.messages.map((message) =>
                message.id === "conversation-23-answer"
                  ? { ...message, text }
                  : message,
              ),
            }
          : session,
      ),
    )
  }
  return {
    ...base,
    phase,
    stage,
    steps: fixture.steps,
    contextText,
    setContextText,
    contextOpen,
    setContextOpen,
    planOpen,
    setPlanOpen,
    reasoning,
    setReasoning,
    advance: () => {
      if (phase !== "running") return
      const next = Math.min(stage + 1, fixture.steps.length)
      setStage(next)
      updateMessage(next)
      if (next === fixture.steps.length) {
        setPhase("completed")
        base.focusComposer()
      }
    },
    reset: () => {
      if (phase === "unknown") return
      setStage(0)
      setPhase("running")
      updateMessage(0)
      base.focusComposer()
    },
    stop: () => {
      if (phase === "running") {
        setPhase("stopped")
        base.focusComposer()
      }
    },
    resume: () => {
      if (phase === "stopped") {
        setPhase("running")
        base.focusComposer()
      }
    },
    reconcile: () => {
      if (phase === "unknown") {
        setPhase("failed")
        base.focusComposer()
      }
    },
  }
}

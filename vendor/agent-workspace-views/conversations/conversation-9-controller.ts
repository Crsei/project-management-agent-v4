"use client"
import { useState, type Dispatch, type SetStateAction } from "react"
import type { ChatEntry } from "../model"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation9Fixture,
  Conversation9Scenario,
  MigrationPhase,
} from "./conversation-9-fixtures"
interface MigrationCheckpoint {
  messages: ChatEntry[]
  step: number
  phase: MigrationPhase
  approval: "once" | "session" | null
}
export interface Conversation9Controller extends ThreadController {
  phase: MigrationPhase
  step: number
  planOpen: boolean
  setPlanOpen: Dispatch<SetStateAction<boolean>>
  checkpoint: MigrationCheckpoint | null
  approval: "once" | "session" | null
  steps: Conversation9Fixture["steps"]
  action: (action: string) => Promise<void>
  advance: () => void
  saveCheckpoint: () => void
  restoreCheckpoint: () => void
}
export function useConversation9Controller(
  fixture: Conversation9Fixture,
  scenario: Conversation9Scenario,
  active: boolean,
): Conversation9Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const [phase, setPhase] = useState(fixture.phase)
  const [step, setStep] = useState(0)
  const [planOpen, setPlanOpen] = useState(true)
  const [approval, setApproval] = useState<"once" | "session" | null>(null)
  const [checkpoint, setCheckpoint] = useState<MigrationCheckpoint | null>(null)
  return {
    ...base,
    phase,
    step,
    planOpen,
    setPlanOpen,
    checkpoint,
    approval,
    steps: fixture.steps,
    action: async (action) => {
      if (phase === "unknown") {
        if (action === "reconcile") setPhase("failed")
        base.focusComposer()
        return
      }
      if (phase === "waiting" && ["accept", "always"].includes(action)) {
        setApproval(action === "always" ? "session" : "once")
        setPhase("running")
        setStep(0)
        setPlanOpen(true)
      }
      if (phase === "waiting" && action === "reject") setPhase("rejected")
      if ((phase === "failed" || phase === "rejected") && action === "retry") {
        setPhase("waiting")
        setApproval(null)
      }
      base.focusComposer()
    },
    advance: () => {
      if (phase !== "running") return
      const next = Math.min(step + 1, fixture.steps.length)
      setStep(next)
      if (next === fixture.steps.length) {
        setPhase("completed")
        base.focusComposer()
      }
    },
    saveCheckpoint: () =>
      setCheckpoint({
        messages: structuredClone(base.selected.messages),
        step,
        phase,
        approval,
      }),
    restoreCheckpoint: () => {
      if (!checkpoint) return
      base.rememberPosition()
      base.setSessions((previous) =>
        previous.map((session) =>
          session.id === base.selectedId
            ? { ...session, messages: structuredClone(checkpoint.messages) }
            : session,
        ),
      )
      setStep(checkpoint.step)
      setPhase(checkpoint.phase)
      setApproval(checkpoint.approval)
    },
  }
}

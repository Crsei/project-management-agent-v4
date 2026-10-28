"use client"
import { useState, type Dispatch, type SetStateAction } from "react"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation12Fixture,
  Conversation12Scenario,
} from "./conversation-12-fixtures"
export interface Conversation12Controller extends ThreadController {
  phase: Conversation12Fixture["phase"]
  view: string
  setView: Dispatch<SetStateAction<string>>
  highlight: boolean
  stackOpen: boolean
  setStackOpen: Dispatch<SetStateAction<boolean>>
  stack: string
  code: string
  testCode: string
  output: string
  frame: "test" | "application"
  locate: (frame?: "test" | "application") => void
  reconcile: () => void
  rerun: () => void
}
export function useConversation12Controller(
  fixture: Conversation12Fixture,
  scenario: Conversation12Scenario,
  active: boolean,
): Conversation12Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const [phase, setPhase] = useState(fixture.phase)
  const [view, setView] = useState("output")
  const [highlight, setHighlight] = useState(false)
  const [frame, setFrame] = useState<"test" | "application">("test")
  const [stackOpen, setStackOpen] = useState(true)
  return {
    ...base,
    phase,
    view,
    setView,
    highlight,
    stackOpen,
    setStackOpen,
    stack: fixture.stack,
    code: phase === "completed" ? fixture.fixed : fixture.code,
    testCode: fixture.testCode,
    output:
      phase === "completed"
        ? fixture.passedLog
        : phase === "unknown"
          ? "LOCAL FIXTURE: outcome unknown; query the local receipt before rerun. No execution is started."
          : fixture.failedLog,
    frame,
    locate: (target = "test") => {
      setView("code")
      setFrame(target)
      setHighlight(true)
    },
    reconcile: () => {
      if (phase !== "unknown") return
      setPhase("failed")
      base.focusComposer()
    },
    rerun: () => {
      if (phase === "unknown") return
      setPhase("completed")
      setView("output")
      setHighlight(false)
      base.focusComposer()
    },
  }
}

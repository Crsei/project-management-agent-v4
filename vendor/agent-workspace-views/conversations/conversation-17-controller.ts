"use client"
import { useState } from "react"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
import type {
  Conversation17Fixture,
  Conversation17Scenario,
  ReleasePhase,
  ReleaseStep,
  ReleaseBlocker,
} from "./conversation-17-fixtures"
export interface Conversation17Controller
  extends ComposerDemoController, ThreadController {
  phase: ReleasePhase
  chunkCount: number
  total: number
  steps: ReleaseStep[]
  blockers: ReleaseBlocker[]
  reviewed: string[]
  toggleReviewed: (id: string, value: boolean) => void
  advance: () => void
  stop: () => void
  resume: () => void
  replay: () => void
  interrupt: () => void
  reconcile: () => void
}
export function useConversation17Controller(
  fixture: Conversation17Fixture,
  scenario: Conversation17Scenario,
  active: boolean,
): Conversation17Controller {
  const [phase, setPhase] = useState(fixture.phase)
  const [chunkCount, setChunkCount] = useState(
    fixture.phase === "completed" ? fixture.chunks.length : 1,
  )
  const [reviewed, setReviewed] = useState<string[]>([])
  const base = useThreadController(fixture.source, scenario, active, {
    canSend: phase !== "streaming" && phase !== "unknown",
  })
  function update(next: number) {
    base.setSessions((previous) =>
      previous.map((session) =>
        session.id === fixture.source.selectedId
          ? {
              ...session,
              messages: session.messages.map((message) =>
                message.id === "conversation-17-answer"
                  ? {
                      ...message,
                      text: {
                        "zh-CN": fixture.chunks
                          .slice(0, next)
                          .map((c) => c["zh-CN"])
                          .join(""),
                        en: fixture.chunks
                          .slice(0, next)
                          .map((c) => c.en)
                          .join(""),
                      },
                    }
                  : message,
              ),
            }
          : session,
      ),
    )
    setChunkCount(next)
  }
  return {
    ...base,
    phase,
    chunkCount,
    total: fixture.chunks.length,
    steps: fixture.steps,
    blockers: fixture.blockers,
    reviewed,
    toggleReviewed: (id, value) =>
      setReviewed((previous) =>
        value
          ? [...new Set([...previous, id])]
          : previous.filter((v) => v !== id),
      ),
    advance: () => {
      if (phase !== "streaming") return
      const next = Math.min(chunkCount + 1, fixture.chunks.length)
      update(next)
      if (next === fixture.chunks.length) {
        setPhase("completed")
        base.focusComposer()
      }
    },
    replay: () => {
      if (phase === "unknown") return
      update(1)
      setPhase("streaming")
    },
    interrupt: () => {
      if (phase === "unknown") return
      update(2)
      setPhase("stopped")
      base.focusComposer()
    },
    stop: () => {
      if (phase === "streaming") {
        setPhase("stopped")
        base.focusComposer()
      }
    },
    resume: () => {
      if (phase === "stopped" || phase === "failed") setPhase("streaming")
    },
    reconcile: () => {
      if (phase === "unknown") {
        setPhase("failed")
        base.focusComposer()
      }
    },
  }
}

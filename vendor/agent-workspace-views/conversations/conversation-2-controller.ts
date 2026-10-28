"use client"
import { useState } from "react"
import type { ToolRecord } from "./tool-activity"
import type { Conversation2Fixture } from "./conversation-2-fixtures"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
export interface Conversation2Controller
  extends ThreadController, ComposerDemoController {
  calls: ToolRecord[]
  advance: (id: string) => void
  cancel: (id: string) => void
  retry: (id: string) => void
  reconcile: (id: string) => void
}
export function useConversation2Controller(
  fixture: Conversation2Fixture,
  scenario: string,
  active: boolean,
): Conversation2Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const [calls, setCalls] = useState(() => structuredClone(fixture.calls))
  const updateCall = (id: string, patch: Partial<ToolRecord>) =>
    setCalls((previous) =>
      previous.map((call) => (call.id === id ? { ...call, ...patch } : call)),
    )
  return {
    ...base,
    calls,
    advance: (id: string) =>
      updateCall(id, {
        status: "completed",
        outcome: "known",
        output:
          "Fixed local audit: compact rows; stable action column; visible keyboard focus.",
        error: undefined,
      }),
    cancel: (id: string) =>
      updateCall(id, {
        status: "cancelled",
        outcome: "known",
        output: undefined,
      }),
    retry: (id: string) =>
      updateCall(id, {
        status: "running",
        error: undefined,
        output: undefined,
      }),
    reconcile: (id: string) =>
      updateCall(id, {
        status: "failed",
        outcome: "known",
        error:
          "Fixture receipt confirms the audit failed; no action was replayed.",
      }),
  }
}

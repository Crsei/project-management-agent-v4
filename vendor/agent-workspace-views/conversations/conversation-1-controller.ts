"use client"
import { useState } from "react"
import type { ComposerDemoSource } from "../demo-source"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
export type ApprovalDecision = "accepted" | "always-allowed" | "rejected"
export interface Conversation1Controller
  extends ThreadController, ComposerDemoController {
  decision?: ApprovalDecision
  decide: (value: ApprovalDecision) => void
}
export function useConversation1Controller(
  source: ComposerDemoSource,
  scenario: string,
  active: boolean,
): Conversation1Controller {
  const base = useThreadController(source, scenario, active)
  const [decisions, setDecisions] = useState<Record<string, ApprovalDecision>>(
    {},
  )
  return {
    ...base,
    decision: decisions[base.selectedId],
    decide: (value: ApprovalDecision) =>
      setDecisions((previous) => ({ ...previous, [base.selectedId]: value })),
  }
}

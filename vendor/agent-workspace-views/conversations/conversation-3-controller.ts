"use client"
import { useState } from "react"
import type { ComposerDemoSource } from "../demo-source"
import type { Copy } from "../model"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
import { campaignDirections } from "./conversation-3-fixtures"
export interface CampaignAnswers {
  direction?: { type: "choice"; selected: string[]; customText?: string }
}
export type AnswerState = {
  answers: CampaignAnswers
  phase: "editing" | "submitted" | "dismissed"
  error?: Copy
  attempted: boolean
  result?: string | Copy
}
export interface Conversation3Controller
  extends ThreadController, ComposerDemoController {
  state: AnswerState
  update: (patch: Partial<AnswerState>) => void
  submit: (answers: CampaignAnswers) => void
}
export function useConversation3Controller(
  source: ComposerDemoSource,
  scenario: string,
  active: boolean,
): Conversation3Controller {
  const base = useThreadController(source, scenario, active)
  const initialAnswers: CampaignAnswers = ["selected", "submitted"].includes(
    scenario,
  )
    ? { direction: { type: "choice", selected: ["speed"] } }
    : {}
  const [states, setStates] = useState<Record<string, AnswerState>>(() => ({
    [source.selectedId]: {
      answers: initialAnswers,
      phase:
        scenario === "submitted"
          ? "submitted"
          : scenario === "dismissed"
            ? "dismissed"
            : "editing",
      attempted: false,
      result:
        scenario === "submitted" ? campaignDirections[0].label : undefined,
    },
  }))
  const state = states[base.selectedId] ?? {
    answers: {},
    phase: "editing" as const,
    attempted: false,
  }
  const update = (patch: Partial<AnswerState>) =>
    setStates((previous) => ({
      ...previous,
      [base.selectedId]: { ...state, ...patch },
    }))
  function submit(answers: CampaignAnswers) {
    if (state.phase !== "editing") return
    const answer = answers.direction
    const selected = answer?.type === "choice" ? answer.selected[0] : undefined
    const choice = campaignDirections.find((item) => item.value === selected)
    const custom =
      answer?.type === "choice" ? (answer.customText?.trim() ?? "") : ""
    if (!choice && !custom) {
      update({
        error: {
          "zh-CN": "请选择一个方向，或填写自己的回答。",
          en: "Select a direction or enter your own response.",
        },
      })
      return
    }
    if (scenario === "submit-error" && !state.attempted) {
      update({
        attempted: true,
        error: {
          "zh-CN": "本地提交示例失败，回答已保留。再次提交可重试。",
          en: "Local example submission failed. Your answer is preserved; submit again to retry.",
        },
      })
      return
    }
    update({
      phase: "submitted",
      error: undefined,
      result: custom || choice?.label,
    })
    base.focusComposer()
  }
  return { ...base, state, update, submit }
}

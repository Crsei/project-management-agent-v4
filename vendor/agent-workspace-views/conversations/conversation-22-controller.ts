"use client"
import { useRef, useState, type Dispatch, type SetStateAction } from "react"
import { useThreadController, type ThreadController } from "./shared"
import { useCitationPreview, type CitationPreviewState } from "./citations"
import type {
  Conversation22Fixture,
  Conversation22Scenario,
  ResearchFollowUp,
} from "./conversation-22-fixtures"

export interface Conversation22Controller
  extends ThreadController, CitationPreviewState {
  fixture: Conversation22Fixture
  refreshError: boolean
  refresh: () => void
  sourcesOpen: boolean
  setSourcesOpen: Dispatch<SetStateAction<boolean>>
  copyState: "idle" | "copied" | "error"
  copyAnswer: () => Promise<void>
  followUp: (id: string) => void
  imageId: "features" | "pricing" | "testimonials" | "layout" | null
  setImageId: Dispatch<SetStateAction<Conversation22Controller["imageId"]>>
}
export function useConversation22Controller(
  fixture: Conversation22Fixture,
  scenario: Conversation22Scenario,
  active: boolean,
): Conversation22Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const [records, setRecords] = useState(() => structuredClone(fixture.sources))
  const citation = useCitationPreview(records)
  const [refreshError, setRefreshError] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [copyState, setCopyState] =
    useState<Conversation22Controller["copyState"]>("idle")
  const [imageId, setImageId] =
    useState<Conversation22Controller["imageId"]>(null)
  const sequence = useRef(1)
  function answerFollowUp(text: string, followUp?: ResearchFollowUp) {
    if (!text.trim() || !base.canSend) return
    const query = text.toLowerCase()
    const match =
      followUp ??
      fixture.followUps.find(
        (item) => item.question[base.locale].toLowerCase() === query,
      ) ??
      fixture.followUps.find((item) =>
        item.keywords.some((word) => query.includes(word)),
      )
    const relevant = match
      ? records.filter(
          (source) => match.sourceIds.includes(source.id) && source.available,
        )
      : []
    const answer = relevant.length
      ? `${base.label("五份保存来源中的相关摘记（非实时搜索）：", "Relevant notes in the five saved sources (not live search):")}\n\n${relevant.map((source) => `${base.copy(source.excerpt)} [${records.findIndex((item) => item.id === source.id) + 1}]`).join("\n\n")}`
      : base.label(
          "保存的来源中没有可用于回答这条问题的摘记。请查看来源或打开原始文档；这里不会运行实时搜索或真实 Agent。",
          "The saved sources contain no available note for this question. Inspect the sources or open their original documents; this page runs neither live search nor a real Agent.",
        )
    const id = `web-follow-${sequence.current++}`
    base.setSessions((previous) =>
      previous.map((session) =>
        session.id === base.selectedId
          ? {
              ...session,
              messages: [
                ...session.messages,
                {
                  id: `${id}-user`,
                  role: "user",
                  text,
                  contexts: base.activeContexts.map((context) => context.name),
                },
                { id: `${id}-answer`, role: "assistant", text: answer },
              ],
            }
          : session,
      ),
    )
    base.updateDraft({ text: "" })
    requestAnimationFrame(base.scrollToLatest)
  }
  return {
    ...base,
    ...citation,
    fixture,
    refreshError,
    sourcesOpen,
    setSourcesOpen,
    copyState,
    imageId,
    setImageId,
    sendMessage: () => answerFollowUp(base.draft.text.trim()),
    followUp: (id) => {
      const item = fixture.followUps.find((value) => value.id === id)
      if (item) answerFollowUp(base.copy(item.question), item)
    },
    copyAnswer: async () => {
      const message = fixture.source.sessions[0].messages.find(
        (item) => item.id === "web-answer-answer",
      )
      if (!message) return
      const text = `${base.copy(message.text)}\n\n${base.label("来源（保存摘记）：", "Sources (saved notes):")}\n${records.map((source, index) => `[${index + 1}] ${base.copy(source.title)} — ${source.url}`).join("\n")}`
      try {
        await navigator.clipboard.writeText(text)
        setCopyState("copied")
      } catch {
        setCopyState("error")
      }
    },
    refresh: () => {
      if (scenario === "refresh-error" && !attempted) {
        setAttempted(true)
        setRefreshError(true)
        return
      }
      setRefreshError(false)
      setRecords((previous) =>
        previous.map((source) => ({ ...source, available: true })),
      )
      base.focusComposer()
    },
  }
}

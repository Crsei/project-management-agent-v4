"use client"
import { useState, type Dispatch, type SetStateAction } from "react"
import type { ReviewComment, ChangeSet } from "./resource-model"
import type { ComposerDemoController } from "../demo-controller"
import { useThreadController, type ThreadController } from "./shared"
import type {
  CommitFileSummary,
  Conversation14Fixture,
  Conversation14Scenario,
} from "./conversation-14-fixtures"
export interface Conversation14Controller extends ComposerDemoController {
  readState: ThreadController["readState"]
  setReadState: ThreadController["setReadState"]
  reviewOpen: boolean
  setReviewOpen: Dispatch<SetStateAction<boolean>>
  changes: ChangeSet
  summaries: CommitFileSummary[]
  fileId: string
  setFileId: Dispatch<SetStateAction<string>>
  comments: ReviewComment[]
  setComments: (comments: ReviewComment[]) => void
  reviewed: string[]
  markReviewed: () => void
  commitMessage: string
  setCommitMessage: Dispatch<SetStateAction<string>>
  phase: "ready" | "unknown" | "prepared"
  handoff: string
  reconcile: () => void
  prepare: () => void
  requestChanges: () => void
  addFeedbackToDraft: (text: string) => void
}
export function useConversation14Controller(
  fixture: Conversation14Fixture,
  scenario: Conversation14Scenario,
  active: boolean,
): Conversation14Controller {
  const base = useThreadController(
    {
      ...fixture.source,
      initialReadingPosition: scenario === "long" ? "start" : "latest",
    },
    scenario,
    active,
  )
  const [reviewOpen, setReviewOpen] = useState(false)
  const [fileId, setFileId] = useState(fixture.changes.files[0].fileId)
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [reviewed, setReviewed] = useState<string[]>([])
  const [commitMessage, setCommitMessage] = useState(
    "feat(ai-chat): add queued conversation steering",
  )
  const [phase, setPhase] = useState<Conversation14Controller["phase"]>(
    scenario === "unknown" ? "unknown" : "ready",
  )
  const [handoff, setHandoff] = useState("")
  const addFeedbackToDraft = (text: string) => {
    base.updateDraft({
      text: [base.draft.text, text].filter(Boolean).join("\n\n"),
    })
    base.focusComposer()
  }
  return {
    ...base,
    reviewOpen,
    setReviewOpen,
    changes: fixture.changes,
    summaries: fixture.summaries,
    fileId,
    setFileId,
    comments,
    setComments,
    reviewed,
    commitMessage,
    setCommitMessage,
    phase,
    handoff,
    markReviewed: () =>
      setReviewed((previous) =>
        previous.includes(fileId) ? previous : [...previous, fileId],
      ),
    addFeedbackToDraft,
    requestChanges: () =>
      addFeedbackToDraft(
        base.label("请修改此变更集：\n", "Please revise this change set:\n"),
      ),
    reconcile: () => {
      if (phase !== "unknown") return
      setPhase("ready")
      setHandoff(
        base.label(
          "本地回执确认尚未创建记录；未自动重放。",
          "Local receipt confirms no record was created; nothing was replayed.",
        ),
      )
      base.focusComposer()
    },
    prepare: () => {
      if (phase !== "ready" || !commitMessage.trim()) return
      setHandoff(
        `${commitMessage.trim()}\n\n${fixture.summaries.map((file) => file.path).join("\n")}\n\n${base.label("本地演示提交记录；未创建 Git 提交或推送。", "Local demo commit record; no Git commit or push was created.")}`,
      )
      setPhase("prepared")
      base.focusComposer()
    },
  }
}

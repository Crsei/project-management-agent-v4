"use client"
import { useRef, useState } from "react"
import type { ChangeSet, ChangedFile, ReviewComment } from "./resource-model"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
import {
  useResourcePanel,
  type ResourcePanelController,
} from "./resource-layout"
import type {
  Conversation5Fixture,
  Conversation5Scenario,
} from "./conversation-5-fixtures"
export interface Conversation5Controller
  extends ThreadController, ComposerDemoController, ResourcePanelController {
  changes: ChangeSet
  fileId: string
  setFileId: (id: string) => void
  view: string
  setView: (view: string) => void
  comments: ReviewComment[]
  setComments: (comments: ReviewComment[]) => void
  reviewOpen: boolean
  openReview: () => void
  closeReview: () => void
  file: ChangedFile
}
export function useConversation5Controller(
  fixture: Conversation5Fixture,
  scenario: Conversation5Scenario,
  active: boolean,
): Conversation5Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const panel = useResourcePanel({
    initialWidth: 850,
    minWidth: 680,
    maxWidth: 1050,
  })
  const [fileId, setFileId] = useState(fixture.changes.files[0].fileId)
  const [view, setView] = useState("changes")
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [reviewOpen, setReviewOpen] = useState(false)
  const reviewFocus = useRef<HTMLElement | null>(null)
  return {
    ...base,
    ...panel,
    changes: fixture.changes,
    fileId,
    setFileId,
    view,
    setView,
    comments,
    setComments: (next) => {
      if (next.length > comments.length) base.focusComposer()
      setComments(next)
    },
    reviewOpen,
    openReview: () => {
      base.rememberPosition()
      reviewFocus.current = document.activeElement as HTMLElement
      setReviewOpen(true)
    },
    closeReview: () => {
      setReviewOpen(false)
      requestAnimationFrame(() => reviewFocus.current?.focus())
    },
    file: fixture.changes.files.find((file) => file.fileId === fileId)!,
  }
}

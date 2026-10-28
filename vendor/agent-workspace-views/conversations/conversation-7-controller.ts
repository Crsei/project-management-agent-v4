"use client"
import { useState } from "react"
import type { ChangedFile } from "./resource-model"
import type { ComposerDemoController } from "../demo-controller"
import { useThreadController, type ThreadController } from "./shared"
import {
  useResourcePanel,
  type ResourcePanelController,
} from "./resource-layout"
import type {
  Conversation7Fixture,
  Conversation7Scenario,
} from "./conversation-7-fixtures"
export interface Conversation7Controller
  extends ThreadController, ComposerDemoController, ResourcePanelController {
  view: string
  setView: (value: string) => void
  previewError: boolean
  revision: number
  html: string
  reload: () => void
  viewport: string
  setViewport: (value: string) => void
  maximized: boolean
  toggleMaximized: () => void
  fileId: string
  setFileId: (id: string) => void
  files: ChangedFile[]
  file: ChangedFile
}
export function useConversation7Controller(
  fixture: Conversation7Fixture,
  scenario: Conversation7Scenario,
  active: boolean,
): Conversation7Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const panel = useResourcePanel({
    initialWidth: 995,
    minWidth: 700,
    maxWidth: 1200,
  })
  const [view, setView] = useState("preview")
  const [viewport, setViewport] = useState("desktop")
  const [fileId, setFileId] = useState("page")
  const [previewError, setPreviewError] = useState(scenario === "preview-error")
  const [revision, setRevision] = useState(1)
  const [maximized, setMaximized] = useState(false)
  return {
    ...base,
    ...panel,
    view,
    setView,
    viewport,
    setViewport,
    maximized,
    fileId,
    setFileId,
    files: fixture.files,
    file: fixture.files.find((file) => file.fileId === fileId)!,
    previewError,
    revision,
    html: fixture.html,
    reload: () => {
      setPreviewError(false)
      setRevision((value) => value + 1)
    },
    toggleMaximized: () => {
      base.rememberPosition()
      setMaximized((value) => !value)
    },
  }
}

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
  Conversation6Fixture,
  Conversation6Scenario,
  TerminalRecord,
} from "./conversation-6-fixtures"
export interface Conversation6Controller
  extends ThreadController, ComposerDemoController, ResourcePanelController {
  view: string
  setView: (value: string) => void
  fileView: string
  setFileView: (value: string) => void
  fileId: string
  setFileId: (value: string) => void
  files: ChangedFile[]
  file: ChangedFile
  status: Conversation6Fixture["status"]
  transcript: TerminalRecord[]
  replay: () => void
  advance: () => void
}
export function useConversation6Controller(
  fixture: Conversation6Fixture,
  scenario: Conversation6Scenario,
  active: boolean,
): Conversation6Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const panel = useResourcePanel({
    initialWidth: 835,
    minWidth: 650,
    maxWidth: 1050,
  })
  const [view, setView] = useState("terminal")
  const [fileView, setFileView] = useState("changes")
  const [fileId, setFileId] = useState(fixture.files[0].fileId)
  const [status, setStatus] = useState(fixture.status)
  const [stage, setStage] = useState(
    fixture.status === "running" ? 1 : fixture.transcript.length,
  )
  return {
    ...base,
    ...panel,
    view,
    setView,
    fileView,
    setFileView,
    files: fixture.files,
    file: fixture.files.find((file) => file.fileId === fileId)!,
    fileId,
    setFileId,
    status,
    transcript: fixture.transcript.slice(0, stage),
    replay: () => {
      setStage(1)
      setStatus("running")
    },
    advance: () => {
      if (status !== "running") return
      const next = Math.min(fixture.transcript.length, stage + 1)
      setStage(next)
      if (next === fixture.transcript.length) setStatus("completed")
    },
  }
}

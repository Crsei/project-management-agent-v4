"use client"
import { useEffect, useRef, useState, type RefObject } from "react"
import type { ComposerDemoController } from "../demo-controller"
import type { LocalArtifact } from "./artifact-model"
import { useThreadController, type ThreadController } from "./shared"
import {
  useResourcePanel,
  type ResourcePanelController,
} from "./resource-layout"
import { useArtifactPreview } from "./artifacts"
import type {
  Conversation8Fixture,
  Conversation8Scenario,
  EditorialSource,
  TranscriptCue,
} from "./conversation-8-fixtures"
export interface Conversation8Controller
  extends ThreadController, ComposerDemoController, ResourcePanelController {
  artifacts: readonly LocalArtifact[]
  artifact: LocalArtifact | undefined
  setArtifactId: (id: string | null) => void
  finalFocus: RefObject<HTMLElement | null>
  openArtifact: (id: string) => void
  cues: TranscriptCue[]
  sources: EditorialSource[]
  video: RefObject<HTMLVideoElement | null>
  time: number
  setTime: (value: number) => void
  duration: number
  setDuration: (value: number) => void
  mediaError: boolean
  setMediaError: (value: boolean) => void
  seek: (value: number) => void
  retryMedia: () => void
  transcriptQuery: string
  setTranscriptQuery: (value: string) => void
  tab: string
  setTab: (value: string) => void
  section: string
  setSection: (value: string) => void
  addedSources: string[]
  addSource: (file: File) => void
}
export function useConversation8Controller(
  fixture: Conversation8Fixture,
  scenario: Conversation8Scenario,
  active: boolean,
): Conversation8Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const panel = useResourcePanel({
    initialWidth: 420,
    minWidth: 380,
    maxWidth: 550,
  })
  const preview = useArtifactPreview(fixture.artifacts)
  const video = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [mediaError, setMediaError] = useState(scenario === "media-error")
  const [transcriptQuery, setTranscriptQuery] = useState("")
  const [tab, setTab] = useState("transcript")
  const [section, setSection] = useState("recording")
  const [addedSources, setAddedSources] = useState<string[]>([])
  useEffect(() => {
    const element = video.current
    if (!element) return
    const update = () => {
      if (Number.isFinite(element.duration)) setDuration(element.duration)
    }
    element.addEventListener("loadedmetadata", update)
    const frame = requestAnimationFrame(update)
    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener("loadedmetadata", update)
    }
  }, [])
  useEffect(() => {
    if (
      !active ||
      !panel.panelOpen ||
      base.selectedId !== fixture.source.selectedId ||
      section !== "recording"
    )
      video.current?.pause()
  }, [
    active,
    panel.panelOpen,
    base.selectedId,
    fixture.source.selectedId,
    section,
  ])
  return {
    ...base,
    ...panel,
    ...preview,
    cues: fixture.cues,
    sources: fixture.sources,
    video,
    time,
    setTime,
    duration,
    setDuration,
    mediaError,
    setMediaError,
    transcriptQuery,
    setTranscriptQuery,
    tab,
    setTab,
    section,
    setSection,
    addedSources,
    seek: (value) => {
      if (!video.current || mediaError || !duration) return
      video.current.currentTime = Math.max(0, Math.min(duration, value))
      setTime(video.current.currentTime)
      panel.setPanelOpen(true)
      setSection("recording")
    },
    retryMedia: () => {
      setMediaError(false)
      video.current?.load()
    },
    addSource: (file) => {
      setAddedSources((previous) => [
        ...previous,
        `${file.name} · ${file.size} bytes · local attachment metadata only`,
      ])
      setSection("sources")
    },
  }
}

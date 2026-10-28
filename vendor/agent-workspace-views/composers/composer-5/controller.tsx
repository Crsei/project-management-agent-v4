"use client"

import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { useComposerDemoController } from "../../demo-controller"
import type { ComposerController } from "../../controller"
import { useRemainingPageState } from "../../showcase/state"
import type { RemainingPageProps } from "../../showcase/model"
import type { ComposerDemoSource } from "../../demo-source"
import type { Copy } from "../../model"
import { apps, createFixture, prompts, references, type AppId } from "./fixtures"
import { buildReply, evidenceForPrompt, selectReference, setConnection, type SourceState } from "./model"

export type PageController = ComposerController & {
  sources: SourceState
  sourceId: AppId | null
  setSourceId: Dispatch<SetStateAction<AppId | null>>
  referenceId: string | null
  setReferenceId: Dispatch<SetStateAction<string | null>>
  readonly: boolean
  suggestion: string
  choosePrompt: (id: string) => void
  toggleConnection: (app: AppId) => void
  toggleReference: (id: string) => void
  readState: "ready" | "loading" | "error"
  setReadState: Dispatch<SetStateAction<PageController["readState"]>>
  notice: Copy | null
  voiceOpen: boolean
  setVoiceOpen: Dispatch<SetStateAction<boolean>>
  transcript: string
  setTranscript: Dispatch<SetStateAction<string>>
  fileInput: RefObject<HTMLInputElement | null>
  addFiles: (files: FileList | null) => void
  useTranscript: () => void
}

export function usePageController({ scenario, active, cache }: RemainingPageProps): PageController {
  const { locale } = useI18n()
  const [seed] = useState<ComposerDemoSource>(() => cache.get("composer-5:composer") as ComposerDemoSource ?? createFixture(scenario, locale))
  const [sources, setSources] = useRemainingPageState<SourceState>("composer-5:sources", () => ({ connected: scenario === "empty" ? [] : apps.map(app => app.id), selectedIds: [] }))
  const [suggestion, setSuggestion] = useRemainingPageState("composer-5:suggestion", () => "followup")
  const [readState, setReadState] = useRemainingPageState<PageController["readState"]>("composer-5:read-state", () => scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready")
  const [sourceId, setSourceId] = useState<AppId | null>(null)
  const [referenceId, setReferenceId] = useState<string | null>(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [transcript, setTranscript] = useRemainingPageState<string>("composer-5:transcript", () => prompts[3].prompt[locale])
  const [notice, setNotice] = useState<Copy | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const runtimeSource = { ...seed, contextItems: references.filter(r => sources.connected.includes(r.app)), canSend: scenario !== "readonly" && readState !== "loading" }
  const base = useComposerDemoController(runtimeSource, active)
  const evidence = evidenceForPrompt({ ...sources, selectedIds: base.draft.contextIds }, base.draft.text)
  const readonly = scenario === "readonly"

  useEffect(() => {
    cache.set("composer-5:composer", { ...seed, sessions: base.sessions, drafts: base.drafts, selectedId: base.selectedId, projectId: base.projectId })
  }, [cache, seed, base.sessions, base.drafts, base.selectedId, base.projectId])

  function choosePrompt(id: string) {
    if (readonly) return
    const prompt = prompts.find(p => p.id === id)
    if (!prompt) return
    setSuggestion(id)
    base.updateDraft({ text: base.copy(prompt.prompt) })
    base.focusComposer()
  }
  function toggleConnection(app: AppId) {
    if (readonly) return
    const connected = !sources.connected.includes(app)
    setSources(current => setConnection(current, app, connected))
    if (!connected) base.updateDraft({ contextIds: base.draft.contextIds.filter(id => references.find(r => r.id === id)?.app !== app) })
  }
  function toggleReference(id: string) {
    if (readonly) return
    const current = { ...sources, selectedIds: base.draft.contextIds }
    const next = selectReference(current, id)
    if (next === current) return
    base.updateDraft({ contextIds: next.selectedIds })
    base.focusComposer()
  }
  function sendMessage() {
    if (!runtimeSource.canSend || !base.draft.text.trim()) return
    const groundedNames = evidence.map(r => r.name)
    base.sendMessage()
    base.setSessions(previous => previous.map(session => session.id !== base.selectedId ? session : {
      ...session,
      messages: session.messages.map((message, i) => i === session.messages.length - 1 ? { ...message, text: buildReply(evidence), contexts: groundedNames } : message),
    }))
  }
  function addFiles(files: FileList | null) {
    if (readonly || !files?.length) return
    const file = files[0]
    setNotice({ "zh-CN": `已选择 ${file.name}（${file.size} 字节）。仅保存本地描述，没有读取或上传文件。`, en: `Selected ${file.name} (${file.size} bytes). Only a local descriptor was saved; no file was read or uploaded.` })
    base.updateDraft({ text: base.draft.text.trim() ? `${base.draft.text}\n\n${file.name} · ${file.size} bytes` : `${base.label("汇总本地 CSV 描述", "Summarize this local CSV descriptor")}: ${file.name} · ${file.size} bytes` })
    if (fileInput.current) fileInput.current.value = ""
    base.focusComposer()
  }
  return {
    ...base, sendMessage, canSend: runtimeSource.canSend,
    sources, sourceId, setSourceId, referenceId, setReferenceId, readonly,
    suggestion, choosePrompt, toggleConnection, toggleReference,
    readState, setReadState, notice, voiceOpen, setVoiceOpen, transcript, setTranscript,
    fileInput, addFiles,
    useTranscript: () => {
      if (readonly || !transcript.trim()) return
      base.updateDraft({ text: `${base.draft.text}${base.draft.text.trim() ? "\n" : ""}${transcript.trim()}` })
      setVoiceOpen(false)
      base.focusComposer()
    },
  }
}

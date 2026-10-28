"use client"
import {
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react"
import { useThreadController, type ThreadController } from "./shared"
import type { ComposerDemoController } from "../demo-controller"
import type { ChatEntry, Copy } from "../model"
import type {
  Conversation20Fixture,
  Conversation20Scenario,
  ContextUsage,
} from "./conversation-20-fixtures"
export type CompactionPhase = "ready" | "warning" | "unknown" | "compacted"
export interface Conversation20Controller
  extends ComposerDemoController, ThreadController {
  original: ChatEntry[]
  summaryText: string
  setSummaryText: Dispatch<SetStateAction<string>>
  previewOpen: boolean
  setPreviewOpen: Dispatch<SetStateAction<boolean>>
  archiveOpen: boolean
  setArchiveOpen: Dispatch<SetStateAction<boolean>>
  usageOpen: boolean
  setUsageOpen: Dispatch<SetStateAction<boolean>>
  phase: CompactionPhase
  error: Copy | null
  finalFocus: RefObject<HTMLElement | null>
  used: number
  limit: number
  usage: ContextUsage
  retained: Conversation20Fixture["retained"]
  openPreview: () => void
  reconcile: () => void
  apply: () => void
}
export function useConversation20Controller(
  fixture: Conversation20Fixture,
  scenario: Conversation20Scenario,
  active: boolean,
): Conversation20Controller {
  const [phase, setPhase] = useState<CompactionPhase>(
    scenario === "empty"
      ? "ready"
      : scenario === "unknown"
        ? "unknown"
        : "warning",
  )
  const base = useThreadController(fixture.source, scenario, active, {
    canSend: phase === "compacted" || phase === "ready",
  })
  const [original] = useState(() => structuredClone(fixture.archive))
  const [summaryText, setSummaryText] = useState(() =>
    base.copy(fixture.summary),
  )
  const [previewOpen, setPreviewOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [error, setError] = useState<Copy | null>(null)
  const [attempted, setAttempted] = useState(false)
  const finalFocus = useRef<HTMLElement | null>(null)
  return {
    ...base,
    original,
    summaryText,
    setSummaryText,
    previewOpen,
    setPreviewOpen,
    archiveOpen,
    setArchiveOpen,
    usageOpen,
    setUsageOpen,
    phase,
    error,
    finalFocus,
    used:
      phase === "ready"
        ? 0
        : phase === "compacted"
          ? fixture.usage.after
          : fixture.usage.before,
    limit: fixture.usage.limit,
    usage: fixture.usage,
    retained: fixture.retained,
    openPreview: () => {
      finalFocus.current = document.activeElement as HTMLElement
      setUsageOpen(false)
      setPreviewOpen(true)
    },
    reconcile: () => {
      if (phase === "unknown") {
        setPhase("warning")
        base.focusComposer()
      }
    },
    apply: () => {
      if (phase !== "warning" || !summaryText.trim()) return
      if (scenario === "compaction-error" && !attempted) {
        setAttempted(true)
        setError({
          "zh-CN": "本地压缩示例失败；历史、摘要和草稿保留，可重试。",
          en: "Local compaction example failed; history, summary and draft are preserved for retry.",
        })
        return
      }
      base.rememberPosition()
      base.setSessions((previous) =>
        previous.map((session) =>
          session.id === fixture.source.selectedId
            ? {
                ...session,
                messages: [
                  {
                    id: "conversation-20-summary",
                    role: "assistant",
                    text: summaryText.trim(),
                  },
                  ...session.messages.slice(-2),
                ],
              }
            : session,
        ),
      )
      setPhase("compacted")
      setError(null)
      setPreviewOpen(false)
      base.focusComposer()
    },
  }
}

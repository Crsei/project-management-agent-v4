"use client"
import { useState } from "react"
import {
  openResourceDocument,
  closeResourceDocument,
  neutralResourceKey,
  type WorkbenchResource,
  type WorkbenchDocuments,
} from "./resource-model"
import type { Copy } from "../model"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation11Fixture,
  Conversation11Scenario,
} from "./conversation-11-fixtures"
export interface Conversation11Controller extends ThreadController {
  files: WorkbenchResource[]
  documents: WorkbenchDocuments
  selectedResource: WorkbenchResource | undefined
  notice: Copy | null
  cardOpen: boolean
  updatedAt: string
  selectFile: (id: string) => void
  selectDocument: (key: string) => void
  closeDocument: (key: string) => void
  pinDocument: (file: WorkbenchResource) => void
  regenerate: () => void
  download: () => void
  copyArtifact: () => Promise<void>
  closeArtifact: () => void
  reopenArtifact: () => void
}
export function useConversation11Controller(
  fixture: Conversation11Fixture,
  scenario: Conversation11Scenario,
  active: boolean,
): Conversation11Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const [documents, setDocuments] = useState<WorkbenchDocuments>(() =>
    openResourceDocument({ documents: [] }, fixture.files[0]),
  )
  const [versions, setVersions] = useState<Record<string, number>>({})
  const [notice, setNotice] = useState<Copy | null>(null)
  const [cardOpen, setCardOpen] = useState(true)
  const [updatedAt, setUpdatedAt] = useState("2026-10-14T10:24:00Z")
  const selected = documents.documents.find(
    (doc) => neutralResourceKey(doc.resource) === documents.activeKey,
  )?.resource
  const resource = (
    id: string,
    version: number,
  ): WorkbenchResource | undefined => {
    const file = fixture.files.find((file) => file.resourceId === id)
    return file
      ? {
          ...file,
          revision: `v${version}`,
          text:
            (version > 1 ? `// Local regenerated artifact v${version}\n` : "") +
            file.text,
        }
      : undefined
  }
  const open = (file: WorkbenchResource, pinned = false) =>
    setDocuments((previous) => openResourceDocument(previous, file, pinned))
  return {
    ...base,
    files: fixture.files,
    documents,
    selectedResource: selected,
    notice,
    cardOpen,
    updatedAt,
    selectFile: (id) => {
      const file = resource(id, versions[id] ?? 1)
      if (file) open(file)
    },
    selectDocument: (key) =>
      setDocuments((previous) => ({ ...previous, activeKey: key })),
    closeDocument: (key) =>
      setDocuments((previous) => closeResourceDocument(previous, key)),
    pinDocument: (file) => open(file, true),
    regenerate: () => {
      if (!selected) return
      const next = (versions[selected.resourceId] ?? 1) + 1
      const file = resource(selected.resourceId, next)
      if (!file) return
      setVersions((previous) => ({ ...previous, [selected.resourceId]: next }))
      open(file)
      setUpdatedAt(new Date().toISOString())
      setNotice({
        "zh-CN": "所选文件的本地新版本已生成；未调用模型或写入文件。",
        en: "A new local revision of the selected file was generated; no model call or file write.",
      })
    },
    download: () => {
      if (!selected) return
      const url = URL.createObjectURL(
        new Blob([selected.text ?? ""], { type: "text/plain" }),
      )
      const link = document.createElement("a")
      link.href = url
      link.download = selected.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice({
        "zh-CN": "已发起所选本地产物下载。",
        en: "Download of selected local artifact started.",
      })
    },
    copyArtifact: async () => {
      if (!selected) return
      try {
        await navigator.clipboard.writeText(selected.text ?? "")
        setNotice({
          "zh-CN": "已复制所选源码。",
          en: "Selected source copied.",
        })
      } catch {
        setNotice({
          "zh-CN": "剪贴板不可用，请下载所选源码。",
          en: "Clipboard unavailable; download the selected source.",
        })
      }
    },
    closeArtifact: () => {
      setCardOpen(false)
      base.focusComposer()
    },
    reopenArtifact: () => setCardOpen(true),
  }
}

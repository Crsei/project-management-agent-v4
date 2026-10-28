"use client"
import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react"
import type { Copy } from "../model"
import type { ComposerDemoController } from "../demo-controller"
import { useThreadController, type ThreadController } from "./shared"
import type {
  Conversation16Fixture,
  Conversation16Scenario,
  ResponseVersion,
} from "./conversation-16-fixtures"
export interface Conversation16Controller extends ComposerDemoController {
  readState: ThreadController["readState"]
  setReadState: ThreadController["setReadState"]
  versions: ResponseVersion[]
  versionIndex: number
  currentVersion: ResponseVersion | undefined
  pair: ResponseVersion[]
  compareOpen: boolean
  editOpen: boolean
  editText: string
  setEditText: Dispatch<SetStateAction<string>>
  editError: Copy | null
  editFocus: RefObject<HTMLElement | null>
  chooseVersion: (index: number) => void
  openCompare: () => void
  closeCompare: () => void
  beginEdit: () => void
  closeEdit: () => void
  saveEdit: () => void
  regenerate: () => void
}
export function useConversation16Controller(
  fixture: Conversation16Fixture,
  scenario: Conversation16Scenario,
  active: boolean,
): Conversation16Controller {
  const base = useThreadController(
    {
      ...fixture.source,
      initialReadingPosition: scenario === "long" ? "start" : "latest",
    },
    scenario,
    active,
  )
  const [versions, setVersions] = useState(() =>
    structuredClone(fixture.versions),
  )
  const [versionIndex, setVersionIndex] = useState(
    Math.max(0, fixture.versions.length - 1),
  )
  const [compareOpen, setCompareOpen] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [editText, setEditText] = useState("")
  const [editError, setEditError] = useState<Copy | null>(null)
  const [attempted, setAttempted] = useState(false)
  const editFocus = useRef<HTMLElement | null>(null)
  const currentVersion = versions[versionIndex]
  function append(prompt: string | Copy) {
    const version: ResponseVersion = {
      id: `branch-${versions.length + 1}`,
      name: {
        "zh-CN": `本地分支 ${versions.length + 1}`,
        en: `Local branch ${versions.length + 1}`,
      },
      summary: {
        "zh-CN": "保留之前版本的本地响应",
        en: "Local response preserving earlier versions",
      },
      time: new Date().toLocaleTimeString(base.locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
      prompt,
      response: {
        "zh-CN":
          "新指令保留为独立分支，旧版本和原始对话未覆盖。本地固定响应，没有调用模型。",
        en: "The instruction is preserved in a separate branch; old versions and the original thread are untouched. This fixed local response did not call a model.",
      },
    }
    setVersions((previous) => [...previous, version])
    setVersionIndex(versions.length)
  }
  return {
    ...base,
    versions,
    versionIndex,
    currentVersion,
    compareOpen,
    editOpen,
    editText,
    setEditText,
    editError,
    editFocus,
    pair:
      versionIndex > 0
        ? versions.slice(versionIndex - 1, versionIndex + 1)
        : versions.slice(0, 2),
    chooseVersion: (index) => {
      if (versions[index]) setVersionIndex(index)
    },
    openCompare: () => setCompareOpen(true),
    closeCompare: () => {
      setCompareOpen(false)
      base.focusComposer()
    },
    beginEdit: () => {
      if (!currentVersion) return
      editFocus.current = document.activeElement as HTMLElement
      if (!editError) setEditText(base.copy(currentVersion.prompt))
      setEditOpen(true)
    },
    closeEdit: () => setEditOpen(false),
    saveEdit: () => {
      if (!editText.trim()) {
        setEditError({
          "zh-CN": "消息不能为空。",
          en: "A message cannot be empty.",
        })
        return
      }
      if (scenario === "edit-error" && !attempted) {
        setAttempted(true)
        setEditError({
          "zh-CN": "本地编辑示例失败；修改已保留，可重试。",
          en: "Local edit example failed; changes are retained for retry.",
        })
        return
      }
      append(editText.trim())
      setEditError(null)
      setEditOpen(false)
    },
    regenerate: () => {
      if (currentVersion) append(currentVersion.prompt)
    },
  }
}

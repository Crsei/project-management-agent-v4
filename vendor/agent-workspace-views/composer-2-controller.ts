"use client"

import { useRef, useState } from "react"
import { useComposerDemoController } from "./demo-controller"
import type { Composer2Attachment, Composer2Source } from "./composer-2-fixtures"
import type { Copy } from "./model"

/** Adds attachment descriptors to the shared local controller; never reads or uploads file contents. */
export function useComposer2Controller(source: Composer2Source, active = true) {
  const [attachmentItems, setAttachmentItems] = useState(() =>
    structuredClone(source.attachmentItems),
  )
  const [notice, setNotice] = useState<Copy | null>(null)
  const [summaryId, setSummaryId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const localSequence = useRef(0)
  const base = useComposerDemoController(
    {
      ...source,
      canSend: true,
      runtime: undefined,
      contextItems: attachmentItems.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        kind: { "zh-CN": "附件描述", en: "Attachment descriptor" },
      })),
    },
    active,
  )
  const attachments = attachmentItems.filter((item) =>
    base.draft.contextIds.includes(item.id),
  )
  const processing = attachments.some((item) =>
    ["uploading", "processing"].includes(item.status),
  )
  const failed = attachments.some((item) => item.status === "error")
  const unknown = attachments.some((item) => item.status === "unknown")
  const canSend = !processing && !failed && !unknown
  const runtime =
    (failed && source.runtime?.status === "failed") ||
    (unknown && source.runtime?.status === "unknown")
      ? source.runtime
      : undefined

  function addAttachments(items: Composer2Attachment[]) {
    const ids = new Set(base.draft.contextIds)
    items.forEach((item) => ids.add(item.id))
    setAttachmentItems((previous) => {
      const known = new Set(previous.map((item) => item.id))
      return [...previous, ...items.filter((item) => !known.has(item.id))]
    })
    base.updateDraft({ contextIds: [...ids] })
    base.focusComposer()
  }
  function addReference(id: string) {
    const item = attachmentItems.find((value) => value.id === id)
    if (item) addAttachments([item])
  }
  function removeAttachment(id: string) {
    const item = attachments.find((value) => value.id === id)
    if (!item || ["uploading", "processing", "unknown"].includes(item.status)) return
    base.removeContext(id)
  }
  function attachSelectedFiles(files: FileList | null) {
    if (!files?.length) return
    const descriptors: Composer2Attachment[] = Array.from(files).map((file) => ({
      id: `file-${++localSequence.current}`,
      name: file.name,
      kind: file.type.startsWith("image/") ? "image" : "document",
      description: {
        "zh-CN": `${file.size.toLocaleString("zh-CN")} 字节 · 本地文件描述`,
        en: `${file.size.toLocaleString("en")} bytes · Local file descriptor`,
      },
      summary: {
        "zh-CN": "仅记录文件名、大小和类型；没有读取文件内容、上传或生成摘要。",
        en: "Only the file name, size, and type were recorded. No contents were read, uploaded, or summarized.",
      },
      status: "done",
    }))
    addAttachments(descriptors)
    setNotice({ "zh-CN": "已添加本地文件描述；未读取或上传内容。", en: "Local file descriptors added; no contents read or uploaded." })
    if (fileInput.current) fileInput.current.value = ""
  }
  function refinePrompt() {
    if (!base.draft.text.trim()) {
      setNotice({ "zh-CN": "先输入任务说明，再使用本地提示词模板。", en: "Enter a task before applying the local prompt template." })
      base.focusComposer()
      return
    }
    const suffix = base.label(
      "请结合引用摘要，列出目标、关键界面状态和可验证的下一步。",
      "Use the reference summaries to list the goal, key UI states, and verifiable next steps.",
    )
    if (!base.draft.text.includes(suffix))
      base.updateDraft({ text: `${base.draft.text.trimEnd()}\n\n${suffix}` })
    setNotice({ "zh-CN": "已应用本地提示词模板。", en: "Local prompt template applied." })
    base.focusComposer()
  }
  function addTargetReference(kind: "area" | "element") {
    addAttachments([{
      id: `example-${kind}`,
      name: kind === "area" ? "Workspace navigation" : "Send message button",
      kind,
      description: kind === "area"
        ? { "zh-CN": "固定区域引用 · 工作空间导航", en: "Fixed area reference · Workspace navigation" }
        : { "zh-CN": "固定元素引用 · 发送按钮", en: "Fixed element reference · Send button" },
      summary: {
        "zh-CN": "固定的本地界面引用，用于说明区域或元素上下文；没有捕获屏幕或操作外部页面。",
        en: "A fixed local UI reference demonstrating area or element context; no screen capture or external page interaction occurred.",
      },
      status: "done",
    }])
    setNotice({ "zh-CN": "已添加固定示例引用。", en: "Fixed example reference added." })
  }
  function resolveAttachmentState(status: "processing" | "unknown") {
    const ids = new Set(attachments.filter((item) => item.status === status).map((item) => item.id))
    setAttachmentItems((previous) => previous.map((item) =>
      ids.has(item.id) ? { ...item, status: "done" } : item,
    ))
    setNotice(status === "unknown"
      ? { "zh-CN": "固定示例检查：没有模型请求被执行。草稿保留，请自行决定是否发送。", en: "Fixed example check: no model request ran. Your draft is preserved; decide whether to send." }
      : { "zh-CN": "本地解析示例已结束；摘要来自固定fixture，没有读取文件。", en: "Local processing example ended; the summary comes from a fixed fixture, without reading files." })
    base.focusComposer()
  }

  return {
    ...base,
    attachments,
    attachmentItems,
    summary: attachmentItems.find((item) => item.id === summaryId),
    summaryId,
    setSummaryId,
    notice,
    fileInput,
    processing,
    failed,
    unknown,
    runtime,
    canSend,
    addReference,
    removeAttachment,
    attachSelectedFiles,
    refinePrompt,
    addTargetReference,
    resolveAttachmentState,
    sendMessage: () => {
      if (canSend) base.sendMessage()
    },
  }
}
export type Composer2Controller = ReturnType<typeof useComposer2Controller>

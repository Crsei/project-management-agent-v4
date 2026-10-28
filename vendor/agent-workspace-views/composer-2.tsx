"use client"

import type { ReactNode } from "react"
import { CircleDashed, FileText, Folder, Image, MousePointer2, PencilLine, Plus, Upload } from "lucide-react"
import { Attachment } from "@easyuse-ui/ui/components/ui/attachment"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { ComposerWorkspaceView, type ComposerHost } from "./composer-workspace-view"
import type { Composer2Controller } from "./composer-2-controller"
import type { Composer2Attachment } from "./composer-2-fixtures"
import styles from "./composer-2.module.css"

function AttachmentIcon({ kind }: { kind: Composer2Attachment["kind"] }) {
  const Icon = kind === "image" ? Image : kind === "folder" ? Folder : kind === "area" ? CircleDashed : kind === "element" ? MousePointer2 : FileText
  return <Icon size={16} aria-hidden="true" />
}

export function Composer2View({ controller, host }: { controller: Composer2Controller; host: ComposerHost }) {
  const { copy, label, summary, setSummaryId, fileInput } = controller
  const tool = (name: string, icon: ReactNode, action: () => void) => (
    <Button variant="ghost" size="icon" className={styles.tool} aria-label={name} onClick={action}>{icon}</Button>
  )
  return (
    <>
      <ComposerWorkspaceView
        controller={controller}
        host={host}
        presentation={{
          id: "composer-2",
          title: { "zh-CN": "Composer 2", en: "Composer 2" },
          welcome: {
            title: { "zh-CN": "从引用材料开始", en: "Work with your references" },
            description: { "zh-CN": "添加附件、查看摘要，再描述任务。本地示例不会上传文件。", en: "Attach files, inspect summaries, then describe your task. This local example does not upload files." },
          },
          beforeInput: (controller.processing || controller.failed || controller.unknown || controller.notice) && (
            <div className={styles.notice} data-composer2-region="attachment-status" data-error={controller.failed} role={controller.failed ? "alert" : "status"}>
              <span>{controller.unknown
                ? label("附件状态未知；检查状态后再发送，草稿已保留。", "Attachment status is unknown. Check before sending; your draft is preserved.")
                : controller.failed
                  ? label("引用已失效。移除失效引用后可发送，草稿已保留。", "A reference is unavailable. Remove it to send; your draft is preserved.")
                  : controller.processing
                    ? label("附件解析中 · 固定本地场景", "Processing attachment · Fixed local scenario")
                    : controller.notice && copy(controller.notice)}</span>
              {controller.processing && <Button variant="outline" onClick={() => controller.resolveAttachmentState("processing")}>{label("完成解析示例", "Finish example processing")}</Button>}
              {controller.unknown && <Button variant="outline" onClick={() => controller.resolveAttachmentState("unknown")}>{label("检查示例状态", "Check example status")}</Button>}
            </div>
          ),
          input: {
            appearance: "attachments",
            attachments: controller.attachments.length ? (
              <ul className={styles.attachmentList} aria-label={label("附件引用", "Attachment references")} aria-busy={controller.processing || undefined}>
                {controller.attachments.map((item) => (
                  <li key={item.id}>
                    <Attachment
                      variant="chip"
                      className={styles.attachment}
                      name={item.name}
                      description={copy(item.description)}
                      leading={<AttachmentIcon kind={item.kind} />}
                      status={item.status}
                      error={item.error ? copy(item.error) : undefined}
                      onOpen={() => setSummaryId(item.id)}
                      onRemove={() => controller.removeAttachment(item.id)}
                    />
                  </li>
                ))}
              </ul>
            ) : undefined,
            leadingAction: (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className={styles.tool} aria-label={label("添加上下文", "Add context")} />}><Plus /></DropdownMenuTrigger>
                <DropdownMenuContent className={styles.menu}>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{label("添加上下文 · 本地示例", "Add context · Local example")}</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => fileInput.current?.click()}><Upload size={16} />{label("选择本地文件描述", "Choose local file descriptors")}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {controller.attachmentItems.filter((item) => ["audit", "image", "notes"].includes(item.id)).map((item) => (
                      <DropdownMenuItem key={item.id} disabled={controller.draft.contextIds.includes(item.id)} onClick={() => controller.addReference(item.id)}><AttachmentIcon kind={item.kind} />{item.name}</DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
            tools: <>
              {tool(label("优化提示词", "Refine prompt"), <PencilLine />, controller.refinePrompt)}
              {tool(label("选择上下文区域", "Select context area"), <CircleDashed />, () => controller.addTargetReference("area"))}
              {tool(label("指向元素", "Point to element"), <MousePointer2 />, () => controller.addTargetReference("element"))}
            </>,
            showContextReferences: false,
            showBlocksControl: false,
            hideSuggestion: true,
            placeholder: { "zh-CN": "根据引用材料补充任务说明…", en: "Add instructions from attached references..." },
            formLabel: { "zh-CN": "带附件的消息编辑器", en: "Composer with attachments" },
          },
        }}
      />
      <input ref={fileInput} type="file" multiple hidden aria-label={label("选择本地文件描述", "Choose local file descriptors")} onChange={(event) => controller.attachSelectedFiles(event.target.files)} />
      <Dialog open={!!summary} onOpenChange={(open) => { if (!open) setSummaryId(null) }}>
        <DialogContent>
          <DialogTitle>{label("引用摘要", "Reference summary")}</DialogTitle>
          <DialogDescription>{label("固定示例摘要；本地文件仅显示描述，没有读取或上传内容。", "Fixed example summaries; local files show descriptors only, without reading or uploading contents.")}</DialogDescription>
          {summary && <div className={styles.summary} data-composer2-region="attachment-summary">
            <span className={styles.summaryLabel}>{label("示例摘要", "Example summary")}</span>
            <h2>{summary.name}</h2>
            <p>{copy(summary.description)}</p>
            <p>{copy(summary.summary)}</p>
          </div>}
        </DialogContent>
      </Dialog>
    </>
  )
}

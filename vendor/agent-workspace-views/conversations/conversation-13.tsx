"use client"
import { ArrowDown, ArrowUp, Pencil, X, ChevronDown, File } from "lucide-react"
import { useId } from "react"
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldLabel,
  FieldError,
  Textarea,
} from "./ui"
import { ThreadMessage, ThreadView, ThreadPanel } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation13Controller } from "./conversation-13-controller"

export function Conversation13View({
  controller,
  host,
}: {
  controller: Conversation13Controller
  host: ComposerHost
}) {
  const { label, copy, queue } = controller
  const editId = useId()
  const beforeInput = (
    <Collapsible
      defaultOpen
      className="mb-2 rounded-panel border"
      aria-label={label("待发送指令", "Queued requests")}
    >
      <div className="flex items-center justify-between p-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost">
            <ChevronDown size={16} />
            {label("待发送指令", "Queued requests")} · {queue.items.length}
          </Button>
        </CollapsibleTrigger>
        {queue.phase === "ready" && (
          <Button
            variant="outline"
            disabled={!queue.items.length}
            onClick={controller.deliver}
          >
            {label("投递下一条示例", "Deliver next example request")}
          </Button>
        )}
        {queue.phase === "unknown" && (
          <Button variant="outline" onClick={controller.reconcile}>
            {label("检查投递示例状态", "Check example delivery status")}
          </Button>
        )}
      </div>
      <CollapsibleContent forceMount>
        <ol className="max-h-56 overflow-y-auto">
          {queue.items.map((item, index) => (
            <li key={item.id} className="flex gap-3 border-t px-3 py-2">
              <span className="pt-1 text-xs text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{copy(item.draft.text)}</p>
                {item.description && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {copy(item.description)}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.attachments?.map((name) => (
                    <Badge variant="outline" key={name}>
                      <File size={12} />
                      {name}
                    </Badge>
                  ))}
                  {item.draft.contextIds.map((id) => (
                    <Badge variant="outline" key={id}>
                      {controller.contextItems.find(
                        (context) => context.id === id,
                      )?.name ?? id}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  aria-label={
                    label("上移", "Move up") + ": " + copy(item.draft.text)
                  }
                  onClick={() => controller.move(item.id, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === queue.items.length - 1}
                  aria-label={
                    label("下移", "Move down") + ": " + copy(item.draft.text)
                  }
                  onClick={() => controller.move(item.id, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    label("编辑", "Edit") + ": " + copy(item.draft.text)
                  }
                  onClick={() => controller.beginEdit(item.id)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    label("移除", "Remove") + ": " + copy(item.draft.text)
                  }
                  onClick={() => controller.remove(item.id)}
                >
                  <X />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
      {queue.notice && (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {copy(queue.notice)}
        </p>
      )}
    </Collapsible>
  )
  return (
    <>
      <ThreadView
        page="conversation-13"
        controller={controller}
        host={host}
        beforeInput={
          controller.selectedId === "conversation-13" ? beforeInput : undefined
        }
        inputOptions={{
          sendLabel: controller.enqueueMode
            ? { "zh-CN": "加入待发送队列", en: "Add to pending queue" }
            : undefined,
          helpText: {
            "zh-CN": "本地演示 · 新指令加入队列，不会中断当前请求。",
            en: "Local demo · New messages join the queue without interrupting.",
          },
          placeholder: {
            "zh-CN": "添加后续指令，不打断当前审阅…",
            en: "Add a follow-up without interrupting…",
          },
        }}
        renderMessage={(message) => (
          <ThreadMessage
            message={message}
            controller={controller}
            agentRole={
              message.role === "assistant"
                ? label("任务协调员", "Task coordinator")
                : undefined
            }
          >
            {message.id === "conversation-13-answer" && (
              <ThreadPanel
                title={label("当前请求", "CURRENT REQUEST")}
                actions={
                  <Badge variant="outline">
                    {queue.phase === "busy"
                      ? label("处理中 · 本地", "Working · Local")
                      : queue.phase === "unknown"
                        ? label("投递未知", "Unknown delivery")
                        : label(
                            "当前审阅已结束 · 本地",
                            "Current review finished · Local",
                          )}
                  </Badge>
                }
              >
                <p>
                  {label(
                    "完成生成批量操作的交互审阅。",
                    "Finish the interaction review for the generated bulk actions.",
                  )}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {label(
                    "桌面选择、加载、失败和重试状态",
                    "Desktop selection, loading, failure, and retry states",
                  )}
                </p>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {queue.items.length}{" "}
                    {label("条后续指令等待中", "follow-ups waiting")}
                  </span>
                  <Button
                    variant="outline"
                    disabled={queue.phase !== "busy"}
                    onClick={controller.finish}
                  >
                    {label("结束当前", "Finish current")}
                  </Button>
                </div>
              </ThreadPanel>
            )}
          </ThreadMessage>
        )}
      />
      <Dialog
        open={!!queue.editId && controller.active}
        onOpenChange={(open) => {
          if (!open) controller.closeEdit()
        }}
      >
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            document.getElementById(editId)?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (controller.active) controller.editFocus.current?.focus()
          }}
        >
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-2 top-2"
              aria-label={label("关闭编辑", "Close edit")}
            >
              <X />
            </Button>
          </DialogClose>
          <DialogTitle>
            {label("编辑待发送指令", "Edit queued instruction")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "只修改当前指令，附件、顺序和会话草稿保持。",
              "Only changes this instruction; attachments, order and composer draft are retained.",
            )}
          </DialogDescription>
          <form
            noValidate
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              controller.saveEdit()
            }}
          >
            <Field data-invalid={!!queue.editError}>
              <FieldLabel htmlFor={editId}>
                {label("指令内容", "Instruction text")}
              </FieldLabel>
              <Textarea
                id={editId}
                required
                aria-invalid={!!queue.editError}
                aria-describedby={
                  queue.editError ? `${editId}-error` : undefined
                }
                value={queue.editText}
                onChange={(event) => controller.setEditText(event.target.value)}
              />
              {queue.editError && (
                <FieldError id={`${editId}-error`} role="alert">
                  {copy(queue.editError)}
                </FieldError>
              )}
            </Field>
            <Button type="submit">
              {label("保存指令", "Save instruction")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

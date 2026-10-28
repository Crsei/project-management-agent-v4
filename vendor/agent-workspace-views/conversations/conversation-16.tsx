"use client"
import {
  ChevronLeft,
  ChevronRight,
  GitBranch,
  RotateCcw,
  X,
} from "lucide-react"
import { useId } from "react"
import {
  Button,
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
import { Markdown } from "./markdown"
import { ThreadMessage, ThreadView, ThreadPanel } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation16Controller } from "./conversation-16-controller"
import styles from "./conversation-16.module.css"
export function Conversation16View({
  controller,
  host,
}: {
  controller: Conversation16Controller
  host: ComposerHost
}) {
  const { label, copy } = controller
  const editId = useId()
  return (
    <>
      <ThreadView
        page="conversation-16"
        controller={controller}
        host={host}
        inputOptions={{
          placeholder: {
            "zh-CN": "请求其他方向或修改当前建议…",
            en: "Ask for another direction or revise the active answer…",
          },
          helpText:
            controller.compareOpen &&
            controller.selectedId === "conversation-16"
              ? { "zh-CN": "比较中 · 本地演示", en: "Comparing · Local demo" }
              : {
                  "zh-CN": "本地演示 · 版本已保留",
                  en: "Local demo · Versions preserved",
                },
        }}
        afterInput={
          controller.selectedId === "conversation-16" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {label("产品表格审阅", "Product table review")} ·{" "}
              {controller.versions.length}{" "}
              {label("个保留版本", "preserved versions")}
            </p>
          ) : undefined
        }
        renderMessage={(message) => (
          <ThreadMessage
            message={message.id === "conversation-16-user" && controller.currentVersion ? { ...message, text: controller.currentVersion.prompt } : message}
            controller={controller}
            agentRole={
              message.role === "assistant"
                ? label("产品审阅员", "Product reviewer")
                : undefined
            }
            hideContent={message.id === "conversation-16-answer"}
          >
            {message.id === "conversation-16-user" && (
              <Button variant="ghost" onClick={controller.beginEdit}>
                {label("编辑消息", "Edit message")}
              </Button>
            )}
            {message.id === "conversation-16-answer" && (
              <>
                {controller.compareOpen ? (
                  <ThreadPanel
                    title={label("比较响应版本", "Compare response versions")}
                    actions={
                      <code className="text-xs text-muted-foreground">
                        {controller.pair
                          .map((version) => version.id)
                          .join(" → ")}
                      </code>
                    }
                  >
                    <p className="mb-3 text-xs text-muted-foreground">
                      {label(
                        "保留方向之前，先审阅变化。",
                        "Review what changed before keeping a direction.",
                      )}
                    </p>
                    <div className={styles.compare}>
                      {controller.pair.map((version, index) => (
                        <section
                          key={version.id}
                          className={
                            index === 0 ? styles.previous : styles.current
                          }
                          tabIndex={0}
                          aria-label={copy(version.name)}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="text-sm font-medium">
                              {copy(version.name)}
                            </h3>
                            <time className="whitespace-nowrap text-xs text-muted-foreground">
                              {version.time}
                            </time>
                          </div>
                          <p className="mb-3 text-xs text-muted-foreground">
                            {copy(version.summary)}
                          </p>
                          <Markdown
                            locale={controller.locale}
                            content={copy(version.response)}
                          />
                          {version.emphasis && (
                            <div className={styles.emphasis}>
                              <Markdown
                                locale={controller.locale}
                                content={copy(version.emphasis)}
                              />
                            </div>
                          )}
                        </section>
                      ))}
                    </div>
                  </ThreadPanel>
                ) : (
                  controller.currentVersion && (
                    <ThreadPanel
                      title={copy(controller.currentVersion.name)}
                      actions={
                        <time className="text-xs text-muted-foreground">
                          {controller.currentVersion.time}
                        </time>
                      }
                    >
                      <Markdown
                        locale={controller.locale}
                        content={copy(controller.currentVersion.response)}
                      />
                      {controller.currentVersion.emphasis && (
                        <div className={styles.emphasis}>
                          <Markdown
                            locale={controller.locale}
                            content={copy(controller.currentVersion.emphasis)}
                          />
                        </div>
                      )}
                    </ThreadPanel>
                  )
                )}
                <div className="my-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label(
                      "上一响应版本",
                      "Previous response version",
                    )}
                    disabled={controller.versionIndex === 0}
                    onClick={() =>
                      controller.chooseVersion(controller.versionIndex - 1)
                    }
                  >
                    <ChevronLeft />
                  </Button>
                  <span className="text-xs">
                    {controller.versionIndex + 1} / {controller.versions.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label("下一响应版本", "Next response version")}
                    disabled={
                      controller.versionIndex >= controller.versions.length - 1
                    }
                    onClick={() =>
                      controller.chooseVersion(controller.versionIndex + 1)
                    }
                  >
                    <ChevronRight />
                  </Button>
                  <div className="ml-auto flex gap-2">
                    <Button
                      variant="ghost"
                      disabled={controller.versions.length < 2}
                      onClick={
                        controller.compareOpen
                          ? controller.closeCompare
                          : controller.openCompare
                      }
                    >
                      {controller.compareOpen ? (
                        <X size={16} />
                      ) : (
                        <GitBranch size={16} />
                      )}
                      {controller.compareOpen
                        ? label("关闭比较", "Close compare")
                        : label("比较版本", "Compare versions")}
                    </Button>
                    <Button variant="ghost" onClick={controller.regenerate}>
                      <RotateCcw size={16} />
                      {label("重新生成 · 本地", "Regenerate · Local")}
                    </Button>
                  </div>
                </div>
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <GitBranch size={14} />
                  {controller.versions.length}{" "}
                  {label(
                    "个响应版本保留在此会话",
                    "response versions preserved in this thread",
                  )}{" "}
                  ·{" "}
                  {controller.currentVersion &&
                    copy(controller.currentVersion.name)}
                </p>
              </>
            )}
          </ThreadMessage>
        )}
      />
      <Dialog
        open={controller.editOpen && controller.active}
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
          <DialogTitle>
            {label("编辑消息并建立分支", "Edit message and branch")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "保留原始对话和旧版本，仅生成新的本地响应。",
              "Preserve the original thread and earlier versions; only create a new local response.",
            )}
          </DialogDescription>
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
          <form
            noValidate
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              controller.saveEdit()
            }}
          >
            <Field data-invalid={!!controller.editError}>
              <FieldLabel htmlFor={editId}>
                {label("消息内容", "Message content")}
              </FieldLabel>
              <Textarea
                id={editId}
                required
                aria-invalid={!!controller.editError}
                aria-describedby={
                  controller.editError ? `${editId}-error` : undefined
                }
                value={controller.editText}
                onChange={(event) => controller.setEditText(event.target.value)}
              />
              {controller.editError && (
                <FieldError id={`${editId}-error`} role="alert">
                  {copy(controller.editError)}
                </FieldError>
              )}
            </Field>
            <Button type="submit">
              {label("保存为新分支", "Save as new branch")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

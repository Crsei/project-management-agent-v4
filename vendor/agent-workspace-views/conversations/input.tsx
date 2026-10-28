"use client"
import { useId, type ComponentProps, type ReactNode } from "react"
import {
  ArrowUp,
  Blocks,
  Check,
  ChevronDown,
  Plus,
  Sparkles,
  Square,
  X,
} from "lucide-react"
import type { ComposerController } from "../controller"
import type { Copy } from "../model"
import {
  Button,
  Textarea,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui"
import styles from "./frame.module.css"

export interface ConversationInputOptions {
  trailingTools?: ReactNode
  showModelControl?: boolean
  readOnly?: boolean
  textareaProps?: Omit<ComponentProps<"textarea">, "value" | "onChange" | "ref">
  leadingAction?: ReactNode
  tools?: ReactNode
  showBlocksControl?: boolean
  placeholder?: Copy
  formLabel?: Copy
  hideSuggestion?: boolean
  showContextReferences?: boolean
  attachments?: ReactNode
  appearance?: "default" | "attachments" | "compact"
  sendLabel?: Copy
  helpText?: Copy
  inputLabel?: Copy
  stopAction?: { label: Copy; onStop: () => void }
  hasContent?: boolean
}

export function ConversationInput({
  controller,
  helpId: suppliedHelpId,
  options = {},
}: {
  controller: ComposerController
  helpId?: string
  options?: ConversationInputOptions
}) {
  const ownId = useId()
  const helpId = suppliedHelpId ?? `${ownId}-input-help`
  const { label, copy, draft, updateDraft, textarea: textareaRef } = controller
  const readOnly = Boolean(options.readOnly || options.textareaProps?.readOnly)
  const disabled = Boolean(options.textareaProps?.disabled)
  const canSubmit =
    controller.canSend &&
    !readOnly &&
    !disabled &&
    (options.hasContent ?? Boolean(draft.text.trim()))
  return (
    <div className={styles.inputShell} data-composer-region="input-shell">
      {options.attachments && (
        <div
          className={styles.attachments}
          data-composer-region="attachments"
          role="group"
          aria-label={label("附件引用", "Attachment references")}
        >
          {options.attachments}
        </div>
      )}
      <form
        className={styles.input}
        data-composer-region="input"
        data-appearance={options.appearance}
        aria-label={copy(
          options.formLabel ?? {
            "zh-CN": "消息编辑器",
            en: "Message composer",
          },
        )}
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit && !options.stopAction) controller.sendMessage()
        }}
      >
        {((options.showContextReferences !== false &&
          controller.activeContexts.length > 0) ||
          draft.blocks) && (
          <div className={styles.references}>
            {draft.blocks && (
              <span className={styles.reference}>
                <Blocks size={12} aria-hidden="true" />
                {label("组件样例", "Component examples")}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={label(
                    "移除组件引用",
                    "Remove component reference",
                  )}
                  onClick={() => {
                    updateDraft({ blocks: false })
                    controller.focusComposer()
                  }}
                >
                  <X />
                </Button>
              </span>
            )}
            {options.showContextReferences !== false &&
              controller.activeContexts.map((item) => (
                <span className={styles.reference} key={item.id}>
                  {item.name}
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`${label("移除引用", "Remove reference")}: ${item.name}`}
                    onClick={() => {
                      controller.removeContext(item.id)
                      controller.focusComposer()
                    }}
                  >
                    <X />
                  </Button>
                </span>
              ))}
          </div>
        )}
        <Textarea
          {...options.textareaProps}
          ref={textareaRef}
          className={`${styles.textarea} ${options.textareaProps?.className ?? ""}`}
          rows={options.textareaProps?.rows ?? 3}
          value={draft.text}
          readOnly={readOnly}
          aria-label={copy(
            options.inputLabel ?? { "zh-CN": "消息输入", en: "Message input" },
          )}
          aria-describedby={helpId}
          placeholder={copy(
            options.placeholder ?? {
              "zh-CN": "继续这段对话…",
              en: "Continue this conversation…",
            },
          )}
          onChange={(event) => updateDraft({ text: event.target.value })}
          onSelect={(event) => {
            controller.rememberPosition()
            options.textareaProps?.onSelect?.(event)
          }}
          onKeyDown={(event) => {
            options.textareaProps?.onKeyDown?.(event)
            if (
              event.defaultPrevented ||
              readOnly ||
              disabled ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              if (canSubmit && !options.stopAction) controller.sendMessage()
            }
          }}
        />
        {!options.hideSuggestion &&
          !controller.hasMessages &&
          !draft.text &&
          controller.suggestionsVisible && (
            <div className={styles.suggestions}>
              {controller.suggestions.map((suggestion, index) => (
                <Button
                  key={index}
                  type="button"
                  variant="outline"
                  onClick={() => {
                    updateDraft({ text: copy(suggestion) })
                    requestAnimationFrame(controller.focusComposer)
                  }}
                >
                  {copy(suggestion)}
                </Button>
              ))}
            </div>
          )}
        <div className={styles.inputTools}>
          {options.leadingAction ?? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={label("添加上下文", "Add context")}
                >
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {label(
                      "添加上下文 · 本地引用",
                      "Add context · Local references",
                    )}
                  </DropdownMenuLabel>
                  {controller.contextItems.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() => controller.toggleContext(item.id)}
                    >
                      <div>
                        <span className="flex items-center gap-2">
                          {item.name}
                          {draft.contextIds.includes(item.id) && (
                            <Check size={14} aria-hidden="true" />
                          )}
                        </span>
                        <small className="block text-muted-foreground">
                          {copy(item.description)}
                        </small>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {options.tools}
          <div className={styles.inputToolsRight}>
            {options.showBlocksControl && (
              <Button
                type="button"
                variant="ghost"
                aria-pressed={draft.blocks}
                onClick={() => updateDraft({ blocks: !draft.blocks })}
              >
                <Blocks />
                {label("组件", "Blocks")}
              </Button>
            )}
            {options.showModelControl !== false && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`${label("模型", "Model")}: ${draft.model}`}
                  >
                    <Sparkles />
                    <span>{draft.model}</span>
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>
                    {label("模型 · 本地选择", "Model · Local selection")}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={draft.model}
                    onValueChange={(model) => updateDraft({ model })}
                  >
                    {controller.models.map((model) => (
                      <DropdownMenuRadioItem key={model} value={model}>
                        {model}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {options.trailingTools}
            <Button
              size="icon"
              type={options.stopAction ? "button" : "submit"}
              disabled={!options.stopAction && !canSubmit}
              aria-label={copy(
                options.stopAction?.label ??
                  options.sendLabel ?? {
                    "zh-CN": "发送消息",
                    en: "Send message",
                  },
              )}
              onClick={
                options.stopAction
                  ? (event) => {
                      event.preventDefault()
                      options.stopAction?.onStop()
                    }
                  : undefined
              }
            >
              {options.stopAction ? <Square /> : <ArrowUp />}
            </Button>
          </div>
        </div>
        <span className="sr-only" id={helpId}>
          {copy(
            options.helpText ?? {
              "zh-CN":
                "Enter 发送，Shift+Enter 换行。回复为本地示例，不执行 Agent。",
              en: "Enter to send, Shift+Enter for a new line. Responses are local examples; no Agent execution.",
            },
          )}
        </span>
      </form>
    </div>
  )
}

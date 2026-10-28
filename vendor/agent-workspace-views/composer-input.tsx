"use client"
import type { ComponentProps, ReactNode } from "react"
import {
  ArrowUp,
  Square,
  Blocks,
  Check,
  ChevronDown,
  FileText,
  Plus,
  Sparkles,
  X,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Suggestions } from "@easyuse-ui/ui/components/blocks/suggestions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import type { Copy } from "./model"
import type { ComposerController } from "./controller"
import styles from "./composer-workspace.module.css"

export type ComposerInputOptions = {
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
  appearance?: "default" | "attachments"
  sendLabel?: Copy
  helpText?: Copy
  inputLabel?: Copy
  stopAction?: { label: Copy; onStop: () => void }
  hasContent?: boolean
}

/** Shared input semantics; the caller supplies additional context actions and tools. */
export function ComposerInput({
  controller,
  helpId,
  options = {},
}: {
  controller: ComposerController
  helpId: string
  options?: ComposerInputOptions
}) {
  const {
    label,
    copy,
    sendMessage,
    activeContexts,
    draft,
    updateDraft,
    focusComposer,
    removeContext,
    textarea,
    rememberPosition,
    hasMessages,
    suggestionsVisible,
    suggestions,
    contextItems,
    toggleContext,
    models,
    canSend,
  } = controller
  const form = (
    <form
      data-composer-region="input"
      className={styles.composer}
      aria-label={
        options.formLabel
          ? copy(options.formLabel)
          : label("消息编辑器", "Message composer")
      }
      onSubmit={(event) => {
        event.preventDefault()
        if (!options.readOnly && !options.textareaProps?.readOnly && !options.textareaProps?.disabled) sendMessage()
      }}
    >
      {((options.showContextReferences !== false && !!activeContexts.length) ||
        draft.blocks) && (
        <div className={styles.references}>
          {draft.blocks && (
            <span className={styles.reference}>
              <Blocks size={12} aria-hidden="true" />
              <span>EasyuseUI Blocks</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label("移除组件引用", "Remove blocks reference")}
                onClick={() => {
                  updateDraft({ blocks: false })
                  focusComposer()
                }}
              >
                <X />
              </Button>
            </span>
          )}
          {options.showContextReferences !== false &&
            activeContexts.map((item) => (
              <span className={styles.reference} key={item.id}>
                <FileText size={12} aria-hidden="true" />
                <span>{item.name}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${label("移除引用", "Remove reference")}: ${item.name}`}
                  onClick={() => removeContext(item.id)}
                >
                  <X />
                </Button>
              </span>
            ))}
        </div>
      )}
      <div className={styles.inputArea}>
        <Textarea
          {...options.textareaProps}
          ref={textarea}
          readOnly={options.readOnly || options.textareaProps?.readOnly}
          onSelect={(event) => { rememberPosition(); options.textareaProps?.onSelect?.(event) }}
          className={styles.textarea}
          rows={3}
          value={draft.text}
          aria-label={
            options.inputLabel
              ? copy(options.inputLabel)
              : label("消息输入", "Message input")
          }
          aria-describedby={helpId}
          placeholder={
            options.placeholder
              ? copy(options.placeholder)
              : hasMessages
                ? label("继续这段对话…", "Continue this conversation…")
                : ""
          }
          onChange={(event) => updateDraft({ text: event.target.value })}
          onKeyDown={(event) => {
            options.textareaProps?.onKeyDown?.(event)
            if (event.defaultPrevented || options.readOnly || options.textareaProps?.readOnly || options.textareaProps?.disabled) return
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault()
              sendMessage()
            }
          }}
        />
        {!options.hideSuggestion && !hasMessages && !draft.text && suggestionsVisible && (
          <Suggestions className={styles.suggestion}
            items={suggestions.map((suggestion, index) => ({
              id: "composer-suggestion-" + index, label: copy(suggestion), prompt: copy(suggestion),
            }))}
            onSelect={(item) => {
              updateDraft({ text: item.prompt })
              requestAnimationFrame(() => {
                const field = textarea.current
                field?.focus()
                field?.setSelectionRange(field.value.length, field.value.length)
              })
            }}/>
        )}
      </div>
      <div className={styles.toolbar}>
        {options.leadingAction ?? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className={styles.iconButton}
                  aria-label={label("添加上下文", "Add context")}
                />
              }
            >
              <Plus />
            </DropdownMenuTrigger>
            <DropdownMenuContent className={styles.contextMenu}>
              <DropdownMenuGroup>
                <DropdownMenuLabel className={styles.menuHeading}>
                  {controller.messageMode === "demo"
                    ? label("添加上下文 · 示例引用", "Add context · Example references")
                    : label("添加上下文", "Add context")}
                </DropdownMenuLabel>
                {contextItems.map((item) => (
                  <DropdownMenuItem
                    className={styles.contextOption}
                    key={item.id}
                    onClick={() => toggleContext(item.id)}
                  >
                    <span className={styles.contextName}>
                      {item.name}
                      {draft.contextIds.includes(item.id) && (
                        <Check size={14} />
                      )}
                    </span>
                    <small>{copy(item.description)}</small>
                    <small>{copy(item.kind)}</small>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className={styles.toolbarRight}>
          {options.tools}
          {options.showBlocksControl !== false && (
            <Button
              variant="ghost"
              className={styles.toolbarButton}
              aria-pressed={draft.blocks}
              onClick={() => updateDraft({ blocks: !draft.blocks })}
            >
              <Blocks />
              {label("组件", "Blocks")}
            </Button>
          )}
          <>{options.showModelControl !== false && (<DropdownMenu><DropdownMenuTrigger render={
            <Button
              variant="ghost"
              className={styles.toolbarButton}
              aria-label={`${label("模型", "Model")}: ${draft.model}`}
            />
          }><Sparkles /><span>{draft.model}</span>
          <ChevronDown /></DropdownMenuTrigger><DropdownMenuContent className={styles.menu}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className={styles.menuHeading}>
                {controller.messageMode === "demo"
                  ? label("模型 · 本地选择", "Model · Local selection")
                  : label("模型", "Model")}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={draft.model}
                onValueChange={(value) => updateDraft({ model: value })}
              >
                {models.map((model) => (
                  <DropdownMenuRadioItem
                    key={model}
                    value={model}
                    closeOnClick
                  >
                    GPT-{model}
                    <span className={styles.modelLabel}>Codex</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent></DropdownMenu>)}{options.trailingTools}</>
          <Button
            variant="ghost"
            size="icon"
            type={options.stopAction ? "button" : "submit"}
            className={styles.sendButton}
            disabled={!options.stopAction && (!(options.hasContent ?? Boolean(draft.text.trim())) || !canSend || options.readOnly || options.textareaProps?.readOnly || options.textareaProps?.disabled)}
            onClick={
              options.stopAction
                ? (event) => {
                    event.preventDefault()
                    options.stopAction?.onStop()
                  }
                : undefined
            }
            aria-label={
              options.stopAction
                ? copy(options.stopAction.label)
                : options.sendLabel
                  ? copy(options.sendLabel)
                  : label("发送消息", "Send message")
            }
          >
            {options.stopAction ? <Square /> : <ArrowUp />}
          </Button>
        </div>
      </div>
      <span className="sr-only" id={helpId}>
        {options.helpText
          ? copy(options.helpText)
          : controller.messageMode === "demo"
            ? label(
                "Enter 发送，Shift+Enter 换行。回复为本地示例。",
                "Enter to send, Shift+Enter for a new line. Responses are local examples.",
              )
            : label("Enter 发送，Shift+Enter 换行。", "Enter to send, Shift+Enter for a new line.")}
      </span>
    </form>
  )
  if (options.appearance !== "attachments") return form
  return (
    <div
      data-composer-region="input-shell"
      className={styles.attachmentComposer}
    >
      {options.attachments && (
        <div
          data-composer-region="attachments"
          className={styles.attachmentTray}
          role="group"
          aria-label={label("附件引用", "Attachment references")}
          tabIndex={0}
          onFocusCapture={(event) => {
            const tray = event.currentTarget
            const target = event.target
            if (!(target instanceof HTMLElement) || !tray.contains(target))
              return
            const bounds = tray.getBoundingClientRect()
            const focused = target.getBoundingClientRect()
            if (focused.left < bounds.left)
              tray.scrollLeft += focused.left - bounds.left
            else if (focused.right > bounds.right)
              tray.scrollLeft += focused.right - bounds.right
          }}
        >
          {options.attachments}
        </div>
      )}
      {form}
    </div>
  )
}

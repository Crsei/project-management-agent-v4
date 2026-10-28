"use client"
import { Paperclip, X } from "lucide-react"
import { type ReactNode } from "react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { Item } from "./item"
import { Button } from "./button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"
export type AttachmentStatus =
  "idle" | "uploading" | "processing" | "done" | "error" | "unknown"
export type AttachmentProps = {
  name: string
  description?: string
  status?: AttachmentStatus
  error?: string
  disabled?: boolean
  onOpen?: () => void
  onRemove?: () => void
  className?: string
  variant?: "item" | "chip"
  leading?: ReactNode
}
/** A caller-owned attachment descriptor. It never reads files or starts uploads. */
export function Attachment({
  name,
  description,
  status = "done",
  error,
  disabled,
  onOpen,
  onRemove,
  className,
  variant = "item",
  leading,
}: AttachmentProps) {
  const { t } = useI18n()
  const state = t(`attachment.${status}`)
  const busy = status === "uploading" || status === "processing"
  const removal = onRemove ? (
    <Button
      size="icon"
      variant="ghost"
      disabled={disabled || busy || status === "unknown"}
      aria-label={t("attachment.remove", { name })}
      onClick={onRemove}
    >
      <X aria-hidden="true" size={16} />
    </Button>
  ) : undefined
  if (variant === "chip") {
    const content = (
      <>
        <span className="shrink-0" aria-hidden="true">
          {leading ?? <Paperclip size={16} />}
        </span>
        <span className="truncate">{name}</span>
      </>
    )
    const details = [name, description, state, error]
      .filter(Boolean)
      .join(" · ")
    return (
      <div
        className={cn(
          "inline-flex h-control max-w-56 items-center rounded-control bg-surface shadow-[inset_0_0_0_1px_var(--border)]",
          error && "shadow-[inset_0_0_0_1px_var(--destructive)]",
          className,
        )}
        data-attachment-variant="chip"
        data-attachment-status={status}
        aria-busy={busy || undefined}
      >
        <Tooltip
          onOpenChange={(_open, details) => {
            if (details.reason === "escape-key") details.allowPropagation()
          }}
        >
          <TooltipTrigger
            delay={300}
            render={
              status === "done" && onOpen ? (
                <Button
                  variant="ghost"
                  className="min-w-0 shrink justify-start px-2 text-xs"
                  aria-label={details}
                  disabled={disabled}
                  onClick={onOpen}
                />
              ) : (
                <span
                  tabIndex={0}
                  aria-label={details}
                  className="inline-flex h-control min-w-0 items-center gap-2 px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              )
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipContent>{details}</TooltipContent>
        </Tooltip>
        {removal}
      </div>
    )
  }
  return (
    <Item
      density="compact"
      className={className}
      title={name}
      description={[description, state].filter(Boolean).join(" · ")}
      leading={leading ?? <Paperclip size={16} aria-hidden="true" />}
      error={error}
      disabled={disabled}
      onSelect={status === "done" ? onOpen : undefined}
      trailing={removal}
    />
  )
}

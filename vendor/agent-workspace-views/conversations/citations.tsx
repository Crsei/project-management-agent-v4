"use client"
import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react"
import { ExternalLink } from "lucide-react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogTitle,
} from "./ui"
import type { ThreadController } from "./shared"
import type { CitationSource } from "./citation-model"

export interface CitationPreviewState {
  sources: readonly CitationSource[]
  source: CitationSource | undefined
  setSourceId: Dispatch<SetStateAction<string | null>>
  citationFocus: RefObject<HTMLElement | null>
  openSource: (id: string) => void
}
export interface CitationController
  extends ThreadController, CitationPreviewState {}
export function useCitationPreview(
  sources: readonly CitationSource[],
): CitationPreviewState {
  const [sourceId, setSourceId] = useState<string | null>(null)
  const citationFocus = useRef<HTMLElement | null>(null)
  return {
    sources,
    source: sources.find((item) => item.id === sourceId),
    setSourceId,
    citationFocus,
    openSource: (id) => {
      citationFocus.current = document.activeElement as HTMLElement
      setSourceId(id)
    },
  }
}
export function InlineCitation({
  controller,
  sourceId,
}: {
  controller: CitationController
  sourceId: string
}) {
  const index = controller.sources.findIndex((source) => source.id === sourceId)
  if (index < 0) return null
  const source = controller.sources[index]
  return (
    <Button
      variant="ghost"
      size="sm"
      className="mx-1 inline-flex h-5 px-1 align-baseline text-xs font-normal"
      disabled={!source.available}
      aria-label={`${controller.label("查看来源", "View source")} ${index + 1}: ${controller.copy(source.title)}`}
      title={
        source.available
          ? controller.copy(source.title)
          : controller.label("引用已失效", "Reference unavailable")
      }
      onClick={() => controller.openSource(source.id)}
    >
      [{index + 1}]
    </Button>
  )
}
export function CitationList({
  controller,
  variant = "list",
  limit,
}: {
  controller: CitationController
  variant?: "list" | "cards"
  limit?: number
}) {
  const sources =
    limit === undefined
      ? controller.sources
      : controller.sources.slice(0, limit)
  return (
    <section
      aria-label={controller.label("研究来源", "Research sources")}
      className={variant === "cards" ? "grid grid-cols-3 gap-2" : "grid gap-1"}
    >
      {sources.map((source, index) => (
        <Button
          key={source.id}
          variant={variant === "cards" ? "outline" : "ghost"}
          className={`h-auto min-w-0 items-start whitespace-normal p-3 text-left ${variant === "cards" ? "min-h-16 flex-col gap-1" : "justify-start gap-3"}`}
          disabled={!source.available}
          onClick={() => controller.openSource(source.id)}
        >
          <span className="text-xs font-medium">
            {variant === "list" && `[${index + 1}] `}
            {controller.copy(source.title)}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {source.available
              ? `${new URL(source.url).hostname}${variant === "cards" ? ` · ${index + 1}` : ""}`
              : controller.label(
                  "引用已失效；正文和草稿保留。",
                  "Reference unavailable; answer and draft are preserved.",
                )}
          </span>
        </Button>
      ))}
    </section>
  )
}
export function CitationPreview({
  controller,
}: {
  controller: CitationController
}) {
  const { source, copy, label } = controller
  return (
    <Dialog
      open={Boolean(source) && controller.active}
      onOpenChange={(open) => {
        if (!open) controller.setSourceId(null)
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (
            controller.active &&
            controller.citationFocus.current?.isConnected
          ) {
            event.preventDefault()
            controller.citationFocus.current.focus({ preventScroll: true })
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {source ? copy(source.title) : label("来源详情", "Source details")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "固定资料摘记，可打开原始文档；这里不执行实时搜索。",
              "Fixed research note; open the original document. No live search is performed here.",
            )}
          </DialogDescription>
        </DialogHeader>
        {source && (
          <div className="space-y-4">
            {source.available ? (
              <p className="text-sm">{copy(source.excerpt)}</p>
            ) : (
              <p role="alert">
                {label(
                  "摘记不可用，已有答复和草稿保留。",
                  "The note is unavailable; the existing answer and draft are preserved.",
                )}
              </p>
            )}
            <a
              className="inline-flex items-center gap-2 text-sm underline"
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink size={14} aria-hidden="true" />
              {label("打开原始文档", "Open original document")}
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

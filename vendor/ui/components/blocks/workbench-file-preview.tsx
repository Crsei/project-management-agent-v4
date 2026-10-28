"use client"
/* Portable raster preview; Next image optimization belongs to the consuming host. */
/* eslint-disable @next/next/no-img-element */
import { useState, useRef, useEffect, type ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogBody,
  DialogFooter,
} from "../ui/dialog"
import { Button } from "../ui/button"
import { DataRegion } from "../ui/data-region"
import { Tabs, TabsList, TabsTab, TabsPanel } from "../ui/tabs"
import { DataTable } from "./data-table"
import {
  FileViewer,
  DiffViewer,
} from "./agent-workbench/review"
import { MessageContent } from "./message-content"
import { useI18n } from "../../lib/i18n-provider"
import {
  resourceKey,
  resourceText,
  resourceCopyText,
  parseResourceCsv,
  safeResourceImage,
  type ResourceSnapshot,
  type WorkbenchDocuments,
  type OpenResourceRequest,
} from "../../lib/workbench-resource-model"
import styles from "./workbench-file-preview.module.css"

export type WorkbenchFilePreviewProps = {
  resource?: ResourceSnapshot
  range?: OpenResourceRequest["range"]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPin?: (resource: ResourceSnapshot) => void
  onExpand?: (resource: ResourceSnapshot) => void
  onAddContext?: (resource: ResourceSnapshot) => void
  onSource?: (resource: ResourceSnapshot) => void
  onReview?: (resource: ResourceSnapshot) => void
  latestRevision?: string
  onRetry?: () => void
  allowedImageOrigins?: readonly string[]
  finalFocus?: React.RefObject<HTMLElement | null>
}
export function WorkbenchResourceContent({
  resource,
  range,
  allowedImageOrigins = [],
}: {
  resource: ResourceSnapshot
  range?: OpenResourceRequest["range"]
  allowedImageOrigins?: readonly string[]
}) {
  const { t } = useI18n()
  const [view, setView] = useState<"read" | "source">("read")
  const [imageError, setImageError] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [split, setSplit] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const key = resourceKey(resource)
  const [lastKey, setLastKey] = useState(key)
  if (lastKey !== key) {
    setLastKey(key)
    setImageError(false)
    setZoom(false)
    setView("read")
  }
  useEffect(() => {
    root.current
      ?.querySelector(`[data-file-line="${range?.start ?? 0}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [key, range?.start])
  const bounded = resourceText(resource)
  let content: ReactNode
  if (resource.availability !== "available")
    content = (
      <p role="status">
        {t(`resource.${resource.availability}`)} ·{" "}
        {resource.reason ?? t("resource.noContent")}
      </p>
    )
  else if (resource.renderer === "image") {
    const src =
      resource.image &&
      safeResourceImage(resource.image.src, allowedImageOrigins)
    content =
      src && !imageError ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={zoom}
            onClick={() => setZoom(!zoom)}
          >
            {t(zoom ? "resource.fit" : "resource.actualSize")}
          </Button>
          <p className={styles.meta}>
            {resource.image?.width ?? "—"} × {resource.image?.height ?? "—"} ·{" "}
            {resource.size ?? "—"} B
          </p>
          {resource.image?.animated ||
          resource.mediaType === "image/gif" ||
          resource.image?.src.startsWith("data:image/gif;") ? (
            <p>{t("resource.animationUnavailable")}</p>
          ) : (
            <div className={styles.imageArea}>
              <img
                className={styles.image}
                style={zoom ? { maxWidth: "none" } : undefined}
                src={src}
                alt={resource.image!.alt}
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => setImageError(true)}
              />
            </div>
          )}
        </>
      ) : (
        <p role="status">{t("resource.imageUnavailable")}</p>
      )
  } else if (resource.renderer === "diff" && resource.diff) {
    content = (
      <>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={split}
          onClick={() => setSplit(!split)}
        >
          {t(split ? "workbench.unified" : "workbench.split")}
        </Button>
        <DiffViewer file={resource.diff} mode={split ? "split" : "unified"} />
      </>
    )
  } else if (resource.text === undefined || resource.renderer === "unsupported")
    content = <p>{resource.reason ?? t("resource.unsupported")}</p>
  else if (resource.renderer === "markdown")
    content = (
      <>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setView(view === "read" ? "source" : "read")}
        >
          {t(view === "read" ? "resource.sourceView" : "resource.readView")}
        </Button>
        <p className={styles.meta}>{t("resource.markdownSubset")}</p>
        {view === "read" ? (
          <MessageContent content={bounded.text} />
        ) : (
          <FileViewer
            resource={{ ...resource, text: bounded.text }}
            revision={resource.revision}
            range={range}
          />
        )}
      </>
    )
  else if (resource.renderer === "json") {
    let text = bounded.text,
      error = ""
    try {
      text = JSON.stringify(JSON.parse(bounded.text), null, 2)
    } catch {
      error = t("resource.jsonError")
    }
    content = (
      <>
        {error && <p role="alert">{error}</p>}
        <FileViewer
          resource={{ ...resource, text }}
          revision={resource.revision}
          range={range}
        />
      </>
    )
  } else if (resource.renderer === "csv") {
    const parsed = parseResourceCsv(bounded.text)
    const [header = [], ...rows] = parsed.rows
    content = parsed.error ? (
      <>
        <p role="alert">
          {t("resource.csvError")} · {parsed.error}
        </p>
        <FileViewer
          resource={{ ...resource, text: bounded.text }}
          revision={resource.revision}
        />
      </>
    ) : (
      <>
        <DataTable
          rows={rows.map((cells, index) => ({ cells, id: String(index) }))}
          columns={header.map((label, index) => ({
            id: String(index),
            header: label,
            cell: (row: { cells: string[] }) => row.cells[index],
          }))}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.cells.join(", ")}
          caption={resource.name}
          maxHeight={400}
        />
        <p className={styles.meta}>
          {rows.length} {t("resource.rowsShown")}
        </p>
        {parsed.truncated && <p>{t("workbench.truncated")}</p>}
      </>
    )
  } else
    content = (
      <>
        {["html", "svg"].includes(resource.renderer) && (
          <p className={styles.meta}>{t("resource.activeContentBlocked")}</p>
        )}
        <FileViewer
          resource={{ ...resource, text: bounded.text }}
          revision={resource.revision}
          range={range}
        />
      </>
    )
  return (
    <div ref={root} className={styles.content} data-resource-key={key}>
      <DataRegion
        state={resource.dataState}
        hasContent={
          resource.availability === "available" &&
          (resource.text !== undefined ||
            Boolean(resource.image || resource.diff))
        }
        error={
          resource.dataState === "error"
            ? {
                category: "request",
                message: resource.reason ?? t("resource.readFailed"),
                reason: resource.reason ?? t("resource.readFailed"),
              }
            : undefined
        }
      >
        {content}
      </DataRegion>
      {resource.text !== undefined && bounded.truncated && (
        <p role="status">{t("workbench.truncated")}</p>
      )}
    </div>
  )
}
export function WorkbenchFilePreview({
  resource,
  range,
  open,
  onOpenChange,
  onPin,
  onExpand,
  onAddContext,
  onSource,
  onReview,
  latestRevision,
  onRetry,
  allowedImageOrigins,
  finalFocus,
}: WorkbenchFilePreviewProps) {
  const { t } = useI18n()
  const [feedback, setFeedback] = useState("")
  const activeKey = useRef(resource ? resourceKey(resource) : "")
  useEffect(() => {
    activeKey.current = resource ? resourceKey(resource) : ""
  }, [resource])
  const perform = async (action: () => Promise<void>) => {
    const key = activeKey.current
    try {
      await action()
      if (key === activeKey.current) setFeedback(t("resource.actionComplete"))
    } catch {
      if (key === activeKey.current) setFeedback(t("resource.actionFailed"))
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog} finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{resource?.name ?? t("workbench.preview")}</DialogTitle>
          <DialogDescription className={styles.meta}>
            {resource?.path} · {resource?.revision} · {resource?.source?.label}{" "}
            · {t("workbench.readOnly")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {resource &&
            latestRevision &&
            resource.revision !== latestRevision && (
              <p role="status">
                {t("workbench.stale")} · {resource.revision} → {latestRevision}
              </p>
            )}
          {resource && (
            <WorkbenchResourceContent
              resource={resource}
              range={range}
              allowedImageOrigins={allowedImageOrigins}
            />
          )}
          {onRetry && (
            <Button variant="secondary" onClick={onRetry}>
              {t("workbench.retry")}
            </Button>
          )}
        </DialogBody>
        <DialogFooter>
          {resource && (
            <>
              {onPin && (
                <Button variant="secondary" onClick={() => onPin(resource)}>
                  {t("resource.pin")}
                </Button>
              )}
              {onExpand && (
                <Button variant="secondary" onClick={() => onExpand(resource)}>
                  {t("resource.expand")}
                </Button>
              )}
              {onSource &&
                (resource.source?.messageId || resource.source?.toolCallId) && (
                  <Button variant="ghost" onClick={() => onSource(resource)}>
                    {t("resource.locateSource")}
                  </Button>
                )}
              {onReview && (
                <Button variant="secondary" onClick={() => onReview(resource)}>
                  {t("workbench.review")}
                </Button>
              )}
              {onAddContext && (
                <Button
                  variant="secondary"
                  disabled={
                    resource.availability !== "available" || !resource.context
                  }
                  onClick={() => onAddContext(resource)}
                >
                  {t("workbench.addContext")}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={
                  resource.availability !== "available" ||
                  (resource.text === undefined && !resource.diff)
                }
                onClick={() =>
                  perform(async () => {
                    await navigator.clipboard.writeText(
                      resourceCopyText(resource),
                    )
                  })
                }
              >
                {t("resource.copyShown")}
              </Button>
              <Button
                variant="ghost"
                disabled={
                  resource.availability !== "available" || !resource.download
                }
                onClick={() =>
                  perform(async () => {
                    const bytes = await resource.download!()
                    if (activeKey.current !== resourceKey(resource)) return
                    const url = URL.createObjectURL(bytes)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = resource.name
                    a.click()
                    setTimeout(() => URL.revokeObjectURL(url), 1000)
                  })
                }
              >
                {t("resource.downloadSource")}
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("resource.close")}
          </Button>
        </DialogFooter>
        <span role="status" className={styles.meta}>
          {feedback}
        </span>
      </DialogContent>
    </Dialog>
  )
}
export function WorkbenchDocumentTabs({
  state,
  onSelect,
  onClose,
  onPin,
  render,
}: {
  state: WorkbenchDocuments
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onPin: (resource: ResourceSnapshot) => void
  render?: (resource: ResourceSnapshot) => ReactNode
}) {
  const { t } = useI18n()
  const active = state.documents.find(
    (d) => resourceKey(d.resource) === state.activeKey,
  )
  if (!active) return <p className={styles.content}>{t("workbench.noFile")}</p>
  return (
    <section aria-label={t("resource.documents")}>
      <Tabs
        value={state.activeKey}
        onValueChange={(value) => {
          if (typeof value === "string") onSelect(value)
        }}
      >
        <TabsList className={styles.tabs}>
          {state.documents.map((d) => (
            <TabsTab
              value={resourceKey(d.resource)}
              key={resourceKey(d.resource)}
            >
              {d.pinned ? "◆ " : ""}
              {d.resource.name} @{d.resource.revision}
            </TabsTab>
          ))}
        </TabsList>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onPin(active.resource)}
            disabled={active.pinned}
          >
            {t("resource.pin")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onClose(resourceKey(active.resource))}
          >
            {t("resource.closeTab")}
          </Button>
        </div>
        {state.documents.map((document) => (
          <TabsPanel
            key={resourceKey(document.resource)}
            value={resourceKey(document.resource)}
            keepMounted
          >
            {render ? (
              render(document.resource)
            ) : (
              <WorkbenchResourceContent
                resource={document.resource}
                range={document.range}
              />
            )}
          </TabsPanel>
        ))}
      </Tabs>
    </section>
  )
}

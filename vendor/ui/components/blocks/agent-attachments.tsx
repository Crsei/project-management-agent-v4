"use client"

import { useState, type ReactNode } from "react"
import {
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  ImageOff,
} from "lucide-react"
import type { AgentAttachment } from "../../lib/agent-elements-model"
import { formatAttachmentSize, safeImageSrc } from "../../lib/agent-media"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { Attachment } from "../ui/attachment"
import { ImageLightbox, type LightboxImage } from "./image-lightbox"
import styles from "./agent-attachments.module.css"

const archiveExtensions: Record<string, true> = {
  zip: true, gz: true, tgz: true, tar: true, rar: true, "7z": true,
  bz2: true, xz: true, jar: true,
}
const sheetExtensions: Record<string, true> = {
  csv: true, tsv: true, xls: true, xlsx: true, ods: true,
}
const textExtensions: Record<string, true> = {
  txt: true, md: true, markdown: true, log: true, rst: true, pdf: true,
}
const imageExtensions: Record<string, true> = {
  png: true, jpg: true, jpeg: true, gif: true, webp: true, avif: true,
  bmp: true, ico: true,
}
const codeExtensions: Record<string, true> = {
  js: true, jsx: true, ts: true, tsx: true, json: true, jsonc: true,
  html: true, htm: true, css: true, scss: true, sass: true, less: true,
  py: true, rb: true, go: true, rs: true, java: true, c: true, h: true,
  cpp: true, hpp: true, cs: true, sh: true, bash: true, zsh: true,
  yml: true, yaml: true, toml: true, xml: true, sql: true, vue: true,
  svelte: true, astro: true, kt: true, swift: true,
}

export type FileAttachmentProps = {
  attachment: AgentAttachment
  onOpen?: (id: string) => void
  onRemove?: (id: string) => void
}

/** One caller-owned attachment: size and type metadata, an image thumbnail when
 * the host reports the image as ready, otherwise a type icon. Reading, upload
 * and readiness stay with the caller; the six Attachment states own removal. */
export function FileAttachment({
  attachment,
  onOpen,
  onRemove,
}: FileAttachmentProps) {
  const { t } = useI18n()
  const previewable = attachment.kind === "image" && attachment.status === "done"
  const src = previewable ? safeImageSrc(attachment.src) : undefined
  const [failed, setFailed] = useState(false)
  const [shownSource, setShownSource] = useState(src ?? "")
  if (shownSource !== (src ?? "")) {
    setShownSource(src ?? "")
    setFailed(false)
  }

  const mediaType = attachment.mediaType?.split(";")[0].trim().toLowerCase()
  const extensionMatch = /\.([A-Za-z0-9]{1,8})$/.exec(attachment.name.trim())
  const extension = extensionMatch ? extensionMatch[1].toLowerCase() : undefined
  const isImage =
    attachment.kind === "image" ||
    mediaType?.startsWith("image/") === true ||
    imageExtensions[extension ?? ""] === true
  const typeLabel =
    extension?.toUpperCase() ??
    mediaType ??
    (isImage ? t("agentElements.image") : t("agentElements.file"))
  const description = `${formatAttachmentSize(attachment.size) ?? t("agentElements.sizeUnknown")} · ${typeLabel}`

  let note: string | undefined
  if (previewable)
    note = !src
      ? t("agentElements.imageUnavailable")
      : failed
        ? t("agentElements.imageFailed")
        : undefined

  let leading: ReactNode
  if (src && !failed)
    leading = (
      // eslint-disable-next-line @next/next/no-img-element -- Portable caller-owned thumbnail.
      <img
        className={styles.thumbnail}
        src={src}
        alt=""
        aria-hidden="true"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    )
  else if (previewable) leading = <ImageOff size={16} aria-hidden="true" />
  else if (isImage) leading = <FileImage size={16} aria-hidden="true" />
  else if (archiveExtensions[extension ?? ""] === true)
    leading = <FileArchive size={16} aria-hidden="true" />
  else if (sheetExtensions[extension ?? ""] === true)
    leading = <FileSpreadsheet size={16} aria-hidden="true" />
  else if (codeExtensions[extension ?? ""] === true)
    leading = <FileCode size={16} aria-hidden="true" />
  else if (textExtensions[extension ?? ""] === true)
    leading = <FileText size={16} aria-hidden="true" />
  else leading = <FileIcon size={16} aria-hidden="true" />

  return (
    <div
      className={styles.entry}
      data-attachment-id={attachment.id}
      data-image-failure={note ? "" : undefined}
    >
      <Attachment
        name={attachment.name}
        description={description}
        status={attachment.status}
        error={attachment.error}
        disabled={attachment.disabled}
        onOpen={onOpen ? () => onOpen(attachment.id) : undefined}
        onRemove={
          onRemove && attachment.removable !== false
            ? () => onRemove(attachment.id)
            : undefined
        }
        leading={leading}
      />
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
    </div>
  )
}

export type AgentAttachmentsProps = {
  attachments: readonly AgentAttachment[]
  onRemove?: (id: string) => void
  onOpenFile?: (id: string) => void
  className?: string
}

/** Attachment row for staged or sent files. Ready images open the shared
 * gallery; every other open request is forwarded to `onOpenFile`. The selected
 * image is tracked by attachment id, so re-sorted or refreshed sources keep the
 * same image on screen. */
export function AgentAttachments({
  attachments,
  onRemove,
  onOpenFile,
  className,
}: AgentAttachmentsProps) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const gallery: LightboxImage[] = []
  for (const attachment of attachments) {
    if (attachment.kind !== "image" || attachment.status !== "done") continue
    const src = safeImageSrc(attachment.src)
    if (src)
      gallery.push({
        id: attachment.id,
        src,
        alt: attachment.alt || attachment.name || t("agentElements.image"),
        name: attachment.name,
      })
  }
  const selectedIndex =
    selectedId === null
      ? -1
      : gallery.findIndex((image) => image.id === selectedId)
  if (selectedId !== null && selectedIndex < 0) setSelectedId(null)

  if (attachments.length === 0) return null
  const open = selectedIndex >= 0
  const handleOpen = (id: string) => {
    if (gallery.some((image) => image.id === id)) setSelectedId(id)
    else onOpenFile?.(id)
  }
  return (
    <>
      <ul
        className={cn(styles.list, className)}
        aria-label={t("agentElements.attachments")}
      >
        {attachments.map((attachment) => (
          <li key={attachment.id} className={styles.item}>
            <FileAttachment
              attachment={attachment}
              onOpen={handleOpen}
              onRemove={onRemove}
            />
          </li>
        ))}
      </ul>
      {gallery.length > 0 && (
        <ImageLightbox
          images={gallery}
          open={open}
          onOpenChange={(next) => {
            if (!next) setSelectedId(null)
          }}
          index={selectedIndex}
          onIndexChange={(next) => {
            const image = gallery[(next + gallery.length) % gallery.length]
            if (image) setSelectedId(image.id)
          }}
        />
      )}
    </>
  )
}

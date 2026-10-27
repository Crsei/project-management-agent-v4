import { useState } from "react"
import type { Entity } from "@contracts"
import { Download, Link2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { usePmService } from "../pm-service"
import { downloadProjectAttachment } from "../service-project-detail-panels"
import { FileTypeIcon } from "./FileTypeIcon"
import { FileContentPreview } from "./FileContentPreview"
import { formatFileSize, formatRelativeTime, classifyFile, kindLabel, type FileEntry } from "./model"
import { useArtifactCopyOrigin } from "./hooks"
import type { FileLifecycleAction } from "./LifecycleDialog"
import styles from "./project-files.module.css"

type FilePreviewDialogProps = {
  entry: FileEntry
  initialVersionId: string | null
  locale: string
  t: (zh: string, en: string) => string
  uploaderName: (id: string) => string
  onOpenChange: (open: boolean) => void
  onCopyLink: (version: Entity) => Promise<boolean>
  canManage: boolean
  canCopy: boolean
  locked: boolean
  onAction: (mode: FileLifecycleAction["mode"], version: Entity) => void
}

export function FilePreviewDialog({ entry, initialVersionId, locale, t, uploaderName, onOpenChange, onCopyLink, canManage, canCopy, locked, onAction }: FilePreviewDialogProps) {
  const { client, workspace } = usePmService()
  const display = useDisplayDateTime()
  const [selectedId, setSelectedId] = useState(initialVersionId ?? entry.latest.id)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const selected = entry.versions.find(version => version.id === selectedId) ?? entry.latest
  const origin = useArtifactCopyOrigin(selected.id, selected.projectId)
  const en = locale === "en"
  const name = typeof selected.data.fileName === "string" && selected.data.fileName ? selected.data.fileName : entry.name
  const mediaType = typeof selected.data.mediaType === "string" ? selected.data.mediaType : ""
  const selectedKind = classifyFile(name, mediaType)
  const size = formatFileSize(selected.data.size)
  const uploader = uploaderName(typeof selected.data.producerId === "string" ? selected.data.producerId : selected.createdBy)

  async function download(version: Entity) {
    if (!client || !workspace) return
    setError(null)
    setDownloading(true)
    try { await downloadProjectAttachment(client, workspace.id, version) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setDownloading(false) }
  }

  async function copy(version: Entity) {
    const copied = await onCopyLink(version)
    setCopyNotice(copied ? t("链接已复制", "Link copied") : t("无法复制链接", "Unable to copy link"))
    window.setTimeout(() => setCopyNotice(null), 2600)
  }

  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent className={styles.previewDialog}>
      <DialogTitle className={styles.previewTitle} title={entry.name}>{entry.name}</DialogTitle>
      <DialogDescription>{kindLabel(selectedKind, en)}{size ? ` · ${size}` : ""} · {uploader} · {formatRelativeTime(selected.createdAt, locale)}</DialogDescription>
      <div className={styles.previewBody}>
        {entry.hidden && <p role="status" className={styles.warning}>{t("已从默认列表隐藏；历史读取和下载仍有效。", "Hidden from the default list; historical reading and downloads remain available.")}</p>}
        <FileContentPreview key={selected.id} version={selected} name={name} locale={locale} t={t} />
        <dl className={styles.metaGrid}>
          <div><dt>{t("原文件名", "Original filename")}</dt><dd>{name}</dd></div>
          <div><dt>SHA-256</dt><dd className={styles.digest}>{String(selected.data.sha256)}</dd></div>
          <div><dt>{t("类型", "Type")}</dt><dd>{kindLabel(selectedKind, en)}{mediaType ? ` · ${mediaType}` : ""}</dd></div>
          <div><dt>{t("大小", "Size")}</dt><dd>{size || t("大小未知", "Size unavailable")}</dd></div>
          <div><dt>{t("上传者", "Uploaded by")}</dt><dd>{uploader}</dd></div>
          <div><dt>{t("时间", "Date")}</dt><dd>{display.dateTime(selected.createdAt)}</dd></div>
          <div><dt>{t("版本", "Version")}</dt><dd>{entry.versions.length - entry.versions.findIndex(version => version.id === selected.id)} / {entry.versions.length}</dd></div>
        </dl>
        {origin.data?.origin && <a className={styles.browse} href={`/pm/${workspace!.id}/projects/${origin.data.origin.sourceProjectId}?tab=files&file=${origin.data.origin.sourceArtifactVersionId}`}>{t("查看来源", "View source")}</a>}
        {origin.error && <p role="alert" className={styles.warning}>{t("来源读取失败；不影响独立副本下载。", "Origin could not be read; the independent copy can still be downloaded.")}<Button size="sm" variant="outline" onClick={() => { void origin.refetch() }}>{t("重试读取来源", "Retry origin")}</Button></p>}
        {entry.versions.length > 1 && <div className={styles.versionList} role="list" aria-label={t("版本历史", "Version history")}>
          <p className={styles.sectionLabel}>{t("版本历史", "Version history")}</p>
          {entry.versions.map((version, index) => <div key={version.id} className={styles.versionRow} role="listitem">
            <button type="button" className={styles.versionButton} aria-pressed={version.id === selected.id} onClick={() => setSelectedId(version.id)}>
              <FileTypeIcon kind={classifyFile(typeof version.data.fileName === "string" ? version.data.fileName : entry.name, typeof version.data.mediaType === "string" ? version.data.mediaType : "")} size={14} />
              <span>v{entry.versions.length - index}</span>
              <span className={styles.versionMeta}>{String(version.data.fileName)} · {formatFileSize(version.data.size) || t("大小未知", "Size unavailable")} · {formatRelativeTime(version.createdAt, locale)}</span>
            </button>
            <Button variant="ghost" size="icon-sm" aria-label={`${t("下载", "Download")} v${entry.versions.length - index}`} onClick={() => { void download(version) }}><Download size={14} /></Button>
          </div>)}
        </div>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {copyNotice && <p role="status" className={styles.notice}>{copyNotice}</p>}
      </div>
      <div className={styles.formActions}>
        <Button variant="outline" disabled={downloading} onClick={() => { void download(selected) }}><Download size={14} />{downloading ? t("下载中…", "Downloading…") : t("下载", "Download")}</Button>
        <Button variant="outline" onClick={() => { void copy(selected) }}><Link2 size={14} />{t("复制链接", "Copy link")}</Button>
        {canManage && !entry.hidden && <Button variant="outline" disabled={locked} onClick={() => onAction("rename", selected)}>{t("修改显示名", "Rename display title")}</Button>}
        {canManage && <Button variant="outline" disabled={locked} onClick={() => onAction(entry.hidden ? "restore" : "hide", selected)}>{entry.hidden ? t("恢复", "Restore") : t("隐藏", "Hide")}</Button>}
        {canCopy && <Button variant="outline" disabled={locked} onClick={() => onAction("copy", selected)}>{t("复制所选版本", "Copy selected version")}</Button>}
        <DialogClose render={<Button variant="default" />}>{t("关闭", "Close")}</DialogClose>
      </div>
    </DialogContent>
  </Dialog>
}

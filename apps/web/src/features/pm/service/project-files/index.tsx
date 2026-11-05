import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import { ApiError, CommandOutcomeUnknown, type ArtifactVisibility, type Command, type CommandReceipt, type Entity } from "@contracts"
import { z } from "zod"
import { Check, Download, Eye, FolderOpen, LayoutGrid, Link2, List, ListFilter, MoreHorizontal, Search, SearchX, Upload, UploadCloud, X } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/ui/empty"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard } from "@/components/blocks/filter-card"
import type { FilterCondition, FilterField } from "@/lib/filter-model"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { usePmCommand, usePmEntities, usePmService, useProjectDirectory } from "../pm-service"
import { usePmNoticeCenter } from "../pm-notice-center"
import { allowed, entitySchema, makeCommand, useDraftState, useText } from "../pm-ui"
import { PmCommandError, PmServiceError, pmErrorMessage } from "../pm-errors"
import { downloadProjectAttachment } from "../service-project-detail-panels"
import { FilePreviewArt, FileTypeIcon } from "./FileTypeIcon"
import { FilePreviewDialog } from "./FilePreviewDialog"
import { UploadDialog, type UploadInput } from "./UploadDialog"
import { FileLifecycleOperations, type FileLifecycleAction } from "./LifecycleDialog"
import { useFileHistory } from "./hooks"
import { allFileKinds, artifactKindFor, buildFileEntries, classifyFile, entryForFile, fileProjectWritable, fileUpdatedValues, filterAndSort, formatFileSize, formatRelativeTime, kindLabel, type FileEntry, type FileKind, type FileSort, type FileView } from "./model"
import styles from "./project-files.module.css"
import { RadixSelect } from "@/components/ui/radix-select"

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

type UploadStage = "staging" | "registering" | "done" | "failed" | "registration-failed" | "unknown"

type UploadQueueItem = {
  id: string
  name: string
  size: number
  kind: FileKind
  stage: UploadStage
  error: string | null
  uploadId: string | null
  targetArtifactId: string
  targetArtifactVersion: number | null
  title: string
  artifactKind: string
  file: File | null
  pendingCommandId?: string
  pendingPhase?: "stage" | "register"
}

const savedUpload = z.object({
  id: z.string(), name: z.string(), size: z.number(), uploadId: z.string().nullable(),
  targetArtifactId: z.string(), targetArtifactVersion: z.number().int().positive().nullable().default(null), title: z.string(), artifactKind: z.string(),
  pendingCommandId: z.string().uuid(), pendingPhase: z.enum(["stage", "register"]),
})

function restoreUpload(key: string): UploadQueueItem[] {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return []
    const item = savedUpload.parse(JSON.parse(raw))
    return [{ ...item, kind: classifyFile(item.name, ""), stage: "unknown", error: null, file: null }]
  } catch {
    // The authoritative command journal still owns recovery if local display metadata is unavailable.
    return []
  }
}

function uploadStageLabel(stage: UploadStage, t: (zh: string, en: string) => string): string {
  if (stage === "staging") return t("暂存中", "Staging")
  if (stage === "registering") return t("登记中", "Registering")
  if (stage === "done") return t("已完成", "Done")
  if (stage === "registration-failed") return t("登记失败", "Registration failed")
  if (stage === "unknown") return t("结果未知", "Outcome unknown")
  return t("上传失败", "Upload failed")
}

function describeError(error: unknown, locale: string): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")
  if (error instanceof CommandOutcomeUnknown || error instanceof ApiError || error instanceof PmCommandError || error instanceof PmServiceError) {
    return pmErrorMessage(error, locale === "en" ? "en" : "zh")
  }
  return error instanceof Error ? error.message : String(error)
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      const area = document.createElement("textarea")
      area.value = value
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.appendChild(area)
      area.select()
      const copied = document.execCommand("copy")
      area.remove()
      return copied
    } catch {
      return false
    }
  }
}

type FileMenuProps = {
  entry: FileEntry
  t: (zh: string, en: string) => string
  onPreview: () => void
  onDownload: () => void
  onCopyLink: () => void
  onAction: (mode: FileLifecycleAction["mode"]) => void
  canManage: boolean
  canCopy: boolean
  locked: boolean
  children: (menuButton: ReactNode) => ReactElement
}

function FileMenuActions({ entry, t, onPreview, onDownload, onCopyLink, onAction, canManage, canCopy, locked, contextMenu = false }: Omit<FileMenuProps, "children"> & { contextMenu?: boolean }) {
  const Item = contextMenu ? ContextMenuItem : DropdownMenuItem
  return <>
    <Item onSelect={onPreview}><Eye size={14} />{t("预览", "Preview")}</Item>
    <Item onSelect={onDownload}><Download size={14} />{t("下载", "Download")}</Item>
    <Item onSelect={onCopyLink}><Link2 size={14} />{t("复制链接", "Copy link")}</Item>
    {canManage && !entry.hidden && <Item disabled={locked} onSelect={() => onAction("rename")}>{t("修改显示名", "Rename display title")}</Item>}
    {canManage && <Item disabled={locked} onSelect={() => onAction(entry.hidden ? "restore" : "hide")}>{entry.hidden ? t("恢复", "Restore") : t("隐藏", "Hide")}</Item>}
    {canCopy && <Item disabled={locked} onSelect={() => onAction("copy")}>{t(`复制最新版本 v${entry.versionCount}`, `Copy latest version v${entry.versionCount}`)}</Item>}
  </>
}

/** A single artifact/action scope supplies both the ellipsis and its real row. */
function FileMenu({ children, ...props }: FileMenuProps) {
  const button = useRef<HTMLButtonElement>(null)
  const target = useRef<HTMLElement | null>(null)
  const dialogHandoff = useRef(false)
  const handoff = (run: () => void, opener: HTMLElement | null) => {
    dialogHandoff.current = true
    requestAnimationFrame(() => { opener?.focus({ preventScroll: true }); run() })
  }
  const resetHandoff = (open: boolean) => { if (open) dialogHandoff.current = false }
  const menuButton = <DropdownMenu onOpenChange={resetHandoff}>
    <DropdownMenuTrigger render={<Button ref={button} variant="ghost" size="icon-sm" className={styles.more} aria-label={`${props.t("文件操作", "File actions")} ${props.entry.name}`} onClick={event => event.stopPropagation()} />}>
      <MoreHorizontal size={14} />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" onClick={event => event.stopPropagation()} onCloseAutoFocus={event => { if (dialogHandoff.current) event.preventDefault() }}>
      <FileMenuActions {...props} onPreview={() => handoff(props.onPreview, button.current)} onAction={mode => handoff(() => props.onAction(mode), button.current)} />
    </DropdownMenuContent>
  </DropdownMenu>
  return <ContextMenu onOpenChange={resetHandoff}>
    <ContextMenuTrigger ref={element => { target.current = element }} asChild tabIndex={0}>{children(menuButton)}</ContextMenuTrigger>
    <ContextMenuContent aria-label={`${props.t("文件操作", "File actions")} ${props.entry.name}`} onClick={event => event.stopPropagation()} onCloseAutoFocus={event => { if (dialogHandoff.current) event.preventDefault() }}>
      <FileMenuActions {...props} contextMenu onPreview={() => handoff(props.onPreview, target.current)} onAction={mode => handoff(() => props.onAction(mode), target.current)} />
    </ContextMenuContent>
  </ContextMenu>
}

export function ProjectFilesPage({ project, open, onOpenChange }: { project: Entity; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace, actor, actorEpoch, capabilities, client } = usePmService()
  const command = usePmCommand()
  const [visibility, setVisibility] = useState<ArtifactVisibility>("visible")
  const artifacts = usePmEntities("artifact", project.id, visibility)
  const versions = usePmEntities("artifact_version", project.id, visibility)
  const visibleArtifacts = usePmEntities("artifact", project.id)
  const uploads = usePmEntities("upload", project.id)
  const directory = useProjectDirectory()
  const t = useText()
  const locale = useWorkspaceStore(state => state.locale)
  const display = useDisplayDateTime()
  const [params, setParams] = useSearchParams()
  const scope = `project-files:${project.id}`
  const recoveryKey = `pm-files-upload:${actor?.id ?? "anonymous"}:${workspace?.id ?? "none"}:${project.id}`
  const actionScope = `${actorEpoch}:${actor?.id ?? ""}:${workspace?.id ?? ""}:${workspace?.version ?? ""}`
  const [query, setQuery] = useDraftState(scope, "query", "")
  const [filters, setFilters] = useDraftState<FilterCondition[]>(scope, "filters", [])
  const [sort, setSort] = useDraftState<FileSort>(scope, "sort", "newest")
  const [view, setView] = useDraftState<FileView>(scope, "view", "grid")
  const [queue, setQueue] = useDraftState<UploadQueueItem[]>(scope, "uploadQueue", () => restoreUpload(recoveryKey))
  const { push } = usePmNoticeCenter()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [lifecycleAction, setLifecycleAction] = useState<(FileLifecycleAction & { scope: string }) | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const en = locale === "en"
  const canManage = capabilities?.business.enabled === true && allowed(workspace, "delivery.write", project.id) && fileProjectWritable(project)
  const canWrite = canManage && capabilities?.storage.enabled === true
  const canCopy = capabilities?.business.enabled === true && capabilities.storage.enabled && workspace?.capabilities.includes("delivery.write") === true
  const locked = command.pending || !!command.unknownCommand
  const staged = (uploads.data ?? []).filter(row => row.data.ownerId === actor?.id && !row.data.consumedAt && Date.parse(typeof row.data.expiresAt === "string" ? row.data.expiresAt : "") > Date.now())
  const entries = useMemo(() => buildFileEntries(artifacts.data, versions.data), [artifacts.data, versions.data])
  const identities = useMemo(() => new Map(directory.data?.projects.find(entry => entry.projectId === project.id)?.identities.map(identity => [identity.id, identity.name]) ?? []), [directory.data, project.id])
  const uploaderOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const entry of entries) {
      if (!entry.uploaderId || seen.has(entry.uploaderId)) continue
      seen.set(entry.uploaderId, uploaderName(entry.uploaderId))
    }
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [entries, identities, actor])
  const updatedFilterLabels: Record<(typeof fileUpdatedValues)[number], string> = {
    "24h": t("最近 24 小时", "Last 24 hours"),
    "7d": t("最近 7 天", "Last 7 days"),
    "30d": t("最近 30 天", "Last 30 days"),
    older: t("30 天以前", "Over 30 days ago"),
  }
  const filterFields: FilterField[] = [
    { id: "kind", label: t("类型", "Kind"), options: allFileKinds.map(kind => ({ value: kind, label: kindLabel(kind, en) })) },
    { id: "uploader", label: t("上传者", "Uploader"), options: uploaderOptions },
    { id: "updated", label: t("更新时间", "Updated"), options: fileUpdatedValues.map(value => ({ value, label: updatedFilterLabels[value] })) },
  ]
  const activeFilterCount = filters.filter(condition => condition.values.length > 0).length
  const filtered = useMemo(() => filterAndSort(entries, query, filters, sort), [entries, query, filters, sort])
  const readError = versions.error ?? artifacts.error
  const hasSnapshot = !!versions.data
  const loading = !readError && ((versions.isPending && !versions.data) || (artifacts.isPending && !artifacts.data && !versions.data))
  const fileParam = params.get("file")
  const history = useFileHistory(fileParam, project.id)
  const previewMatch = fileParam ? history.data ?? (!history.error ? entryForFile(entries, fileParam) : null) : null
  const missingFile = !!fileParam && !previewMatch && !history.isPending && !loading

  useEffect(() => {
    setQueue(previous => {
      let changed = false
      const next = previous.map(item => {
        if (item.stage !== "staging" && item.stage !== "registering") return item
        changed = true
        return { ...item, stage: item.pendingCommandId ? "unknown" as const : item.uploadId ? "registration-failed" as const : "failed" as const, error: t("上传被中断；有原命令键时请先核对。", "Upload interrupted. Reconcile its original command key before retrying.") }
      })
      return changed ? next : previous
    })
    // Interrupted in-flight work is converted once per mount; normal updates flow through processItem.
  }, [])

  useEffect(() => {
    const receipt = command.receipt
    if (!receipt || command.unknownCommand?.commandId === receipt.commandId) return
    const item = queue.find(row => row.stage === "unknown" && row.pendingCommandId === receipt.commandId)
    if (item) applyRecoveredReceipt(item, receipt)
  }, [command.receipt, command.unknownCommand, queue])

  function uploaderName(id: string): string {
    if (!id) return "—"
    if (id === actor?.id) return actor?.name ?? id
    return identities.get(id) ?? "—"
  }

  function updateQueueItem(id: string, patch: Partial<UploadQueueItem>) {
    setQueue(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item))
  }

  function removeQueueItem(id: string) {
    const item = queue.find(row => row.id === id)
    if (item?.pendingCommandId) clearSavedAttempt(item.pendingCommandId)
    setQueue(previous => previous.filter(item => item.id !== id))
  }

  function clearSavedAttempt(commandId: string) {
    try {
      const raw = sessionStorage.getItem(recoveryKey)
      if (raw && savedUpload.parse(JSON.parse(raw)).pendingCommandId === commandId) sessionStorage.removeItem(recoveryKey)
    } catch { /* The original receipt remains authoritative if stale display metadata survives. */ }
  }

  async function executeUpload(item: UploadQueueItem, request: Command, phase: "stage" | "register") {
    // Save only recovery intent, never file bytes; the existing IndexedDB journal owns the command.
    sessionStorage.setItem(recoveryKey, JSON.stringify({
      id: item.id, name: item.name, size: item.size, uploadId: item.uploadId,
      targetArtifactId: item.targetArtifactId, title: item.title, artifactKind: item.artifactKind,
      targetArtifactVersion: item.targetArtifactVersion,
      pendingCommandId: request.commandId, pendingPhase: phase,
    }))
    updateQueueItem(item.id, { pendingCommandId: request.commandId, pendingPhase: phase })
    try {
      const receipt = await command.execute(request)
      clearSavedAttempt(request.commandId)
      return receipt
    } catch (error) {
      if (!(error instanceof CommandOutcomeUnknown)) clearSavedAttempt(request.commandId)
      throw error
    }
  }

  function applyRecoveredReceipt(item: UploadQueueItem, receipt: CommandReceipt) {
    if (receipt.commandId !== item.pendingCommandId) return
    if (receipt.status !== "committed") {
      updateQueueItem(item.id, { stage: item.uploadId ? "registration-failed" : "failed", error: t("原命令已被拒绝；未重新上传。", "The original command was rejected. No upload was repeated.") })
    } else if (item.pendingPhase === "stage") {
      const upload = z.object({ upload: entitySchema }).parse(receipt.result).upload
      updateQueueItem(item.id, { uploadId: upload.id, stage: "registration-failed", error: t("原暂存已确认。点击重试继续登记，不会重新上传。", "Original staging confirmed. Retry to register without uploading again.") })
    } else {
      updateQueueItem(item.id, { stage: "done", error: null })
    }
    clearSavedAttempt(receipt.commandId)
    void uploads.refetch(); void versions.refetch(); void artifacts.refetch()
  }

  function readBase64(file: File): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(t("无法读取文件。", "Unable to read the file.")))
    reader.onload = () => {
      const result = String(reader.result ?? "")
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.readAsDataURL(file)
    return promise
  }

  async function registerItem(item: UploadQueueItem, uploadId: string) {
    if (!workspace) throw new PmServiceError("session_changed")
    const stagedUpload = await client.getEntity(workspace.id, uploadId)
    if (item.targetArtifactId) {
      if (item.targetArtifactVersion === null) throw new Error(t("请选择并确认目标成果基线。", "Choose and confirm the target artifact baseline."))
      const request: Command = { commandId: crypto.randomUUID(), commandType: "AddArtifactVersion", targetId: item.targetArtifactId, projectId: project.id, expectedVersions: { [item.targetArtifactId]: item.targetArtifactVersion, [stagedUpload.id]: stagedUpload.version }, payload: { uploadId } }
      await executeUpload({ ...item, uploadId }, request, "register")
      return
    }
    await executeUpload({ ...item, uploadId }, makeCommand("RegisterArtifact", { title: item.title || item.name, kind: item.artifactKind || "file", uploadId }, undefined, project.id, [stagedUpload]), "register")
  }

  async function processItem(item: UploadQueueItem) {
    let uploadId = item.uploadId
    try {
      if (uploadId) {
        updateQueueItem(item.id, { stage: "registering", error: null })
      } else if (item.file) {
        updateQueueItem(item.id, { stage: "staging", error: null })
        const contentBase64 = await readBase64(item.file)
        const receipt = await executeUpload(item, makeCommand("StageUpload", { contentBase64, fileName: item.file.name, mediaType: item.file.type || "application/octet-stream" }, undefined, project.id), "stage")
        if (receipt.status !== "committed") throw new Error(t("上传未提交。", "The upload was not committed."))
        const upload = z.object({ upload: entitySchema }).parse(receipt.result).upload
        uploadId = upload.id
        updateQueueItem(item.id, { uploadId, stage: "registering" })
      } else {
        throw new Error(t("没有可登记的文件。", "There is no file to register."))
      }
      await registerItem(item, uploadId)
      updateQueueItem(item.id, { stage: "done", error: null })
      window.setTimeout(() => removeQueueItem(item.id), 2000)
      return true
    } catch (error) {
      const unknown = error instanceof CommandOutcomeUnknown
      updateQueueItem(item.id, {
        stage: unknown ? "unknown" : uploadId ? "registration-failed" : "failed",
        uploadId,
        error: describeError(error, locale),
      })
      return !unknown
    }
  }

  function enqueue(items: UploadQueueItem[]) {
    if (!items.length) return
    setQueue(previous => [...previous, ...items])
    const processable = items.filter(item => item.file || item.uploadId)
    if (!processable.length) return
    chain.current = chain.current
      .then(async () => {
        for (const item of processable) { if (!await processItem(item)) break }
      })
      .catch(() => undefined)
  }

  function queueItemsForFiles(files: File[], targetArtifactId: string, artifactKind: string, targetArtifactVersion: number | null): UploadQueueItem[] {
    return files.map(file => {
      const kind = classifyFile(file.name, file.type)
      const valid = file.size > 0 && file.size <= MAX_UPLOAD_BYTES
      return {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        kind,
        stage: valid ? "staging" : "failed",
        error: valid ? null : t("文件必须为 1 字节至 8 MiB。", "Files must contain 1 byte to 8 MiB."),
        uploadId: null,
        targetArtifactId,
        targetArtifactVersion,
        title: file.name,
        artifactKind: artifactKind || artifactKindFor(kind),
        file: valid ? file : null,
      }
    })
  }

  function handleFiles(files: File[], targetArtifactId = "", artifactKind = "", targetArtifactVersion: number | null = null) {
    if (!files.length) return
    if (!canWrite || locked) {
      push({ severity: "warning", title: t("当前项目或权限不允许上传。", "This project or your capabilities do not allow uploads."), source: "project-files" })
      return
    }
    enqueue(queueItemsForFiles(files, targetArtifactId, artifactKind, targetArtifactVersion))
  }

  function handleUploadInput(input: UploadInput) {
    if (input.staged) {
      const name = typeof input.staged.data.fileName === "string" && input.staged.data.fileName ? input.staged.data.fileName : input.staged.id
      const mediaType = typeof input.staged.data.mediaType === "string" ? input.staged.data.mediaType : ""
      const kind = classifyFile(name, mediaType)
      enqueue([{
        id: crypto.randomUUID(),
        name,
        size: typeof input.staged.data.size === "number" ? input.staged.data.size : 0,
        kind,
        stage: "registering",
        error: null,
        uploadId: input.staged.id,
        targetArtifactId: input.targetArtifactId,
        targetArtifactVersion: input.targetArtifactVersion,
        title: input.title || name,
        artifactKind: input.kind || artifactKindFor(kind),
        file: null,
      }])
      return
    }
    handleFiles(input.files, input.targetArtifactId, input.kind, input.targetArtifactVersion)
  }

  async function reconcileItem(item: UploadQueueItem) {
    if (!workspace || !item.pendingCommandId) return
    try {
      const receipt = command.unknownCommand?.commandId === item.pendingCommandId
        ? await command.reconcile()
        : await client.getCommandReceipt(workspace.id, item.pendingCommandId)
      if (receipt) applyRecoveredReceipt(item, receipt)
    } catch (error) { push({ severity: "error", title: t("原上传请求核对失败", "Upload reconciliation failed"), detail: describeError(error, locale), source: "project-files" }) }
  }

  function retry(item: UploadQueueItem) {
    if (item.stage === "unknown") { void reconcileItem(item); return }
    if (item.stage === "registration-failed" && item.uploadId) {
      updateQueueItem(item.id, { stage: "registering", error: null })
      chain.current = chain.current.then(async () => { await processItem(item) }).catch(() => undefined)
      return
    }
    if (item.stage === "failed" && item.file) {
      updateQueueItem(item.id, { stage: "staging", error: null })
      chain.current = chain.current.then(async () => { await processItem(item) }).catch(() => undefined)
    }
  }

  async function confirmTargetBaseline(item: UploadQueueItem) {
    if (!workspace || locked || !item.targetArtifactId) return
    try {
      const current = await client.getEntity(workspace.id, item.targetArtifactId)
      if (current.kind !== "artifact" || current.projectId !== project.id || current.data.hiddenAt !== null) throw new Error(t("目标已隐藏或不可用；请先恢复目标成果。", "The target is hidden or unavailable; restore it first."))
      if (!window.confirm(t(`明确采用当前成果基线 v${current.version}（${String(current.data.title)}）？保留已暂存文件，不会重新上传。`, `Explicitly adopt artifact baseline v${current.version} (${String(current.data.title)})? The staged file is retained and will not be uploaded again.`))) return
      updateQueueItem(item.id, { targetArtifactVersion: current.version, error: t("当前基线已明确确认。点击重试继续登记原暂存。", "Current baseline explicitly confirmed. Retry to register the original staged upload.") })
    } catch (error) { push({ severity: "error", title: t("无法确认文件基线", "Could not confirm file baseline"), detail: error instanceof Error ? error.message : describeError(error, locale), source: "project-files" }) }
  }

  function openPreview(entry: FileEntry, versionId: string) {
    const next = new URLSearchParams(params)
    next.set("tab", "files")
    next.set("file", versionId)
    setParams(next)
  }

  function closePreview() {
    const next = new URLSearchParams(params)
    next.delete("file")
    setParams(next, { replace: true })
  }

  function copyLinkText(version: Entity) {
    const url = new URL(window.location.href)
    url.searchParams.set("tab", "files")
    url.searchParams.set("file", version.id)
    return copyText(url.toString())
  }

  function copyLink(version: Entity) {
    void copyLinkText(version).then(copied => push({ severity: copied ? "success" : "error", title: copied ? t("链接已复制", "Link copied") : t("无法复制链接", "Unable to copy link"), source: "project-files" }))
  }

  async function download(version: Entity) {
    if (!client || !workspace) return
    try {
      await downloadProjectAttachment(client, workspace.id, version)
      push({ severity: "success", title: t("已开始下载", "Download started"), source: "project-files" })
    } catch (error) {
      push({ severity: "error", title: t("下载失败", "Download failed"), detail: describeError(error, locale), source: "project-files" })
    }
  }

  return <div className={styles.root} data-pm-project-files>
    <div className={styles.toolbar} data-pm-file-toolbar>
      <div className={styles.searchWrap}>
        <Search size={13} className={styles.searchIcon} aria-hidden="true" />
        <input className={styles.search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索文件", "Search files")} aria-label={t("搜索文件", "Search files")} />
      </div>
      <RadixSelect className={styles.select} value={visibility} onChange={event => setVisibility(event.target.value as ArtifactVisibility)} aria-label={t("文件可见性", "File visibility")}>
        <option value="visible">{t("可见文件", "Visible files")}</option><option value="hidden">{t("已隐藏", "Hidden")}</option><option value="all">{t("全部", "All")}</option>
      </RadixSelect>
      <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
        <PopoverTrigger render={<Button variant="outline" size="sm" data-pm-file-filter aria-label={t("筛选文件", "Filter files")} />}>
          <ListFilter size={14} aria-hidden="true" />{t("筛选", "Filter")}
          {activeFilterCount > 0 && <Badge size="sm" tone="info">{activeFilterCount}</Badge>}
        </PopoverTrigger>
        <PopoverContent align="end" className={styles.filterPanel} aria-label={t("文件筛选", "File filters")}>
          <FilterCard
            title={t("筛选文件", "Filter files")}
            fields={filterFields}
            conditions={filters}
            onChange={setFilters}
            emptyHint={t("尚未添加筛选条件，显示全部文件。", "No filters yet; all files are shown.")}
            addLabel={t("添加条件", "Add condition")}
            clearLabel={t("清除", "Clear")}
            whereLabel={t("条件", "Where")}
            andLabel={t("并且", "and")}
            anyLabel={t("任意", "Any")}
            removeLabel={t("移除条件", "Remove filter")}
          />
        </PopoverContent>
      </Popover>
      <RadixSelect className={styles.select} value={sort} onChange={event => setSort(event.target.value as FileSort)} aria-label={t("排序", "Sort")}>
        <option value="newest">{t("最新", "Newest")}</option>
        <option value="name">{t("名称", "Name")}</option>
        <option value="type">{t("类型", "Type")}</option>
      </RadixSelect>
      <span className={styles.spacer} />
      <div className={styles.segmented} role="group" aria-label={t("文件布局", "File layout")}>
        <button type="button" className={styles.segmentButton} aria-pressed={view === "grid"} aria-label={t("网格视图", "Grid view")} onClick={() => setView("grid")}><LayoutGrid size={14} /></button>
        <button type="button" className={styles.segmentButton} aria-pressed={view === "list"} aria-label={t("列表视图", "List view")} onClick={() => setView("list")}><List size={14} /></button>
      </div>
      <Button size="sm" disabled={!canWrite || locked} onClick={() => onOpenChange(true)} title={!canWrite ? t("当前项目或权限不允许上传。", "This project or your capabilities do not allow uploads.") : undefined}><Upload size={14} />{t("上传", "Upload")}</Button>
    </div>

    {readError && <div role="alert" className={styles.errorPanel}>
      <p>{readError.message}{hasSnapshot ? ` ${t("显示上次快照。", "Showing the previous snapshot.")}` : ""}</p>
      <Button variant="outline" size="sm" onClick={() => { void versions.refetch(); void artifacts.refetch() }}>{t("重试读取", "Retry read")}</Button>
    </div>}
    {missingFile && <p role="alert" className={styles.notice}>{t("未找到该文件或无权访问。", "The file was not found or is not accessible.")} <Button variant="ghost" size="sm" onClick={closePreview}>{t("清除", "Clear")}</Button></p>}
    {history.error && <p role="alert" className={styles.warning}>{history.error.message} <Button size="sm" variant="outline" onClick={() => { void history.refetch() }}>{t("重读历史文件", "Reload historical file")}</Button></p>}

    {loading ? <p role="status" className={styles.loading}>{t("正在读取文件…", "Loading files…")}</p> : readError && !hasSnapshot ? null : <>
      <label
        className={`${styles.dropzone} ${!canWrite || locked ? styles.dropzoneDisabled : ""}`}
        data-over={dragOver || undefined}
        role="button"
        tabIndex={canWrite && !locked ? 0 : -1}
        aria-disabled={!canWrite || locked}
        onKeyDown={event => {
          if (!canWrite || locked) return
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            fileInput.current?.click()
          }
        }}
        onDragEnter={event => { if (canWrite && !locked) { event.preventDefault(); setDragOver(true) } }}
        onDragOver={event => { if (canWrite && !locked) { event.preventDefault(); setDragOver(true) } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false) }}
        onDrop={event => { event.preventDefault(); setDragOver(false); if (canWrite && !locked) handleFiles([...(event.dataTransfer.files ?? [])]) }}
      >
        <UploadCloud size={18} aria-hidden="true" />
        <span>{t("将文件拖到这里或", "Drop files here or")} <span className={styles.browse}>{t("浏览", "browse")}</span> — {t("每个文件最大 8 MiB", "up to 8 MiB each")}</span>
        <input ref={fileInput} type="file" multiple hidden disabled={!canWrite || locked} onChange={event => { handleFiles([...(event.target.files ?? [])]); event.target.value = "" }} />
      </label>

      {!!queue.length && <div className={styles.queue} aria-live="polite" aria-label={t("上传队列", "Upload queue")}>
        {queue.map(item => {
          const active = item.stage === "staging" || item.stage === "registering"
          return <div key={item.id} className={styles.uploadItem} data-stage={item.stage}>
            <FileTypeIcon kind={item.kind} size={14} />
            <div className={styles.uploadInfo}>
              <div className={styles.uploadHead}><span className={styles.uploadName} title={item.name}>{item.name}</span><span className={styles.uploadState}>{uploadStageLabel(item.stage, t)}</span></div>
              {active && <div className={styles.progress} role="progressbar" aria-label={t("上传进度", "Upload progress")} aria-valuetext={uploadStageLabel(item.stage, t)}><i /></div>}
              {item.error && <p role="alert" className={styles.error}>{item.error}</p>}
            </div>
            {item.stage === "unknown" && <Button variant="outline" size="sm" disabled={command.pending} onClick={() => retry(item)}>{t("核对", "Check")}</Button>}
            {item.stage === "registration-failed" && item.targetArtifactId && <Button variant="outline" size="sm" disabled={!canWrite || locked} onClick={() => { void confirmTargetBaseline(item) }}>{t("重新确认目标基线", "Reconfirm target baseline")}</Button>}
            {(item.stage === "failed" || item.stage === "registration-failed") && <Button variant="outline" size="sm" disabled={!canWrite || locked} onClick={() => retry(item)}>{t("重试", "Retry")}</Button>}
            {item.stage === "done" ? <Check size={16} className={styles.doneIcon} aria-hidden="true" /> : <Button variant="ghost" size="icon-sm" disabled={active || item.stage === "unknown"} aria-label={t("移除", "Dismiss")} onClick={() => removeQueueItem(item.id)}><X size={14} /></Button>}
          </div>
        })}
      </div>}

      {directory.error && entries.length > 0 && <p className={styles.warning}>{t("无法读取成员目录，上传者仅显示标识。", "The member directory could not be read; uploaders show identifiers only.")}</p>}
      {uploads.error && <p className={styles.warning}>{t("无法读取已暂存文件；仍可直接上传。", "Staged uploads could not be read; direct upload is still available.")}</p>}

      {!entries.length
        ? <Empty icon={<FolderOpen size={20} />} title={visibility === "hidden" ? t("没有已隐藏文件", "No hidden files") : t("还没有文件", "No files yet")} description={visibility === "hidden" ? t("隐藏不撤销历史读取权限；恢复会保留原ID。", "Hiding does not revoke historical access. Restoration retains the original ID.") : t("上传设计、文档和资产，与项目成员共享。", "Upload designs, documents, and assets to share them with the project.")} />
        : !filtered.length
          ? <Empty icon={<SearchX size={20} />} title={t("没有匹配的文件", "No results found")} description={t("没有文件符合当前搜索或筛选条件。", "No files match the current search or filters.")} />
          : view === "grid"
            ? <ul className={styles.grid} aria-label={t("文件", "Files")}>
                {filtered.map(entry => <FileMenu key={entry.id} entry={entry} t={t} onPreview={() => openPreview(entry, entry.latest.id)} onDownload={() => { void download(entry.latest) }} onCopyLink={() => copyLink(entry.latest)} canManage={canManage} canCopy={canCopy} locked={locked} onAction={mode => setLifecycleAction({ mode, artifact: entry.artifact, version: entry.latest, scope: actionScope })}>{menuButton => <li className={styles.card} data-pm-file>
                  <button type="button" className={styles.cardButton} aria-label={`${t("预览", "Preview")} ${entry.name}`} onClick={() => openPreview(entry, entry.latest.id)}>
                    <FilePreviewArt kind={entry.kind} name={entry.originalFileName} />
                    <span className={styles.cardInfo}>
                      <span className={styles.fileName} title={entry.name}>{entry.name}</span>
                      <span className={styles.fileMeta}>{entry.hidden && `${t("已隐藏", "Hidden")} · `}{entry.originalFileName} · {[formatFileSize(entry.size), uploaderName(entry.uploaderId), formatRelativeTime(entry.updatedAt, locale)].filter(Boolean).join(" · ")}{entry.versionCount > 1 ? ` · v${entry.versionCount}` : ""}</span>
                    </span>
                  </button>
                  {menuButton}
                </li>}</FileMenu>)}
              </ul>
            : <div className={styles.tableWrap} role="region" aria-label={t("文件表格", "Files table")} tabIndex={0}>
                <table className={styles.table}>
                  <thead><tr><th scope="col">{t("名称", "Name")}</th><th scope="col">{t("类型", "Type")}</th><th scope="col">{t("大小", "Size")}</th><th scope="col">{t("上传者", "Uploaded by")}</th><th scope="col">{t("日期", "Date")}</th><th scope="col"><span className="sr-only">{t("操作", "Actions")}</span></th></tr></thead>
                  <tbody>
                    {filtered.map(entry => {
                      const uploader = uploaderName(entry.uploaderId)
                      return <FileMenu key={entry.id} entry={entry} t={t} onPreview={() => openPreview(entry, entry.latest.id)} onDownload={() => { void download(entry.latest) }} onCopyLink={() => copyLink(entry.latest)} canManage={canManage} canCopy={canCopy} locked={locked} onAction={mode => setLifecycleAction({ mode, artifact: entry.artifact, version: entry.latest, scope: actionScope })}>{menuButton => <tr data-pm-file>
                        <td><button type="button" className={styles.nameButton} title={`${entry.name} · ${entry.originalFileName}`} onClick={() => openPreview(entry, entry.latest.id)}><FileTypeIcon kind={entry.kind} size={14} /><span className={styles.nameText}>{entry.name}{entry.hidden && ` · ${t("已隐藏", "Hidden")}`}</span>{entry.versionCount > 1 && <span className={styles.versionBadge}>v{entry.versionCount}</span>}</button><small className={styles.fileMeta}>{entry.originalFileName}</small></td>
                        <td>{kindLabel(entry.kind, en)}</td>
                        <td className={styles.numeric}>{formatFileSize(entry.size) || "—"}</td>
                        <td><span className={styles.uploader}>{uploader !== "—" && <Avatar name={uploader} size={24} />}<span>{uploader}</span></span></td>
                        <td className={styles.date} title={display.dateTime(entry.updatedAt)}>{formatRelativeTime(entry.updatedAt, locale)}</td>
                        <td className={styles.actions}>{menuButton}</td>
                      </tr>}</FileMenu>
                    })}
                  </tbody>
                </table>
              </div>}
    </>}

    {open && <UploadDialog onOpenChange={onOpenChange} artifacts={visibleArtifacts.data ?? []} staged={staged} stagedError={uploads.error} canWrite={canWrite} locked={locked} t={t} onSubmit={handleUploadInput} />}
    {previewMatch && <FilePreviewDialog key={`${previewMatch.entry.id}:${previewMatch.versionId}`} entry={previewMatch.entry} initialVersionId={previewMatch.versionId} locale={locale} t={t} uploaderName={uploaderName} onOpenChange={open => { if (!open) closePreview() }} onCopyLink={copyLinkText} canManage={canManage} canCopy={canCopy} locked={locked} onAction={(mode, version) => setLifecycleAction({ mode, artifact: previewMatch.entry.artifact, version, scope: actionScope })} />}
    <FileLifecycleOperations action={lifecycleAction?.scope === actionScope ? lifecycleAction : null} project={project} locale={locale} onClose={() => setLifecycleAction(null)} />
  </div>
}

import { useState } from "react"
import type { Entity } from "@contracts"
import { Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { artifactKindFor, classifyFile, formatFileSize } from "./model"
import styles from "./project-files.module.css"
import { RadixSelect } from "@/components/ui/radix-select"

export type UploadInput = {
  files: File[]
  staged: Entity | null
  targetArtifactId: string
  targetArtifactVersion: number | null
  title: string
  kind: string
}

type UploadDialogProps = {
  onOpenChange: (open: boolean) => void
  artifacts: Entity[]
  staged: Entity[]
  stagedError: Error | null
  canWrite: boolean
  locked: boolean
  t: (zh: string, en: string) => string
  onSubmit: (input: UploadInput) => void
}

export function UploadDialog({ onOpenChange, artifacts, staged, stagedError, canWrite, locked, t, onSubmit }: UploadDialogProps) {
  const [files, setFiles] = useState<File[]>([])
  const [stagedId, setStagedId] = useState("")
  const [targetArtifactId, setTargetArtifactId] = useState("")
  const [targetArtifactVersion, setTargetArtifactVersion] = useState<number | null>(null)
  const [title, setTitle] = useState("")
  const [kind, setKind] = useState("document")
  const [error, setError] = useState<string | null>(null)
  const selectedStaged = stagedId ? staged.find(row => row.id === stagedId) ?? null : null
  const sourceCount = selectedStaged ? 1 : files.length
  const disabled = !canWrite || locked

  function chooseStaged(id: string) {
    setStagedId(id)
    setFiles([])
    setError(null)
    const row = staged.find(candidate => candidate.id === id)
    if (row) {
      const name = typeof row.data.fileName === "string" ? row.data.fileName : row.id
      const mediaType = typeof row.data.mediaType === "string" ? row.data.mediaType : ""
      setTitle(name)
      setKind(artifactKindFor(classifyFile(name, mediaType)))
    }
  }

  function submit() {
    setError(null)
    if (!canWrite) { setError(t("当前项目或权限不允许上传。", "This project or your capabilities do not allow uploads.")); return }
    if (locked) { setError(t("有命令尚未完成，请先查询或等待。", "A command is still pending; reconcile or wait before uploading.")); return }
    if (stagedId && !selectedStaged) { setError(t("暂存文件不可用，请刷新后重试。", "The staged upload is unavailable. Refresh and try again.")); return }
    if (!sourceCount) { setError(t("请选择文件或已暂存文件。", "Choose a file or a staged upload.")); return }
    if (targetArtifactId && sourceCount > 1) { setError(t("追加新版本时一次只能选择一个文件。", "Choose one file when adding a new version.")); return }
    if (!targetArtifactId && selectedStaged && !title.trim()) { setError(t("请填写成果标题。", "Enter an artifact title.")); return }
    if (!targetArtifactId && !kind.trim()) { setError(t("请填写成果类型。", "Enter an artifact kind.")); return }
    onSubmit({ files: selectedStaged ? [] : files, staged: selectedStaged, targetArtifactId, targetArtifactVersion, title: title.trim(), kind: kind.trim() })
    onOpenChange(false)
  }

  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent className={styles.uploadDialog}>
      <DialogTitle>{t("上传文件", "Upload files")}</DialogTitle>
      <DialogDescription>{t("文件先暂存，再登记为成果或成果的新版本。每个文件最大 8 MiB。", "Files are staged first, then registered as an artifact or a new artifact version. Maximum 8 MiB per file.")}</DialogDescription>
      <form className={styles.dialogBody} onSubmit={event => { event.preventDefault(); submit() }}>
        <label className={styles.field}>
          <span>{t("目标成果", "Target artifact")}</span>
          <RadixSelect className={styles.formSelect} value={targetArtifactId} onChange={event => { const target = artifacts.find(artifact => artifact.id === event.target.value); setTargetArtifactId(event.target.value); setTargetArtifactVersion(target?.version ?? null); setFiles([]); setError(null) }} disabled={disabled}>
            <option value="">{t("创建新成果", "Create a new artifact")}</option>
            {artifacts.filter(artifact => artifact.data.hiddenAt === null).map(artifact => <option key={artifact.id} value={artifact.id}>{String(artifact.data.title)}</option>)}
          </RadixSelect>
          <small>{targetArtifactId ? t("选择文件后将追加为不可变的新版本。", "The selected file becomes an immutable new version.") : t("每个文件创建一个以文件名命名的成果。", "Each file creates an artifact named after the file.")}</small>
        </label>

        {!!staged.length && <label className={styles.field}>
          <span>{t("或登记已暂存文件", "Or register a staged upload")}</span>
          <RadixSelect className={styles.formSelect} value={stagedId} onChange={event => chooseStaged(event.target.value)} disabled={disabled}>
            <option value="">{t("不使用暂存文件", "Do not use a staged upload")}</option>
            {staged.map(row => <option key={row.id} value={row.id}>{`${typeof row.data.fileName === "string" ? row.data.fileName : row.id} · ${formatFileSize(row.data.size)}`}</option>)}
          </RadixSelect>
          {stagedError && <small className={styles.warning}>{stagedError.message}</small>}
        </label>}

        {!stagedId && <label className={styles.field}>
          <span>{t("文件", "File")}</span>
          <input key={targetArtifactId ? "single" : "multiple"} className={styles.fileInput} type="file" multiple={!targetArtifactId} disabled={disabled} onChange={event => { const selected = [...(event.target.files ?? [])]; setFiles(selected); setStagedId(""); setError(null); if (!targetArtifactId && selected[0] && kind === "document") setKind(artifactKindFor(classifyFile(selected[0].name, selected[0].type))) }} />
          <small>{targetArtifactId ? t("一次一个文件。", "One file at a time.") : t("可多选；每个文件独立提交。", "Select multiple files; each is submitted separately.")}</small>
        </label>}

        {!targetArtifactId && <label className={styles.field}>
          <span>{t("成果类型", "Artifact kind")}</span>
          <Input value={kind} onChange={event => setKind(event.target.value)} disabled={disabled} maxLength={100} required />
          <small>{t("纯文本元数据，例如 document、design、report。", "Plain metadata such as document, design, or report.")}</small>
        </label>}

        {!targetArtifactId && selectedStaged && <label className={styles.field}>
          <span>{t("成果标题", "Artifact title")}</span>
          <Input value={title} onChange={event => setTitle(event.target.value)} disabled={disabled} required />
        </label>}

        {selectedStaged && <p className={styles.hint}>{t("当前文件：", "Selected staged file: ")}{typeof selectedStaged.data.fileName === "string" ? selectedStaged.data.fileName : selectedStaged.id} · {formatFileSize(selectedStaged.data.size)}</p>}
        {!!files.length && !targetArtifactId && <p className={styles.hint}>{t(`将创建 ${files.length} 个成果：`, `Will create ${files.length} artifacts: `)}{files.map(file => file.name).join("、")}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.formActions}>
          <DialogClose render={<Button variant="outline" />}>{t("取消", "Cancel")}</DialogClose>
          <Button type="submit" disabled={disabled}><Upload size={14} />{t("上传", "Upload")}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
}

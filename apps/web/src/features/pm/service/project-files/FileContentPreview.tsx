import { useEffect, useState } from "react"
import type { Entity } from "@contracts"
import { Button } from "@/components/ui/button"
import { usePmService } from "../pm-service"
import { allowed } from "../pm-ui"
import { pmErrorMessage } from "../pm-errors"
import { PdfPreview } from "../../markdown/preview-pdf"
import { filePreviewLimit, filePreviewPolicy, literalPreviewText, matchesPreviewSignature, textPreviewLimit } from "./preview-model"
import styles from "./project-files.module.css"

type Preview = { scope: string } & ({ kind: "image"; url: string } | { kind: "pdf"; bytes: Uint8Array } | { kind: "text"; text: string } | { kind: "unsupported" })

export function FileContentPreview({ version, name, locale, t }: { version: Entity; name: string; locale: string; t: (zh: string, en: string) => string }) {
  const { client, actor, actorEpoch, workspace, error: serviceError } = usePmService()
  const canRead = !!actor && !serviceError && allowed(workspace, "domain.read", version.projectId)
  const scope = `${actorEpoch}:${actor?.id ?? ""}:${workspace?.id ?? ""}:${workspace?.version ?? ""}:${canRead}:${version.id}`
  const [result, setResult] = useState<Preview | null>(null)
  const [error, setError] = useState<{ scope: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!canRead || !workspace) return
    const abort = new AbortController()
    let url: string | undefined
    async function load() {
      const fresh = await client.getEntity(workspace!.id, version.id, { signal: abort.signal })
      if (abort.signal.aborted) return
      if (fresh.projectId !== version.projectId) throw new Error("scope_changed")
      const policy = filePreviewPolicy(fresh, workspace!.id, version.id)
      if (policy.kind === "unsupported") { setResult({ scope, kind: "unsupported" }); return }
      const limit = policy.kind === "text" ? textPreviewLimit : filePreviewLimit
      if (typeof fresh.data.size !== "number" || fresh.data.size <= 0 || fresh.data.size > limit) throw new Error(policy.kind === "text" ? "text_limit" : "preview_limit")
      const download = await client.downloadArtifactVersion(workspace!.id, version.id, { signal: abort.signal })
      if (abort.signal.aborted) return
      if (download.bytes.byteLength !== fresh.data.size || download.bytes.byteLength > limit) throw new Error("integrity")
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", download.bytes as Uint8Array<ArrayBuffer>))].map(value => value.toString(16).padStart(2, "0")).join("")
      if (abort.signal.aborted) return
      if (digest !== fresh.data.sha256) throw new Error("integrity")
      if (policy.kind === "text") { setResult({ scope, kind: "text", text: literalPreviewText(download.bytes) }); return }
      if (!matchesPreviewSignature(download.bytes, policy.mediaType)) throw new Error("signature")
      if (policy.kind === "pdf") { setResult({ scope, kind: "pdf", bytes: download.bytes }); return }
      url = URL.createObjectURL(new Blob([download.bytes as Uint8Array<ArrayBuffer>], { type: policy.mediaType }))
      setResult({ scope, kind: "image", url })
    }
    void load().catch(cause => {
      if (abort.signal.aborted) return
      const code = cause instanceof Error ? cause.message : ""
      const message = code === "text_limit" ? t("文本预览限 256 KiB；请下载原文件。", "Text preview is limited to 256 KiB. Download the original file.")
        : code === "preview_limit" ? t("文件超出 8 MiB 预览限制或大小无效。", "File size is invalid or exceeds the 8 MiB preview limit.")
        : code === "signature" || code === "integrity" ? t("内容与登记的类型、大小或 SHA-256 不符，已拒绝预览。", "Content does not match its registered type, size or SHA-256. Preview refused.")
        : code === "not_text" ? t("内容不是有效的 UTF-8 纯文本，已拒绝预览。", "Content is not valid UTF-8 plain text. Preview refused.")
        : code === "scope_changed" ? t("文件不在当前授权项目中。", "File is not in the authorized project.")
        : pmErrorMessage(cause, locale === "en" ? "en" : "zh")
      setError({ scope, message })
    })
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url) }
    // Localized feedback is captured per request; language changes do not refetch bytes.
  }, [client, scope, version.id, version.projectId, canRead, attempt])
  const active = result?.scope === scope ? result : null
  const failed = error?.scope === scope ? error.message : null
  if (!canRead) return <p role="alert" className={styles.error}>{t("需要当前项目的有效读取权限才能预览。", "Preview requires current read access to this project.")}</p>
  if (failed) return <div className={styles.contentPreview}><p role="alert" className={styles.error}>{failed}</p><Button size="sm" variant="outline" onClick={() => { setError(null); setResult(null); setAttempt(value => value + 1) }}>{t("重试预览", "Retry preview")}</Button></div>
  if (!active) return <p role="status">{t("正在读取授权文件…", "Loading authorized file…")}</p>
  if (active.kind === "unsupported") return <p className={styles.hint}>{t("为安全起见不预览 HTML、SVG、XML 或其他不支持的格式。可下载原文件；下载不表示内容安全。", "HTML, SVG, XML and unsupported formats are not previewed for safety. Download the original file; downloading does not imply it is safe.")}</p>
  return <div className={`${styles.contentPreview}${active.kind === "pdf" ? " markdown-preview" : ""}`} data-pm-file-content={active.kind}>
    {active.kind === "image" ? <img src={active.url} alt={name} referrerPolicy="no-referrer" onError={() => setError({ scope, message: t("图片解码失败，请下载原文件。", "Image decoding failed. Download the original file.") })} />
      : active.kind === "pdf" ? <PdfPreview key={scope} bytes={active.bytes} label={name} />
      : <pre tabIndex={0} aria-label={t("纯文本预览", "Plain text preview")}>{active.text}</pre>}
  </div>
}

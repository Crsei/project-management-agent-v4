import { useEffect, useState } from "react";
import { useAui, type Attachment } from "@assistant-ui/react";
import { FileIcon, RotateCcw, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@agent/components/ui/dialog";
import { useAgentText, type AgentText } from "../i18n";
import { attachmentProgressView, attachmentRetryPayload, attachmentRetryPlan, type AttachmentRetryPlan } from "./attachment-progress";
import { isVideoAttachment } from "./attachment-video-frame";
import { VideoAttachmentFrame } from "./attachment-video-frame-view";
import "./composer-attachment-strip.css";

type AttachmentStatus = Attachment["status"];

type AttachmentFailure = Extract<AttachmentStatus, { type: "incomplete" }>;

function describeFailure(status: AttachmentFailure, t: AgentText): string {
  if (status.reason === "upload-paused") return t("上传已暂停", "Upload paused");
  return status.message || t("附件不可用", "Attachment unavailable");
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function retryExplanation(plan: AttachmentRetryPlan, t: AgentText): string | undefined {
  if (plan.retryable) return undefined;
  if (plan.reason === "too-large") return t("文件超过 24 MB，无法在本地重建；请移除后重新选择。", "Over 24 MB, so it cannot be rebuilt locally. Remove it and attach it again.");
  if (plan.reason === "no-bytes") return t("没有可重建的附件内容；请移除后重新选择文件。", "No recoverable attachment content. Remove it and attach the file again.");
  return undefined;
}

function AttachmentTile({ attachment, disabled, onRemove }: { attachment: Attachment; disabled: boolean; onRemove: (id: string) => void }) {
  const t = useAgentText();
  const aui = useAui();
  const [url, setUrl] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const [retryPercent, setRetryPercent] = useState<number>();
  const [retryError, setRetryError] = useState<string>();
  useEffect(() => {
    if (!attachment.file) {
      setUrl(undefined);
      return;
    }
    const next = URL.createObjectURL(attachment.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [attachment.file]);

  const video = isVideoAttachment(attachment);

  const part = attachment.content?.find(item => item.type === "image" || item.type === "file");
  const embedded = part?.type === "image" && typeof part.image === "string" ? part.image : part?.type === "file" && typeof part.data === "string" ? part.data : undefined;
  const source = url ?? embedded;
  const isImage = attachment.type === "image" && !video;
  const size = formatBytes(attachment.file?.size);
  const retry = attachmentRetryPlan(attachment);
  const failure = attachment.status.type === "incomplete" ? attachment.status : undefined;
  const failureText = failure ? describeFailure(failure, t) : undefined;
  const explanation = failure ? retryExplanation(retry, t) : undefined;
  const progress = retrying && retryPercent !== undefined
    ? { kind: "determinate" as const, percent: retryPercent }
    : attachmentProgressView(attachment.status);
  const detail = progress.kind === "determinate" ? `${progress.percent}%`
    : progress.kind === "indeterminate" ? t("正在上传…", "Uploading…")
      : retrying ? t("正在重试…", "Retrying…")
        : size || t("附件", "Attachment");
  const note = [failureText, explanation, retryError].filter((value): value is string => !!value).join(" · ") || undefined;
  const label = `${attachment.name}${size ? ` · ${size}` : ""}`;
  const title = [note, label].filter((value): value is string => !!value).join(" · ");

  const handleRetry = () => {
    if (!retry.retryable || retrying) return;
    setRetrying(true);
    setRetryError(undefined);
    setRetryPercent(undefined);
    void (async () => {
      try {
        const payload = await attachmentRetryPayload(attachment, percent => setRetryPercent(percent));
        if (!payload) throw new Error(t("没有可重建的附件内容。", "No attachment content could be rebuilt."));
        // Replace in place only after the retry bytes exist, so a read failure
        // leaves the failed card (and its message) exactly as it was.
        await aui.composer.attachment({ id: attachment.id }).remove();
        await aui.composer.addAttachment(payload);
      } catch (cause) {
        setRetryError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRetrying(false);
        setRetryPercent(undefined);
      }
    })();
  };

  const imagePreview = isImage && source
    ? <Dialog><DialogTrigger render={<button type="button" className="composer-attachment-preview" aria-label={t(`预览 ${attachment.name}`, `Preview ${attachment.name}`)}><img src={source} alt={attachment.name} /></button>} />
        <DialogContent className="max-w-3xl"><DialogTitle>{attachment.name}</DialogTitle><img src={source} alt={attachment.name} className="max-h-[75vh] w-full object-contain" /></DialogContent>
      </Dialog>
    : undefined;
  const videoPreview = video
    ? <VideoAttachmentFrame attachment={attachment} url={url} />
    : undefined;

  return <div className="composer-attachment-tile" data-image={(isImage && source) || undefined} data-video={video || undefined} data-error={failure ? true : undefined} title={title}>
    {imagePreview ?? videoPreview ?? <span className="composer-attachment-file" aria-hidden="true"><FileIcon /></span>}
    <span className="composer-attachment-meta">
      <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
      <span className="composer-attachment-size" data-progress={progress.kind !== "none" || undefined}>{detail}</span>
      {progress.kind !== "none" && <span className="composer-attachment-progress" role="progressbar"
        aria-label={retrying ? t("重试进度", "Retry progress") : t("上传进度", "Upload progress")}
        aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={progress.kind === "determinate" ? progress.percent : undefined}
        aria-valuetext={progress.kind === "determinate" ? `${progress.percent}%` : retrying ? t("正在重试", "Retrying") : t("正在上传", "Uploading")}>
        <span className="composer-attachment-progress-fill" aria-hidden="true" style={progress.kind === "determinate" ? { width: `${progress.percent}%` } : undefined} />
      </span>}
      {note && <span className="composer-attachment-note">{note}</span>}
    </span>
    {retry.retryable && <button type="button" className="composer-attachment-retry" disabled={disabled || retrying}
      aria-busy={retrying || undefined}
      aria-label={t(`重试附件 ${attachment.name}`, `Retry attachment ${attachment.name}`)}
      title={t("重新读取原始字节并恢复该附件", "Re-read the original bytes and restore this attachment")}
      onClick={handleRetry}><RotateCcw aria-hidden="true" /></button>}
    <button type="button" className="composer-attachment-remove" disabled={disabled} aria-label={t(`移除附件 ${attachment.name}`, `Remove attachment ${attachment.name}`)} onClick={() => onRemove(attachment.id)}><X aria-hidden="true" /></button>
  </div>;
}

/** t3code-style media row; the editor keeps attachment nodes for round-trip and submission. */
export function ComposerAttachmentStrip({ attachments, disabled, onRemove }: { attachments: readonly Attachment[]; disabled: boolean; onRemove: (id: string) => void }) {
  const t = useAgentText();
  if (!attachments.length) return null;
  return <div className="composer-attachment-strip" aria-label={t("已添加附件", "Attached files")}>
    {attachments.map(attachment => <AttachmentTile key={attachment.id} attachment={attachment} disabled={disabled} onRemove={onRemove} />)}
  </div>;
}

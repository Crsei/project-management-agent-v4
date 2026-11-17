import { useEffect, useState } from "react";
import type { Attachment } from "@assistant-ui/react";
import { FileIcon, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@agent/components/ui/dialog";
import { useAgentText } from "../i18n";
import "./composer-attachment-strip.css";

type AttachmentStatus = Attachment["status"];
function statusText(status: AttachmentStatus, t: ReturnType<typeof useAgentText>): string | undefined {
  if (status.type === "running") return t("正在准备…", "Preparing…");
  if (status.type === "incomplete" && status.reason === "error") return status.message || t("附件不可用", "Attachment unavailable");
  return undefined;
}

function AttachmentTile({ attachment, disabled, onRemove }: { attachment: Attachment; disabled: boolean; onRemove: (id: string) => void }) {
  const t = useAgentText();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!attachment.file) return;
    const next = URL.createObjectURL(attachment.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [attachment.file]);
  const part = attachment.content?.find(item => item.type === "image" || item.type === "file");
  const embedded = part?.type === "image" && typeof part.image === "string" ? part.image : part?.type === "file" && typeof part.data === "string" ? part.data : undefined;
  const source = url ?? embedded;
  const isImage = attachment.type === "image";
  const status = statusText(attachment.status, t);
  const bytes = attachment.file?.size;
  const size = bytes === undefined ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  const label = `${attachment.name}${size ? ` · ${size}` : ""}`;
  return <div className="composer-attachment-tile" data-image={isImage || undefined} data-error={attachment.status.type === "incomplete" ? true : undefined} title={status ?? label}>
    {isImage && source
      ? <Dialog><DialogTrigger render={<button type="button" className="composer-attachment-preview" aria-label={t(`预览 ${attachment.name}`, `Preview ${attachment.name}`)}><img src={source} alt={attachment.name} /></button>} />
          <DialogContent className="max-w-3xl"><DialogTitle>{attachment.name}</DialogTitle><img src={source} alt={attachment.name} className="max-h-[75vh] w-full object-contain" /></DialogContent>
        </Dialog>
      : <span className="composer-attachment-file" aria-hidden="true"><FileIcon /></span>}
    <span className="composer-attachment-meta">
      <span className="composer-attachment-name">{attachment.name}</span>
      <span className="composer-attachment-size">{status ?? size ?? t("附件", "Attachment")}</span>
    </span>
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

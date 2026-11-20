import type { Attachment, AttachmentStatus, CreateAttachment, ThreadUserMessagePart } from "@assistant-ui/react";

/**
 * B3 attachment model: reported upload progress and retry eligibility.
 *
 * Every value here comes from the `Attachment` assistant-ui already exposes or
 * from bytes the browser can actually read again. Nothing is estimated: a
 * percentage is shown only when the runtime reported a measurement, and a
 * retry is offered only when the original bytes can be rebuilt losslessly.
 */

/**
 * Larger files are not copied into an in-memory data URL again; the composer
 * clipboard/draft contract rejects the same ceiling (24 MB), so offering a
 * retry past it would promise a card that sending could never serialize.
 */
export const ATTACHMENT_RETRY_BYTE_LIMIT = 24_000_000;

/** Clamp a reported measurement to an integer percentage, or drop it. */
export function normalizeAttachmentProgress(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(100, Math.round(value));
}

export type AttachmentProgressView =
  | { readonly kind: "none" }
  | { readonly kind: "determinate"; readonly percent: number }
  | { readonly kind: "indeterminate" };

/**
 * `CloudFileAttachmentAdapter` seeds `progress: 0` and never updates it, so a
 * zero measurement is indistinguishable from "no measurement yet". It renders
 * as activity, never as `0%`.
 */
export function attachmentProgressView(status: AttachmentStatus): AttachmentProgressView {
  if (status.type !== "running") return { kind: "none" };
  const percent = normalizeAttachmentProgress(status.progress);
  return percent === undefined || percent === 0 ? { kind: "indeterminate" } : { kind: "determinate", percent };
}

export function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

export type AttachmentRetryPlan =
  | { readonly retryable: true; readonly source: "file" | "content" }
  | { readonly retryable: false; readonly reason: "complete" | "pending" | "too-large" | "no-bytes" };

/**
 * A failed attachment is retryable only while its bytes still exist: the local
 * `File` the adapter kept, or content parts that serialize back byte-for-byte.
 * `requires-action`/`running` are normal pending states, not failures.
 */
export function attachmentRetryPlan(attachment: Attachment): AttachmentRetryPlan {
  const status = attachment.status;
  if (status.type === "complete") return { retryable: false, reason: "complete" };
  if (status.type !== "incomplete") return { retryable: false, reason: "pending" };
  if (isBlobLike(attachment.file)) {
    return attachment.file.size > ATTACHMENT_RETRY_BYTE_LIMIT ? { retryable: false, reason: "too-large" } : { retryable: true, source: "file" };
  }
  if (attachmentRetryContent(attachment)) return { retryable: true, source: "content" };
  return { retryable: false, reason: "no-bytes" };
}

/**
 * Lossless copy of the attachment's own parts. Any part that cannot be
 * serialized exactly (audio, hosted data parts) makes the whole attachment
 * non-retryable instead of silently dropping bytes.
 */
export function attachmentRetryContent(attachment: Attachment): ThreadUserMessagePart[] | undefined {
  const parts = attachment.content;
  if (!parts?.length) return undefined;
  const content: ThreadUserMessagePart[] = [];
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") content.push({ type: "image", image: part.image, ...(part.filename ? { filename: part.filename } : {}) });
    else if (part.type === "file") content.push({ type: "file", data: part.data, mimeType: part.mimeType, ...(part.filename ? { filename: part.filename } : {}) });
    else return undefined;
  }
  return content;
}

/** Read one local blob again, reporting only real `FileReader` progress. */
export function readAttachmentDataUrl(file: Blob, onProgress?: (percent: number) => void): Promise<string> {
  if (typeof FileReader === "undefined") return Promise.reject(new Error("FileReader is unavailable; cannot read the attachment bytes."));
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onprogress = (event) => {
    if (!event.lengthComputable || !event.total) return;
    const percent = normalizeAttachmentProgress((event.loaded / event.total) * 100);
    if (percent !== undefined) onProgress?.(percent);
  };
  reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Cannot read the attachment bytes.")));
  reader.onerror = () => reject(reader.error ?? new Error("Cannot read the attachment bytes."));
  reader.onabort = () => reject(new Error("Attachment read cancelled."));
  reader.readAsDataURL(file);
  return promise;
}

/**
 * Descriptor handed back to `composer.addAttachment` on retry. It keeps the
 * original id so editor anchors and captured attachment bindings still resolve,
 * and the original name/type/contentType so the card does not change identity.
 */
export async function attachmentRetryPayload(attachment: Attachment, onProgress?: (percent: number) => void): Promise<CreateAttachment | undefined> {
  const plan = attachmentRetryPlan(attachment);
  if (!plan.retryable) return undefined;
  const metadata = { id: attachment.id, name: attachment.name, type: attachment.type, ...(attachment.contentType ? { contentType: attachment.contentType } : {}) };
  if (plan.source === "content") {
    const content = attachmentRetryContent(attachment);
    return content ? { ...metadata, content } : undefined;
  }
  const file = attachment.file;
  if (!isBlobLike(file)) return undefined;
  const dataUrl = await readAttachmentDataUrl(file, onProgress);
  const mediaType = file.type || attachment.contentType || "application/octet-stream";
  const content: ThreadUserMessagePart[] = mediaType.toLowerCase().startsWith("image/")
    ? [{ type: "image", image: dataUrl, filename: attachment.name }]
    : [{ type: "file", data: dataUrl, mimeType: mediaType, filename: attachment.name }];
  return { ...metadata, content };
}

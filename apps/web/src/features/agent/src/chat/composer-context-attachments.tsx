import { useEffect, useState } from "react";
import type { Attachment } from "@assistant-ui/react";
import { z } from "zod";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@agent/components/ui/dialog";
import { FileChip, ImageChipButton } from "./context-chip-parts";

export type ComposerContextAttachment = Attachment;
export const clipboardAttachmentSchema = z.strictObject({
  id: z.string().min(1).max(256), name: z.string().max(512),
  type: z.custom<ComposerContextAttachment["type"]>(value => typeof value === "string" && ["image", "document", "file"].includes(value)),
  contentType: z.string().max(256).optional(),
  content: z.array(z.union([
    z.strictObject({ type: z.literal("text"), text: z.string() }),
    z.strictObject({ type: z.literal("image"), image: z.string().max(24000000) }),
    z.strictObject({ type: z.literal("file"), data: z.string().max(24000000), mimeType: z.string(), filename: z.string().optional() }),
  ])).min(1).max(100),
});
export type ClipboardAttachment = z.infer<typeof clipboardAttachmentSchema>;
type Prepared = { file: File | undefined; content: ComposerContextAttachment["content"]; promise: Promise<ClipboardAttachment>; value?: ClipboardAttachment; error?: string };
const prepared = new Map<string, Prepared>();
const keyOf = (owner: string, id: string) => `${owner}\u0000${id}`;

export function clipboardComposerAttachment(attachment: ComposerContextAttachment): ClipboardAttachment {
  const content = attachment.content?.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image" && typeof part.image === "string") return { type: "image", image: part.image };
    if (part.type === "file" && typeof part.data === "string") return { type: "file", data: part.data, mimeType: part.mimeType, ...(part.filename ? { filename: part.filename } : {}) };
    throw new Error("This attachment cannot be serialized without losing its real content.");
  });
  return clipboardAttachmentSchema.parse({ id: attachment.id, name: attachment.name, type: attachment.type, ...(attachment.contentType ? { contentType: attachment.contentType } : {}), content });
}

/** Capture real bytes once in session memory; neither localStorage nor a fabricated attachment. */
export function prepareComposerContextAttachment(owner: string, attachment: ComposerContextAttachment): Promise<ClipboardAttachment> {
  const key = keyOf(owner, attachment.id);
  const cached = prepared.get(key);
  if (cached && cached.file === attachment.file && cached.content === attachment.content) return cached.promise;
  const { promise, resolve, reject } = Promise.withResolvers<ClipboardAttachment>();
  const entry: Prepared = { file: attachment.file, content: attachment.content, promise };
  prepared.set(key, entry);
  void (async () => {
    const metadata = { id: attachment.id, name: attachment.name, type: attachment.type, ...(attachment.contentType ? { contentType: attachment.contentType } : {}) };
    if (attachment.file) {
      const { promise: fileReady, resolve: readFile, reject: fail } = Promise.withResolvers<string>();
      const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? readFile(reader.result) : fail(new Error("Cannot read attachment bytes.")); reader.onerror = () => fail(reader.error || new Error("Cannot read attachment bytes.")); reader.onabort = () => fail(new Error("Attachment preparation cancelled.")); reader.readAsDataURL(attachment.file);
      const url = await fileReady;
      const value = clipboardAttachmentSchema.parse({ ...metadata, content: [{ type: "file", data: url, mimeType: attachment.contentType || attachment.file.type || "application/octet-stream", filename: attachment.name }] });
      return value;
    }
    return clipboardComposerAttachment(attachment);
  })().then(value => { entry.value = value; resolve(value); }, cause => { entry.error = cause instanceof Error ? cause.message : String(cause); reject(cause); });
  return promise;
}
export function readPreparedComposerAttachment(owner: string, id: string): ClipboardAttachment {
  const entry = prepared.get(keyOf(owner, id));
  if (!entry?.value) throw new Error(entry?.error || "Attachment bytes are still being prepared. Retry copying; the draft is unchanged.");
  return entry.value;
}

export function InlineComposerAttachment({ attachment }: { attachment: ComposerContextAttachment }) {
  const [local, setLocal] = useState<{ file: File; url: string }>();
  useEffect(() => {
    if (!attachment.file) return;
    const url = URL.createObjectURL(attachment.file); setLocal({ file: attachment.file, url });
    return () => URL.revokeObjectURL(url);
  }, [attachment.file]);
  const part = attachment.content?.find(item => item.type === "image" || item.type === "file");
  const data = part?.type === "image" && typeof part.image === "string" ? part.image : part?.type === "file" && typeof part.data === "string" ? part.data : undefined;
  const url = attachment.file && local?.file === attachment.file ? local.url : data;
  const error = attachment.status.type === "incomplete" && attachment.status.reason === "error";
  const suffix = attachment.status.type === "incomplete" && attachment.status.reason === "error" ? attachment.status.message || "Attachment unavailable" : attachment.status.type === "running" ? "Preparing attachment…" : undefined;
  const bytes = attachment.file?.size;
  const size = bytes === undefined ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (attachment.type !== "image") return <FileChip name={attachment.name} size={size} suffix={suffix} error={error} />;
  const chip = <ImageChipButton name={attachment.name} previewUrl={url} size={size} suffix={suffix} state={error ? "invalid" : undefined} />;
  return url ? <Dialog><DialogTrigger render={chip} /><DialogContent className="max-w-3xl"><DialogTitle>{attachment.name}</DialogTitle><img src={url} alt={attachment.name} className="max-h-[75vh] w-full object-contain" /></DialogContent></Dialog> : chip;
}

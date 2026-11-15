import type { ChatContextInput } from "@agent-workspace/contracts/message-context";
import type { Attachment } from "@assistant-ui/react";

/** SDK conversion appends attachment content in captured attachment order. No filename/byte guessing. */
export type ContextAttachmentBinding = { attachmentId: string; partIndex: number };
export function contextAttachmentBindings(parts: readonly { type: string; url?: unknown }[], inputs: readonly ChatContextInput[], attachments: readonly Attachment[]): ContextAttachmentBinding[] {
  const content = attachments.flatMap(attachment => attachment.file && !attachment.content?.length
    ? [{ attachmentId: attachment.id, wireType: "file" }]
    : (attachment.content ?? []).map(part => ({ attachmentId: attachment.id, wireType: part.type === "image" || part.type === "file" || part.type === "audio" ? "file" : part.type === "data" ? `data-${part.name}` : part.type })));
  const start = parts.length - content.length;
  if (start < 0 || content.some((part, index) => parts[start + index]?.type !== part.wireType))
    throw new Error("The captured attachment identities no longer match the outgoing message. Nothing was sent.");
  return inputs.flatMap(input => {
    const id = input.source.type === "browser" ? input.source.attachmentId : undefined;
    const matches = id ? content.flatMap((part, index) => part.attachmentId === id && part.wireType === "file" ? [start + index] : []) : [];
    return id && matches.length === 1 ? [{ attachmentId: id, partIndex: matches[0]! }] : [];
  });
}
export function readContextAttachmentBindings(value: unknown): ContextAttachmentBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ContextAttachmentBinding => item && typeof item.attachmentId === "string" && Number.isSafeInteger(item.partIndex) && item.partIndex >= 0);
}

/** Retained file object identity is authoritative when queue text editing moves part indices. */
export function reindexContextAttachmentBindings(original: readonly { type: string }[], next: readonly { type: string }[], bindings: readonly ContextAttachmentBinding[]): ContextAttachmentBinding[] {
  return bindings.map(binding => {
    const part = original[binding.partIndex];
    if (!part || part.type !== "file") throw new Error("The saved attachment correlation is invalid; the draft is unchanged.");
    const partIndex = next.indexOf(part);
    if (partIndex < 0) throw new Error("The queued attachment could not be retained.");
    return { attachmentId: binding.attachmentId, partIndex };
  });
}

/** Undo/edit keep the SDK's numeric IDs, while canonical context records keep original attachment IDs. */
export function canonicalContextAttachments(attachments: readonly Attachment[], parts: readonly { type: string; url?: unknown }[], bindings: readonly ContextAttachmentBinding[]): readonly Attachment[] {
  if (!attachments.length || !bindings.length) return attachments;
  const fileParts = parts.flatMap((part, partIndex) => part.type === "file" ? [partIndex] : []);
  return attachments.map(attachment => {
    const index = Number(attachment.id);
    if (!Number.isSafeInteger(index) || String(index) !== attachment.id) return attachment;
    const partIndex = fileParts[index];
    if (partIndex === undefined) return attachment;
    const binding = bindings.find(value => value.partIndex === partIndex);
    const content = attachment.content?.find(part => part.type === "image" || part.type === "file");
    const url = content?.type === "image" ? content.image : content?.type === "file" ? content.data : undefined;
    return binding && typeof url === "string" && url === parts[partIndex]?.url ? { ...attachment, id: binding.attachmentId } : attachment;
  });
}

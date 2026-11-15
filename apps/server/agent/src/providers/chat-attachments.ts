import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UIMessage } from "ai";
import { isProviderSendTurnSupportedImageMimeType, type ChatAttachment } from "@t3tools/contracts";
import type { ProviderDriver } from "@agent-workspace/contracts/provider";
import { providerAttachmentsDirectory, registerProviderAttachment } from "./t3code/upstream-services/attachments.ts";
import { ProviderRuntimeError } from "./runtime.ts";
import { z } from "zod";

const filePartSchema = z.object({ type: z.literal("file"), url: z.string().max(28000000), mediaType: z.string().max(100), filename: z.string().max(512).optional() });
type FilePart = z.infer<typeof filePartSchema>;
function decoded(part: FilePart): Buffer {
  const mime = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : "";
  const prefix = `data:${mime};base64,`;
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) || typeof part.url !== "string" ||
      !part.url.startsWith(prefix) || part.url.length > 28000000)
    throw new ProviderRuntimeError(400, "unsupported_attachment", "Attachments require complete data/base64 payloads; network URLs, blob URLs and local paths are not fetched.");
  const encoded = part.url.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new ProviderRuntimeError(400, "invalid_attachment", "Attachment bytes are incomplete or invalid.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length > (mime.startsWith("image/") ? 10 : 20) * 1024 * 1024)
    throw new ProviderRuntimeError(413, "attachment_too_large", "Attachment payload exceeds its supported size or is not canonical base64.");
  if (mime.startsWith("image/") && !isProviderSendTurnSupportedImageMimeType(mime))
    throw new ProviderRuntimeError(415, "unsupported_attachment", "The pinned native Provider supports PNG, JPEG, GIF and WebP images only.");
  return bytes;
}
/** Validate before admission: unsupported attachments must never look successfully sent. */
export function validateChatAttachments(parts: readonly unknown[] | undefined, driver: ProviderDriver): { part: FilePart; bytes: Buffer }[] {
  const selected: FilePart[] = [];
  const seen = new Map<string, Set<string>>();
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object" || !("type" in part))
      throw new ProviderRuntimeError(400, "invalid_attachment", "Message part has no valid transport type.");
    if (part.type === "file") {
      const file = filePartSchema.parse(part), key = `${file.mediaType.toLowerCase()}\0${file.filename ?? ""}`;
      let urls = seen.get(key);
      if (!urls) { urls = new Set(); seen.set(key, urls); }
      if (!urls.has(file.url)) { urls.add(file.url); selected.push(file); }
    }
    else if (part.type === "image" || part.type === "audio" || part.type === "video")
      throw new ProviderRuntimeError(415, "unsupported_attachment", "Unsupported attachment transport; use the native file-part upload protocol.");
  }
  if (selected.length && driver !== "codex" && driver !== "claude")
    throw new ProviderRuntimeError(415, "unsupported_attachment", "Chat attachments are not wired to this native Provider; select Codex or Claude, or remove the attachment.");
  if (selected.length > 100) throw new ProviderRuntimeError(413, "attachment_too_large", "At most 100 attachments are supported.");
  const payloads = selected.map(part => ({ part, bytes: decoded(part) }));
  if (payloads.reduce((total, payload) => total + payload.bytes.length, 0) > 20 * 1024 * 1024)
    throw new ProviderRuntimeError(413, "attachment_too_large", "Chat attachments exceed 20 MiB in total.");
  return payloads;
}
/** Reuse the pinned ChatAttachment/ProviderHost registry, not browser paths or a new attachment database. */
export function materializeChatAttachments(parts: UIMessage["parts"] | undefined, driver: ProviderDriver): ChatAttachment[] {
  const selected = validateChatAttachments(parts, driver);
  if (!selected.length) return [];
  const root = providerAttachmentsDirectory();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink())
    throw new ProviderRuntimeError(409, "attachment_store_changed", "Provider attachment root is not canonical.");
  return selected.map(({ part, bytes }) => {
    const mime = part.mediaType.toLowerCase();
    // Unicode Cc also includes DEL/C1; preserve them under the existing C0-only filename rule.
    const name = (part.filename?.replaceAll(/[\p{Cc}/\\]/gu,
      character => character.charCodeAt(0) < 32 || character === "/" || character === "\\" ? "_" : character).trim().slice(0, 255) || "attachment");
    const id = createHash("sha256").update(mime).update("\0").update(name).update("\0").update(bytes).digest("hex");
    const extension = path.extname(name).toLowerCase();
    const relative = `chat-${id}${/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ""}`, file = path.join(root, relative);
    try { writeFileSync(file, bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!fstatSync(fd).isFile() || fstatSync(fd).size !== bytes.length || !readFileSync(fd).equals(bytes)) throw new ProviderRuntimeError(409, "attachment_store_changed", "Registered attachment bytes changed; no native dispatch occurred."); }
      finally { closeSync(fd); }
    }
    const attachment: ChatAttachment = { id, type: mime.startsWith("image/") ? "image" : "file", name, mimeType: mime, sizeBytes: bytes.length };
    registerProviderAttachment(attachment, relative);
    return attachment;
  });
}

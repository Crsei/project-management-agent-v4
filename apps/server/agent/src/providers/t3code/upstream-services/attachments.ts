import { ChatAttachment, isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as Schema from "effect/Schema";
import { providerDataDirectory } from "../../instances.ts";

export function providerAttachmentsDirectory() { return path.join(providerDataDirectory(), "provider-attachments"); }
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
export function resolveRegisteredProviderPath(target: string, attachmentsDir = providerAttachmentsDirectory()): string | null {
  try {
    const root = path.resolve(attachmentsDir);
    if (realpathSync(root) !== root || !inside(root, path.resolve(target))) return null;
    const resolved = realpathSync(target);
    if (!inside(root, resolved) || !statSync(resolved).isFile()) return null;
    return resolved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Trusted upload integration registers a file only after it has been persisted below the private root. */
export function registerProviderAttachment(attachment: ChatAttachment, relativePath: string): void {
  const parsed = Schema.decodeUnknownSync(ChatAttachment)(attachment);
  if (!/^[a-z0-9_-]+$/i.test(parsed.id) || !["image", "file"].includes(parsed.type)
    || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new Error("Invalid Provider attachment.");
  if (parsed.type === "image" && !isProviderSendTurnSupportedImageMimeType(parsed.mimeType)) throw new Error("Unsupported attachment image.");
  const root = providerAttachmentsDirectory();
  const target = resolveRegisteredProviderPath(path.resolve(root, relativePath), root);
  if (!target || statSync(target).size !== parsed.sizeBytes) throw new Error("Attachment is missing or changed.");
  const registry = path.join(root, ".registry");
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  if (lstatSync(registry).isSymbolicLink()) throw new Error("Unsafe attachment registry.");
  const temporary = path.join(registry, "." + randomUUID());
  writeFileSync(temporary, JSON.stringify({ attachment: parsed, relativePath }), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path.join(registry, parsed.id + ".json"));
}
function resolveStoredAttachment(attachmentsDir: string, attachmentId: string): { attachment: ChatAttachment; filePath: string } | null {
  if (!/^[a-z0-9_-]+$/i.test(attachmentId)) return null;
  try {
    const metadata = path.join(attachmentsDir, ".registry", attachmentId + ".json");
    if (resolveRegisteredProviderPath(metadata, attachmentsDir) !== metadata) return null;
    const row: unknown = JSON.parse(readFileSync(metadata, "utf8"));
    if (!row || typeof row !== "object" || !("attachment" in row) || !("relativePath" in row) || typeof row.relativePath !== "string"
      || !Schema.is(ChatAttachment)(row.attachment)) return null;
    const stored = row.attachment;
    if (stored.id !== attachmentId || !["image", "file"].includes(stored.type)
      || stored.type === "image" && !isProviderSendTurnSupportedImageMimeType(stored.mimeType)
      || path.isAbsolute(row.relativePath) || row.relativePath.split(/[\\/]/).includes("..")) return null;
    const filePath = resolveRegisteredProviderPath(path.resolve(attachmentsDir, row.relativePath), attachmentsDir);
    return filePath && statSync(filePath).size === stored.sizeBytes ? { attachment: stored, filePath } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
export function resolveAttachmentPath(input: { readonly attachmentsDir: string; readonly attachment: ChatAttachment }): string | null {
  const { attachment, attachmentsDir } = input;
  const registered = resolveStoredAttachment(attachmentsDir, attachment.id);
  if (!registered) return null;
  const stored = registered.attachment;
  return stored.type === attachment.type && stored.name === attachment.name && stored.mimeType === attachment.mimeType
    && stored.sizeBytes === attachment.sizeBytes ? registered.filePath : null;
}
/** Native snapshot cleanup resolves only an actual, unchanged registered attachment. */
export function resolveAttachmentPathById(input: { readonly attachmentsDir: string; readonly attachmentId: string }): string | null {
  return resolveStoredAttachment(input.attachmentsDir, input.attachmentId)?.filePath ?? null;
}
/** Document sidecars are available only for a currently registered file attachment. */
export function resolveRegisteredDocumentPath(file: string): string | null {
  const root = providerAttachmentsDirectory();
  const resolved = resolveRegisteredProviderPath(file, root);
  if (!resolved) return null;
  let records: string[];
  try { records = readdirSync(path.join(root, ".registry")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  for (const name of records) {
    if (!/^[a-z0-9_-]+\.json$/i.test(name)) continue;
    const registered = resolveStoredAttachment(root, name.slice(0, -5));
    if (registered?.attachment.type === "file" && registered.filePath === resolved) return resolved;
  }
  return null;
}

import type { Entity } from "@contracts"
import { mediaKind, registeredAttachmentMediaType } from "../../markdown/preview-syntax.ts"

export const filePreviewLimit = 8 * 1024 * 1024
export const textPreviewLimit = 256 * 1024
export type FilePreviewKind = "image" | "pdf" | "text" | "unsupported"

/** The registered, authorized version selects the decoder, never a URL or response MIME. */
export function filePreviewPolicy(version: Entity, workspaceId: string, versionId: string): { kind: FilePreviewKind; mediaType: string } {
  const mediaType = (registeredAttachmentMediaType(version, workspaceId, versionId) ?? "").split(";", 1)[0]!.trim()
  const name = typeof version.data.fileName === "string" ? version.data.fileName : ""
  if (/\.(?:html?|xhtml|svgz?|xml|mhtml?|js|mjs|cjs)(?:\s|\.|$)/i.test(name)) return { kind: "unsupported", mediaType }
  const kind = mediaKind(mediaType)
  if (kind === "image" || kind === "pdf") return { kind, mediaType }
  return { kind: ["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json"].includes(mediaType) ? "text" : "unsupported", mediaType }
}

export function matchesPreviewSignature(bytes: Uint8Array, mediaType: string): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  const ascii = (offset: number, value: string) => [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  switch (mediaType) {
    case "image/png": return starts(137, 80, 78, 71, 13, 10, 26, 10)
    case "image/jpeg": return starts(255, 216, 255)
    case "image/gif": return ascii(0, "GIF87a") || ascii(0, "GIF89a")
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP")
    case "image/avif": return ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))
    case "image/bmp": return ascii(0, "BM")
    case "application/pdf": return ascii(0, "%PDF-")
    default: return false
  }
}

export function literalPreviewText(bytes: Uint8Array): string {
  if (bytes.byteLength > textPreviewLimit) throw new Error("text_limit")
  let value: string
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  catch { throw new Error("not_text") }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("not_text")
  return value
}

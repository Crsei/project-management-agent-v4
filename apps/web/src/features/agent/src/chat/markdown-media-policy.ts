/**
 * Security policy for Markdown images.
 *
 * An author-provided image URL is never fetched by the browser. Only a source
 * that resolves to a file inside this session's authorized execution root may
 * be read through the existing same-origin inspector media endpoint, and even
 * then the response MIME type and byte size are enforced again.
 *
 * Everything here is pure so the decision can be tested without a DOM.
 */
import { markdownFileReference } from "./markdown-url.ts";
import { markdownMediaKind } from "./markdown-rich-policy.ts";

/** Keep in sync with the inspector preview limit. */
export const MARKDOWN_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** A data:/blob: copy target larger than this is not worth putting on the clipboard. */
export const MARKDOWN_IMAGE_MAX_COPY_SOURCE = 4096;

/** The image extensions the session media endpoint may answer with. */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif)$/i;

export interface MarkdownImageSession {
  /** Session file access must be granted; without it nothing is auto-loaded. */
  canOpenFiles: boolean;
  executionPath?: string;
  documentPath?: string;
}

export interface MarkdownImageTarget {
  /** Path relative to the execution root, as resolved by `markdownFileReference`. */
  path: string;
  line?: number;
}

export type MarkdownImageFailure = "type" | "size" | "unavailable";

/**
 * Resolves an image source to a session file only when all of these hold:
 * - file access is granted and an execution root exists;
 * - the source is a relative/same-root workspace path, not a URL;
 * - the resolved path stays inside the execution root;
 * - the filename has a supported raster image extension.
 *
 * The extension is a cheap pre-filter, not proof: the response Content-Type is
 * checked again before a blob URL is created.
 */
export function markdownAuthorizedImageSource(
  src: string | undefined,
  session: MarkdownImageSession | null | undefined,
): MarkdownImageTarget | undefined {
  if (!src || !session?.canOpenFiles || !session.executionPath) return undefined;
  const target = markdownFileReference(src, session.executionPath, session.documentPath);
  if (!target || !markdownImageCandidate(target.path)) return undefined;
  return target;
}

/** Raster-only: SVG and other active content never qualify for an inline blob. */
export function markdownImageCandidate(path: string): boolean {
  return IMAGE_EXTENSION.test(path);
}

/** The response must opt into an allow-listed image MIME type. */
export function markdownImageContentTypeAllowed(contentType: string | null | undefined): boolean {
  return markdownMediaKind(contentType ?? "") === "image";
}

/**
 * Enforces the 20 MiB ceiling on both the declared Content-Length and the
 * actual blob size. A missing or malformed header is not a rejection; the
 * blob itself is the final guard.
 */
export function markdownImageWithinSizeLimit(
  contentLength?: string | number | null,
  blobSize?: number,
): boolean {
  const declared = typeof contentLength === "number" ? contentLength : contentLength ? Number(contentLength) : Number.NaN;
  if (Number.isFinite(declared) && declared > MARKDOWN_IMAGE_MAX_BYTES) return false;
  if (typeof blobSize === "number" && Number.isFinite(blobSize) && blobSize > MARKDOWN_IMAGE_MAX_BYTES) return false;
  return true;
}

/**
 * A copy-to-clipboard affordance is the only action offered for URLs we refuse
 * to fetch automatically. It accepts http(s), blob, short data:image payloads
 * and same-origin root paths; anything else is never surfaced.
 */
export function markdownImageCopySource(src: string | undefined): string | undefined {
  const value = src?.trim();
  if (!value || value.length > MARKDOWN_IMAGE_MAX_COPY_SOURCE) return undefined;
  // oxlint-disable-next-line no-control-regex -- a copy target must be one unambiguous token.
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  // Never surface active schemes (javascript:, vbscript:, mailto:, file:) or a
  // bare relative path as an image affordance.
  if (/^https?:/i.test(value) || /^blob:/i.test(value) || /^data:image\//i.test(value)) return value;
  return value.startsWith("/") && !value.startsWith("//") ? value : undefined;
}

/** Wrapping gallery navigation; never returns an out-of-range index. */
export function markdownGalleryIndex(index: number, step: number, length: number): number {
  if (!Number.isFinite(length) || length < 1) return 0;
  const total = Math.trunc(length);
  const current = Number.isFinite(index) ? Math.trunc(index) : 0;
  const delta = Number.isFinite(step) ? Math.trunc(step) : 0;
  return ((current + delta) % total + total) % total;
}

/** Download name for an object URL; the extension is preserved for the OS. */
export function markdownGalleryFileName(path: string): string {
  const name = path.split("/").pop()?.trim();
  return name && name !== "." && name !== ".." ? name : "image";
}

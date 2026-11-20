import type { Attachment } from "@assistant-ui/react";

/**
 * B3 video attachments: first-frame thumbnails from local bytes only.
 *
 * An attachment that only carries a remote or embedded URL keeps the file card:
 * loading it would be an unrequested fetch (remote) or a large silent decode
 * (data URL). No placeholder frame is ever drawn.
 */

export type VideoAttachmentSource = Pick<Attachment, "type" | "contentType" | "file" | "content">;

export function attachmentMediaType(attachment: Pick<Attachment, "contentType" | "file" | "content">): string | undefined {
  if (attachment.contentType) return attachment.contentType;
  if (attachment.file?.type) return attachment.file.type;
  for (const part of attachment.content ?? []) if (part.type === "file" && part.mimeType) return part.mimeType;
  return undefined;
}

export function isVideoAttachment(attachment: VideoAttachmentSource): boolean {
  if (attachment.type === "video") return true;
  return (attachmentMediaType(attachment) ?? "").toLowerCase().startsWith("video/");
}

export type VideoPreviewPlan =
  | { readonly kind: "local-file"; readonly file: Blob }
  | { readonly kind: "deferred"; readonly reason: "remote" | "embedded" }
  | { readonly kind: "unavailable"; readonly reason: "not-video" | "no-source" };

/** Decide what the tile may do without user interaction. */
export function videoPreviewPlan(attachment: VideoAttachmentSource): VideoPreviewPlan {
  if (!isVideoAttachment(attachment)) return { kind: "unavailable", reason: "not-video" };
  const file = attachment.file;
  if (file && typeof Blob !== "undefined" && file instanceof Blob && (!file.type || file.type.toLowerCase().startsWith("video/"))) {
    return { kind: "local-file", file };
  }
  const source = (attachment.content ?? []).flatMap(part => part.type === "file" ? [part.data] : part.type === "image" ? [part.image] : [])[0];
  if (!source) return { kind: "unavailable", reason: "no-source" };
  if (/^(?:data|blob):/iu.test(source)) return { kind: "deferred", reason: "embedded" };
  if (/^https?:/iu.test(source)) return { kind: "deferred", reason: "remote" };
  return { kind: "unavailable", reason: "no-source" };
}

const frames = new WeakMap<Blob, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * Draw the first decodable frame into a 2x backing canvas and return it as a
 * JPEG data URL. Resolution failures return `null` so the tile keeps its file
 * card; the blob identity is memoized so re-renders do not decode again, and
 * captures run one at a time so a multi-video paste does not decode in parallel.
 */
export function captureVideoFirstFrame(file: Blob, options: { size?: number; timeoutMs?: number } = {}): Promise<string | null> {
  const cached = frames.get(file);
  if (cached) return cached;
  const capture = queue.then(() => drawFirstFrame(file, options)).catch(() => null);
  frames.set(file, capture);
  queue = capture;
  return capture;
}

async function drawFirstFrame(file: Blob, options: { size?: number; timeoutMs?: number }): Promise<string | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const size = Math.max(16, Math.round(options.size ?? 64));
  const timeoutMs = options.timeoutMs ?? 5000;
  const source = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = source;
  try {
    await waitForFrame(video, timeoutMs);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = size * 2;
    canvas.height = size * 2;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const scale = Math.max(canvas.width / width, canvas.height / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    context.drawImage(video, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
    return canvas.toDataURL("image/jpeg", 0.72);
  } finally {
    video.pause();
    video.removeAttribute("src");
    URL.revokeObjectURL(source);
    video.load();
    video.remove();
  }
}

function waitForFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    video.removeEventListener("loadeddata", onReady);
    video.removeEventListener("canplay", onReady);
    video.removeEventListener("error", onError);
  };
  const onReady = () => { cleanup(); resolve(); };
  const onError = () => { cleanup(); reject(new Error("The video's first frame could not be decoded.")); };
  timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for the video's first frame.")); }, timeoutMs);
  video.addEventListener("loadeddata", onReady);
  video.addEventListener("canplay", onReady);
  video.addEventListener("error", onError);
  if (video.readyState >= 2) onReady();
  return promise;
}

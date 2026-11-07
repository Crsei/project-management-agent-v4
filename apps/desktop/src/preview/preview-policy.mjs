import { createHash } from "node:crypto";

export const PREVIEW_PARTITION_PREFIX = "persist:pm-preview-";
export const PREVIEW_PARTITION = /^persist:pm-preview-[a-f0-9]{16}$/;
export const PREVIEW_MAX_URL_LENGTH = 2048;

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const WEB_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** A stable partition per workspace origin; preview cookies never share the workspace session. */
export function previewPartition(origin) {
  if (typeof origin !== "string" || origin.length === 0 || origin.length > PREVIEW_MAX_URL_LENGTH)
    throw new Error("A workspace origin is required for the preview session.");
  const digest = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  return `${PREVIEW_PARTITION_PREFIX}${digest}`;
}

export function isPreviewPartition(value) {
  return typeof value === "string" && PREVIEW_PARTITION.test(value);
}

/**
 * Preview navigation is limited to web URLs. Bare loopback hosts default to
 * HTTP; everything else defaults to HTTPS. Credentials are never accepted.
 */
export function normalizePreviewUrl(raw) {
  if (typeof raw !== "string") throw new Error("Enter an http(s) URL.");
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PREVIEW_MAX_URL_LENGTH) throw new Error("Enter an http(s) URL up to 2048 characters.");
  const candidate = WEB_SCHEME.test(trimmed)
    ? trimmed
    : ANY_SCHEME.test(trimmed) && !LOOPBACK.test(trimmed)
      ? null
      : `${LOOPBACK.test(trimmed) ? "http" : "https"}://${trimmed}`;
  if (candidate === null) throw new Error("Only http:// or https:// URLs can be previewed.");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("That URL is not valid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http:// or https:// URLs can be previewed.");
  if (parsed.username || parsed.password) throw new Error("Preview URLs cannot contain credentials.");
  if (parsed.href.length > PREVIEW_MAX_URL_LENGTH) throw new Error("Enter an http(s) URL up to 2048 characters.");
  return parsed.href;
}

export function isAllowedPreviewUrl(value) {
  try {
    normalizePreviewUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function previewTabId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new Error("Invalid preview tab id.");
  return value;
}

export function normalizePreviewRect(value, label = "rect") {
  if (!value || typeof value !== "object") throw new Error(`Invalid ${label}.`);
  const { x, y, width, height } = value;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part)))
    throw new Error(`Invalid ${label}.`);
  if (width <= 0 || height <= 0) throw new Error(`Invalid ${label}.`);
  return { x, y, width, height };
}

/**
 * capturePage returns a 1x NativeImage containing device pixels, so crop uses
 * CSS coordinates scaled by the guest DPR, clamped to the captured image.
 */
export function elementCropRect(rect, dpr, imageSize) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const fullWidth = Number.isFinite(imageSize?.width) ? imageSize.width : 0;
  const fullHeight = Number.isFinite(imageSize?.height) ? imageSize.height : 0;
  const x = Math.max(0, Math.floor(rect.x * scale));
  const y = Math.max(0, Math.floor(rect.y * scale));
  const right = Math.min(fullWidth, Math.ceil((rect.x + rect.width) * scale));
  const bottom = Math.min(fullHeight, Math.ceil((rect.y + rect.height) * scale));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** The PiP page is a local, framed image surface; it has no network access. */
export function pipPageDataUrl() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111}
    body{display:flex;align-items:center;justify-content:center}
    img{width:100%;height:100%;object-fit:contain;display:block}
    button{position:fixed;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:12px;background:rgb(0 0 0 / 55%);color:#fff;font:16px/24px sans-serif;cursor:pointer}
  </style></head><body><img id="frame" alt=""><button id="close" aria-label="Close floating preview" title="Close floating preview">×</button>
  <script>
    document.getElementById('close').addEventListener('click', () => window.previewPictureInPicture.close());
    window.previewPictureInPicture.onFrame((url) => { document.getElementById('frame').src = url; });
  </script></body></html>`;
  return `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

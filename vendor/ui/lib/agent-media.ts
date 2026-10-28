/** Pure media display helpers for caller-owned attachment descriptors.
 * They decide only what the UI may render; reading, uploading and validating
 * files stays with the host.
 */

/** Keep embedded images bounded, matching the workbench resource preview. */
const maxDataImageLength = 8 * 1024 * 1024
/** Raster only: SVG and other vector payloads can carry markup the host never vouched for. */
const rasterDataImage =
  /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,[a-z0-9+/=]+$/i
const scheme = /^[a-z][a-z0-9+\-.]*:/i
const svgReference = /\.svgz?(?:[?#]|$)/i

/** Resolves an image source the UI may display: explicit http(s), a local
 * `blob:` object URL, or a raster `data:` image. URLs carrying credentials and
 * every SVG reference are rejected, so a rejected source never reaches `src`.
 * A scheme-less path stays a same-origin reference to the caller's own host. */
export function safeImageSrc(
  source: string | null | undefined,
): string | undefined {
  if (typeof source !== "string") return undefined
  const src = source.trim().replace(/[\t\n\r]/g, "")
  if (!src) return undefined
  if (src.startsWith("blob:")) return src
  if (src.startsWith("data:"))
    return rasterDataImage.test(src) && src.length <= maxDataImageLength
      ? src
      : undefined
  if (scheme.test(src)) {
    let url: URL
    try {
      url = new URL(src)
    } catch {
      return undefined
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.username || url.password) return undefined
    if (svgReference.test(url.pathname)) return undefined
    return url.href
  }
  if (svgReference.test(src)) return undefined
  return src
}

/** Byte size in B / KB / MB; undefined when the caller did not supply a usable size. */
export function formatAttachmentSize(bytes?: number): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
    return undefined
  const value = Math.round(bytes)
  if (value < 1024) return `${value} B`
  // One decimal keeps the unit readable without hiding the next magnitude.
  if (value < 1024 * 1024) return `${Math.round((value / 1024) * 10) / 10} KB`
  return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`
}

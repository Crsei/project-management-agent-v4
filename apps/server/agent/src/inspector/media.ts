import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { DurableError } from "../durable/errors.ts";
import { InspectorPathError, resolveInsideRoot, IGNORED_DIRECTORIES } from "./paths.ts";
import { resolveInspectorRoot } from "./scope.ts";

export const MEDIA_READ_LIMIT = 20 * 1024 * 1024;
/** Both the extension and a binary signature must agree. SVG/HTML and arbitrary downloads are never served. */
export function safeMediaType(relative: string, bytes: Uint8Array): string | null {
  const extension = path.extname(relative).toLowerCase(), buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (extension === ".png" && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if ([".jpg", ".jpeg"].includes(extension) && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (extension === ".gif" && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
  const riff = buffer.toString("ascii", 0, 4) === "RIFF";
  if (extension === ".webp" && riff && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (extension === ".wav" && riff && buffer.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (extension === ".mp3" && (buffer.toString("ascii", 0, 3) === "ID3" || buffer[0] === 255 && (buffer[1]! & 224) === 224)) return "audio/mpeg";
  if (extension === ".flac" && buffer.toString("ascii", 0, 4) === "fLaC") return "audio/flac";
  if ([".ogg", ".oga", ".ogv"].includes(extension) && buffer.toString("ascii", 0, 4) === "OggS") return extension === ".ogv" ? "video/ogg" : "audio/ogg";
  if (extension === ".webm" && buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return "video/webm";
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (extension === ".avif" && ["avif", "avis"].includes(brand)) return "image/avif";
    if (extension === ".m4a" && ["M4A ", "isom", "mp42"].includes(brand)) return "audio/mp4";
    if ([".mp4", ".m4v"].includes(extension) && ["isom", "iso2", "mp41", "mp42", "M4V ", "avc1"].includes(brand)) return "video/mp4";
  }
  return null;
}
export const mediaRoutes = new Hono().get("/media", async c => {
  try {
    const url = new URL(c.req.url), root = await resolveInspectorRoot(url, c.req.raw.headers);
    const relative = url.searchParams.get("path") ?? "";
    if (!relative || relative.replaceAll("\\", "/").split("/").some(component => component.startsWith(".") || IGNORED_DIRECTORIES[component]))
      throw new DurableError(403, "media_path_forbidden", "媒体预览不读取隐藏目录、元数据或私有文件。");
    const resolved = await resolveInsideRoot(relative, root), canonical = await realpath(resolved.absolute);
    const canonicalRelative = path.relative(root, canonical);
    if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative) ||
        canonicalRelative.split(path.sep).some(component => component.startsWith(".") || IGNORED_DIRECTORIES[component]))
      throw new DurableError(403, "media_path_forbidden", "媒体预览不能通过符号链接读取隐藏目录、元数据或私有文件。");
    const expected = await stat(canonical);
    if (!expected.isFile()) throw new DurableError(400, "not_a_file", "媒体路径必须是普通文件。");
    if (expected.size < 1 || expected.size > MEDIA_READ_LIMIT) throw new DurableError(413, "media_too_large", "媒体预览最多读取 20 MiB。");
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      await resolveInsideRoot(relative, root);
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size)
        throw new DurableError(409, "media_changed", "读取期间媒体文件已改变，请重新预览。");
      bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const final = await handle.stat();
      if (offset !== bytes.length || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || await realpath(resolved.absolute) !== canonical)
        throw new DurableError(409, "media_changed", "读取期间媒体文件已改变，请重新预览。");
    } finally { await handle.close(); }
    const mediaType = safeMediaType(relative, bytes);
    if (!mediaType) throw new DurableError(415, "unsupported_media", "只预览已核验格式的本地图片、音频或视频；不支持 SVG、HTML 或格式不匹配的文件。");
    // Recheck current directory/PM authority after filesystem I/O, before returning any bytes.
    if (await resolveInspectorRoot(url, c.req.raw.headers) !== root) throw new DurableError(409, "execution_binding_changed", "会话目录已变化。");
    return new Response(new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), { headers: { "content-type": mediaType, "content-length": String(bytes.length),
      "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline" } });
  } catch (error) {
    if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof InspectorPathError) return c.json({ error: error.message, code: "invalid_path" }, 400);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "找不到媒体文件。", code: "not_found" }, 404);
    return c.json({ error: "媒体不可读取。", code: "media_unavailable" }, 403);
  }
});

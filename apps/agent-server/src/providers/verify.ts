/** Raw provider bodies/CLI output are never public diagnostics. */
export function sanitizeErrorText(text: string, secret?: string): string {
  let value = text;
  if (secret) value = value.split(secret).join("[redacted]");
  value = value
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:x-api-key|api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[redacted]")
    // oxlint-disable-next-line no-control-regex -- remove raw diagnostic control characters.
    .replace(/[\x00-\x1f\x7f]/g, " ");
  return value.replace(/\s+/g, " ").trim().slice(0, 400);
}

const sensitiveKey =
  /(?:secret|password|passwd|authorization|cookie|apikey|accesstoken|refreshtoken|privatekey|credential)/i
const isSecret = (key: string) =>
  sensitiveKey.test(key.replace(/[-_\s]/g, "")) ||
  /token$/i.test(key.replace(/[-_\s]/g, ""))
export function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /("(?:[^"\\]|\\.)+"\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
      (match, prefix: string) => {
        const key = prefix.match(/^"((?:[^"\\]|\\.)+)"/)?.[1] ?? ""
        return isSecret(key) ? `${prefix}"[REDACTED]"` : match
      },
    )
    .replace(
      /(\b(?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]]+)/gi,
      "$1[REDACTED]",
    )
}
/** Redacts before rendering, previewing, copying or exporting. No HTML is evaluated. */
export function redact(value: unknown): string {
  const seen = new WeakSet<object>()
  function clean(input: unknown): unknown {
    if (typeof input === "string") return redactText(input)
    if (typeof input === "bigint") return String(input)
    if (!input || typeof input !== "object") return input
    if (seen.has(input)) return "[Circular]"
    seen.add(input)
    const result = Array.isArray(input)
      ? input.map(clean)
      : Object.fromEntries(
          Object.entries(input).map(([key, child]) => [
            key,
            isSecret(key) ? "[REDACTED]" : clean(child),
          ]),
        )
    seen.delete(input)
    return result
  }
  if (typeof value === "string") {
    try {
      return JSON.stringify(clean(JSON.parse(value)), null, 2)
    } catch {
      return redactText(value)
    }
  }
  return JSON.stringify(clean(value), null, 2) ?? ""
}
export function previewText(text: string, maxLines = 200, maxBytes = 32768) {
  const lines = text.split("\n")
  const limited = lines.slice(0, maxLines).join("\n")
  const bytes = new TextEncoder().encode(limited)
  return {
    text:
      bytes.length > maxBytes
        ? new TextDecoder().decode(bytes.slice(0, maxBytes), { stream: true })
        : limited,
    truncated: lines.length > maxLines || bytes.length > maxBytes,
  }
}

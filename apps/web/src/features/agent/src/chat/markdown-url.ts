/**
 * Deliberately narrower than Streamdown's wildcard default URL policy.
 *
 * Accepts only fragment links, same-origin absolute paths, and http/https/mailto
 * URLs. Control characters and backslashes are rejected before parsing so a
 * protocol cannot be smuggled through whitespace or an escaped separator.
 */
export function safeMarkdownUrl(url: string): string | undefined {
  const value = url.trim();
  // oxlint-disable-next-line no-control-regex -- reject ambiguous/control-bearing URLs before parsing.
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  if (
    value.startsWith("#") ||
    (value.startsWith("/") && !value.startsWith("//"))
  )
    return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "mailto:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

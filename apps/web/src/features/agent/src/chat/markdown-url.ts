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

export interface MarkdownFileReference {
  /** Relative to the current session's execution root, never a server path. */
  path: string;
  line?: number;
}

/**
 * Markdown is untrusted. Resolving a file reference only prepares an inspector
 * action; the inspector still authorizes and resolves the real file server-side.
 */
export function markdownFileReference(
  url: string,
  executionPath: string,
  documentPath?: string,
): MarkdownFileReference | undefined {
  let value = url.trim();
  // oxlint-disable-next-line no-control-regex -- do not normalize ambiguous paths.
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith("#") || value.startsWith("//")) return undefined;
  if (/^file:/i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname || parsed.search) return undefined;
      value = `${parsed.pathname}${parsed.hash}`;
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/\.[a-z\d]+:\d+(?::\d+)?(?:#.*)?$/i.test(value)) {
    return undefined;
  }
  const hash = value.indexOf("#");
  const fragment = hash < 0 ? "" : value.slice(hash + 1);
  value = hash < 0 ? value : value.slice(0, hash);
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  // oxlint-disable-next-line no-control-regex -- decode before enforcing separators.
  if (!value || /[\u0000-\u001f\u007f\\?]/.test(value) || value.startsWith("//")) return undefined;
  let line: number | undefined;
  const lineFragment = /^L?(\d+)(?::\d+)?(?:-L?\d+(?::\d+)?)?$/i.exec(fragment);
  const lineSuffix = /:(\d+)(?::\d+)?$/.exec(value);
  const rawLine = lineFragment?.[1] ?? lineSuffix?.[1];
  if (lineSuffix) value = value.slice(0, -lineSuffix[0].length);
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return undefined;
  if (rawLine) {
    line = Number(rawLine);
    if (!Number.isSafeInteger(line) || line < 1) return undefined;
  }
  const normalize = (path: string): string | undefined => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return undefined;
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return parts.join("/");
  };
  if (!executionPath.startsWith("/")) return undefined;
  const root = normalize(executionPath);
  if (root === undefined) return undefined;
  let relative = value;
  if (!value.startsWith("/") && documentPath !== undefined) {
    // This is an authorized file path, not another URL. Do not decode it or let
    // a malformed base silently fall back to a different root-level document.
    // oxlint-disable-next-line no-control-regex -- enforce an unambiguous root-relative base.
    if (!documentPath || documentPath.startsWith("/") || /[\u0000-\u001f\u007f\\?#]/.test(documentPath) || /^[a-z][a-z\d+.-]*:/i.test(documentPath)) return undefined;
    const document = normalize(documentPath);
    if (!document) return undefined;
    const slash = document.lastIndexOf("/");
    if (slash >= 0) relative = `${document.slice(0, slash + 1)}${value}`;
  }
  let path = normalize(relative);
  if (!path) return undefined;
  if (value.startsWith("/")) {
    if (root && !path.startsWith(`${root}/`)) return undefined;
    path = root ? path.slice(root.length + 1) : path;
  }
  return path ? { path, ...(line === undefined ? {} : { line }) } : undefined;
}

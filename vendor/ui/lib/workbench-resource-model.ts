import type { ChangedFile, ContextReference } from "./agent-workbench-model"
import type { DataState } from "./runtime-status"
import { redactText, previewText } from "./redact"

/** A host-owned read snapshot. Identity includes scope AND revision; names never select renderers. */
export type ResourceIdentity = {
  projectId: string
  sessionId: string
  resourceId: string
  revision: string
}
export type ResourceSnapshot = ResourceIdentity & {
  name: string
  path: string
  mediaType: string
  renderer:
    | "text"
    | "markdown"
    | "image"
    | "json"
    | "csv"
    | "html"
    | "svg"
    | "diff"
    | "unsupported"
  availability: "available" | "denied" | "missing" | "unknown"
  dataState: DataState
  reason?: string
  updatedAt?: string
  size?: number
  /** Source has already granted access. A bounded preview must not imply complete content. */
  text?: string
  complete?: boolean
  image?: {
    src: string
    alt: string
    width?: number
    height?: number
    animated?: boolean
  }
  diff?: ChangedFile
  source?: {
    messageId?: string
    toolCallId?: string
    artifactId?: string
    label: string
  }
  context?: ContextReference
  /** Explicit host capability. Returning bytes is distinct from the rendered preview. */
  download?: () => Blob | Promise<Blob>
}
export type OpenResourceRequest = ResourceIdentity & {
  range?: { start: number; end: number }
}
export function resourceKey(resource: ResourceIdentity) {
  return JSON.stringify([
    resource.projectId,
    resource.sessionId,
    resource.resourceId,
    resource.revision,
  ])
}
export function resourceMatches(a: ResourceIdentity, b: ResourceIdentity) {
  return resourceKey(a) === resourceKey(b)
}
export type WorkbenchDocument = {
  resource: ResourceSnapshot
  pinned: boolean
  range?: OpenResourceRequest["range"]
}
export type WorkbenchDocuments = {
  documents: WorkbenchDocument[]
  activeKey?: string
}
export function openDocument(
  state: WorkbenchDocuments,
  resource: ResourceSnapshot,
  pinned = false,
  range?: OpenResourceRequest["range"],
): WorkbenchDocuments {
  const key = resourceKey(resource)
  const existing = state.documents.find((d) => resourceKey(d.resource) === key)
  if (existing)
    return {
      documents: state.documents.map((d) =>
        d === existing
          ? { ...d, resource, pinned: d.pinned || pinned, range }
          : d,
      ),
      activeKey: key,
    }
  // Only the transient preview may be replaced. Older pinned revisions remain visible.
  return {
    documents: [
      ...state.documents.filter((d) => d.pinned),
      { resource, pinned, range },
    ],
    activeKey: key,
  }
}
export function closeDocument(
  state: WorkbenchDocuments,
  key: string,
): WorkbenchDocuments {
  const index = state.documents.findIndex(
    (d) => resourceKey(d.resource) === key,
  )
  const documents = state.documents.filter(
    (d) => resourceKey(d.resource) !== key,
  )
  return {
    documents,
    activeKey:
      state.activeKey === key
        ? documents[Math.min(Math.max(0, index), documents.length - 1)]
          ? resourceKey(
              documents[Math.min(Math.max(0, index), documents.length - 1)]
                .resource,
            )
          : undefined
        : state.activeKey,
  }
}
/** Read guards discard late results; same-resource refresh errors retain the previous readable body. */
export function acceptResourceRead(
  request: ResourceIdentity,
  result: ResourceSnapshot,
  previous?: ResourceSnapshot,
) {
  if (!resourceMatches(request, result)) return previous
  if (
    result.availability === "available" &&
    result.dataState === "error" &&
    previous &&
    resourceMatches(previous, result)
  )
    return {
      ...previous,
      dataState: result.dataState,
      reason: result.reason,
      updatedAt: previous.updatedAt,
    }
  return result
}
export function resourceText(resource: ResourceSnapshot) {
  const lines = redactText(resource.text ?? "").split("\n")
  const bound = previewText(
    lines
      .slice(0, 1000)
      .map((line) => line.slice(0, 8192))
      .join("\n"),
    1000,
    resource.renderer === "markdown"
      ? 32768
      : ["json", "csv"].includes(resource.renderer)
        ? 65536
        : 262144,
  )
  return {
    text: bound.text,
    truncated:
      bound.truncated ||
      !resource.complete ||
      lines.length > 1000 ||
      lines.some((line) => line.length > 8192),
  }
}
/** Quote-aware CSV parser with hard source/cell/row bounds. No formulas or HTML are evaluated. */
export function parseResourceCsv(text: string, maximumRows = 100) {
  const bounded = previewText(redactText(text), 1000, 65536)
  const rows: string[][] = [],
    row: string[] = []
  let cell = "",
    quoted = false,
    truncated = bounded.truncated
  for (let i = 0; i < bounded.text.length; i++) {
    const c = bounded.text[i]
    if (c === '"') {
      if (quoted && bounded.text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(cell.slice(0, 8192))
      cell = ""
      if (row.length > 64)
        return { rows, error: "column-limit", truncated: true }
      if (c === "\n") {
        rows.push([...row])
        row.length = 0
        if (rows.length >= maximumRows + 1) {
          truncated ||= i < bounded.text.length - 1
          break
        }
      }
    } else if (c !== "\r") cell += c
  }
  if (quoted) return { rows, error: "unclosed-quote", truncated }
  if (row.length || cell) {
    row.push(cell.slice(0, 8192))
    if (row.length > 64) return { rows, error: "column-limit", truncated: true }
    rows.push(row)
  }
  const width = rows[0]?.length ?? 0
  return {
    rows: rows.slice(0, maximumRows + 1),
    error: rows.some((r) => r.length !== width) ? "column-count" : undefined,
    truncated: truncated || rows.length > maximumRows + 1,
  }
}
/** Copy the same bounded fragment the renderer shows, independently of source download bytes. */
export function resourceCopyText(resource: ResourceSnapshot) {
  if (resource.availability !== "available") return ""
  if (resource.renderer === "diff" && resource.diff)
    return resource.diff.lines.slice(0, 1000).map((line) =>
      `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${redactText(line.text).slice(0, 8192)}`,
    ).join("\n")
  const bounded = resourceText(resource).text
  if (resource.renderer === "json") {
    try { return resourceText({ ...resource, renderer: "text", text: JSON.stringify(JSON.parse(bounded), null, 2) }).text } catch { return bounded }
  }
  if (resource.renderer === "csv") {
    const parsed = parseResourceCsv(bounded)
    if (!parsed.error) return parsed.rows.map((row) => row.map((cell) =>
      /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell,
    ).join(",")).join("\n")
  }
  return bounded
}
/** Images are inert raster sources; SVG/HTML use text. Host URLs require an explicit allowed origin. */
export function safeResourceImage(
  src: string,
  allowedOrigins: readonly string[] = [],
) {
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(src))
    return src.length <= 8 * 1024 * 1024 ? src : undefined
  try {
    const url = new URL(src)
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      allowedOrigins.includes(url.origin)
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}
export type CommandRecord = {
  commandId: string
  sessionId: string
  runId: string
  toolCallId?: string
  messageId?: string
  resourceIds?: string[]
  command: string
  cwd: string
  status: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  exitCode?: number
  outcome: "known" | "unknown"
  connection: "connected" | "disconnected" | "unknown"
  output: {
    text: string
    source: string
    timestamp: string
    truncated?: boolean
  }
}

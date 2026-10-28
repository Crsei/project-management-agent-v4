export type ResourceLanguage =
  | "text"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "json"
  | "css"
  | "html"
  | "markdown"

export interface WorkbenchFile {
  fileId: string
  path: string
  content?: string
  language?: ResourceLanguage
}

export interface WorkbenchResource {
  projectId: string
  sessionId: string
  resourceId: string
  revision: string
  name: string
  path?: string
  text?: string
  renderer: "text" | "image" | "pdf" | "audio" | "video" | "unsupported"
  mediaType?: string
  availability: "available" | "unavailable" | "expired" | "forbidden"
  dataState: "loading" | "empty" | "partial" | "error" | "success"
  complete: boolean
  source?: { messageId?: string; artifactId?: string; label?: string }
}

export interface WorkbenchDocument {
  resource: WorkbenchResource
  pinned: boolean
}
export interface WorkbenchDocuments {
  documents: WorkbenchDocument[]
  activeKey?: string
}

/** The identity includes revision; delimiters inside identifiers cannot collide. */
export function neutralResourceKey(
  resource: Pick<
    WorkbenchResource,
    "projectId" | "sessionId" | "resourceId" | "revision"
  >,
): string {
  return JSON.stringify([
    resource.projectId,
    resource.sessionId,
    resource.resourceId,
    resource.revision,
  ])
}

export function openResourceDocument(
  state: WorkbenchDocuments,
  resource: WorkbenchResource,
  pinned = false,
): WorkbenchDocuments {
  const key = neutralResourceKey(resource)
  const found = state.documents.find(
    (document) => neutralResourceKey(document.resource) === key,
  )
  if (found)
    return {
      documents: state.documents.map((document) =>
        document === found
          ? { resource, pinned: document.pinned || pinned }
          : document,
      ),
      activeKey: key,
    }
  return {
    documents: [
      ...state.documents.filter((document) => document.pinned),
      { resource, pinned },
    ],
    activeKey: key,
  }
}

export function closeResourceDocument(
  state: WorkbenchDocuments,
  key: string,
): WorkbenchDocuments {
  const index = state.documents.findIndex(
    (document) => neutralResourceKey(document.resource) === key,
  )
  if (index < 0) return state
  const documents = state.documents.filter((_, position) => position !== index)
  return {
    documents,
    activeKey:
      state.activeKey === key
        ? documents[Math.min(index, documents.length - 1)]
          ? neutralResourceKey(
              documents[Math.min(index, documents.length - 1)].resource,
            )
          : undefined
        : state.activeKey,
  }
}

export interface ChangeLine {
  id: string
  kind: "context" | "add" | "remove"
  text: string
  oldLine?: number
  newLine?: number
}
export interface ChangedFile extends WorkbenchFile {
  kind: "added" | "modified" | "deleted" | "renamed"
  previousPath?: string
  /** A complete base snapshot. Absence never implies an unchanged head. */
  baseContent?: string
  /** Explicitly declares that lines represent both complete documents, not a hunk. */
  linesComplete?: boolean
  lines: ChangeLine[]
  patch?: string
}
export interface ChangeSet {
  repositoryId: string
  scope: string
  base: string
  head: string
  revision: string
  files: ChangedFile[]
}
export interface ReviewComment {
  id: string
  scopeId: string
  fileId: string
  revision: string
  lineId?: string
  side: "base" | "head" | "file"
  line?: number
  text: string
  resolved: boolean
}

export interface DiffDocuments {
  base: string
  head: string
  complete: boolean
}

export function resolveDiffDocuments(file: ChangedFile): DiffDocuments {
  if (file.baseContent !== undefined && file.content !== undefined)
    return { base: file.baseContent, head: file.content, complete: true }
  if (file.kind === "added" && file.content !== undefined)
    return { base: "", head: file.content, complete: true }
  if (file.kind === "deleted" && file.baseContent !== undefined)
    return { base: file.baseContent, head: "", complete: true }
  if (file.linesComplete)
    return {
      base: file.lines
        .filter((line) => line.kind !== "add")
        .map((line) => line.text)
        .join("\n"),
      head: file.lines
        .filter((line) => line.kind !== "remove")
        .map((line) => line.text)
        .join("\n"),
      complete: true,
    }
  return { base: "", head: "", complete: false }
}

export function inferResourceLanguage(path = ""): ResourceLanguage {
  const extension = path.toLowerCase().split(".").pop()
  switch (extension) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript"
    case "jsx":
      return "jsx"
    case "ts":
    case "mts":
    case "cts":
      return "typescript"
    case "tsx":
      return "tsx"
    case "json":
      return "json"
    case "css":
      return "css"
    case "html":
    case "htm":
      return "html"
    case "md":
    case "mdx":
      return "markdown"
    default:
      return "text"
  }
}

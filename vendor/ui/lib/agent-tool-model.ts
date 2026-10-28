import type {
  WorkbenchTool,
  ChangedFile,
  ChangeLine,
} from "./agent-workbench-model"
import type {
  ToolDisplay,
  ToolKind,
  ToolTask,
  ToolSearchResult,
} from "./agent-elements-model"
import type { DataState } from "./runtime-status"

/**
 * Minimal tool-part shapes accepted by `normalizeToolCall`. Either a full
 * `WorkbenchTool` (already host-shaped) or an AI-SDK-style part using
 * `toolCallId` / `toolName` / `type=tool-NAME` with `state` / `input` /
 * `output` / `errorText`. No SDK type is imported; this is a structural
 * contract only.
 */
export type ToolPartSource = {
  id?: string
  toolCallId?: string
  name?: string
  toolName?: string
  type?: string
  status?: string
  state?: string
  arguments?: unknown
  input?: unknown
  output?: unknown
  error?: string
  errorText?: string
  target?: string
  duration?: string
  exitCode?: number
  outputTruncated?: boolean
  outcome?: "known" | "unknown"
  fileIds?: string[]
  changeRevision?: string
  startedAt?: string
  parentId?: string
  revision?: string
  receipt?: string
  detailsState?: DataState
  display?: ToolDisplay
}

/** Runtime status vocabulary shared with RuntimeStatusBadge; unknown values pass through verbatim. */
const stateAliases: Record<string, string> = {
  "input-streaming": "running",
  streaming: "running",
  call: "running",
  "partial-call": "running",
  "output-available": "completed",
  result: "completed",
  "output-error": "failed",
  error: "failed",
  "permission-requested": "waiting",
}

function resolveStatus(source: ToolPartSource): string {
  const raw = source.status ?? source.state
  if (raw === undefined || raw === "") return "unknown"
  return stateAliases[raw] ?? raw
}

function resolveName(source: ToolPartSource): string {
  const explicit = source.name ?? source.toolName
  if (explicit) return explicit
  const type = source.type
  if (!type) return ""
  return type.startsWith("tool-") ? type.slice(5) : type
}

/**
 * Adapt a host tool record or a minimal tool part into a `WorkbenchTool`.
 * The original tool name, status, errors, partial-output and unknown outcome
 * are preserved verbatim; nothing is replayed or re-derived.
 */
export function normalizeToolCall(source: ToolPartSource): WorkbenchTool {
  const tool: WorkbenchTool = {
    id: source.id ?? source.toolCallId ?? "",
    name: resolveName(source),
    status: resolveStatus(source),
  }
  const args = source.arguments !== undefined ? source.arguments : source.input
  const error = source.error !== undefined ? source.error : source.errorText
  if (args !== undefined) tool.arguments = args
  if (source.output !== undefined) tool.output = source.output
  if (error !== undefined) tool.error = error
  if (source.target !== undefined) tool.target = source.target
  if (source.duration !== undefined) tool.duration = source.duration
  if (source.exitCode !== undefined) tool.exitCode = source.exitCode
  if (source.outputTruncated !== undefined)
    tool.outputTruncated = source.outputTruncated
  if (source.outcome !== undefined) tool.outcome = source.outcome
  if (source.fileIds !== undefined) tool.fileIds = source.fileIds
  if (source.changeRevision !== undefined)
    tool.changeRevision = source.changeRevision
  if (source.startedAt !== undefined) tool.startedAt = source.startedAt
  if (source.parentId !== undefined) tool.parentId = source.parentId
  if (source.revision !== undefined) tool.revision = source.revision
  if (source.receipt !== undefined) tool.receipt = source.receipt
  if (source.detailsState !== undefined) tool.detailsState = source.detailsState
  if (source.display !== undefined) tool.display = source.display
  return tool
}

/** Known tool-name aliases matched case/format-insensitively when no explicit display is supplied. */
const nameKindAliases: Record<string, ToolKind> = {}
function alias(names: readonly string[], kind: ToolKind) {
  for (const name of names) nameKindAliases[name] = kind
}
alias(
  [
    "bash",
    "terminal",
    "shell",
    "exec",
    "executecommand",
    "runcommand",
    "bashcommand",
    "runterminalcommand",
  ],
  "bash",
)
alias(
  [
    "edit",
    "write",
    "strreplace",
    "strreplaceeditor",
    "strreplacefile",
    "applypatch",
    "applydiff",
    "multiedit",
    "patch",
    "createfile",
    "updatefile",
    "fileedit",
    "savefile",
    "writetofile",
    "newfile",
  ],
  "edit",
)
alias(
  [
    "search",
    "grep",
    "glob",
    "websearch",
    "webfetch",
    "codebasesearch",
    "semanticsearch",
    "find",
    "findinfiles",
    "ripgrep",
    "rg",
  ],
  "search",
)
alias(
  [
    "todo",
    "todowrite",
    "todoread",
    "taskcreate",
    "taskupdate",
    "tasklist",
    "checklist",
    "managetasks",
    "updatetodo",
  ],
  "todo",
)
alias(
  [
    "plan",
    "createplan",
    "updateplan",
    "plannode",
    "planning",
    "exitplanmode",
    "writeplan",
    "proposal",
  ],
  "plan",
)
alias(
  [
    "subagent",
    "agent",
    "spawnagent",
    "dispatchagent",
    "delegatetask",
    "generalagent",
    "taskagent",
    "childagent",
  ],
  "subagent",
)
alias(
  [
    "think",
    "thinking",
    "reflection",
    "reasoning",
    "contemplation",
    "chainofthought",
    "scratchpad",
  ],
  "thinking",
)

/** MCP tools carry a `mcp__server__tool` (or `mcp-server`) name rather than an alias. */
export function isMcpToolName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.startsWith("mcp__") ||
    lower.startsWith("mcp-") ||
    lower.startsWith("tool-mcp__")
  )
}

/** Explicit source display wins; otherwise a known name alias; otherwise generic. */
export function routeToolCall(call: WorkbenchTool): ToolKind {
  if (call.display?.kind) return call.display.kind
  const name = call.name ?? ""
  if (isMcpToolName(name)) return "mcp"
  return nameKindAliases[name.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? "generic"
}

/* ---------------- Todo delta (stable-ID comparison) ---------------- */

export type TodoChange = {
  id: string
  title: string
  from: string
  to: string
}

export type TodoDelta = {
  created: ToolTask[]
  removed: ToolTask[]
  changed: TodoChange[]
  unchangedCount: number
}

/**
 * Compare two todo lists by stable id. A missing `previous` means the source
 * supplied no baseline, so every current item counts as a creation rather than
 * an invented status transition.
 */
export function diffTodos(
  previous: readonly ToolTask[] | undefined,
  items: readonly ToolTask[],
): TodoDelta {
  const before = new Map((previous ?? []).map((task) => [task.id, task]))
  const after = new Map(items.map((task) => [task.id, task]))
  const created: ToolTask[] = []
  const removed: ToolTask[] = []
  const changed: TodoChange[] = []
  let unchangedCount = 0
  for (const task of items) {
    const prior = before.get(task.id)
    if (!prior) created.push(task)
    else if (prior.status !== task.status)
      changed.push({
        id: task.id,
        title: task.title,
        from: prior.status,
        to: task.status,
      })
    else unchangedCount += 1
  }
  for (const task of previous ?? [])
    if (!after.has(task.id)) removed.push(task)
  return { created, removed, changed, unchangedCount }
}

/* ---------------- Edit diff (real LCS, truthful bounds) ---------------- */

const MAX_DIFF_LINES = 1000
const MAX_LCS_CELLS = 1_000_000

function fallbackDiff(oldLines: string[], newLines: string[]): ChangeLine[] {
  const lines: ChangeLine[] = []
  oldLines.forEach((text, index) =>
    lines.push({
      id: `d${index}`,
      kind: "remove",
      text,
      oldLine: index + 1,
    }),
  )
  newLines.forEach((text, index) =>
    lines.push({ id: `d${index}`, kind: "add", text, newLine: index + 1 }),
  )
  return lines
}

function lcsDiff(oldLines: string[], newLines: string[]): ChangeLine[] {
  const m = oldLines.length
  const n = newLines.length
  if (m * n > MAX_LCS_CELLS) return fallbackDiff(oldLines, newLines)
  const table: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  )
  for (let i = m - 1; i >= 0; i -= 1)
    for (let j = n - 1; j >= 0; j -= 1)
      table[i][j] =
        oldLines[i] === newLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
  const lines: ChangeLine[] = []
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      lines.push({
        id: `c${i}`,
        kind: "context",
        text: oldLines[i],
        oldLine: oldNo,
        newLine: newNo,
      })
      i += 1
      j += 1
      oldNo += 1
      newNo += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({
        id: `r${i}`,
        kind: "remove",
        text: oldLines[i],
        oldLine: oldNo,
      })
      i += 1
      oldNo += 1
    } else {
      lines.push({ id: `a${j}`, kind: "add", text: newLines[j], newLine: newNo })
      j += 1
      newNo += 1
    }
  }
  while (i < m) {
    lines.push({
      id: `r${i}`,
      kind: "remove",
      text: oldLines[i],
      oldLine: oldNo,
    })
    i += 1
    oldNo += 1
  }
  while (j < n) {
    lines.push({ id: `a${j}`, kind: "add", text: newLines[j], newLine: newNo })
    j += 1
    newNo += 1
  }
  return lines
}

/**
 * Build a `ChangedFile` for DiffViewer from explicit before/after text. Line
 * numbers are truthful and the result is bounded; `truncated` reports when the
 * source exceeded the cap so callers never invent +/− counts.
 */
export function buildEditDiff(
  path: string,
  before: string,
  after: string,
  revision?: string,
): ChangedFile {
  const oldLines = before.split("\n")
  const newLines = after.split("\n")
  const all = lcsDiff(oldLines, newLines)
  const truncated = all.length > MAX_DIFF_LINES
  const kind: ChangedFile["kind"] =
    oldLines.length === 0 || (before === "" && after !== "")
      ? "added"
      : newLines.length === 0 || (after === "" && before !== "")
        ? "deleted"
        : "modified"
  return {
    fileId: revision ?? path,
    path,
    kind,
    lines: truncated ? all.slice(0, MAX_DIFF_LINES) : all,
    truncated,
  }
}

/* ---------------- MCP content unwrap ---------------- */

export type McpUnwrapped = {
  recognized: boolean
  text?: string
  json?: unknown
}

type McpBlock = { type?: unknown; text?: unknown }

function collectTextBlocks(blocks: readonly McpBlock[]): string | undefined {
  const parts = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
  return parts.length > 0 ? parts.join("\n") : undefined
}

/**
 * Unwrap MCP tool results into displayable text or JSON. Recognized wrappers
 * (Anthropic `content` blocks, `{ result }`, `{ output }`, `{ output_text }`,
 * structured JSON strings) are unwrapped; anything else stays unrecognized so
 * callers keep the generic display instead of guessing.
 */
export function unwrapMcpContent(content: unknown): McpUnwrapped {
  if (content === undefined || content === null) return { recognized: false }
  if (typeof content === "string") {
    const trimmed = content.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        return { recognized: true, json: parsed }
      } catch {
        return { recognized: true, text: content }
      }
    }
    return { recognized: true, text: content }
  }
  if (Array.isArray(content)) {
    const text = collectTextBlocks(content as McpBlock[])
    return text === undefined
      ? { recognized: true, json: content }
      : { recognized: true, text }
  }
  if (typeof content === "object") {
    const record = content as Record<string, unknown>
    if (Array.isArray(record.content)) {
      const text = collectTextBlocks(record.content as McpBlock[])
      if (text !== undefined) return { recognized: true, text }
    }
    if (typeof record.output_text === "string")
      return { recognized: true, text: record.output_text }
    if (typeof record.text === "string")
      return { recognized: true, text: record.text }
    for (const key of ["result", "output"] as const) {
      const nested = record[key]
      if (nested !== undefined && nested !== null && nested !== content)
        return unwrapMcpContent(nested)
    }
    return { recognized: true, json: record }
  }
  return { recognized: true, text: String(content) }
}

/* ---------------- Small display helpers ---------------- */

/** Normalize arbitrary search-result payloads into the shared descriptor, dropping malformed rows. */
export function normalizeSearchResults(
  value: unknown,
): ToolSearchResult[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const record = row as Record<string, unknown>
    const title = typeof record.title === "string" ? record.title : undefined
    if (!title) return []
    const result: ToolSearchResult = {
      id:
        typeof record.id === "string"
          ? record.id
          : typeof record.url === "string"
            ? record.url
            : title,
      title,
      source:
        typeof record.source === "string"
          ? record.source
          : typeof record.url === "string"
            ? record.url
            : "",
    }
    if (typeof record.date === "string") result.date = record.date
    if (typeof record.href === "string") result.href = record.href
    else if (typeof record.url === "string") result.href = record.url
    return [result]
  })
}

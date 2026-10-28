/**
 * Pure helpers for tool relationship views (tool group, subagent, thinking).
 *
 * These functions only read source-provided fields (`display`, `name`, `parentId`,
 * `startedAt`, `status`, `outcome`, `error`, `duration`). They never mutate a tool
 * record and never infer completion, approval, or success from elapsed time.
 */
import type { WorkbenchTool } from "./agent-workbench-model"

export type ToolCategory = "files" | "searches" | "commands" | "other"
export type ToolCategoryCounts = Record<ToolCategory, number>

/** Stable display order for category summaries. */
export const toolCategories = [
  "files",
  "searches",
  "commands",
  "other",
] as const satisfies readonly ToolCategory[]

const fileToolNames: Record<string, true> = {
  read: true,
  readfile: true,
  openfile: true,
  edit: true,
  editfile: true,
  multiedit: true,
  write: true,
  writefile: true,
  createfile: true,
  deletefile: true,
  updatefile: true,
  patch: true,
  applypatch: true,
  notebookedit: true,
  view: true,
  save: true,
  file: true,
  files: true,
}

const searchToolNames: Record<string, true> = {
  search: true,
  grep: true,
  glob: true,
  find: true,
  ls: true,
  list: true,
  listdir: true,
  websearch: true,
  webfetch: true,
  codebasesearch: true,
}

const commandToolNames: Record<string, true> = {
  bash: true,
  shell: true,
  sh: true,
  run: true,
  runcmd: true,
  runcommand: true,
  exec: true,
  execute: true,
  executecommand: true,
  terminal: true,
  powershell: true,
  cmd: true,
  subprocess: true,
  spawn: true,
}

function normalizedToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^tool[-_.\s]/, "")
    .replace(/[^a-z0-9]/g, "")
}

/** Category comes from explicit display first, then from the source tool name. */
export function toolCategory(tool: WorkbenchTool): ToolCategory {
  const kind = tool.display?.kind
  if (kind === "edit") return "files"
  if (kind === "search") return "searches"
  if (kind === "bash") return "commands"
  if (kind !== undefined && kind !== "generic") return "other"

  const name = normalizedToolName(tool.name)
  if (Object.hasOwn(fileToolNames, name)) return "files"
  if (Object.hasOwn(searchToolNames, name)) return "searches"
  if (Object.hasOwn(commandToolNames, name)) return "commands"
  return "other"
}

export type ToolAttentionMarker = {
  /** Tool status, or `failed` when a source error is present. */
  status: string
  count: number
}

export type ToolRelationshipSummary = {
  total: number
  counts: ToolCategoryCounts
  /**
   * Child statuses that differ from the caller-displayed status, so a caption
   * never conceals failed, waiting, running, or cancelled children.
   */
  attention: readonly ToolAttentionMarker[]
  /** Children whose outcome the source marks as unknown. */
  unknown: number
}

function attentionOrder(status: string): number {
  if (status === "failed") return 0
  if (status === "waiting" || status === "paused") return 1
  return 2
}

export function summarizeToolRelationships(
  tools: readonly WorkbenchTool[],
  displayedStatus?: string,
): ToolRelationshipSummary {
  const counts: ToolCategoryCounts = {
    files: 0,
    searches: 0,
    commands: 0,
    other: 0,
  }
  const statusCounts = new Map<string, number>()
  let unknown = 0
  for (const tool of tools) {
    counts[toolCategory(tool)] += 1
    if (tool.outcome === "unknown") unknown += 1
    const failed = tool.status === "failed" || Boolean(tool.error)
    const status = failed ? "failed" : tool.status
    if (!status || status === "completed") continue
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
  }
  const explicit = displayedStatus?.trim() || undefined
  const attention = [...statusCounts]
    .filter(([status]) => status !== explicit)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => attentionOrder(a.status) - attentionOrder(b.status))
  return { total: tools.length, counts, attention, unknown }
}

const terminalToolStatuses: Record<string, true> = {
  completed: true,
  failed: true,
  cancelled: true,
  interrupted: true,
}

/** Terminal statuses stop the source clock; every other status keeps it running. */
export function toolStatusIsActive(status: string): boolean {
  const value = status.trim()
  return value !== "" && !Object.hasOwn(terminalToolStatuses, value)
}

/**
 * Whether the source clock should tick. A caller-provided status wins; without
 * one, any non-terminal child keeps the relationship active.
 */
export function relationshipIsActive(
  displayedStatus: string | undefined,
  tools: readonly WorkbenchTool[],
): boolean {
  const explicit = displayedStatus?.trim()
  if (explicit) return toolStatusIsActive(explicit)
  return tools.some((tool) => toolStatusIsActive(tool.status))
}

export type ToolHierarchy = {
  /** Direct children, selected by the source `parentId` association. */
  children: WorkbenchTool[]
  /** Every reachable descendant in breadth-first source order. */
  descendants: WorkbenchTool[]
  /** True when the source hierarchy contains a cycle; descendants are then partial. */
  cyclic: boolean
}

/**
 * Collect nested tools by explicit `parentId`. The visited set bounds traversal
 * on malformed source data (self-parenting or a parent/child cycle).
 */
export function subagentHierarchy(
  call: WorkbenchTool,
  tools: readonly WorkbenchTool[],
): ToolHierarchy {
  const byParent = new Map<string, WorkbenchTool[]>()
  for (const tool of tools) {
    if (!tool.parentId) continue
    const bucket = byParent.get(tool.parentId)
    if (bucket) bucket.push(tool)
    else byParent.set(tool.parentId, [tool])
  }
  // A tool that claims itself as a child is a cycle, never a legitimate child.
  const rawChildren = byParent.get(call.id) ?? []
  const children = rawChildren.filter((tool) => tool.id !== call.id)
  const visited = new Set<string>([call.id])
  const descendants: WorkbenchTool[] = []
  let cyclic = false
  let queue = rawChildren
  while (queue.length > 0) {
    const next: WorkbenchTool[] = []
    for (const tool of queue) {
      if (visited.has(tool.id)) {
        cyclic = true
        continue
      }
      visited.add(tool.id)
      descendants.push(tool)
      const nested = byParent.get(tool.id)
      if (nested) next.push(...nested)
    }
    queue = next
  }
  return { children, descendants, cyclic }
}

/** Last still-running descendant, otherwise the last descendant in source order. */
export function currentActivityTool(
  descendants: readonly WorkbenchTool[],
): WorkbenchTool | undefined {
  for (let index = descendants.length - 1; index >= 0; index -= 1) {
    const tool = descendants[index]
    if (toolStatusIsActive(tool.status)) return tool
  }
  return descendants.length > 0
    ? descendants[descendants.length - 1]
    : undefined
}

/** Parse a source-provided timestamp (ISO string or epoch) without guessing. */
export function parseSourceTimestamp(value?: string): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) {
    // Ten digits are epoch seconds; longer digit runs are epoch milliseconds.
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return undefined
    return trimmed.length <= 10 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const total = Math.floor(ms / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

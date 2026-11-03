import { z } from "zod"
import { parseMarkdown, patchMarkdown } from "../../../../../../packages/pm-markdown/index.ts"
import { MAX_WORK_ITEM_ESTIMATE_POINTS, ProtocolError, validateTransition, type FileRecord, type ProtocolConfiguration, type WorkspaceSnapshot } from "../../../../../../packages/pm-schema/index.ts"
import { validateRelations } from "../../../../../../packages/pm-schema/relations.ts"
import { hasUncertainDocumentSave } from "../markdown/document-save-model.ts"

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}, "Expected a valid calendar date")
export const projectTaskChangesSchema = z.object({
  title: z.string().optional(),
  status: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable().optional(),
  assignee: z.string().nullable().optional(),
  "x-pm-start": calendarDate.nullable().optional(),
  "x-pm-estimate": z.number().finite().min(0).max(MAX_WORK_ITEM_ESTIMATE_POINTS).nullable().optional(),
  due: calendarDate.nullable().optional(),
}).strict()
export type ProjectTaskChanges = z.infer<typeof projectTaskChangesSchema>
export type ProjectTaskField = keyof ProjectTaskChanges
export type ProjectTaskDraftPhase = "editing" | "rejected" | "conflict" | "unknown" | "observed"
export type ProjectTaskDraft = {
  projectId: string
  baseRaw: string
  revision: string
  changes: ProjectTaskChanges
  phase: ProjectTaskDraftPhase
  message: string
}
const backupSchema = z.object({
  projectId: z.string().min(1), baseRaw: z.string(), revision: z.string().min(1),
  changes: projectTaskChangesSchema,
  phase: z.enum(["editing", "rejected", "conflict", "unknown", "observed"]), message: z.string(),
}).strict()
const storedDraftSchema = z.object({ raw: z.string(), revision: z.string(), projectTaskEditing: backupSchema })
export function readProjectTaskDraft(value: unknown): ProjectTaskDraft | undefined {
  const result = storedDraftSchema.safeParse(value)
  return result.success && result.data.revision === result.data.projectTaskEditing.revision ? result.data.projectTaskEditing : undefined
}
export function hasUncertainProjectTaskDraft(values: Readonly<Record<string, unknown>>, savingDocumentId?: string): boolean {
  // All native editor surfaces share this write gate. Only an active PUT may keep editing its own draft.
  if (hasUncertainDocumentSave(values, savingDocumentId)) return true
  return Object.values(values).some(value => {
    const draft = readProjectTaskDraft(value)
    return draft?.phase === "unknown" || draft?.phase === "observed"
  })
}
export function projectTaskSourceProblem(file: FileRecord | undefined): string | null {
  if (!file) return "The source file is unavailable."
  if (file.entity.archived) return "Archived sources are read-only."
  if (file.stale || file.error || file.diagnostics?.some(issue => issue.severity === "error")) return "Repair the stale or invalid source before editing."
  return null
}
export type ProjectTaskWriteContext = {
  projectId: string
  snapshot: WorkspaceSnapshot | undefined
  canWrite: boolean
  locked: boolean
  readError: boolean
  sourceDrafts: Readonly<Record<string, unknown>>
}
export function projectTaskWriteProblem(context: ProjectTaskWriteContext, id: string, allowOwnDraft = true): string | null {
  if (context.locked) return "A write is pending or its result still requires reconciliation."
  if (!context.canWrite) return "Project planning permission is required."
  if (!context.snapshot || context.readError) return "Refresh the authoritative workspace before editing."
  if (context.snapshot.configurationErrors.some(issue => issue.severity === "error")) return "Repair the workspace configuration before editing."
  const project = context.snapshot.files.find(file => file.id === context.projectId && file.entity.entity === "project")
  const projectProblem = projectTaskSourceProblem(project)
  if (projectProblem) return projectProblem
  const file = context.snapshot.files.find(candidate => candidate.id === id && candidate.entity.entity === "work_item" && candidate.entity.project === context.projectId)
  const problem = projectTaskSourceProblem(file)
  if (problem) return problem
  if (context.snapshot.unsupportedFiles.some(candidate => candidate.id === id || candidate.id === context.projectId)) return "Unsupported source versions are read-only."
  const sourceDraft = context.sourceDrafts[id]
  if (sourceDraft && (!allowOwnDraft || !readProjectTaskDraft(sourceDraft))) return "Resolve the existing source draft in the full editor before editing inline."
  if (context.sourceDrafts[context.projectId]) return "Resolve the project's source draft in the full editor before editing tasks."
  return null
}
export function prepareProjectTaskPatch(file: FileRecord, draft: ProjectTaskDraft, configuration: ProtocolConfiguration, files: FileRecord[]): { changes: ProjectTaskChanges; raw: string } {
  if (file.revision !== draft.revision) throw new Error("The source revision changed; explicitly adopt it before saving the retained draft.")
  const changes = projectTaskChangesSchema.parse(draft.changes)
  const before = parseMarkdown(draft.baseRaw, configuration)
  if (before.id !== file.id || before.entity !== "work_item" || before.project !== draft.projectId) throw new Error("The retained draft does not belong to this project task.")
  const start = Object.hasOwn(changes, "x-pm-start") ? changes["x-pm-start"] : before["x-pm-start"]
  const due = Object.hasOwn(changes, "due") ? changes.due : before.due
  if (typeof start === "string" && typeof due === "string" && start > due) throw new Error("The due date cannot precede the start date.")
  const raw = patchMarkdown(draft.baseRaw, changes, configuration)
  const entity = parseMarkdown(raw, configuration)
  const baseline = validateRelations(files, configuration)
  const diagnostics = [
    ...validateTransition(before, entity, configuration),
    ...validateRelations(files.map(candidate => candidate.id === file.id ? { ...candidate, raw, entity, stale: false, diagnostics: [] } : candidate), configuration)
      .filter(issue => issue.entityId === file.id || !baseline.some(previous => previous.code === issue.code && previous.entityId === issue.entityId && previous.field === issue.field && previous.targetId === issue.targetId)),
  ].filter(issue => issue.severity === "error")
  if (diagnostics.length) throw new ProtocolError(diagnostics)
  return { changes, raw }
}
export function projectTaskDraftValue(file: FileRecord, draft: ProjectTaskDraft | undefined, field: ProjectTaskField): unknown {
  return draft && Object.hasOwn(draft.changes, field) ? draft.changes[field] : file.entity[field]
}
export function projectTaskObservedMatch(file: FileRecord, draft: ProjectTaskDraft): boolean {
  return Object.entries(draft.changes).every(([key, expected]) => (file.entity[key] ?? null) === expected)
}

export function observeProjectTaskDraft(file: FileRecord, draft: ProjectTaskDraft): ProjectTaskDraft {
  if (draft.phase !== "unknown") throw new Error("Only an uncertain write can be reconciled.")
  return { ...draft, phase: "observed", message: projectTaskObservedMatch(file, draft)
    ? "The current source contains the requested field values. This is an observation, not a write receipt. Review and deliberately adopt or discard the draft."
    : "The current source differs from the requested fields. No write was retried. Review and deliberately adopt or discard the draft." }
}

export function adoptProjectTaskDraft(file: FileRecord, draft: ProjectTaskDraft): ProjectTaskDraft {
  if (draft.phase === "unknown") throw new Error("Read the authoritative source before resolving an uncertain write.")
  return { ...draft, baseRaw: file.raw, revision: file.revision, phase: "editing", message: "Current source adopted. Review the retained fields, then save explicitly." }
}

/** Native source-editor actions cannot silently remove a pending task attempt. */
export function preserveUncertainProjectTaskDrafts<T>(previous: Readonly<Record<string, T>>, next: Record<string, T>): Record<string, T> {
  let retained = next
  for (const [id, value] of Object.entries(previous)) {
    const draft = readProjectTaskDraft(value)
    if (draft?.phase !== "unknown" && draft?.phase !== "observed") continue
    if (retained === next) retained = { ...next }
    retained[id] = value
  }
  return retained
}

import { statusCategory, workflowFor, type WorkspaceSnapshot } from "../../../../../../packages/pm-schema/index.ts"
import { projectTaskChangesSchema, projectTaskSourceProblem } from "./project-task-editing-model.ts"

/** Empty means unknown/cleared. Zero is an explicit, valid point quantity. */
export function parseTeamPointsInput(input: string): number | null {
  const text = input.trim()
  if (!text) return null
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error("Enter a finite nonnegative decimal point quantity, or clear the field for unknown.")
  const value = Number(text)
  projectTaskChangesSchema.parse({ "x-pm-estimate": value })
  return value === 0 ? 0 : value
}

/** UI availability only; the existing CreateWorkItem command rechecks authority. */
export function teamTaskCreateProjectProblem(snapshot: WorkspaceSnapshot | undefined, projectId: string, sourceDrafts: Readonly<Record<string, unknown>>): string | null {
  if (!snapshot) return "Read the authoritative workspace before creating a task."
  if (snapshot.configurationErrors.some(issue => issue.severity === "error")) return "Repair the workspace configuration before creating a task."
  const workflow = workflowFor("work_item", snapshot.configuration)
  const initial = workflow?.states.find(state => state.id === workflow.initial)
  if (!initial || initial.category === "completed" || initial.category === "canceled") return "The task workflow must have a nonterminal initial state before creating a task."
  if (snapshot.unsupportedFiles.some(file => file.id === projectId)) return "Unsupported project sources are read-only."
  const project = snapshot.files.find(file => file.id === projectId && file.entity.entity === "project")
  const problem = projectTaskSourceProblem(project)
  if (problem) return problem
  if (project && ["completed", "canceled"].includes(statusCategory(project.entity, snapshot.configuration) ?? "")) return "Reopen the terminal project before creating tasks."
  if (sourceDrafts[projectId]) return "Resolve the project's source draft before creating tasks."
  return null
}

export type TeamCapacityBaseline = { id: string; version: number; capacityPoints: number | null } | null

/** An absent capacity is not an existing cleared record; CAS always targets its ID. */
export function teamCapacityExpected(baseline: TeamCapacityBaseline): { targetId?: string; expectedVersions?: Record<string, number> } {
  return baseline ? { targetId: baseline.id, expectedVersions: { [baseline.id]: baseline.version } } : {}
}

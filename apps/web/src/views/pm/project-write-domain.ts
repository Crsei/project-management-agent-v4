import type { ProjectCardRecord } from "./project-list-1-fixtures"

export type ProjectWriteOutcome = "confirmed" | "rejected" | "unknown"
export type ProjectWriteChange =
  | { kind: "create"; project: ProjectCardRecord }
  | {
      kind: "patch"
      projectId: string
      patch: Partial<ProjectCardRecord>
      baseFingerprint: string
    }
export type ProjectWriteRequest = {
  id: string
  consumer: string
  projectId: string
  change: ProjectWriteChange
}
export type ProjectWriteState = {
  sequence: number
  requests: Record<string, ProjectWriteRequest>
}
export type ProjectWriteResult = {
  status: ProjectWriteOutcome | "stale" | "locked"
  requestId: string | null
  projectId: string
}
export type ProjectWriteTransition = {
  writes: ProjectWriteState
  projects: ProjectCardRecord[]
  result: ProjectWriteResult
}
export const createProjectWriteState = (): ProjectWriteState => ({
  sequence: 0,
  requests: {},
})
export const projectWriteFingerprint = (project: ProjectCardRecord): string =>
  JSON.stringify(project)
export function projectWriteLocked(
  state: ProjectWriteState,
  consumer: string,
  projectId: string | null,
): boolean {
  return Object.values(state.requests).some(
    (request) =>
      request.consumer === consumer ||
      (projectId === null
        ? request.change.kind === "create"
        : request.projectId === projectId),
  )
}
function applyProjectWrite(
  projects: ProjectCardRecord[],
  change: ProjectWriteChange,
): ProjectCardRecord[] | null {
  if (change.kind === "create")
    return projects.some((project) => project.id === change.project.id)
      ? null
      : [change.project, ...projects]
  const current = projects.find((project) => project.id === change.projectId)
  if (!current || projectWriteFingerprint(current) !== change.baseFingerprint)
    return null
  return projects.map((project) =>
    project.id === change.projectId
      ? { ...project, ...change.patch, id: project.id }
      : project,
  )
}
export function submitProjectWrite(
  writes: ProjectWriteState,
  projects: ProjectCardRecord[],
  consumer: string,
  change: ProjectWriteChange,
  outcome: ProjectWriteOutcome,
): ProjectWriteTransition {
  const projectId =
    change.kind === "create" ? change.project.id : change.projectId
  const unchanged = (
    status: ProjectWriteResult["status"],
  ): ProjectWriteTransition => ({
    writes,
    projects,
    result: { status, requestId: null, projectId },
  })
  if (
    projectWriteLocked(
      writes,
      consumer,
      change.kind === "create" ? null : projectId,
    )
  )
    return unchanged("locked")
  if (
    change.kind === "create"
      ? projects.some((project) => project.id === projectId)
      : !projects.some(
          (project) =>
            project.id === projectId &&
            projectWriteFingerprint(project) === change.baseFingerprint,
        )
  )
    return unchanged("stale")
  const sequence = writes.sequence + 1
  const request: ProjectWriteRequest = {
    id: `project-write-${sequence}`,
    consumer,
    projectId,
    change: structuredClone(change),
  }
  const next = { ...writes, sequence }
  if (outcome === "unknown")
    next.requests = { ...writes.requests, [request.id]: request }
  const applied =
    outcome === "confirmed" ? applyProjectWrite(projects, request.change) : null
  return {
    writes: next,
    projects: applied ?? projects,
    result: { status: outcome, requestId: request.id, projectId },
  }
}
export function reconcileProjectWrite(
  writes: ProjectWriteState,
  projects: ProjectCardRecord[],
  requestId: string,
  outcome: Exclude<ProjectWriteOutcome, "unknown">,
): ProjectWriteTransition {
  const request = writes.requests[requestId]
  if (!request)
    return {
      writes,
      projects,
      result: { status: "locked", requestId, projectId: "" },
    }
  const requests = { ...writes.requests }
  delete requests[requestId]
  const applied =
    outcome === "confirmed" ? applyProjectWrite(projects, request.change) : null
  return {
    writes: { ...writes, requests },
    projects: applied ?? projects,
    result: {
      status: outcome === "confirmed" && !applied ? "stale" : outcome,
      requestId,
      projectId: request.projectId,
    },
  }
}

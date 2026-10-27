import { useCallback } from "react"
import { usePmDomainState } from "./domain-session"
import type { PmScenario } from "./model"
import {
  createProjectList1Fixtures,
  type ProjectCardRecord,
} from "./project-list-1-fixtures"
import {
  createProjectWriteState,
  projectWriteLocked,
  reconcileProjectWrite,
  submitProjectWrite,
  type ProjectWriteChange,
  type ProjectWriteOutcome,
  type ProjectWriteResult,
} from "./project-write-domain"

export function useProjectWrites(scenario: PmScenario, consumer: string) {
  const [projects, setProjects] = usePmDomainState<ProjectCardRecord[]>(
    "projects",
    () => createProjectList1Fixtures(scenario),
  )
  const [writes, setWrites] = usePmDomainState(
    "project-writes",
    createProjectWriteState,
  )
  const request = Object.values(writes.requests).find(
    (pending) => pending.consumer === consumer,
  )
  const allowed = scenario !== "readonly" && scenario !== "loading"
  const submit = useCallback(
    (
      change: ProjectWriteChange,
      outcome: ProjectWriteOutcome,
    ): ProjectWriteResult => {
      const projectId =
        change.kind === "create" ? change.project.id : change.projectId
      let result: ProjectWriteResult = {
        status: "locked",
        requestId: null,
        projectId,
      }
      if (!allowed) return result
      setWrites((currentWrites) => {
        let nextWrites = currentWrites
        setProjects((currentProjects) => {
          const next = submitProjectWrite(
            currentWrites,
            currentProjects,
            consumer,
            change,
            outcome,
          )
          nextWrites = next.writes
          result = next.result
          return next.projects
        })
        return nextWrites
      })
      return result
    },
    [allowed, consumer, setProjects, setWrites],
  )
  const reconcile = useCallback(
    (outcome: Exclude<ProjectWriteOutcome, "unknown">): ProjectWriteResult => {
      let result: ProjectWriteResult = {
        status: "locked",
        requestId: request?.id ?? null,
        projectId: request?.projectId ?? "",
      }
      if (!allowed || !request) return result
      setWrites((currentWrites) => {
        let nextWrites = currentWrites
        setProjects((currentProjects) => {
          const next = reconcileProjectWrite(
            currentWrites,
            currentProjects,
            request.id,
            outcome,
          )
          nextWrites = next.writes
          result = next.result
          return next.projects
        })
        return nextWrites
      })
      return result
    },
    [allowed, request, setProjects, setWrites],
  )
  return {
    projects,
    sequence: writes.sequence,
    request,
    requests: writes.requests,
    canWrite: (projectId: string | null) =>
      allowed && !projectWriteLocked(writes, consumer, projectId),
    submit,
    reconcile,
  }
}

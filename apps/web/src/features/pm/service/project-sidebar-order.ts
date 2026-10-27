import { useEffect, useMemo, useRef, useState } from "react"
import type { Command, Entity } from "@contracts"
import { moveProjectSidebarOrderIds, projectSidebarOrderIds } from "../../../../../../packages/domain/src/project-extras"
import { usePmCommand, usePmService, useProjectExtras } from "./pm-service"
import { useText } from "./pm-ui"

type OrderFeedback = { scope: string; pending: boolean; error: string | null; notice: string | null }
export type ProjectSidebarOrderState = {
  orderedProjects: Entity[]
  moveProject: (projectId: string, direction: "up" | "down") => Promise<void>
  pending: boolean
  error: string | null
  notice: string | null
}

/** Pass the complete authorized project list, never a search-filtered subset. */
export function useProjectSidebarOrder(projects: Entity[]): ProjectSidebarOrderState {
  const { actor, actorEpoch, workspace } = usePmService()
  const query = useProjectExtras()
  const command = usePmCommand()
  const t = useText()
  const scope = `${actor?.id ?? "anonymous"}:${actorEpoch}:${workspace?.id ?? "none"}:${workspace?.version ?? 0}`
  const currentScope = useRef<string | null>(scope)
  const submitting = useRef<string | null>(null)
  const [feedback, setFeedback] = useState<OrderFeedback | null>(null)
  currentScope.current = scope
  useEffect(() => {
    currentScope.current = scope
    return () => { if (currentScope.current === scope) currentScope.current = null }
  }, [scope])

  const saved = query.data?.sidebarOrder
  const orderedProjects = useMemo(() => {
    const authorized = new Map(projects.filter(project => project.kind === "project" && project.data.archived !== true && !project.data.archivedAt
      && workspace?.capabilities.includes("domain.read") && (workspace.projectIds === null || workspace.projectIds.includes(project.id))).map(project => [project.id, project]))
    return projectSidebarOrderIds(saved?.data.projectIds ?? [], [...authorized.keys()]).map(id => authorized.get(id)!)
  }, [projects, saved, workspace])
  const local = feedback?.scope === scope ? feedback : null
  const pending = !actor || !workspace || !query.data || !!query.error || query.isFetching || command.pending || !!command.unknownCommand || local?.pending === true

  const moveProject = async (projectId: string, direction: "up" | "down") => {
    if (pending || submitting.current === scope) return
    const projectIds = moveProjectSidebarOrderIds(orderedProjects.map(project => project.id), projectId, direction)
    if (!projectIds) return
    const request: Command = {
      commandId: crypto.randomUUID(),
      commandType: "SetProjectSidebarOrder",
      expectedVersions: saved ? { [saved.id]: saved.version } : {},
      payload: { projectIds },
    }
    submitting.current = scope
    setFeedback({ scope, pending: true, error: null, notice: null })
    try {
      await command.execute(request)
      if (currentScope.current !== scope) return
      const refreshed = await query.refetch()
      if (currentScope.current !== scope) return
      setFeedback({ scope, pending: false, error: refreshed.error?.message ?? null, notice: t("侧栏项目顺序已保存。", "Sidebar project order saved.") })
    } catch (error) {
      if (currentScope.current === scope) setFeedback({ scope, pending: false, error: error instanceof Error ? error.message : String(error), notice: null })
    } finally {
      if (submitting.current === scope) submitting.current = null
    }
  }

  return {
    orderedProjects,
    moveProject,
    pending,
    error: query.error?.message ?? local?.error ?? null,
    notice: command.unknownCommand ? t("结果未知，请在工作区核对原命令；不会自动重新排序。", "Outcome unknown. Check the original command in the workspace; ordering is never automatically replayed.") : local?.notice ?? null,
  }
}

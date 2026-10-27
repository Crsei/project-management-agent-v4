import type { Entity } from "@contracts"
import { z } from "zod"
import type { ProjectDirectoryManagement as DirectoryManagement, ProjectDirectoryProject, ProjectIdentity } from "../../../../../../packages/domain/src/project-directory"
import { Button } from "@/components/ui/button"
import { usePmService, useProjectDirectory } from "./pm-service"
import { CommandNotice, Form, allowed, useAction, useDraftState, useText } from "./pm-ui"

const committedRecordVersion = z.object({ id: z.string().uuid(), version: z.number().int().positive() })

function Selection({ label, options, selected, onChange }: { label: string; options: ProjectIdentity[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const t = useText()
  const known = new Set(options.map(option => option.id))
  const choices = [...options, ...selected.filter(id => !known.has(id)).map(id => ({ id, name: `${t("当前不可用", "Currently unavailable")} · ${id}` }))]
  return <fieldset className="min-w-0 space-y-2 rounded-md border p-3"><legend className="px-1 text-sm font-medium">{label}</legend>
    {choices.length ? choices.map(option => <label key={option.id} className="flex min-h-8 items-center gap-2 break-all text-sm"><input type="checkbox" checked={selected.includes(option.id)} onChange={event => onChange(event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id))} /><span>{option.name}</span></label>) : <p className="text-sm text-muted-foreground">{t("没有可选记录。", "No available records.")}</p>}
  </fieldset>
}

/** Authorized fragments only: the backend has already removed unrelated identities. */
export function ProjectTeams({ projectId }: { projectId: string }) {
  const query = useProjectDirectory()
  const t = useText()
  if (query.isPending) return <p role="status">{t("加载项目团队…", "Loading project teams…")}</p>
  if (query.error) return <div role="alert"><p>{query.error.message}</p><Button variant="outline" onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>
  const current = query.data?.projects.find(project => project.projectId === projectId)
  if (!current) return <p>{t("项目不可访问。", "Project unavailable.")}</p>
  return <div className="space-y-3 text-sm">
    {current.teams.length ? current.teams.map(team => <div key={team.id} className="rounded-md border p-3"><p className="font-medium">{team.name}</p><p className="break-words text-muted-foreground">{team.members.map(member => member.name).join(" · ") || t("没有当前可见成员。", "No currently visible members.")}</p></div>) : <p className="text-muted-foreground">{t("尚未关联团队。", "No teams assigned.")}</p>}
    <p className="text-xs text-muted-foreground">{t("团队关联不会授予项目访问权限；仅展示当前有权访问本项目的成员。", "Team assignments never grant project access; only members currently authorized for this project are shown.")}</p>
  </div>
}


export function ProjectTeamAssignment({ project }: { project: Entity }) {
  const query = useProjectDirectory()
  const { workspace } = usePmService()
  const t = useText()
  if (!allowed(workspace, "access.manage")) return <ProjectTeams projectId={project.id} />
  if (query.isPending) return <p role="status">{t("加载项目团队…", "Loading project teams…")}</p>
  if (query.error) return <div role="alert"><p>{query.error.message}</p><Button variant="outline" onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>
  const current = query.data?.projects.find(row => row.projectId === project.id)
  return current && query.data?.management ? <AssignmentEditor project={project} current={current} management={query.data.management} /> : <p>{t("项目团队关联不可用。", "Project team assignment unavailable.")}</p>
}

function AssignmentEditor({ project, current, management }: { project: Entity; current: ProjectDirectoryProject; management: DirectoryManagement }) {
  const query = useProjectDirectory()
  const action = useAction()
  const t = useText()
  const scope = `project-team-assignment:${project.id}`
  const [base, setBase] = useDraftState(scope, "base", { project, assignment: current.assignment, teams: management.teams })
  const [teamIds, setTeamIds] = useDraftState(scope, "teams", current.teams.map(team => team.id))
  const activeTeams = management.teams.filter(team => !team.data.archivedAt)
  const changed = base.project.version !== project.version || base.assignment?.version !== current.assignment?.version || teamIds.some(id => base.teams.find(team => team.id === id)?.version !== management.teams.find(team => team.id === id)?.version)
  const writable = !project.data.archivedAt && project.data.archived !== true && ["planning", "active"].includes(String(project.data.status))
  return <section className="min-w-0 space-y-3" aria-label={t("项目团队关联", "Project team assignment")}>
    <ProjectTeams projectId={project.id} />
    <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">{t("管理项目团队关联", "Manage project teams")}</summary><div className="space-y-3 pt-3"><Form disabled={action.locked || changed || !writable} onSubmit={async () => {
      const expectedVersions = Object.fromEntries([base.project, ...(base.assignment ? [base.assignment] : []), ...base.teams.filter(team => teamIds.includes(team.id))].map(record => [record.id, record.version]))
      const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "SetProjectTeams", targetId: project.id, projectId: project.id, expectedVersions, payload: { teamIds } })
      // Adopt only our committed head; a concurrent directory refresh is not an acknowledgement.
      if (receipt.status === "committed") setBase({ ...base, assignment: committedRecordVersion.parse(receipt.result) })
      await query.refetch()
    }}>
      <Selection label={t("活动团队", "Active teams")} options={activeTeams.map(team => ({ id: team.id, name: team.data.name }))} selected={teamIds} onChange={setTeamIds} />
    </Form>
      {!writable && <p className="text-sm">{t("项目不可写，不能修改关联。", "Project is not writable; assignments cannot change.")}</p>}
      {changed && <div role="status" className="space-y-2 text-sm"><p>{t("项目、团队或关联版本已变化；草稿保留。", "Project, team or assignment version changed; draft retained.")}</p><Button variant="ghost" disabled={action.locked} onClick={() => setBase({ project, assignment: current.assignment, teams: management.teams })}>{t("采用当前版本（保留草稿）", "Use current version (keep draft)")}</Button></div>}
      <CommandNotice />
    </div></details>
  </section>
}

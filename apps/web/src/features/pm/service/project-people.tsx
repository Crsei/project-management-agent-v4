import { useState } from "react"
import type { Entity } from "@contracts"
import { z } from "zod"
import type { ProjectPeople } from "../../../../../../packages/domain/src/people"
import { Button } from "@/components/ui/button"
import { MemberAvatar, MemberAvatarGroup } from "./people-components"
import { usePeopleCandidates } from "./people-hooks"
import { usePmService, usePrivateQuery, useProjectDirectory } from "./pm-service"
import { CommandNotice, Form, useAction, useDraftState, useText } from "./pm-ui"
import { ProjectTeamAssignment } from "./project-directory"
import { ProjectShareDialog } from "./project-share-dialog"
import { pmKeys } from "./pm-data"

function useProjectPeople(projectId: string) {
  const { actor, workspace } = usePmService()
  return usePrivateQuery([...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "people", "project", projectId], "domain.read", projectId,
    (client, workspaceId, signal) => client.people.project(workspaceId, projectId, signal))
}

export function ProjectPeopleSummary({ projectId }: { projectId: string }) {
  const { workspace } = usePmService()
  const query = useProjectDirectory()
  const t = useText()
  const project = !query.error ? query.data?.projects.find(row => row.projectId === projectId) : undefined
  if (!workspace || !project) return <span className="text-xs text-muted-foreground">{query.error ? t("成员读取失败", "People unavailable") : t("读取成员…", "Loading people…")}</span>
  return <MemberAvatarGroup members={project.participants.map(person => ({ userId: person.id, name: person.name }))} href={`/pm/${encodeURIComponent(workspace.id)}/projects/${encodeURIComponent(projectId)}/overview?panel=people#project-people`} label={t(`显式参与人 · ${project.participants.length}`, `Explicit participants · ${project.participants.length}`)} />
}

export function ProjectPeoplePanel({ project }: { project: Entity }) {
  const query = useProjectPeople(project.id)
  const { actor, workspace } = usePmService()
  const t = useText()
  const [sharing, setSharing] = useState(false)
  return <section id="project-people" className="space-y-4 scroll-mt-20" aria-label={t("项目成员", "Project people")}>
    <h2 className="text-base font-medium">{t("项目成员", "Project people")}</h2>
    <p className="text-xs text-muted-foreground">{t("显式参与人、关联团队和实际访问权限是三个独立事实；参与或团队关联不会授予权限，也不会自动分派任务。", "Explicit participation, linked teams and actual access are separate facts. Participation and team links grant no access and do not assign tasks.")}</p>
    {query.error ? <div role="alert"><p>{query.error.message}</p><Button variant="outline" onClick={() => { void query.refetch() }}>{t("重新读取", "Reload")}</Button></div> : !query.data ? <p role="status">{t("读取项目成员…", "Loading project people…")}</p> : workspace && <ParticipationEditor key={`${actor?.id}:${workspace.id}:${project.id}`} project={project} query={query} data={query.data} />}
    <div className="border-t pt-3"><h3 className="mb-2 text-sm font-medium">{t("关联团队", "Linked teams")}</h3><ProjectTeamAssignment project={project} /></div>
    <div className="space-y-2 border-t pt-3"><h3 className="text-sm font-medium">{t("真实访问权限", "Actual access")}</h3><p className="text-xs text-muted-foreground">{t("授权沿用工作区成员能力和项目范围。整个工作区授权不能在单个项目中排除；邀请接受之前不是可分派成员。", "Access follows workspace capabilities and project scope. Workspace-wide access cannot exclude one project. Pending invitations are not assignable members.")}</p><Button variant="outline" onClick={() => setSharing(true)}>{t("查看访问 / 分享与邀请", "View access / Share and invite")}</Button></div>
    <ProjectShareDialog project={project} open={sharing} onOpenChange={setSharing} />
  </section>
}

function ParticipationEditor({ project, query, data }: { project: Entity; query: { error: Error | null; isFetching: boolean; refetch: () => Promise<unknown> }; data: ProjectPeople }) {
  const { workspace } = usePmService()
  const directory = useProjectDirectory()
  const candidates = usePeopleCandidates({ purpose: "participant", projectId: project.id, enabled: data.canManage })
  const action = useAction()
  const t = useText()
  const scope = `project-participation:${project.id}`
  const [base, setBase] = useDraftState(scope, "base", { projectVersion: data.projectVersion, participation: data.participation })
  const [memberIds, setMemberIds] = useDraftState<string[]>(scope, "members", data.participation?.memberIds ?? [])
  const changed = base.projectVersion !== data.projectVersion || base.participation?.version !== data.participation?.version
  const writable = !project.data.archivedAt && project.data.archived !== true
  const identities = new Map(data.participants.map(member => [member.userId, member]))
  const options = candidates.items
  const known = new Set(options.map(member => member.userId))
  return <div className="space-y-3">
    <h3 className="text-sm font-medium">{t("显式参与人", "Explicit participants")}</h3>
    <ul className="flex flex-wrap gap-3">{data.participants.map(member => <li key={member.userId}><MemberAvatar member={member} workspaceSlug={workspace!.id} showName /></li>)}</ul>
    {!data.participation?.memberIds.length && <p className="text-sm text-muted-foreground">{t("尚未设置显式参与人；不会从任务负责人或团队成员自动推断。", "No explicit participants set; task assignees and team members are not inferred as participants.")}</p>}
    {(data.participation?.memberIds.length ?? 0) > data.participants.length && <p className="text-xs text-muted-foreground">{t("部分历史参与记录当前身份不可用；不会恢复权限或自动删除历史。", "Some recorded participants are currently unavailable; no access is restored or history silently removed.")}</p>}
    {data.canManage && <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">{t("管理显式参与人", "Manage explicit participants")}</summary><div className="space-y-3 pt-3">
      {candidates.error && <div role="alert"><p>{candidates.error.message}</p><Button variant="outline" onClick={() => { void candidates.refetch() }}>{t("重读候选", "Reload candidates")}</Button></div>}
      <Form disabled={action.locked || changed || !writable || !candidates.complete || !!query.error || query.isFetching} onSubmit={async () => {
        const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "SetProjectParticipants", targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: base.projectVersion, ...(base.participation ? { [base.participation.id]: base.participation.version } : {}) }, payload: { memberIds } })
        if (receipt.status === "committed") {
          const committed = z.object({ id: z.string(), version: z.number().int().positive() }).parse(receipt.result)
          setBase({ projectVersion: base.projectVersion, participation: { ...committed, memberIds } })
        }
        await query.refetch()
        await directory.refetch()
      }}>
        <fieldset className="max-h-64 space-y-2 overflow-auto"><legend className="mb-2 text-xs text-muted-foreground">{t("仅当前有本项目读取权的有效成员", "Active members with current read access to this project")}</legend>
          {options.map(member => <label key={member.userId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={memberIds.includes(member.userId)} onChange={event => setMemberIds(ids => event.target.checked ? [...ids, member.userId] : ids.filter(id => id !== member.userId))} /><span>{member.name}</span></label>)}
          {memberIds.filter(id => !known.has(id)).map(id => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked onChange={() => setMemberIds(ids => ids.filter(value => value !== id))} /><span>{identities.get(id)?.name ?? t("当前不可用的参与记录", "Currently unavailable participant")} · {id}</span></label>)}
        </fieldset>
      </Form>
      {!writable && <p>{t("项目已归档，参与人不可修改。", "Archived project: participants cannot be changed.")}</p>}
      {changed && <div role="status"><p>{t("项目或参与版本已变化；草稿保留，请先比较当前记录。", "Project or participation version changed. Draft retained; compare the current record first.")}</p><Button variant="outline" disabled={action.locked} onClick={() => setBase({ projectVersion: data.projectVersion, participation: data.participation })}>{t("保留草稿，采用当前版本", "Keep draft, adopt current version")}</Button></div>}
      <CommandNotice />
    </div></details>}
  </div>
}

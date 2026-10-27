import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import type { Command, TeamDirectory } from "@contracts"
import type { ControlledMember } from "@/views/pm/people-controlled-contracts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { CommandNotice, Field, Form, useDraftState, useText } from "./pm-ui"
import { usePmCommand } from "./pm-service"

type Team = TeamDirectory["teams"][number]
export type TeamEditorSelection = { id: string | null; mode: "details" | "members" | "projects" | "archive" }
const committedHead = z.object({ id: z.string().uuid(), version: z.number().int().positive() })
const detailsSchema = z.object({ name: z.string().trim().min(1).max(160), identifier: z.string().trim().min(1).max(64).nullable(), description: z.string().trim().max(5000), focus: z.string().trim().min(1).max(500).nullable(), responseTargetHours: z.number().finite().nonnegative().max(8760).nullable() })

export function TeamEditorDialog({ selection, directory, members, disabled, onClose, onChanged, finalFocus }: { selection: TeamEditorSelection | null; directory: TeamDirectory | undefined; members: readonly ControlledMember[]; disabled: boolean; onClose: () => void; onChanged: () => void; finalFocus: () => HTMLElement | null }) {
  const t = useText()
  const team = directory?.teams.find(item => item.id === selection?.id)
  const title = !selection?.id ? t("添加团队", "Add team") : selection.mode === "members" ? t("成员与维护者", "Members and maintainers") : selection.mode === "projects" ? t("关联项目", "Linked projects") : selection.mode === "archive" ? t("归档团队", "Archive team") : t("编辑团队", "Edit team")
  return <Dialog open={!!selection} onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-w-2xl" finalFocus={finalFocus}>
    <DialogTitle>{title}</DialogTitle><DialogDescription>{t("团队只组织已有成员，不授予权限。版本冲突与未知结果保留草稿。", "Teams organize existing members without granting access. Conflicts and unknown outcomes retain drafts.")}</DialogDescription>
    <DialogBody className="space-y-4"><CommandNotice />{selection && directory && (!selection.id || team) ? selection.mode === "projects" && team ? <TeamProjectRelations key={team.id} team={team} directory={directory} disabled={disabled} onChanged={onChanged} /> : <TeamWriteForm key={`${selection.id ?? "new"}:${selection.mode}`} team={team} mode={selection.mode} members={members} disabled={disabled} onChanged={onChanged} /> : <p role="status">{t("当前记录不可用；不能提交旧快照。", "The current record is unavailable; an old snapshot cannot be submitted.")}</p>}</DialogBody>
  </DialogContent></Dialog>
}

function TeamWriteForm({ team, mode, members, disabled, onChanged }: { team?: Team; mode: TeamEditorSelection["mode"]; members: readonly ControlledMember[]; disabled: boolean; onChanged: () => void }) {
  const t = useText()
  const command = usePmCommand()
  const scope = `teams:${team?.id ?? "create"}:${mode}`
  const unknown = command.unknownCommand
  const original = unknown && (!team ? unknown.commandType === "CreateProjectTeam" : unknown.targetId === team.id && (mode === "details" && (unknown.commandType === "UpdateProjectTeamDetails" || unknown.commandType === "RenameProjectTeam") || mode === "members" && (unknown.commandType === "SetProjectTeamMembers" || unknown.commandType === "SetProjectTeamMaintainers") || mode === "archive" && unknown.commandType === "ArchiveProjectTeam")) ? unknown : null
  const originalDetails = original?.commandType === "CreateProjectTeam" || original?.commandType === "UpdateProjectTeamDetails" ? original.payload : null
  const [baseVersion, setBaseVersion] = useDraftState(scope, "baseVersion", team ? original?.expectedVersions?.[team.id] ?? team.version : null)
  const [name, setName] = useDraftState(scope, "name", originalDetails?.name ?? team?.data.name ?? "")
  const [identifier, setIdentifier] = useDraftState(scope, "identifier", originalDetails ? originalDetails.identifier ?? "" : team?.data.identifier ?? "")
  const [description, setDescription] = useDraftState(scope, "description", originalDetails?.description ?? team?.data.description ?? "")
  const [focus, setFocus] = useDraftState(scope, "focus", originalDetails ? originalDetails.focus ?? "" : team?.data.focus ?? "")
  const initialResponse = originalDetails ? originalDetails.responseTargetHours : team?.data.responseTargetHours
  const [response, setResponse] = useDraftState(scope, "response", initialResponse == null ? "" : String(initialResponse))
  const [memberIds, setMemberIds] = useDraftState<string[]>(scope, "memberIds", original?.commandType === "SetProjectTeamMembers" ? original.payload.memberIds : team?.data.memberIds ?? [])
  const [maintainerIds, setMaintainerIds] = useDraftState<string[]>(scope, "maintainerIds", original?.commandType === "SetProjectTeamMaintainers" ? original.payload.maintainerIds : team?.data.maintainerIds ?? [])
  const [attemptId, setAttemptId] = useDraftState<string | null>(scope, "attemptId", original?.commandId ?? null)
  const [attemptType, setAttemptType] = useDraftState<Command["commandType"] | null>(scope, "attemptType", original?.commandType ?? null)
  const handled = useRef<string | null>(null)
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null)
  const changed = !!team && baseVersion !== team.version
  const locked = disabled || command.pending || !!command.unknownCommand || !!team?.data.archivedAt || changed
  const activeMembers = members.filter(member => member.isActive)
  const choices = [...activeMembers, ...members.filter(member => !member.isActive && memberIds.includes(member.userId))]
  async function submit(value: Command) {
    setAcknowledgement(null)
    setAttemptId(value.commandId)
    setAttemptType(value.commandType)
    await command.execute(value)
  }
  useEffect(() => {
    const receipt = command.receipt
    if (!attemptId || receipt?.commandId !== attemptId || handled.current === receipt.commandId) return
    handled.current = receipt.commandId
    setAttemptId(null)
    if (receipt.status !== "committed") return
    const parsed = committedHead.safeParse(receipt.result)
    if (!parsed.success || team && parsed.data.id !== team.id) {
      setAcknowledgement(t("收据结构与当前团队不匹配；请重新读取，不要重复提交。", "The receipt does not match this team. Read again; do not resubmit."))
      return
    }
    if (team) {
      setBaseVersion(parsed.data.version)
      if (attemptType === "SetProjectTeamMembers") setMaintainerIds(previous => previous.filter(id => memberIds.includes(id)))
    } else {
      setName(""); setIdentifier(""); setDescription(""); setFocus(""); setResponse(""); setMemberIds([]); setMaintainerIds([])
    }
    setAcknowledgement(t(`已确认提交 · 版本 ${parsed.data.version}`, `Confirmed committed · version ${parsed.data.version}`))
    onChanged()
  }, [attemptId, attemptType, command.receipt, memberIds, onChanged, setAttemptId, setBaseVersion, setDescription, setFocus, setIdentifier, setMaintainerIds, setMemberIds, setName, setResponse, t, team])
  const envelope = team && baseVersion !== null ? { targetId: team.id, expectedVersions: { [team.id]: baseVersion } } : {}
  const conflict = changed && <div role="status" className="space-y-2 rounded-md border p-3 text-sm"><p>{t("服务版本已变化。请核对当前记录；采用新版本不会覆盖草稿。", "The server version changed. Review the current record; adopting its version keeps your draft.")}</p><p className="break-words">{team?.data.name} · {team?.data.identifier ?? "—"} · {team?.data.description}</p><Button variant="outline" disabled={command.pending || !!command.unknownCommand || disabled} onClick={() => { setBaseVersion(team?.version ?? null); setAcknowledgement(null) }}>{t("采用当前版本，保留草稿", "Use current version, keep draft")}</Button></div>
  if (mode === "archive") return <div className="space-y-4"><p className="text-sm">{t("归档后不再出现在活动团队与项目关联中；历史保留。此操作不撤销任何人的权限。", "Archiving removes the team from active teams and project associations while preserving history. It does not revoke anyone's access.")}</p>{team && <Form disabled={locked} label={t("确认归档", "Confirm archive")} onSubmit={() => submit({ commandId: crypto.randomUUID(), commandType: "ArchiveProjectTeam", ...envelope, payload: {} })}><p className="break-words font-medium">{team.data.name}</p></Form>}{conflict}{team?.data.archivedAt && <p role="status">{t("团队已归档。", "The team is archived.")}</p>}{acknowledgement && <p role="status">{acknowledgement}</p>}</div>
  if (mode === "members" && team) return <div className="space-y-5">
    <Form disabled={locked} label={t("保存成员", "Save roster")} onSubmit={() => submit({ commandId: crypto.randomUUID(), commandType: "SetProjectTeamMembers", ...envelope, payload: { memberIds } })}>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t("已有有效成员", "Existing active members")}</legend>{choices.map(member => <label key={member.userId} className="flex min-h-8 min-w-0 items-center gap-2 break-words text-sm"><input type="checkbox" checked={memberIds.includes(member.userId)} disabled={!member.isActive && !memberIds.includes(member.userId)} onChange={event => { setMemberIds(event.target.checked ? [...memberIds, member.userId] : memberIds.filter(id => id !== member.userId)); setAcknowledgement(null) }} /><span className="min-w-0 break-words">{member.name}{!member.isActive && ` · ${t("已撤销", "Revoked")}`}</span></label>)}{!choices.length && <p className="text-sm">{t("没有有效候选成员。", "No active candidate members.")}</p>}</fieldset>
      {memberIds.filter(id => !members.some(member => member.userId === id)).map(id => <label key={id} className="flex min-h-8 items-center gap-2 text-sm"><input type="checkbox" checked onChange={() => { setMemberIds(previous => previous.filter(memberId => memberId !== id)); setAcknowledgement(null) }} />{t("不可用的旧成员选择（取消以移除）", "Unavailable retained member selection (uncheck to remove)")}</label>)}
    </Form>
    <Form disabled={locked} label={t("保存维护者", "Save maintainers")} onSubmit={() => submit({ commandId: crypto.randomUUID(), commandType: "SetProjectTeamMaintainers", ...envelope, payload: { maintainerIds } })}>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t("当前团队有效成员中的维护者", "Maintainers from the current active roster")}</legend>{activeMembers.filter(member => team.data.memberIds.includes(member.userId)).map(member => <label key={member.userId} className="flex min-h-8 items-center gap-2 break-words text-sm"><input type="checkbox" checked={maintainerIds.includes(member.userId)} onChange={event => { setMaintainerIds(event.target.checked ? [...maintainerIds, member.userId] : maintainerIds.filter(id => id !== member.userId)); setAcknowledgement(null) }} />{member.name}</label>)}</fieldset><p className="text-xs text-muted-foreground">{t("先保存成员，再设置维护者；移除成员会自动移除其维护者职责。维护者不获得权限。", "Save roster changes before assigning maintainers. Removing a member also removes their maintainer responsibility. Maintainers gain no permissions.")}</p>
      {maintainerIds.filter(id => !team.data.memberIds.includes(id) || !activeMembers.some(member => member.userId === id)).map(id => <label key={id} className="flex min-h-8 items-center gap-2 text-sm"><input type="checkbox" checked onChange={() => { setMaintainerIds(previous => previous.filter(memberId => memberId !== id)); setAcknowledgement(null) }} />{t("不可用的维护者选择（取消以移除）", "Unavailable retained maintainer selection (uncheck to remove)")}</label>)}
    </Form>{conflict}{acknowledgement && <p role="status">{acknowledgement}</p>}
  </div>
  return <div className="space-y-4"><Form disabled={locked} onSubmit={async () => {
    const payload = detailsSchema.parse({ name, identifier: identifier.trim() || null, description, focus: focus.trim() || null, responseTargetHours: response.trim() === "" ? null : Number(response) })
    if (team) await submit({ commandId: crypto.randomUUID(), commandType: "UpdateProjectTeamDetails", ...envelope, payload })
    else await submit({ commandId: crypto.randomUUID(), commandType: "CreateProjectTeam", payload: { ...payload, memberIds: [], maintainerIds: [] } })
  }}>
    <Field label={t("团队名称", "Team name")} value={name} onChange={value => { setName(value); setAcknowledgement(null) }} required />
    <Field label={t("标识（可留空）", "Identifier (optional)")} value={identifier} onChange={value => { setIdentifier(value); setAcknowledgement(null) }} />
    <Field label={t("团队说明", "Description")} value={description} onChange={value => { setDescription(value); setAcknowledgement(null) }} multiline />
    <Field label={t("工作方向（可留空）", "Focus (optional)")} value={focus} onChange={value => { setFocus(value); setAcknowledgement(null) }} />
    <Field label={t("响应目标小时数（0–8760；留空表示未知）", "Response target hours (0–8760; blank means unknown)")} value={response} onChange={value => { setResponse(value); setAcknowledgement(null) }} />
    <p className="text-xs text-muted-foreground">{t("响应目标只是配置，不表示正在计时、告警或评估 SLA。创建后可维护成员与项目关联。", "The response target is configuration only, not an active timer, alert or SLA evaluation. Manage members and projects after creation.")}</p>
  </Form>{conflict}{team?.data.archivedAt && <p role="status">{t("团队已归档，不能编辑。", "Archived teams cannot be edited.")}</p>}{acknowledgement && <p role="status">{acknowledgement}</p>}</div>
}

function TeamProjectRelations({ team, directory, disabled, onChanged }: { team: Team; directory: TeamDirectory; disabled: boolean; onChanged: () => void }) {
  const t = useText()
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">{t("逐个项目明确保存；仅显示当前可读项目，不会替换其他团队的关联。关联不授予项目权限。", "Save each project explicitly. Only readable projects appear; other team associations are preserved. Associations do not grant project access.")}</p>{directory.projects.map(project => <ProjectRelationForm key={project.id} team={team} project={project} directory={directory} disabled={disabled} onChanged={onChanged} />)}{!directory.projects.length && <p role="status">{t("没有当前可读的项目。", "No projects are currently readable.")}</p>}</div>
}

function ProjectRelationForm({ team, project, directory, disabled, onChanged }: { team: Team; project: TeamDirectory["projects"][number]; directory: TeamDirectory; disabled: boolean; onChanged: () => void }) {
  const t = useText()
  const command = usePmCommand()
  const scope = `teams:${team.id}:project:${project.id}`
  const currentIds = directory.teams.filter(item => !item.data.archivedAt && item.projectIds.includes(project.id)).map(item => item.id)
  const currentBase = { projectVersion: project.version, assignment: project.assignment, teams: directory.teams.filter(item => currentIds.includes(item.id) || item.id === team.id).map(item => ({ id: item.id, version: item.version })) }
  const [base, setBase] = useDraftState(scope, "base", currentBase)
  const [selected, setSelected] = useDraftState(scope, "selected", currentIds.includes(team.id))
  const [confirmed, setConfirmed] = useState(false)
  const changed = base.projectVersion !== project.version || base.assignment?.version !== project.assignment?.version || base.teams.some(record => directory.teams.find(item => item.id === record.id)?.version !== record.version)
  const locked = disabled || !project.canManage || changed || command.pending || !!command.unknownCommand || !!team.data.archivedAt
  return <section className="space-y-3 rounded-md border p-3"><h3 className="break-words text-sm font-medium">{project.name}</h3><Form disabled={locked} label={t("保存此项目关联", "Save this project association")} onSubmit={async () => {
    setConfirmed(false)
    const teamIds = selected ? [...new Set([...currentIds, team.id])] : currentIds.filter(id => id !== team.id)
    const expectedVersions = Object.fromEntries([{ id: project.id, version: base.projectVersion }, ...(base.assignment ? [base.assignment] : []), ...base.teams.filter(record => teamIds.includes(record.id))].map(record => [record.id, record.version]))
    const receipt = await command.execute({ commandId: crypto.randomUUID(), commandType: "SetProjectTeams", targetId: project.id, projectId: project.id, expectedVersions, payload: { teamIds } })
    if (receipt.status !== "committed") throw new Error(t("关联未确认提交；草稿保留。", "The association was not confirmed committed; the draft is retained."))
    setBase({ ...base, assignment: committedHead.parse(receipt.result) })
    setConfirmed(true)
    onChanged()
  }}><label className="flex min-h-8 items-center gap-2 break-words text-sm"><input type="checkbox" checked={selected} onChange={event => { setSelected(event.target.checked); setConfirmed(false) }} />{t("关联当前团队", "Link this team")}</label></Form>
    {!project.canManage && <p className="text-sm text-muted-foreground">{t("此项目不可写或没有管理权限。", "This project is not writable or you cannot manage its associations.")}</p>}
    {changed && <div role="status" className="space-y-2 text-sm"><p>{t("项目、团队或关联版本已变化；草稿保留。", "Project, team or association versions changed; the draft is retained.")}</p><Button variant="outline" disabled={disabled || command.pending || !!command.unknownCommand} onClick={() => { setBase(currentBase); setConfirmed(false) }}>{t("采用当前版本，保留草稿", "Use current version, keep draft")}</Button></div>}{confirmed && <p role="status" className="text-sm">{t("已通过原命令收据确认关联保存。", "Association saved, confirmed by the original command receipt.")}</p>}
  </section>
}

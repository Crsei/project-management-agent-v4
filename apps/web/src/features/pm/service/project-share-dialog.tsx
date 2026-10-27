import { useEffect, useState } from "react"
import { Copy, RefreshCw, UserPlus } from "lucide-react"
import { Link } from "react-router"
import { CommandOutcomeUnknown, type Command, type Entity, type MemberDirectoryMember, type MemberRole } from "@contracts"
import { memberRoleCapabilities } from "../../../../../../packages/domain/src/members.ts"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { InvitationStatus } from "@/views/pm/people-views"
import { useMemberDirectory, useMemberInvitations } from "./pm-member-hooks"
import { invitationRecord } from "./pm-member-model"
import { usePmCommand, usePmService } from "./pm-service"
import { Choice, CommandNotice, Field, Form, PmCommandRecovery, string, useDraftState, useText } from "./pm-ui"
import { canManageProjectShare, canReadProjectShare, projectShareCandidates, projectShareConflict, projectShareDraft, projectShareInvitationCommand, projectShareMemberCommand, projectShareScope, projectShareUrl, type ProjectShareScopeDraft } from "./project-share-model"

export function ProjectShareDialog({ project, open, onOpenChange }: { project: Entity; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { actor, workspace } = usePmService()
  const command = usePmCommand()
  const t = useText()
  const [copyOutcome, setCopyOutcome] = useState<{ url: string; ok: boolean } | null>(null)
  const readable = canReadProjectShare(workspace, project)
  const managing = readable && canManageProjectShare(workspace)
  const locked = command.pending || !!command.unknownCommand
  const url = readable && workspace ? projectShareUrl(window.location.origin, workspace.id, project.id) : ""
  const close = () => { if (!locked) onOpenChange(false) }
  return <Dialog open={open} onOpenChange={next => { if (next || !locked) onOpenChange(next) }}>
    <DialogContent className="max-w-2xl" data-pm-project-share={project.id} onEscapeKeyDown={event => { if (locked) event.preventDefault() }} onPointerDownOutside={event => { if (locked) event.preventDefault() }}>
      <DialogTitle>{t("分享项目", "Share project")} · {string(project.data.name) || project.id}</DialogTitle>
      <DialogDescription>{t("只有已获授权的成员可以打开项目链接。这里没有公开访问开关；团队归属不会授予访问权。", "Only authorized members can open the project link. There is no public access switch; team membership does not grant access.")}</DialogDescription>
      <DialogBody className="space-y-5">
        <CommandNotice />
        <PmCommandRecovery />
        {!readable || !workspace ? <p role="alert">{t("当前账号不能读取此工作区中的项目；分享内容不可用。", "This account cannot read this project in the current workspace; sharing details are unavailable.")}</p> : <>
          <section className="space-y-2 rounded-md border p-3 text-sm" aria-label={t("你的项目访问", "Your project access")}>
            <h3 className="font-medium">{t("你的访问权限", "Your access")}{actor ? ` · ${actor.name}` : ""}</h3>
            <p>{workspace.projectIds === null ? t("继承整个工作区的授权。", "Inherited from workspace-wide access.") : t("当前项目在你的明确授权范围内。", "This project is in your explicit access scope.")}</p>
            <AccessPermissions capabilities={workspace.capabilities} />
          </section>
          {managing && open ? <ProjectShareManagement key={`${actor?.id}:${workspace.id}:${project.id}`} project={project} onNavigate={close} /> : <p className="text-sm text-muted-foreground">{t("仅具有整个工作区 access.manage 的成员可以查看完整授权、添加成员或发送邀请。你的权限未因此改变；其他成员的权限不会推测展示。", "Only members with unrestricted workspace access.manage can view all grants, add members or send invitations. Your permissions are unchanged; other members’ permissions are not inferred.")}</p>}
        </>}
      </DialogBody>
      <DialogFooter className="flex-col items-stretch border-t">
        {url && <div className="space-y-2 text-sm">
          <div className="flex min-w-0 flex-wrap gap-2"><Input className="min-w-0 flex-1" aria-label={t("项目链接", "Project link")} value={url} readOnly onFocus={event => event.currentTarget.select()} /><Button variant="outline" onClick={() => { void (async () => {
            try { await navigator.clipboard.writeText(url); setCopyOutcome({ url, ok: true }) }
            catch { setCopyOutcome({ url, ok: false }) }
          })() }}><Copy aria-hidden="true" />{t("复制链接", "Copy link")}</Button></div>
          {copyOutcome?.url === url && <p role={copyOutcome.ok ? "status" : "alert"}>{copyOutcome.ok ? t("项目链接已复制。访问仍需登录和授权。", "Project link copied. Authentication and authorization are still required.") : t("复制失败，请选择上方链接后手动复制。", "Copy failed. Select the link above and copy it manually.")}</p>}
        </div>}
        <div className="flex justify-end"><Button disabled={locked} onClick={close}>{t("完成", "Done")}</Button></div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function AccessPermissions({ capabilities }: { capabilities: readonly string[] }) {
  const t = useText()
  const readable = capabilities.includes("domain.read")
  return <div className="space-y-1">
    <p>{!readable ? t("没有 domain.read，不能读取项目业务内容。", "No domain.read: cannot read project business data.") : capabilities.includes("planning.edit") ? t("可读取并编辑项目规划。其他操作以独立能力为准。", "Can read and edit project planning. Other actions require their separate grants.") : t("可读取项目；没有规划编辑权。其他操作以独立能力为准。", "Can read the project; no planning edit permission. Other actions require their separate grants.")}</p>
    <details><summary className="cursor-pointer text-muted-foreground">{t(`实际独立能力（${capabilities.length}）`, `Actual capabilities (${capabilities.length})`)}</summary><ul className="mt-2 flex flex-wrap gap-1">{capabilities.map(capability => <li key={capability}><code className="rounded bg-muted px-1 py-0.5 text-xs">{capability}</code></li>)}</ul></details>
  </div>
}

function ShareIdentity({ member }: { member: Pick<MemberDirectoryMember, "name" | "email" | "avatarDataUrl"> }) {
  return <div className="flex min-w-0 items-center gap-2"><Avatar size={32} name={member.name} src={member.avatarDataUrl ?? undefined} /><div className="min-w-0"><p className="break-words font-medium">{member.name}</p>{member.email && <p className="break-all text-xs text-muted-foreground">{member.email}</p>}</div></div>
}

function ProjectShareManagement({ project, onNavigate }: { project: Entity; onNavigate: () => void }) {
  const { workspace } = usePmService()
  const directory = useMemberDirectory()
  const invitations = useMemberInvitations()
  const command = usePmCommand()
  const t = useText()
  const scope = `project-share:${project.id}`
  const [query, setQuery] = useDraftState(scope, "query", "")
  const [operation, setOperation] = useDraftState<ProjectShareScopeDraft | null>(scope, "operation", null)
  const [email, setEmail] = useDraftState(scope, "email", "")
  const [role, setRole] = useDraftState<MemberRole>(scope, "role", "guest")
  const [attempt, setAttempt] = useDraftState<Command | null>(scope, "attempt", null)
  const [notice, setNotice] = useDraftState<string | null>(scope, "notice", null)
  const busy = command.pending || !!command.unknownCommand
  const canManage = canManageProjectShare(workspace) && directory.data?.capabilities.canManageMembers === true
  const readBlocked = !canManage || !directory.data || !!directory.error
  const locked = busy || readBlocked
  const members = directory.data?.members ?? []
  const current = members.find(member => member.userId === operation?.userId)
  const conflict = !!operation && projectShareConflict(operation, current?.access)
  const currentScope = projectShareScope(current?.access ?? null, project.id)
  const matching = projectShareCandidates(members, query).filter(member => projectShareScope(member.access, project.id) === "none")
  const granted = members.filter(member => ["direct", "inherited"].includes(projectShareScope(member.access, project.id)))
  const archived = !!project.data.archivedAt || project.data.archived === true
  const smtpEnabled = invitations.data?.enabled === true && !invitations.error
  const invitationBlocked = locked || !invitations.data || !!invitations.error || !smtpEnabled || archived
  const invitationItems = invitations.data?.items.filter(item => item.workspaceId === project.workspaceId && (item.projectIds === null || item.projectIds.includes(project.id))) ?? []
  const membersHref = `/pm/${encodeURIComponent(project.workspaceId)}/members?tab=members&view=member3`

  // The workspace recovery bar may reconcile our original request. Consume only
  // its actual receipt, never a refreshed member list or a delivery guess.
  useEffect(() => {
    if (!attempt || command.receipt?.commandId !== attempt.commandId) return
    if (command.receipt.status === "committed") {
      if (attempt.commandType === "SetWorkspaceMember") {
        setOperation(null)
        setNotice(t("项目授权范围已确认保存，其他范围与能力未改动。", "Project scope change confirmed; other scopes and capabilities are unchanged."))
      } else if (attempt.commandType === "CreateMemberInvitation") {
        setEmail("")
        setNotice(t("邀请记录已确认创建；真实邮件状态见下方，不代表已送达。", "Invitation record confirmed; actual email status is shown below, not proof of delivery."))
      }
    }
    setAttempt(null)
  }, [attempt, command.receipt, setAttempt, setEmail, setNotice, setOperation, t])

  const execute = async (body: Command) => {
    setNotice(null)
    setAttempt(body)
    try { await command.execute(body) }
    catch (error) { if (!(error instanceof CommandOutcomeUnknown)) setAttempt(null); throw error }
  }
  const openDraft = (member: MemberDirectoryMember, action: "add" | "remove") => {
    if (locked) return
    setOperation(projectShareDraft(member, action))
    setNotice(null)
  }
  const managementLink = <Link className="text-sm underline" to={membersHref} aria-disabled={busy} tabIndex={busy ? -1 : undefined} onClick={event => { if (busy) event.preventDefault(); else onNavigate() }}>{t("在成员目录中打开完整能力编辑器", "Open full capability editor in member directory")}</Link>

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{t("项目授权与成员", "Project grants and people")}</h3><Button variant="ghost" size="sm" disabled={busy || directory.isFetching || invitations.isFetching} onClick={() => { void directory.refetch(); void invitations.refetch() }}><RefreshCw aria-hidden="true" />{t("刷新权限与邀请", "Refresh access and invitations")}</Button></div>
    {directory.isPending && !directory.data && <p role="status">{t("正在读取真实成员授权…", "Reading actual member grants…")}</p>}
    {directory.error && <p role="alert" className="break-words text-sm text-destructive">{t("成员读取失败，修改已禁用；如有显示，仅为上次快照：", "Member read failed; changes are disabled. Any displayed grants are the previous snapshot: ")}{directory.error.message}</p>}
    {directory.data && !canManage && <p role="status">{t("当前服务授权不允许管理成员。请重新读取权限。", "Current server permissions do not allow member management. Refresh access before continuing.")}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {canManage && <>
      <section className="space-y-3" aria-label={t("具有项目授权的成员", "People with project grants")}>
        <p className="text-sm text-muted-foreground">{t("现有能力适用于成员的全部授权项目。这里仅增减当前项目范围，不提供虚假的单项目角色选择，也不替换能力。", "Existing capabilities apply to all of a member’s authorized projects. This dialog only adds or removes this project scope; it does not simulate per-project roles or replace capabilities.")}</p>
        {granted.length === 0 && <p className="text-sm">{t("没有可显示的项目授权记录。", "No project grant records to display.")}</p>}
        <ul className="space-y-2">{granted.map(member => <li key={member.userId} className="space-y-2 rounded-md border p-3 text-sm" data-pm-project-share-member={member.userId}>
          <div className="flex flex-wrap items-center justify-between gap-2"><ShareIdentity member={member} />{member.access?.projectIds === null ? <span className="text-xs text-muted-foreground">{t("工作区继承 · 不能单项目移除", "Workspace inherited · cannot remove per project")}</span> : <Button size="sm" variant="outline" disabled={locked} aria-label={t(`移除 ${member.name} 的当前项目范围`, `Remove this project scope for ${member.name}`)} onClick={() => openDraft(member, "remove")}>{t("移出此项目", "Remove from project")}</Button>}</div>
          <AccessPermissions capabilities={member.access!.capabilities} />
        </li>)}</ul>
        {managementLink}
        <p className="text-xs text-muted-foreground">{t("在目录中选择该成员的“管理访问”可编辑完整能力与范围；那里的修改可能影响其他项目。", "Choose the member’s Manage access action in the directory to edit full capabilities and scope; those changes may affect other projects.")}</p>
      </section>
      <section className="space-y-3 border-t pt-4" aria-label={t("添加已有成员", "Add existing members")}>
        <Field label={t("按姓名或邮箱查找已有工作区成员", "Find existing workspace members by name or email")} value={query} onChange={setQuery} disabled={busy} />
        {archived && <p role="status" className="text-sm">{t("项目已归档，不能增加授权或邀请新成员；已有授权仍可读取和移除。", "This project is archived: adding grants and new invitations is disabled. Existing grants remain readable and removable.")}</p>}
        <ul className="max-h-56 space-y-2 overflow-auto">{matching.map(member => <li key={member.userId} className="space-y-2 rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><ShareIdentity member={member} /><Button size="sm" variant="outline" disabled={locked || archived || !member.access?.capabilities.includes("domain.read")} aria-label={t(`添加 ${member.name} 到当前项目`, `Add ${member.name} to this project`)} onClick={() => openDraft(member, "add")}><UserPlus aria-hidden="true" />{t("添加", "Add")}</Button></div>
          <AccessPermissions capabilities={member.access!.capabilities} />
          {!member.access!.capabilities.includes("domain.read") && <p className="text-xs text-muted-foreground">{t("不能靠添加范围赋予读取权；请到完整能力编辑器显式调整。", "Adding scope cannot grant read permission; use the full capability editor for an explicit change.")}</p>}
        </li>)}</ul>
        {matching.length === 0 && <p className="text-sm text-muted-foreground">{t("没有匹配的未授权成员。已有项目/工作区授权在上方；已撤销成员需到完整编辑器管理。新账号请使用下方邮件邀请。", "No matching ungranted members. Existing project/workspace grants are above; revoked memberships require the full editor. Invite new accounts by email below.")}</p>}
      </section>
      {operation && <section className="space-y-3 rounded-md border p-3 text-sm" aria-label={t("待保存的项目范围修改", "Draft project scope change")}>
        <h3 className="font-medium">{operation.action === "add" ? t("添加当前项目范围：", "Add this project scope: ") : t("仅移除当前项目范围：", "Remove only this project scope: ")}{operation.name}</h3>
        <p>{t("原版本：", "Original version: ")}{operation.base.version} · {t("原项目范围：", "Original project scope: ")}{operation.base.projectIds === null ? t("整个工作区（继承）", "Whole workspace (inherited)") : operation.base.projectIds.join(", ") || t("无项目", "No projects")}</p>
        <AccessPermissions capabilities={operation.base.capabilities} />
        {operation.action === "remove" && operation.base.projectIds?.length === 1 && <p>{t("这是最后一个项目。保存后保留成员资格及全部能力，项目范围变为空数组；不会撤销整个工作区成员资格。", "This is the final project. Saving retains the membership and all capabilities with an empty project scope; it does not revoke workspace membership.")}</p>}
        {conflict && <div role="status" className="space-y-2"><p>{t("授权版本已变化或当前记录不可读；草稿保留，未自动重试。请比较当前授权后再采用新版本。", "Access changed or the current record is unavailable. Draft retained; no automatic retry. Compare current grants before adopting their version.")}</p>{current?.access && <><p>{t("当前项目范围：", "Current project scope: ")}{current.access.projectIds === null ? t("整个工作区（继承）", "Whole workspace (inherited)") : current.access.projectIds.join(", ") || t("无项目", "No projects")}</p><AccessPermissions capabilities={current.access.capabilities} /><Button variant="outline" disabled={locked} onClick={() => setOperation(projectShareDraft(current, operation.action))}>{t("保留操作，采用当前能力和范围版本", "Keep action, adopt current grants and version")}</Button></>}</div>}
        {currentScope === "inherited" && <p role="status">{t("当前授权来自整个工作区，不能在此添加或单项目移除；请使用完整能力编辑器。", "Current access is inherited from the whole workspace. It cannot be added or removed per project here; use the full capability editor.")}</p>}
        {currentScope === "revoked" && <p role="status">{t("当前成员资格已撤销。此对话框不会重新激活旧权限；请使用完整能力编辑器。", "This membership is revoked. This dialog will not reactivate old grants; use the full capability editor.")}</p>}
        {(operation.action === "add" && currentScope === "direct" || operation.action === "remove" && currentScope === "none") && <p role="status">{t("当前范围已包含所需结果，不会重复提交。可取消此草稿。", "The current scope already has the requested result. No duplicate request will be submitted; cancel this draft.")}</p>}
        <Form label={operation.action === "add" ? t("确认添加项目范围", "Confirm adding project scope") : t("确认仅移除此项目", "Confirm removing only this project")} disabled={locked || conflict || !current?.access || currentScope !== (operation.action === "add" ? "none" : "direct") || operation.action === "add" && (archived || !current.access.capabilities.includes("domain.read"))} onSubmit={async () => { await execute(projectShareMemberCommand(workspace, project, operation, current?.access, crypto.randomUUID())) }}>
          <p>{t("其他项目、独立能力和成员资格均保留。若其他范围已失效，服务可能拒绝本次保存；不会替你删去其他授权。", "Other projects, capabilities and membership are retained. The server may reject saving if another scope is no longer valid; no other grants will be silently stripped.")}</p>
        </Form>
        <Button variant="ghost" disabled={busy} onClick={() => setOperation(null)}>{t("取消范围修改", "Cancel scope change")}</Button>
      </section>}
      <section className="space-y-3 border-t pt-4" aria-label={t("邀请新成员到此项目", "Invite new members to this project")}>
        <h3 className="font-medium">{t("通过邮箱邀请新成员", "Invite a new member by email")}</h3>
        {invitations.isPending && !invitations.data && <p role="status" className="text-sm">{t("正在读取 SMTP 邀请能力…", "Reading SMTP invitation capability…")}</p>}
        {invitations.error && <p role="alert" className="break-words text-sm text-destructive">{t("邀请状态读取失败，发送已禁用；如有显示，仅为上次服务快照：", "Invitation status read failed; sending disabled. Any displayed statuses are the previous server snapshot: ")}{invitations.error.message}</p>}
        {invitations.data && !smtpEnabled && <p role="status" className="text-sm">{t("SMTP / 邀请部署未配置或状态不可用：不能发送邮件邀请，不会创建虚假待发送记录。已有成员授权不依赖 SMTP。", "SMTP / invitation deployment is not configured or unavailable: email invitations are disabled, with no fake queued records. Existing-member grants do not require SMTP.")}</p>}
        <Form label={t("发送当前项目邀请", "Send invitation for this project")} disabled={invitationBlocked} onSubmit={async () => { await execute(projectShareInvitationCommand(workspace, project, email, role, smtpEnabled, crypto.randomUUID())) }}>
          <Field label={t("受邀邮箱", "Invitation email")} value={email} onChange={setEmail} type="email" required />
          <Choice label={t("新成员能力模板（不是单项目角色）", "New member capability template (not a per-project role)")} value={role} onChange={value => setRole(value === "member" ? "member" : "guest")} options={[{ value: "guest", label: t("Guest · 只读", "Guest · Read-only") }, { value: "member", label: t("Member · 规划与交付", "Member · Planning and delivery") }]} />
          <AccessPermissions capabilities={memberRoleCapabilities(role)} />
          <p className="text-sm">{t("固定范围：", "Fixed scope: ")}{project.id} · {string(project.data.name)}</p>
          <p className="text-xs text-muted-foreground">{t("邀请不会覆盖已有有效成员授权。SMTP 接受不代表收件箱送达；收件人需接受邀请后才获得权限。", "Invitations cannot overwrite active membership grants. SMTP acceptance is not inbox delivery; recipients gain access only after accepting.")}</p>
        </Form>
        <div className="space-y-2 text-sm"><h4 className="font-medium">{t("适用于本项目的邀请记录", "Invitation records applicable to this project")}</h4>
          {invitations.data && !invitations.error && invitationItems.length === 0 && <p>{t("没有邀请记录。", "No invitation records.")}</p>}
          <ul className="space-y-2">{invitationItems.map(invitation => <li key={invitation.id} className="space-y-1 rounded-md border p-3"><p className="break-all font-medium">{invitation.email} · {invitation.role}</p><InvitationStatus invitation={invitationRecord(invitation)} /><p className="text-xs text-muted-foreground">{invitation.projectIds === null ? t("整个工作区（继承）", "Whole workspace (inherited)") : `${t("项目范围：", "Project scope: ")}${invitation.projectIds.join(", ")}`} · {t("有效期至：", "Expires: ")}<time dateTime={invitation.expiresAt}>{invitation.expiresAt}</time></p>{invitation.delivery?.failureCode && <p role="status">{invitation.delivery.failureCode}</p>}</li>)}</ul>
          <Link className="inline-block underline" to={`${membersHref}&panel=invitations`} aria-disabled={busy} tabIndex={busy ? -1 : undefined} onClick={event => { if (busy) event.preventDefault(); else onNavigate() }}>{t("管理完整邀请记录、撤销和显式重发", "Manage full invitation records, revocation and explicit resend")}</Link>
        </div>
      </section>
    </>}
  </div>
}

import { useState } from "react"
import { Mail, RefreshCw, UserPen, UserPlus } from "lucide-react"
import { useSearchParams } from "react-router"
import type { MemberInvitationDto } from "@contracts"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { MemberDirectoryView } from "@/views/pm/member-directory"
import { InvitationStatus } from "@/views/pm/people-views"
import type { ControlledContactCopyReceipt, ControlledInvitation, ControlledMember, MemberDirectoryInteraction, MemberDirectorySort } from "@/views/pm/people-controlled-contracts"
import { usePmCommand, usePmService } from "./pm-service"
import { memberViews, resolveVariant, usePmDisplaySetting } from "./pm-display-settings"
import { ServiceGuard, CommandNotice, useText, allowed, queryData, useDraftState } from "./pm-ui"
import { useMemberDirectory, useMemberInvitations } from "./pm-member-hooks"
import { directoryMemberRecord, invitationRecord, memberRoleValues, visibleDirectoryMembers } from "./pm-member-model"
import { MemberAccessForm, MemberInvitationForm, MemberInvitationOperationDialog, MemberSelfProfileEditor, type InvitationOperation } from "./pm-member-editors"

export function ServiceMembers() {
  const { workspace, actor } = usePmService()
  const t = useText()
  const query = useMemberDirectory()
  const invitationQuery = useMemberInvitations()
  const command = usePmCommand()
  const [searchParams, setSearchParams] = useSearchParams()
  const configuredView = usePmDisplaySetting(workspace?.id, "memberView")
  const variant = resolveVariant(searchParams.get("view"), configuredView, memberViews)
  const [editor, setEditor] = useDraftState<{ userId: string | null; mode: "role" | "capabilities" } | null>("members-directory", "accessEditor", null)
  const profileOpen = searchParams.get("profile") === "me"
  const inviteOpen = searchParams.get("panel") === "invitations"
  const setPanel = (key: "profile" | "panel", value: string | null) => {
    const next = new URLSearchParams(searchParams)
    next.set("tab", "members")
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next)
  }
  const [operation, setOperation] = useDraftState<InvitationOperation | null>("members-directory", "invitationOperation", null)
  const [copyReceipt, setCopyReceipt] = useState<ControlledContactCopyReceipt | null>(null)
  const [interaction, setInteraction] = useDraftState<MemberDirectoryInteraction>("members-directory", "interaction", {
    query: "", roleFilter: null, activeFilter: "all", sort: "name", display: "grid",
    comfortable: false, hiddenColumns: [], tab: "members", selectedIds: [],
    selectedId: null, detailOpen: false,
  })
  const canManage = allowed(workspace, "access.manage") && !!query.data?.capabilities.canManageMembers
  const canEditProfile = !!query.data?.capabilities.canEditSelfProfile
  const readBlocked = !query.data || !!query.error
  const locked = readBlocked || command.pending || !!command.unknownCommand
  const invitationBlocked = !canManage || !invitationQuery.data || !!invitationQuery.error
  const smtpEnabled = invitationQuery.data?.enabled === true
  const all = (query.data?.members ?? []).map(member => directoryMemberRecord(member, workspace?.ownerId, query.estimatedServerNow, query.data!.presenceTtlMs))
  const roles = [
    { value: memberRoleValues.admin, label: "Admin" }, { value: memberRoleValues.member, label: "Member" },
    { value: memberRoleValues.guest, label: "Guest" }, { value: memberRoleValues.custom, label: "Custom" },
    { value: memberRoleValues.unknown, label: t("角色未提供", "Role unavailable") },
  ]
  const sortOptions: MemberDirectorySort[] = ["name", "name-desc", "joined", "joined-desc", "teams", "teams-desc", "presence"]
  const roleAvailable = !!query.data && all.every(member => member.role !== memberRoleValues.unknown)
  if (roleAvailable) sortOptions.push("role")
  const effectiveState: MemberDirectoryInteraction = {
    ...interaction,
    roleFilter: roleAvailable && variant === "member3" ? interaction.roleFilter : null,
    roleFilters: roleAvailable && variant === "member1" ? interaction.roleFilters : [],
    presenceFilters: variant === "member1" ? interaction.presenceFilters : [],
    activeFilter: variant === "member1" ? interaction.activeFilter : "all",
    securityFilter: "any",
    sort: sortOptions.includes(interaction.sort) ? interaction.sort : "name",
  }
  const filtered = visibleDirectoryMembers(all, effectiveState, variant)
  const invitationItems = invitationQuery.data?.items ?? []
  const invitations = invitationItems.map(invitationRecord).filter(invitation =>
    invitation.email.toLocaleLowerCase().includes(interaction.query.trim().toLocaleLowerCase()) &&
    (effectiveState.roleFilter === null || invitation.role === effectiveState.roleFilter)
  )
  const selectedEditor = query.data?.members.find(member => member.userId === editor?.userId)
  const manage = (member: ControlledMember, mode: "role" | "capabilities") => {
    if (canManage && !locked) setEditor({ userId: member.userId, mode })
  }
  const invitationAction = (row: ControlledInvitation, kind: "revoke" | "resend") => {
    const invitation = invitationItems.find(item => item.id === row.id)
    if (invitation && !invitationBlocked && !locked) setOperation({ kind, invitation })
  }
  const invitationNotice = !canManage
    ? t("目录可读，但仅整个工作区的管理员可查看和管理邀请。", "You can read the directory; only workspace-wide administrators can view or manage invitations.")
    : !smtpEnabled && invitationQuery.data
      ? t("SMTP 未配置：不能新建或重发邀请；已有邀请的状态与撤销仍可查看。", "SMTP is not configured: creating and resending invitations are disabled. Existing statuses and revocation remain available.")
      : undefined
  const header = <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
    {query.data && <span className="text-xs text-muted-foreground" data-pm-member-count>{t(`${all.length} 位可见成员`, `${all.length} visible members`)}</span>}
    <select className="h-8 max-w-full rounded-md border bg-background px-2 text-xs" aria-label={t("成员布局", "Member layout")} value={variant} onChange={event => {
      const next = new URLSearchParams(searchParams)
      next.set("view", event.target.value)
      setSearchParams(next)
    }}><option value="member1">{t("目录表格", "Directory table")}</option><option value="member2">{t("联系卡片", "Contact cards")}</option><option value="member3">{t("管理表格", "Management table")}</option></select>
    <Button variant="outline" disabled={!query.data} onClick={() => setPanel("profile", "me")}><UserPen aria-hidden="true" />{t("本人资料", "My profile")}</Button>
    {canManage && <Button variant="outline" disabled={locked} onClick={() => setEditor({ userId: null, mode: "capabilities" })} title={t("直接授权已存在账号，不发送邮件", "Grant an existing account access without sending email")}><UserPlus aria-hidden="true" />{t("授权已有账号", "Grant existing account")}</Button>}
    {canManage && <Button variant="outline" onClick={() => setPanel("panel", "invitations")}><Mail aria-hidden="true" />{t("邀请记录", "Invitations")}</Button>}
    {canManage && variant !== "member3" && <Button disabled={locked || invitationBlocked || !smtpEnabled} onClick={() => setPanel("panel", "invitations")}><UserPlus aria-hidden="true" />{t("邀请成员", "Invite member")}</Button>}
    <Button size="icon" variant="ghost" aria-label={t("刷新成员与邀请", "Refresh members and invitations")} disabled={query.isFetching || canManage && invitationQuery.isFetching} onClick={() => { void query.refetch(); if (canManage) void invitationQuery.refetch() }}><RefreshCw aria-hidden="true" /></Button>
  </div>
  return <ServiceGuard>
    <CommandNotice />
    <MemberDirectoryView
      interactive
      embedded
      variant={variant}
      headerActions={header}
      readModel={{
        members: filtered, selectedMember: all.find(member => member.membershipId === interaction.selectedId) ?? null,
        teams: [], teamsAvailable: true, roles,
        invitations, invitationsData: canManage ? queryData({ ...invitationQuery, data: invitationQuery.data?.items }, invitations.length) : { state: "empty" },
        invitationsNotice: invitationNotice, suggestedContacts: null, totalMemberCount: all.length,
        sortOptions, copyReceipt: copyReceipt && all.some(member => member.userId === copyReceipt.membershipId) ? copyReceipt : null,
        data: queryData({ ...query, data: query.data?.members }, filtered.length),
        sourceDescription: t("目录按当前授权范围脱敏；团队不授予权限。2FA 没有权威来源，状态与筛选明确不可用。", "The directory is redacted to your current access scope. Teams grant no permissions. No authoritative 2FA source is configured; its status and filters are unavailable."),
      }}
      interaction={effectiveState}
      capabilities={{
        invite: canManage && !locked && !invitationBlocked && smtpEnabled,
        editRole: member => canManage && !locked && member.role !== memberRoleValues.unknown,
        memberOpen: () => !readBlocked, reconcileInvitation: !command.pending,
        manageAccess: () => canManage && !locked, filterPresence: !!query.data, filterSecurity: false, filterRole: roleAvailable,
        copyContact: (member, kind) => !readBlocked && (kind === "email" ? !!member.email : kind === "phone" ? !!member.phone : !!member.email || !!member.phone),
        cancelInvitation: row => !locked && !invitationBlocked && row.status !== "accepted" && row.status !== "revoked",
        resendInvitation: row => !locked && !invitationBlocked && row.status !== "accepted" && row.status !== "revoked" && smtpEnabled && row.deliveryStatus !== "sending",
      }}
      actions={{
        setInteraction,
        memberOpen: member => setInteraction(previous => ({ ...previous, selectedId: member.membershipId, detailOpen: true })),
        memberWorkload: member => {
          setInteraction(previous => ({ ...previous, detailOpen: false }))
          const next = new URLSearchParams(searchParams)
          next.set("tab", "workload")
          next.set("memberId", member.userId)
          next.delete("teamId")
          next.delete("profile")
          next.delete("panel")
          setSearchParams(next)
        },
        editRole: member => { setInteraction(previous => ({ ...previous, detailOpen: false })); manage(member, "role") },
        manageAccess: member => manage(member, "capabilities"),
        invite: () => setPanel("panel", "invitations"),
        reconcileInvitation: () => { if (command.unknownCommand) void command.reconcile().catch(() => undefined); else void invitationQuery.refetch() },
        cancelInvitation: row => invitationAction(row, "revoke"), resendInvitation: row => invitationAction(row, "resend"),
        copyContact: (member, kind) => {
          const value = kind === "email" ? member.email : kind === "phone" ? member.phone : [member.email, member.phone].filter(Boolean).join("\n")
          if (!value) return
          void (async () => {
            let ok = false
            try { await navigator.clipboard.writeText(value); ok = true } catch { /* The visible source value remains selectable. */ }
            setCopyReceipt({ membershipId: member.membershipId, kind, ok })
          })()
        },
      }}
      inviteEditor={variant === "member3" ? <div id="pm-member-invitation-editor" className="p-6 max-sm:p-5">{canManage
        ? inviteOpen ? <p role="status">{t("邀请草稿在邀请面板中继续编辑。", "Continue editing the invitation draft in the invitations panel.")}</p> : <MemberInvitationForm disabled={locked || invitationBlocked} enabled={smtpEnabled} />
        : <p role="status">{t("当前可读取成员目录，但没有邀请与授权管理权限。", "You can read the member directory but cannot manage invitations or access.")}</p>}</div> : undefined}
      inviteDialog={<Dialog open={inviteOpen} onOpenChange={open => setPanel("panel", open ? "invitations" : null)}><DialogContent className="max-w-3xl">
        <DialogTitle>{t("成员邀请", "Member invitations")}</DialogTitle><DialogDescription>{t("真实邮件邀请与投递状态；SMTP 接受不代表送达。", "Real email invitations and delivery status; SMTP acceptance is not delivery.")}</DialogDescription>
        <DialogBody className="space-y-6"><CommandNotice />{query.error && <p role="alert">{query.error.message}<Button variant="outline" onClick={() => { void query.refetch() }}>{t("重试成员读取", "Retry member read")}</Button></p>}{!query.data && !query.error ? <p role="status">{t("正在读取成员权限…", "Reading member permissions…")}</p> : canManage ? <><MemberInvitationForm disabled={locked || invitationBlocked} enabled={smtpEnabled} />
          <InvitationRecords items={invitationItems} loading={invitationQuery.isPending} error={invitationQuery.error} refresh={() => { void invitationQuery.refetch() }} disabled={locked || invitationBlocked} enabled={smtpEnabled} onOperation={(invitation, kind) => setOperation({ invitation, kind })} />
        </> : <p role="status">{invitationNotice}</p>}</DialogBody>
      </DialogContent></Dialog>}
      roleEditor={<Dialog open={editor !== null && canManage} onOpenChange={open => { if (!open) setEditor(null) }}><DialogContent className="max-w-2xl">
        <DialogTitle>{editor?.mode === "role" ? t("角色模板", "Role template") : t("成员能力与访问", "Member capabilities and access")}</DialogTitle>
        <DialogDescription>{t("仅当前工作区管理员可修改；版本冲突与未知结果保留草稿。", "Only current workspace administrators can make changes. Conflicts and unknown outcomes retain the draft.")}</DialogDescription>
        <DialogBody className="space-y-4"><CommandNotice />
          {editor?.userId && <div className="flex gap-2"><Button variant={editor.mode === "role" ? "secondary" : "outline"} disabled={locked} onClick={() => setEditor({ ...editor, mode: "role" })}>{t("角色模板", "Role template")}</Button><Button variant={editor.mode === "capabilities" ? "secondary" : "outline"} disabled={locked} onClick={() => setEditor({ ...editor, mode: "capabilities" })}>{t("编辑独立能力", "Edit capabilities")}</Button></div>}
          {editor && (!editor.userId || selectedEditor?.access) && <MemberAccessForm key={`${actor?.id}:${workspace?.id}:${editor.userId ?? "new"}:${editor.mode}`} member={selectedEditor} all={query.data?.members ?? []} mode={editor.mode} disabled={!canManage || readBlocked} />}
        </DialogBody>
      </DialogContent></Dialog>}
    />
    <Dialog open={profileOpen} onOpenChange={open => setPanel("profile", open ? "me" : null)}><DialogContent>
      <DialogTitle>{t("本人资料", "My profile")}</DialogTitle><DialogDescription>{t("仅修改本人，资料版本跨工作区共享。2FA 暂无可信身份源，不提供虚假开关。", "Edit only your own profile; its version is shared across workspaces. No trusted 2FA source is configured, so no simulated switch is offered.")}</DialogDescription>
      <DialogBody className="space-y-4"><CommandNotice />
        {query.error && <p role="alert">{query.error.message}<Button variant="outline" onClick={() => { void query.refetch() }}>{t("重试资料读取", "Retry profile read")}</Button></p>}
        {!query.data && !query.error && <p role="status">{t("正在读取本人资料…", "Reading your profile…")}</p>}
        {query.data && <>{!canEditProfile && <p role="status">{t("当前授权只能读取本人资料，不能修改。", "Your current access allows reading, but not editing, your profile.")}</p>}<MemberSelfProfileEditor key={`${actor?.id}:${workspace?.id}`} profile={query.data.selfProfile} disabled={!canEditProfile || readBlocked} /></>}
      </DialogBody>
    </DialogContent></Dialog>
    <MemberInvitationOperationDialog operation={canManage ? operation : null} current={invitationItems} disabled={locked || invitationBlocked} enabled={smtpEnabled} onClose={() => setOperation(null)} />
  </ServiceGuard>
}

function InvitationRecords({ items, loading, error, refresh, disabled, enabled, onOperation }: { items: readonly MemberInvitationDto[]; loading: boolean; error: Error | null; refresh: () => void; disabled: boolean; enabled: boolean; onOperation: (invitation: MemberInvitationDto, kind: "revoke" | "resend") => void }) {
  const t = useText()
  return <section className="space-y-3" aria-label={t("邀请记录", "Invitation records")}><div className="flex items-center justify-between gap-2"><h3>{t("邀请记录", "Invitation records")}</h3><Button variant="outline" onClick={refresh}>{t("刷新状态", "Refresh status")}</Button></div>
    {loading && <p role="status">{t("读取真实邀请状态…", "Reading invitation status…")}</p>}
    {error && <p role="alert">{error.message}</p>}
    {!loading && !error && items.length === 0 && <p>{t("没有邀请记录。", "No invitation records.")}</p>}
    <ul className="space-y-3">{items.map(invitation => <li key={invitation.id} className="space-y-2 rounded border p-3 text-sm">
      <p className="break-all font-medium">{invitation.email} · {invitation.role}</p><InvitationStatus invitation={invitationRecord(invitation)} />
      <p>{t("有效期至：", "Expires: ")}<time dateTime={invitation.expiresAt}>{invitation.expiresAt}</time></p>
      <p>{t("范围：", "Scope: ")}{invitation.projectIds?.join(", ") ?? t("整个工作区", "Whole workspace")}</p>
      {invitation.delivery?.failureCode && <p role="status">{invitation.delivery.failureCode}</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={disabled || invitation.status === "accepted" || invitation.status === "revoked"} onClick={() => onOperation(invitation, "revoke")}>{t("撤销", "Revoke")}</Button><Button variant="outline" disabled={disabled || !enabled || invitation.status === "accepted" || invitation.status === "revoked" || invitation.delivery?.status === "sending"} onClick={() => onOperation(invitation, "resend")}>{t("重发并作废旧链接", "Resend and invalidate old link")}</Button></div>
    </li>)}</ul>
  </section>
}

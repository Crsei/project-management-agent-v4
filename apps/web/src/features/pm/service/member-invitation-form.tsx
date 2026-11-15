import { useEffect, useRef, useState } from "react"
import { CommandOutcomeUnknown, type CommandReceipt, type MemberInvitationDto, type MemberRole } from "@contracts"
import { Button } from "@/components/ui/button"
import { usePmCommand } from "./pm-service"
import { Choice, Field, Form, useDraftState, useText } from "./pm-ui"
import { useTeamDirectory } from "./pm-team-hooks"
import { MemberCapabilityPreview, MemberScopeFields } from "./member-access-fields"
import { prepareInvitationBatch, type InvitationAttempt } from "./member-invitation-model"

export function InvitationBatchForm({ disabled, enabled, defaultProjectId, defaultTeamIds = [], onInvited }: { disabled: boolean; enabled: boolean; defaultProjectId?: string; defaultTeamIds?: readonly string[]; onInvited?: () => void | Promise<void> }) {
  const t = useText()
  const command = usePmCommand()
  const directory = useTeamDirectory()
  const scope = `member-invitation:${defaultProjectId ?? "workspace"}:${[...defaultTeamIds].sort().join(",")}`
  const [emails, setEmails] = useDraftState(scope, "emails", "")
  const [role, setRole] = useDraftState<MemberRole>(scope, "role", "member")
  const [whole, setWhole] = useDraftState(scope, "whole", !defaultProjectId)
  const [projects, setProjects] = useDraftState<string[]>(scope, "projects", defaultProjectId ? [defaultProjectId] : [])
  const [teamIds, setTeamIds] = useDraftState<string[]>(scope, "teams", [...defaultTeamIds])
  const [attempts, setAttempts] = useDraftState<InvitationAttempt[]>(scope, "attempts", [])
  const attemptsWriter = useRef(setAttempts)
  attemptsWriter.current = setAttempts
  useEffect(() => {
    const original = command.unknownCommand
    const receipt = command.receipt
    attemptsWriter.current(rows => {
      if (original?.commandType === "CreateMemberInvitation" && typeof original.payload.email === "string" && !rows.some(row => row.command.commandId === original.commandId)) {
        return [...rows, { email: original.payload.email, command: original, status: "unknown" }]
      }
      if (!receipt || !rows.some(row => row.command.commandId === receipt.commandId && row.status === "unknown")) return rows
      return rows.map(row => row.command.commandId === receipt.commandId ? { ...row, status: receipt.status === "committed" ? "committed" : "rejected", error: receipt.status === "rejected" ? receipt.error.message : "" } : row)
    })
  }, [command.unknownCommand, command.receipt])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const projectOptions = directory.error ? [] : (directory.data?.projects ?? []).filter(project => project.canManage)
  const teams = directory.error ? [] : (directory.data?.teams ?? []).filter(team => !team.data.archivedAt)
  const unavailable = !directory.data?.canManage || !!directory.error
  const invalid = role !== "admin" && !whole && (!projects.length || projects.some(id => !projectOptions.some(project => project.id === id))) || teamIds.some(id => !teams.some(team => team.id === id))
  const locked = disabled || !enabled || unavailable || busy || command.pending || !!command.unknownCommand
  const update = (id: string, change: Partial<InvitationAttempt>) => setAttempts(rows => rows.map(row => row.command.commandId === id ? { ...row, ...change } : row))
  const settle = (id: string, receipt: CommandReceipt) => {
    const invitation = receipt.status === "committed" ? receipt.result as MemberInvitationDto : null
    update(id, { status: receipt.status === "committed" ? "committed" : "rejected", ...(invitation ? { invitationId: invitation.id } : {}), error: receipt.status === "rejected" ? receipt.error.message : "" })
  }
  const changed = async () => {
    try { await onInvited?.() } catch { setNotice(t("邀请已确认，但列表刷新失败；请刷新列表。", "Invitation confirmed, but the list refresh failed. Refresh the list.")) }
  }
  const send = async (attempt: InvitationAttempt) => {
    update(attempt.command.commandId, { status: "unknown", error: "" })
    try {
      const receipt = await command.execute(attempt.command)
      settle(attempt.command.commandId, receipt)
    } catch (error) {
      update(attempt.command.commandId, { status: error instanceof CommandOutcomeUnknown ? "unknown" : "rejected", error: error instanceof Error ? error.message : String(error) })
      return false
    }
    await changed()
    return true
  }
  const reconcile = async (attempt: InvitationAttempt) => {
    if (command.unknownCommand?.commandId !== attempt.command.commandId) return
    setBusy(true)
    try {
      const receipt = await command.reconcile()
      if (receipt) { settle(attempt.command.commandId, receipt); if (receipt.status === "committed") await changed() }
    } catch (error) {
      // A rejected receipt is authoritative; transport failures stay unresolved.
      if (error && typeof error === "object" && "receipt" in error) settle(attempt.command.commandId, error.receipt as CommandReceipt)
      else setNotice(t("仍无法核对，保留原命令，不能生成替代邀请。", "Still unresolved. Keep the original command; do not create a replacement invitation."))
    } finally { setBusy(false) }
  }
  const unresolved = attempts.some(attempt => attempt.status === "ready" || attempt.status === "unknown")
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t("账号、工作区授权、团队归属不同。接受后才激活授权并加入所选团队；团队不额外授予项目权限。", "Accounts, workspace access and teams are separate. Access and selected team membership activate only on acceptance; teams grant no additional project access.")}</p>
    {!enabled && <p role="status">{t("SMTP 未配置或状态不可用，不能创建或重发邀请；不会伪造已发送。", "SMTP is not configured or unavailable. Invitations cannot be created or resent; no delivery is fabricated.")}</p>}
    {directory.error && <p role="alert">{t("项目与团队读取失败，邀请已禁用。", "Projects and teams could not be read. Invitations are disabled.")}<Button variant="outline" onClick={() => { void directory.refetch() }}>{t("重试读取", "Retry read")}</Button></p>}
    <Form label={t("逐项发送邀请", "Send invitations individually")} disabled={locked || unresolved} onSubmit={async () => {
      if (invalid) throw new Error(t("请选择当前可用的项目与团队。", "Select currently available projects and teams."))
      const batch = prepareInvitationBatch({ emails, role, projectIds: role === "admin" || whole ? null : projects, teamIds })
      setAttempts(rows => [...rows, ...batch]); setEmails(""); setNotice(""); setBusy(true)
      try { for (const attempt of batch) if (!await send(attempt)) break } finally { setBusy(false) }
    }}>
      <Field label={t("受邀邮箱（换行、逗号或分号分隔，最多100项）", "Invitation emails (newline, comma or semicolon; maximum 100)")} value={emails} onChange={setEmails} multiline required />
      <Choice label={t("角色模板", "Role template")} value={role} onChange={value => setRole(value as MemberRole)} options={[{ value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "guest", label: "Guest" }]} />
      <MemberCapabilityPreview before={[]} role={role} />
      <MemberScopeFields whole={whole} setWhole={setWhole} projects={projects} setProjects={setProjects} options={projectOptions} admin={role === "admin"} />
      <fieldset className="max-h-56 space-y-2 overflow-y-auto rounded border p-3"><legend className="text-sm">{t("接受后加入团队（可选）", "Join teams upon acceptance (optional)")}</legend>{teams.map(team => <label key={team.id} className="flex gap-2 text-sm"><input type="checkbox" checked={teamIds.includes(team.id)} onChange={event => setTeamIds(event.target.checked ? [...teamIds, team.id] : teamIds.filter(id => id !== team.id))} />{team.data.name}</label>)}{teamIds.some(id => !teams.some(team => team.id === id)) && <p role="alert">{t("已选团队不再可用。", "A selected team is unavailable.")}<Button type="button" variant="outline" onClick={() => setTeamIds(teamIds.filter(id => teams.some(team => team.id === id)))}>{t("清除不可用团队", "Clear unavailable teams")}</Button></p>}</fieldset>
    </Form>
    {notice && <p role="status">{notice}</p>}
    {attempts.length > 0 && <section className="space-y-3" aria-label={t("逐项邀请结果", "Per-address invitation results")}><p className="text-xs text-muted-foreground">{t("每项保留自己的原命令。邀请已创建不等于邮件已发送，SMTP接受也不等于收件箱送达；完整投递状态见邀请记录。", "Each address retains its original command. Creation is not email delivery; SMTP acceptance is not inbox delivery. See invitation records for delivery status.")}</p>{attempts.map(attempt => <article key={attempt.command.commandId} className="space-y-2 rounded border p-3 text-sm"><p className="break-all">{attempt.email} · {attempt.status === "committed" ? t("邀请已确认创建；投递状态请查记录", "Invitation confirmed; check delivery records") : attempt.status === "rejected" ? t("本项未成功", "This item failed") : attempt.status === "ready" ? t("未发送", "Not sent") : t("结果未知，须核对", "Outcome unknown; reconcile first")}</p><p className="break-all text-xs">{t("原命令：", "Original command: ")}{attempt.command.commandId}</p>{attempt.error && <p role="alert">{attempt.error}</p>}{attempt.status === "ready" && <Button disabled={locked} variant="outline" onClick={() => { setBusy(true); void send(attempt).finally(() => setBusy(false)) }}>{t("发送此项原请求", "Send this original request")}</Button>}{attempt.status === "unknown" && <Button disabled={disabled || busy || command.pending || command.unknownCommand?.commandId !== attempt.command.commandId} variant="outline" onClick={() => { void reconcile(attempt) }}>{t("核对本项原命令", "Reconcile this original command")}</Button>}</article>)}</section>}
  </div>
}

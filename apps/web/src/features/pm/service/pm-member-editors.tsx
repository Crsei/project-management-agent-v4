import { useState } from "react"
import { z } from "zod"
import type { CommandPayloadMap, MemberDirectoryAccess, MemberDirectoryMember, MemberInvitationDto, MemberRole, SelfProfile } from "@contracts"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { InvitationStatus } from "@/views/pm/people-views"
import { usePmCommand, usePmService } from "./pm-service"
import { Choice, CommandNotice, Field, Form, entityReference, lines, makeCommand, useDraftState, useText, uuid } from "./pm-ui"
import { invitationRecord } from "./pm-member-model"

const capabilities = ["domain.read", "directory.read", "audit.read", "intent.propose", "intent.decide", "planning.edit", "planning.lifecycle", "workitem.cancel_reopen", "delivery.write", "delivery.submit", "delivery.review", "workitem.complete", "access.manage"] as const
const roleOptions = [{ value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "guest", label: "Guest" }]

export function MemberRoleExplanation() {
  const t = useText()
  return <p className="text-sm text-muted-foreground">{t("角色是显式能力模板：Admin 管理整个工作区；Member 可提议、规划、交付和提交；Guest 只读。角色不隐含审核或完成权。Custom 表示现有自定义能力，只有明确保存模板才会替换。团队归属不授予权限。", "Roles are explicit capability templates: Admin manages the whole workspace; Member can propose, plan, deliver and submit; Guest is read-only. Roles never imply review or completion rights. Custom preserves existing grants until you explicitly save a template. Team membership grants no access.")}</p>
}

function ScopeFields({ whole, setWhole, projects, setProjects, admin = false }: { whole: boolean; setWhole: (value: boolean) => void; projects: string; setProjects: (value: string) => void; admin?: boolean }) {
  const t = useText()
  return <><label className="flex gap-2 text-sm"><input type="checkbox" checked={admin || whole} disabled={admin} onChange={event => setWhole(event.target.checked)} />{t("整个工作区", "Whole workspace")}</label>{admin && <p className="text-xs text-muted-foreground">{t("Admin 必须覆盖整个工作区。", "Admin requires workspace-wide scope.")}</p>}{!admin && !whole && <Field label={t("授权项目 ID（每行一项；团队不会自动授权）", "Authorized project IDs (one per line; teams do not grant access)")} value={projects} onChange={setProjects} multiline required />}</>
}

export function MemberAccessForm({ member, all, mode, disabled }: { member?: MemberDirectoryMember; all: readonly MemberDirectoryMember[]; mode: "role" | "capabilities"; disabled: boolean }) {
  const t = useText()
  const command = usePmCommand()
  const scope = `member-access:${member?.userId ?? "new"}:${mode}`
  const [base, setBase] = useDraftState<MemberDirectoryAccess | null>(scope, "base", member?.access ?? null)
  const [userId, setUserId] = useDraftState(scope, "userId", member?.userId ?? "")
  const [selected, setSelected] = useDraftState<string[]>(scope, "capabilities", member?.access?.capabilities ?? ["domain.read", "directory.read"])
  const [role, setRole] = useDraftState(scope, "role", member?.role === "admin" || member?.role === "member" || member?.role === "guest" ? member.role : "")
  const [whole, setWhole] = useDraftState(scope, "whole", member?.access?.projectIds === null || !member)
  const [projects, setProjects] = useDraftState(scope, "projects", member?.access?.projectIds?.join("\n") ?? "")
  const [saved, setSaved] = useState(false)
  const fresh = all.find(item => item.userId === userId)?.access ?? null
  const expected = base ?? fresh
  const conflict = !!base && !!fresh && fresh.version > base.version
  const locked = disabled || command.pending || !!command.unknownCommand
  const saveResult = (value: unknown) => {
    const access = z.object({ version: z.number(), capabilities: z.array(z.enum(capabilities)), projectIds: z.array(z.string()).nullable(), revokedAt: z.string().nullable() }).parse(value)
    setBase(access)
    setSaved(true)
  }
  return <div className="space-y-4"><MemberRoleExplanation />
    {conflict && <div role="status" className="space-y-2 rounded border p-3 text-sm"><p>{t("授权已更新，原草稿未丢失。当前能力：", "Access changed; your original draft is retained. Current grants: ")}{fresh.capabilities.join(", ")} · {fresh.projectIds?.join(", ") ?? t("整个工作区", "Whole workspace")}</p><Button variant="outline" disabled={locked} onClick={() => { setBase(fresh); setSaved(false) }}>{t("保留草稿，采用当前版本", "Keep draft, use current version")}</Button></div>}
    <Form label={mode === "role" ? t("保存角色模板", "Save role template") : t("保存成员能力", "Save member capabilities")} disabled={locked || conflict} onSubmit={async () => {
      const id = uuid.parse(userId)
      const projectIds = mode === "role" && role === "admin" || whole ? null : z.array(entityReference).min(1).parse([...new Set(lines(projects))])
      const body = mode === "role"
        ? makeCommand("SetMemberRole", { userId: id, role: z.enum(["admin", "member", "guest"]).parse(role), projectIds })
        : makeCommand("SetWorkspaceMember", { userId: id, capabilities: z.array(z.enum(capabilities)).parse(selected), projectIds })
      body.targetId = id
      body.expectedVersions = expected ? { [id]: expected.version } : {}
      const receipt = await command.execute(body)
      if (receipt.status === "committed") saveResult(receipt.result)
    }}>
      <Field label={t("已创建账号的用户 UUID（不发送邀请邮件）", "Existing account UUID (does not send invitation email)")} value={userId} onChange={value => { setUserId(value); setBase(null); setSaved(false) }} required disabled={!!member} />
      {mode === "role" ? <Choice label={t("显式应用模板（会替换当前能力）", "Explicitly apply template (replaces existing capabilities)")} value={role} onChange={value => { setRole(value); setSaved(false) }} options={[{ value: "", label: t("Custom · 请选择模板", "Custom · choose a template") }, ...roleOptions]} /> : <fieldset className="grid gap-2"><legend className="text-sm">{t("独立能力", "Independent capabilities")}</legend>{capabilities.map(capability => <label key={capability} className="flex gap-2 text-sm"><input type="checkbox" checked={selected.includes(capability)} onChange={event => { setSelected(event.target.checked ? [...selected, capability] : selected.filter(value => value !== capability)); setSaved(false) }} />{capability}</label>)}</fieldset>}
      <ScopeFields whole={whole} setWhole={setWhole} projects={projects} setProjects={setProjects} admin={mode === "role" && role === "admin"} />
    </Form>
    {saved && <p role="status">{t("授权已确认保存。", "Access change confirmed.")}</p>}
    {mode === "capabilities" && expected && <Form label={t("撤销成员访问", "Revoke member access")} disabled={locked || conflict || !!expected.revokedAt} onSubmit={async () => {
      const body = makeCommand("RevokeWorkspaceMember", { userId: uuid.parse(userId) })
      body.targetId = userId
      body.expectedVersions = { [userId]: expected.version }
      const receipt = await command.execute(body)
      if (receipt.status === "committed") saveResult(receipt.result)
    }}><p className="text-sm">{t("撤销立即终止访问；服务端保护最后一名管理员。", "Revocation removes access immediately. The server protects the last administrator.")}</p></Form>}
  </div>
}

type ProfileDraft = { name: string; timeZone: string; jobTitle: string; phone: string; avatarDataUrl: string | null; version: number }
function profileDraft(profile: SelfProfile): ProfileDraft {
  return { name: profile.name, timeZone: profile.timeZone, jobTitle: profile.jobTitle ?? "", phone: profile.phone ?? "", avatarDataUrl: profile.avatarDataUrl, version: profile.version }
}
export function MemberSelfProfileEditor({ profile, disabled }: { profile: SelfProfile; disabled: boolean }) {
  const command = usePmCommand()
  const { refresh } = usePmService()
  const t = useText()
  const [draft, setDraft] = useDraftState("member-self-profile", "draft", () => profileDraft(profile))
  const [imageError, setImageError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const conflict = profile.version !== draft.version
  const locked = disabled || command.pending || !!command.unknownCommand
  const change = (next: ProfileDraft) => { setDraft(next); setSaved(false) }
  return <div className="space-y-4">
    {profile.version > draft.version && <div className="space-y-2 rounded border p-3 text-sm" role="status"><p>{t("本人资料已在其他页面或工作区更新；草稿及原版本保留。服务值：", "Your profile changed in another page or workspace; draft and original version retained. Saved values: ")}{profile.name} · {profile.timeZone} · {profile.jobTitle ?? "—"} · {profile.phone ?? "—"}</p><div className="flex flex-wrap gap-2"><Button disabled={locked} variant="outline" onClick={() => change({ ...draft, version: profile.version })}>{t("保留草稿，采用当前版本", "Keep draft, use current version")}</Button><Button disabled={locked} variant="ghost" onClick={() => change(profileDraft(profile))}>{t("放弃草稿，载入服务值", "Discard draft, load saved values")}</Button></div></div>}
    <Form label={t("保存本人资料", "Save my profile")} disabled={locked || conflict} onSubmit={async () => {
      const payload: CommandPayloadMap["UpdateSelfProfile"] = { name: draft.name.trim(), timeZone: draft.timeZone.trim(), jobTitle: draft.jobTitle.trim() || null, phone: draft.phone.trim() || null, avatarDataUrl: draft.avatarDataUrl }
      const receipt = await command.execute({ commandId: crypto.randomUUID(), commandType: "UpdateSelfProfile", targetId: profile.userId, expectedVersions: { [profile.userId]: draft.version }, payload })
      if (receipt.status !== "committed") return
      change(profileDraft(receipt.result as SelfProfile))
      setSaved(true)
      void refresh().catch(() => undefined)
    }}>
      <Field label={t("姓名", "Name")} value={draft.name} onChange={name => change({ ...draft, name })} required />
      <Field label={t("IANA 时区，例如 Asia/Shanghai", "IANA time zone, e.g. Asia/Shanghai")} value={draft.timeZone} onChange={timeZone => change({ ...draft, timeZone })} required />
      <Field label={t("岗位", "Job title")} value={draft.jobTitle} onChange={jobTitle => change({ ...draft, jobTitle })} />
      <Field label={t("电话（本人和管理员可见）", "Phone (visible to you and administrators)")} value={draft.phone} onChange={phone => change({ ...draft, phone })} type="tel" />
      <div className="flex items-center gap-3"><Avatar name={draft.name} src={draft.avatarDataUrl ?? undefined} size={40} /><Button type="button" variant="outline" disabled={!draft.avatarDataUrl} onClick={() => change({ ...draft, avatarDataUrl: null })}>{t("移除头像", "Remove avatar")}</Button></div>
      <label className="grid gap-1 text-sm"><span>{t("头像：PNG/JPEG/WebP，最大 256 KiB；不接受 SVG 或外部链接", "Avatar: PNG/JPEG/WebP, maximum 256 KiB; no SVG or external URL")}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ""
        if (!file) return
        setImageError(null)
        if (file.size > 256 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setImageError(t("请选择不超过 256 KiB 的 PNG/JPEG/WebP。", "Choose a PNG/JPEG/WebP image no larger than 256 KiB.")); return }
        const reader = new FileReader()
        reader.onerror = () => setImageError(t("头像读取失败。", "Could not read avatar."))
        reader.onload = () => { if (typeof reader.result === "string") { const avatarDataUrl = reader.result; setDraft(previous => ({ ...previous, avatarDataUrl })); setSaved(false) } }
        reader.readAsDataURL(file)
      }} /></label>
      {imageError && <p role="alert" className="text-sm text-destructive">{imageError}</p>}
    </Form>
    {saved && <p role="status">{t("本人资料已确认保存。", "Your profile was saved.")}</p>}
  </div>
}

export function MemberInvitationForm({ disabled, enabled }: { disabled: boolean; enabled: boolean }) {
  const t = useText()
  const command = usePmCommand()
  const [email, setEmail] = useDraftState("member-invitation", "email", "")
  const [role, setRole] = useDraftState<MemberRole>("member-invitation", "role", "member")
  const [whole, setWhole] = useDraftState("member-invitation", "whole", true)
  const [projects, setProjects] = useDraftState("member-invitation", "projects", "")
  const [savedId, setSavedId] = useState<string | null>(null)
  return <div className="space-y-3"><details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("角色模板与授权范围说明", "Role templates and access scope")}</summary><div className="pt-2"><MemberRoleExplanation /></div></details>
    {!enabled && <p role="status" className="text-sm">{t("SMTP 邮件适配器未配置或状态不可用，无法创建或重发邮件邀请。不会创建虚假的待发送记录。", "SMTP is not configured or unavailable. Email invitations cannot be created or resent; no fake pending records are created.")}</p>}
    <Form label={t("发送邀请邮件", "Send invitation email")} disabled={disabled || !enabled || command.pending || !!command.unknownCommand} onSubmit={async () => {
      const body = makeCommand("CreateMemberInvitation", { email: z.email().parse(email.trim()), role, projectIds: role === "admin" || whole ? null : z.array(entityReference).min(1).parse([...new Set(lines(projects))]) })
      const receipt = await command.execute(body)
      if (receipt.status !== "committed") return
      const saved = receipt.result as MemberInvitationDto
      setSavedId(saved.id)
      setEmail("")
    }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("受邀邮箱", "Invitation email")} value={email} onChange={value => { setEmail(value); setSavedId(null) }} type="email" required />
        <Choice label={t("角色模板", "Role template")} value={role} onChange={value => setRole(z.enum(["admin", "member", "guest"]).parse(value))} options={roleOptions} />
      </div>
      <ScopeFields whole={whole} setWhole={setWhole} projects={projects} setProjects={setProjects} admin={role === "admin"} />
      <p className="text-xs text-muted-foreground">{t("SMTP 接受不代表收件箱送达；受邀人需用链接确认邮箱对应账号。", "SMTP acceptance does not confirm inbox delivery. The recipient must accept the link using the account for this email.")}</p>
    </Form>
    {savedId && <p role="status" className="break-all text-sm">{t("邀请记录已确认，邮件状态以列表为准：", "Invitation record confirmed; consult the list for email status: ")}{savedId}</p>}
  </div>
}

export type InvitationOperation = { kind: "revoke" | "resend"; invitation: MemberInvitationDto }
export function MemberInvitationOperationDialog({ operation, current, disabled, enabled, onClose }: { operation: InvitationOperation | null; current: readonly MemberInvitationDto[]; disabled: boolean; enabled: boolean; onClose: () => void }) {
  const t = useText()
  return <Dialog open={!!operation} onOpenChange={open => { if (!open) onClose() }}><DialogContent><DialogTitle>{operation?.kind === "resend" ? t("重发邀请", "Resend invitation") : t("撤销邀请", "Revoke invitation")}</DialogTitle><DialogDescription>{t("使用该邀请的原版本提交；冲突不会自动覆盖。", "Submit against the original invitation version; conflicts never overwrite automatically.")}</DialogDescription><DialogBody><CommandNotice />{operation && <InvitationOperationForm key={`${operation.kind}:${operation.invitation.id}`} operation={operation} current={current} disabled={disabled} enabled={enabled} onClose={onClose} />}</DialogBody></DialogContent></Dialog>
}
function InvitationOperationForm({ operation, current, disabled, enabled, onClose }: { operation: InvitationOperation; current: readonly MemberInvitationDto[]; disabled: boolean; enabled: boolean; onClose: () => void }) {
  const command = usePmCommand()
  const t = useText()
  const [base, setBase] = useDraftState(`invitation:${operation.invitation.id}:${operation.kind}`, "base", operation.invitation)
  const [confirmed, setConfirmed] = useDraftState(`invitation:${operation.invitation.id}:${operation.kind}`, "confirmed", false)
  const fresh = current.find(item => item.id === base.id)
  const conflict = !!fresh && fresh.version > base.version
  const eligible = !!fresh && fresh.status !== "accepted" && fresh.status !== "revoked" && (operation.kind !== "resend" || enabled && fresh.delivery?.status !== "sending")
  return <div className="space-y-3"><p className="break-all">{base.email}</p><InvitationStatus invitation={invitationRecord(fresh ?? base)} />
    {conflict && <div role="status"><p>{t("邀请已更新，操作未重试。请比较状态后采用当前版本。", "Invitation changed; the operation was not retried. Compare its status before using the current version.")}</p><Button variant="outline" disabled={command.pending || !!command.unknownCommand} onClick={() => { setBase(fresh); setConfirmed(false) }}>{t("采用当前版本", "Use current version")}</Button></div>}
    <Form label={operation.kind === "resend" ? t("确认重发并作废旧链接", "Resend and invalidate old link") : t("确认撤销", "Confirm revocation")} disabled={disabled || !eligible || conflict || command.pending || !!command.unknownCommand} onSubmit={async () => {
      if (!confirmed) throw new Error(t("请先确认此操作。", "Confirm this action first."))
      const body = makeCommand(operation.kind === "resend" ? "ResendMemberInvitation" : "RevokeMemberInvitation", {})
      body.targetId = base.id
      body.expectedVersions = { [base.id]: base.version }
      const receipt = await command.execute(body)
      if (receipt.status === "committed") onClose()
    }}>
      <p className="text-sm">{operation.kind === "resend" ? t("重发会旋转令牌，使旧链接失效。之前的邮件（尤其状态未知时）可能已经送达，因此可能出现多封邮件；不会自动重发。", "Resending rotates the token and invalidates the old link. A previous email, especially one with unknown status, may already have arrived; the recipient may receive multiple emails. Resending is never automatic.") : t("撤销后链接立即失效，受邀人无法再接受。", "Revocation invalidates the link immediately and prevents acceptance.")}</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("我已了解并确认此操作", "I understand and confirm this action")}</label>
    </Form>
  </div>
}

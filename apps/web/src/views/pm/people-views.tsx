import { useRef } from "react"
import { Copy, Mail, Phone } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import type { ControlledMember, ControlledInvitation, PeopleRoleOption, PeopleContactKind, ControlledContactCopyReceipt, ControlledPeopleDirectoryRow, ControlledTeam } from "./people-controlled-contracts"
import styles from "./people.module.css"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export function PeopleRoleLabel({ member, roles }: { member: Pick<ControlledMember, "role" | "isOwner">; roles: readonly PeopleRoleOption[] }) {
  const { locale } = useI18n()
  return <Badge data-pm-access-role={member.role} tone={member.isOwner ? "info" : "neutral"}>{member.isOwner ? (locale === "en" ? "Owner" : "所有者") : roles.find((role) => role.value === member.role)?.label ?? `${locale === "en" ? "Role" : "角色"} ${member.role}`}</Badge>
}
export function PeopleIdentity({ member, size = 32 }: { member: ControlledMember; size?: 24 | 32 | 40 }) {
  return <span className="flex min-w-0 items-center gap-2" data-pm-member={member.membershipId}><span className={styles.avatarWrap} data-pm-person-avatar><Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={size} /></span><span className="flex min-w-0 flex-col text-left"><span className={styles.cardName} title={member.name}>{member.name}</span><span className={styles.cardSubtitle} title={member.email}>{member.email}</span></span></span>
}
export function InvitationStatus({ invitation }: { invitation: ControlledInvitation }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const labels = {
    unknown: en ? "Unknown · check original request" : "结果未知 · 检查原请求",
    rejected: en ? "Rejected" : "已拒绝",
    confirmed: en ? "Invite record confirmed · delivery unconfirmed" : "邀请记录已确认 · 未确认投递",
    smtpAccepted: en ? "SMTP accepted · delivery unconfirmed" : "SMTP 已接受 · 未确认投递",
    accepted: en ? "Invitation accepted" : "邀请已接受",
    pending: en ? "Pending acceptance" : "等待接受",
    revoked: en ? "Invitation revoked" : "邀请已撤销",
    expired: en ? "Invitation expired" : "邀请已过期",
  }
  const deliveryLabels = {
    queued: en ? "Email queued" : "邮件排队中",
    sending: en ? "Sending · do not resend" : "发送中 · 请勿重发",
    smtp_accepted: en ? "SMTP accepted · inbox delivery unconfirmed" : "SMTP 已接受 · 收件箱投递未确认",
    failed: en ? "Email failed" : "邮件发送失败",
    unknown: en ? "Email outcome unknown · no automatic resend" : "邮件结果未知 · 不自动重发",
    cancelled: en ? "Email cancelled" : "邮件已取消",
  }
  return <span className="inline-flex flex-wrap gap-1"><Badge tone={invitation.status === "rejected" || invitation.status === "revoked" ? "danger" : invitation.status === "unknown" || invitation.status === "expired" ? "warning" : invitation.status === "accepted" ? "success" : "neutral"}>{labels[invitation.status]}</Badge>{invitation.deliveryStatus && <Badge tone={invitation.deliveryStatus === "unknown" || invitation.deliveryStatus === "failed" ? "warning" : "neutral"}>{deliveryLabels[invitation.deliveryStatus]}</Badge>}</span>
}
export type PeopleContactControls = {
  canCopy: (kind: PeopleContactKind) => boolean
  copy: (kind: PeopleContactKind, trigger: HTMLElement) => void
  receipt?: ControlledContactCopyReceipt | null
}
export function PeoplePresenceLabel({ member }: { member: ControlledMember }) {
  const { locale } = useI18n()
  const labels = { available: locale === "en" ? "Available" : "在线", away: locale === "en" ? "Away" : "离开", offline: locale === "en" ? "Offline" : "离线" }
  return <Badge data-pm-availability={member.presence ?? "unknown"}>{member.presence ? labels[member.presence] : locale === "en" ? "Presence unknown" : "在线状态未知"}</Badge>
}
function PeopleContactInfo({ member, controls }: { member: ControlledMember; controls?: PeopleContactControls }) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const copyButton = (kind: PeopleContactKind, available: boolean) => <Button variant="ghost" size="icon" disabled={!available || !controls?.canCopy(kind)} aria-label={text(`复制 ${member.name} (${member.membershipId}) 的${kind === "email" ? "邮箱" : kind === "phone" ? "电话" : "联系方式"}`, `Copy ${kind} for ${member.name} (${member.membershipId})`)} onClick={(event) => { if (available && controls?.canCopy(kind)) controls.copy(kind, event.currentTarget) }}><Copy aria-hidden="true" size={16} /></Button>
  return <div className={styles.contactInfo}>
    {!member.email && !member.phone && <p className={styles.missing} data-pm-contact-missing>{text("联系方式未提供", "Contact information unavailable")}</p>}
    <div className={styles.emailRow}><Mail aria-hidden="true" size={14} /><span className={styles.emailText} title={member.email || undefined}>{member.email || text("邮箱未提供", "Email unavailable")}</span>{copyButton("email", !!member.email)}</div>
    <div className={styles.emailRow}><Phone aria-hidden="true" size={14} /><span className={styles.emailText} title={member.phone ?? undefined}>{member.phone || text("电话未提供", "Phone unavailable")}</span>{copyButton("phone", !!member.phone)}</div>
    {controls?.receipt?.membershipId === member.membershipId && <p role="status" className={styles.receipt} data-pm-copy-receipt>{controls.receipt.ok ? text("已复制", "Copied") : text("无法复制；请手动选择联系方式。", "Copy unavailable; select the contact information manually.")}</p>}
  </div>
}
export function PeopleDirectoryCard({ row, contextId, roles, selected, canOpen, onOpen, canEditMembership, onSetMembershipRole, contactControls }: {
  row: ControlledPeopleDirectoryRow
  contextId: string
  roles: readonly PeopleRoleOption[]
  selected: boolean
  canOpen: boolean
  onOpen: (trigger: HTMLElement) => void
  canEditMembership: boolean
  onSetMembershipRole?: (role: "maintainer" | "member", trigger: HTMLElement | null) => void
  contactControls?: PeopleContactControls
}) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { member, teams, membership } = row
  const roleTriggerId = `pm-directory-membership-${contextId}-${membership?.membershipId ?? member.membershipId}`
  return <li className={styles.directoryCard} data-pm-directory-card data-member-id={member.membershipId} data-selected={selected}>
    <div className={styles.directoryTop}><span className={styles.avatarWrap} data-pm-person-avatar><Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={40} /></span>{member.engagement && <Badge data-pm-engagement>{member.engagement}</Badge>}</div>
    <div className={styles.directoryIdentity}><h3 className={styles.cardName} title={member.name}>{member.name}</h3><p className={styles.cardSubtitle}>{member.companyRole ?? text("岗位未提供", "Job role unavailable")}</p><PeopleRoleLabel member={member} roles={roles} /></div>
    <dl className={styles.facts}><div><dt>{text("团队", "Teams")}</dt><dd title={teams.map((team) => team.name).join(", ")}>{teams.map((team) => team.name).join(", ") || text("未分配", "Unassigned")}</dd></div><div><dt>{text("加入时间", "Joined")}</dt><dd>{member.joinedAt ? <time dateTime={member.joinedAt}>{new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", timeZone: "UTC" }).format(new Date(member.joinedAt))}</time> : text("未提供", "Unavailable")}</dd></div></dl>
    <PeopleContactInfo member={member} controls={contactControls} />
    <div className={styles.directoryFooter}><Button id={`pm-directory-member-${contextId}-${member.membershipId}`} variant="ghost" disabled={!canOpen} aria-label={text(`查看 ${member.name} (${member.membershipId}) 的联系方式`, `Contact details for ${member.name} (${member.membershipId})`)} onClick={(event) => onOpen(event.currentTarget)}>{text("成员明细", "Member details")}</Button><span className={styles.spacer} /><PeoplePresenceLabel member={member} />{membership && <DropdownMenu><DropdownMenuTrigger render={<Button id={roleTriggerId} variant="ghost" disabled={!canEditMembership || !onSetMembershipRole} />} >{membership.role === "maintainer" ? text("维护者", "Maintainer") : text("成员", "Member")}</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuRadioGroup value={membership.role} onValueChange={(role) => { if (canEditMembership && onSetMembershipRole && role !== membership.role && (role === "maintainer" || role === "member")) onSetMembershipRole(role, document.getElementById(roleTriggerId)) }}><DropdownMenuRadioItem value="maintainer">{text("维护者", "Maintainer")}</DropdownMenuRadioItem><DropdownMenuRadioItem value="member">{text("成员", "Member")}</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>}</div>
  </li>
}
export function PeopleMemberInspector({ member, teams, teamsAvailable = true, roles, open, onOpenChange, finalFocus, canEditRole = false, onEditRole, onWorkload, contactControls, readingPosition = 0, onReadingPositionChange }: {
  member: ControlledMember | null | undefined
  teams: readonly ControlledTeam[]
  teamsAvailable?: boolean
  roles: readonly PeopleRoleOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus: () => HTMLElement | null
  canEditRole?: boolean
  onEditRole?: (trigger: HTMLElement) => void
  onWorkload?: () => void
  contactControls?: PeopleContactControls
  readingPosition?: number
  onReadingPositionChange?: (top: number) => void
}) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  return <Dialog open={open && !!member} onOpenChange={onOpenChange}><DialogContent initialFocus={titleRef} data-pm-contact-details finalFocus={finalFocus}>
    <DialogTitle ref={titleRef} tabIndex={-1}>{member?.name}</DialogTitle>
    <DialogDescription>{text("成员身份与联系方式；未知事实保持未提供", "Membership identity and contact information; unknown facts remain unavailable")}</DialogDescription>
    {member && <><DialogBody className={styles.detailsBody} ref={(element) => { if (element && element.scrollTop !== readingPosition) element.scrollTop = readingPosition }} onScroll={(event) => onReadingPositionChange?.(event.currentTarget.scrollTop)} data-pm-member-detail-scroll>
      <Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={40} />
      <dl className={styles.detailsFacts}>
        <div><dt>{text("访问角色", "Access role")}</dt><dd><PeopleRoleLabel member={member} roles={roles} /></dd></div>
        <div><dt>{text("岗位", "Job role")}</dt><dd>{member.companyRole ?? text("未提供", "Unavailable")}</dd></div>
        <div><dt>{text("方向归属", "Responsibility")}</dt><dd>{member.ownership ?? text("未提供", "Unavailable")}</dd></div>
        <div><dt>{text("在线状态", "Presence")}</dt><dd><PeoplePresenceLabel member={member} /></dd></div>
        <div><dt>2FA</dt><dd>{member.twoFactor == null ? text("无可信来源 · 不可用", "No trusted source · unavailable") : member.twoFactor ? text("已启用", "Enabled") : text("未启用", "Disabled")}</dd></div>
        <div><dt>{text("加入时间", "Joined")}</dt><dd>{member.joinedAt ? <time dateTime={member.joinedAt}>{new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(member.joinedAt))}</time> : text("未提供", "Unavailable")}</dd></div>
        <div><dt>{text("成员范围", "Membership scope")}</dt><dd>{member.scope === "workspace" ? text("工作区", "Workspace") : member.scope === "unknown" ? text("未提供", "Unavailable") : member.projectId ?? text("指定项目", "Selected projects")}</dd></div>
        <div><dt>{text("成员状态", "Membership status")}</dt><dd>{member.isActive ? text("有效", "Active") : text("已停用", "Inactive")}</dd></div>
        <div><dt>{text("身份", "Identity")}</dt><dd>{member.membershipId}</dd></div>
      </dl>
      <PeopleContactInfo member={member} controls={contactControls} />
      {!teamsAvailable && <p>{text("团队信息未提供", "Team information unavailable")}</p>}
      <ul className={styles.teamList}>{member.teams !== undefined
        ? member.teams.map((team) => <li key={team.id}><Badge>{team.name}</Badge></li>)
        : teams.map((team) => <li key={team.id}><Badge>{team.name}{team.identifier ? ` (${team.identifier})` : ""} · {team.members.find((entry) => entry.userId === member.userId)?.role === "maintainer" ? text("维护者", "Maintainer") : text("成员", "Member")}</Badge></li>)}</ul>
    </DialogBody><DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>{text("关闭", "Close")}</Button>{onWorkload && <Button variant="outline" onClick={onWorkload}>{text("查看成员工作量", "View member workload")}</Button>}{onEditRole && <Button disabled={!canEditRole} onClick={(event) => onEditRole(event.currentTarget)}>{text("编辑角色", "Edit role")}</Button>}</DialogFooter></>}
  </DialogContent></Dialog>
}

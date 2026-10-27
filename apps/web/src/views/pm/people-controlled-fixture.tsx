import { useEffect, useRef } from "react"
import { ChevronDown, Mail, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { useI18n } from "@/lib/i18n-provider"
import { usePmControlsReady, usePmNavigation } from "./domain-session"
import { usePmScenarioState } from "./shared"
import { copyText, directoryRows, personMatchesQuery, teamsForMember } from "./people-controller"
import { getInviteRequest, setPeopleAccessRole, setPeopleAvailability, setPeopleMembershipRole } from "./people-domain"
import { addInviteRow, cancelInvite, checkInviteResult, createMemberList3State, pendingRows, prepareSuggestedInvite, removeInviteRow, setInviteRowEmail, setInviteRowRole, submitInvites, suggestedRows, syncMemberList3Request, type InviteMessage, type InviteOutcome, type InviteRowError } from "./member-list-3-controller"
import { checkMemberInviteResult, createMemberList1State, openInvite, submitMemberInvite, syncMemberList1Request } from "./member-list-1-controller"
import { accessRoleLabels, engagementLabels, type AccessRole } from "./people-fixtures"
import { usePeopleDomain } from "./use-people-domain"
import { useIssueDomain } from "./use-issue-domain"
import { createTeamList1Fixtures, focusLabels } from "./team-list-1-fixtures"
import { checkTeamResult, createTeamList1State, openTeamEditor, submitTeamDraft } from "./team-list-1-controller"
import { createTeamList2State, departmentGroups, directoryMembers } from "./team-list-2-controller"
import { createWorkloadState, departmentWorkload, taskPool, workloadSnapshot } from "./team-list-3-controller"
import { pmClock, type PmScenario } from "./model"
import { MemberDirectoryView } from "./member-directory"
import { TeamCollectionView } from "./team-collection"
import type { ControlledInvitation, ControlledMember, ControlledPeopleDirectoryRow, ControlledTeam, MemberDirectoryInteraction, MemberDirectoryViewProps, TeamCollectionInteraction, TeamCollectionViewProps } from "./people-controlled-contracts"
import type { ControlledIssueRecord, PmControlledData } from "./controlled-contracts"
import type { ProjectCollectionRecord } from "./project-collection-contracts"
import inviteStyles from "./member-list-3.module.css"

const roleValues: Record<AccessRole, number> = { admin: 20, member: 15, guest: 5 }
const roleKeys: Record<number, AccessRole> = { 20: "admin", 15: "member", 5: "guest" }

/** Only explicit Showcase wrappers import this fixture controller. */
function usePeopleFixture(scenario: PmScenario) {
  const { locale } = useI18n()
  const [domain, setDomain] = usePeopleDomain(scenario)
  const [projectIds, setProjectIds] = usePmScenarioState<Record<string, readonly string[]>>("people-controlled:project-relations", () => Object.fromEntries(domain.teams.map((team) => [team.id, createTeamList1Fixtures(scenario).projects.filter((project) => project.teamId === team.id).map((project) => project.id)])))
  const members: ControlledMember[] = directoryRows(domain).map(({ member, person }) => ({ membershipId: `fixture-membership:${member.id}`, userId: member.id, name: member.name, email: person.contact?.email ?? "", phone: person.contact?.phone ?? null, joinedAt: person.joinedAt, ownership: person.ownership[locale], engagement: engagementLabels[person.engagement][locale], twoFactor: person.twoFactor, role: roleValues[person.accessRole], scope: "workspace", projectId: null, isActive: true, isOwner: false, version: "fixture:1", companyRole: member.role[locale], presence: person.availability }))
  const teams: ControlledTeam[] = domain.teams.map((team) => ({ id: team.id, identifier: team.identifier, focus: focusLabels[team.focus][locale], responseTarget: `${team.slaHours}h`, activityAt: team.activityAt, name: team.name[locale], description: team.description[locale], members: domain.memberships.filter((entry) => entry.teamId === team.id).map((entry) => ({ membershipId: `fixture-team-membership:${team.id}:${entry.memberId}`, userId: entry.memberId, role: entry.role })), projectIds: projectIds[team.id] ?? [], version: "fixture:1" }))
  const roles = (["admin", "member", "guest"] as const).map((role) => ({ value: roleValues[role], label: accessRoleLabels[role][locale] }))
  const projects: ProjectCollectionRecord[] = createTeamList1Fixtures(scenario).projects.map((project) => ({ id: project.id, identifier: project.identifier, title: project.title[locale], description: null, owner: null, status: null, cycle: null, cycleWeeks: null, teamSize: null, health: null, dueDate: project.dueDate, archived: null, artwork: null, starred: null, taskCounts: null }))
  const data: PmControlledData = { state: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : scenario === "empty" ? "empty" : "success", updatedAt: pmClock, error: scenario === "refresh-error" ? { category: "network", message: locale === "en" ? "Fixture refresh failed" : "Fixture 刷新失败", reason: locale === "en" ? "Local data is retained; no service request is made." : "本地数据保留；不会发送服务请求。" } : undefined }
  return { domain, setDomain, members, teams, roles, projects, data, setProjectIds }
}
export function MemberDirectoryFixture({ scenario, variant }: { scenario: PmScenario; variant: MemberDirectoryViewProps["variant"] }) {
  const interactive = usePmControlsReady()
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const fixture = usePeopleFixture(scenario)
  const [readingPosition, setReadingPosition] = usePmScenarioState(`${variant}:reading-position`, () => 0)
  const canWrite = scenario !== "readonly" && scenario !== "loading"
  const trigger = useRef<HTMLElement | null>(null)
  const [state, setState] = usePmScenarioState<MemberDirectoryInteraction>(`${variant}:controlled`, () => ({ query: "", roleFilter: null, roleFilters: variant === "member1" ? [] : undefined, presenceFilters: [], securityFilter: "any", activeFilter: "all", sort: "name", display: "grid", comfortable: false, hiddenColumns: [], tab: "members", selectedIds: [], selectedId: null, detailOpen: false }))
  const [editor, setEditor] = usePmScenarioState(`${variant}:access-editor`, () => ({ roleId: null as string | null }))
  const [copyReceipt, setCopyReceipt] = usePmScenarioState<MemberDirectoryViewProps["readModel"]["copyReceipt"]>(`${variant}:contact-copy`, () => null)
  const [savedInvites, setInvites] = usePmScenarioState(`${variant}:invitation-controller`, createMemberList3State)
  const [savedSingle, setSingle] = usePmScenarioState(`${variant}:single-invitation-controller`, createMemberList1State)
  const invites = syncMemberList3Request(savedInvites, fixture.domain)
  const single = syncMemberList1Request(savedSingle, fixture.domain)
  useEffect(() => {
    if (variant === "member3") setInvites((previous) => syncMemberList3Request(previous, fixture.domain))
    else setSingle((previous) => syncMemberList1Request(previous, fixture.domain))
  }, [fixture.domain, variant, setInvites, setSingle])
  const unknown = fixture.domain.request?.resolved === "pending"
  const disabled = !canWrite || unknown
  const errorLabel = (error: InviteRowError) => error === "required" ? text("请输入邮箱地址。", "Enter an email address.") : error === "invalid" ? text("邮箱格式无效。", "Invalid email format.") : error === "duplicate" ? text("邮箱重复：已有成员或已有待处理邀请。", "Duplicate email: already a member or pending invitation.") : undefined
  const messageLabel = (message: InviteMessage) => {
    if (message === "required" || message === "invalid" || message === "duplicate") return errorLabel(message)
    if (message === "unknown") return text("原请求结果未知；草稿已保留，禁止重放。", "Original request outcome unknown; draft retained and replay blocked.")
    if (message === "rejected" || message === "checked-rejected" || message === "shared-checked-rejected") return text("原请求已拒绝；草稿已保留。", "Original request rejected; draft retained.")
    if (message === "confirmed" || message === "checked-confirmed" || message === "shared-checked-confirmed") return text("本地邀请记录已确认；不表示已投递邮件或加入成员。", "Local invitation record confirmed; not email delivery or membership.")
    if (message === "partial" || message === "checked-partial" || message === "shared-checked-partial") return text("原请求逐行结果已确认；未确认行草稿已保留。", "Original row outcomes recorded; unconfirmed row drafts retained.")
    if (message === "suggestion-prepared") return text("建议联系人已填入草稿；尚未提交邀请。", "Suggested contact prepared in draft; no invitation submitted.")
    if (message === "invite-cancelled") return text("本地邀请已取消。", "Local invitation cancelled.")
    return ""
  }
  const outcomeLabel = (outcome: InviteOutcome) => outcome === "confirmed" ? text("确认", "Confirmed") : outcome === "rejected" ? text("拒绝", "Rejected") : text("未知", "Unknown")
  const outcomeControl = (id: string, label: string, value: InviteOutcome, change: (value: InviteOutcome) => void, locked = disabled, check = false) => <Field id={id} label={label}>{(control) => <Select value={value} disabled={locked} items={(check ? ["confirmed", "rejected"] as const : ["confirmed", "rejected", "unknown"] as const).map((value) => ({ value, label: outcomeLabel(value) }))} onValueChange={(value) => { if (value === "confirmed" || value === "rejected" || (!check && value === "unknown")) change(value) }}><SelectTrigger {...control}>{outcomeLabel(value)}</SelectTrigger><SelectContent>{(check ? ["confirmed", "rejected"] as const : ["confirmed", "rejected", "unknown"] as const).map((value) => <SelectItem key={value} value={value}>{outcomeLabel(value)}</SelectItem>)}</SelectContent></Select>}</Field>
  const roleControl = (id: string, label: string, value: AccessRole, change: (value: AccessRole) => void, locked = disabled) => <Field id={id} label={label}>{(control) => <Select value={String(roleValues[value])} disabled={locked} items={fixture.roles.map((role) => ({ value: String(role.value), label: role.label }))} onValueChange={(value) => { if (value !== null && roleKeys[Number(value)]) change(roleKeys[Number(value)]) }}><SelectTrigger {...control} className={`${inviteStyles.selectTrigger} w-full`}><span>{accessRoleLabels[value][locale]}</span><ChevronDown aria-hidden="true" size={14} /></SelectTrigger><SelectContent>{fixture.roles.map((role) => <SelectItem key={role.value} value={String(role.value)}>{role.label}</SelectItem>)}</SelectContent></Select>}</Field>
  const check = () => {
    if (!canWrite || !unknown) return
    if (variant === "member3") {
      const next = checkInviteResult(invites, fixture.domain)
      setInvites(next.page)
      fixture.setDomain(next.domain)
    } else {
      const next = checkMemberInviteResult(single, fixture.domain)
      setSingle(next.page)
      fixture.setDomain(next.domain)
    }
  }
  const receiptId = unknown ? fixture.domain.request!.id : variant === "member3" ? invites.sharedCheckRequestId ?? invites.inviteRequestId : single.inviteReceiptRequestId
  const receipt = receiptId ? getInviteRequest(fixture.domain, receiptId) : undefined
  const packet = receipt && <div data-pm-invite-pending-request><code>{receipt.id}</code><ul aria-label={text("原请求逐行结果", "Original request row outcomes")} data-pm-invite-results>{receipt.rows.map((row, index) => <li key={index}>{row.email} · {accessRoleLabels[row.role][locale]}{outcomeLabel(receipt.rowOutcomes[index])}</li>)}</ul></div>
  const notice = variant === "member3" ? invites.message : single.inviteMessage
  const validation = notice === "required" || notice === "invalid" || notice === "duplicate"
  const feedback = <>{notice && <p role={validation ? "alert" : "status"} data-pm-invite-notice>{messageLabel(notice)}{variant === "member3" && invites.inviteReceipt ? ` ${invites.inviteReceipt.email}` : ""}</p>}{packet}{unknown && <div className="flex items-end gap-3">{outcomeControl(variant === "member3" ? "pm-member3-check" : "pm-member1-invite-check", text("检查原请求的模拟结果", "Simulated outcome for original request check"), variant === "member3" ? invites.checkOutcome : single.inviteCheckOutcome, (value) => { if (value === "unknown") return; if (variant === "member3") setInvites((previous) => ({ ...previous, checkOutcome: value })); else setSingle((previous) => ({ ...previous, inviteCheckOutcome: value })) }, !canWrite, true)}<Button type="button" disabled={!canWrite} onClick={check}>{text("检查模拟结果", "Check simulated result")}</Button></div>}</>
  const inviteForm = variant === "member3" ? <form id="pm-member3-invite-form" aria-label={text("本地模拟邀请表单", "Local simulated invite form")} onSubmit={(event) => {
    event.preventDefault()
    if (disabled) return
    const next = submitInvites(invites, fixture.domain)
    setInvites(next.page)
    fixture.setDomain(next.domain)
    const invalid = next.page.rows.find((row) => next.page.rowErrors[row.key])
    if (invalid) requestAnimationFrame(() => document.getElementById(`pm-member3-email-${invalid.key}`)?.focus())
  }}>
    <div className={inviteStyles.inviteRows}>{invites.rows.map((row) => <div key={row.key} className={`${inviteStyles.inviteRow} ${invites.rows.length > 1 ? inviteStyles.multipleRows : ""}`}>
      <Field id={`pm-member3-email-${row.key}`} label={text("邮箱地址", "Email address")} error={errorLabel(invites.rowErrors[row.key] ?? "")} className={inviteStyles.field}>{(control) => <InputGroup><InputGroupAddon><Mail size={16} aria-hidden="true" /></InputGroupAddon><InputGroupInput {...control} placeholder="jane@example.com" value={row.email} disabled={disabled} onChange={(event) => setInvites((previous) => setInviteRowEmail(previous, row.key, event.target.value))} /></InputGroup>}</Field>
      {roleControl(`pm-member3-role-${row.key}`, text("邀请角色", "Invitation role"), row.role, (role) => setInvites((previous) => setInviteRowRole(previous, row.key, role)))}
      {invites.rows.length > 1 && <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={text(`删除邀请行 ${row.key}`, `Remove invite row ${row.key}`)} onClick={() => { const next = removeInviteRow(invites, row.key); setInvites(next); requestAnimationFrame(() => document.getElementById(`pm-member3-email-${next.rows[0].key}`)?.focus()) }}><Trash2 size={16} aria-hidden="true" /></Button>}
    </div>)}</div>
    <div className={inviteStyles.inviteActions}><Button type="button" variant="secondary" disabled={disabled} onClick={() => { const next = addInviteRow(invites); setInvites(next); requestAnimationFrame(() => document.getElementById(`pm-member3-email-row-${next.rowSequence}`)?.focus()) }}><Plus aria-hidden="true" size={16} />{text("添加一行", "Add more")}</Button></div>
    {feedback}
    <details><summary>{text("本地 fixture 结果控制 · 不发送真实邮件", "Local fixture outcome controls · no real email")}</summary><div className="space-y-3">{outcomeControl("pm-member3-outcome", text("默认模拟结果", "Default simulated outcome"), invites.outcome, (outcome) => setInvites((previous) => ({ ...previous, outcome })))}{invites.rows.map((row, index) => <div key={row.key}>{outcomeControl(`pm-member3-outcome-${row.key}`, text(`第 ${index + 1} 行模拟结果`, `Row ${index + 1} simulated outcome`), row.outcome ?? invites.outcome, (outcome) => setInvites((previous) => ({ ...previous, rows: previous.rows.map((draft) => draft.key === row.key ? { ...draft, outcome } : draft) })) )}</div>)}</div></details>
  </form> : <form aria-label={text("本地模拟邀请表单", "Local simulated invite form")} className="space-y-4" onSubmit={(event) => {
    event.preventDefault()
    if (disabled) return
    const next = submitMemberInvite(single, fixture.domain)
    setSingle(next.page)
    fixture.setDomain(next.domain)
    if (next.page.inviteResult === "validation") requestAnimationFrame(() => document.getElementById("pm-member1-invite-email")?.focus())
  }}>
    <Field id="pm-member1-invite-email" label={text("邮箱地址", "Email address")} error={validation ? errorLabel(single.inviteMessage as InviteRowError) : undefined}>{(control) => <Input {...control} value={single.inviteDraft?.email ?? ""} disabled={disabled} onChange={(event) => setSingle((previous) => ({ ...previous, inviteDraft: { email: event.target.value, role: previous.inviteDraft?.role ?? "member" }, inviteMessage: "", inviteResult: "idle" }))} />}</Field>
    {roleControl("pm-member1-invite-role", text("邀请角色", "Invitation role"), single.inviteDraft?.role ?? "member", (role) => setSingle((previous) => ({ ...previous, inviteDraft: { email: previous.inviteDraft?.email ?? "", role } })))}
    {outcomeControl("pm-member1-invite-outcome", text("本地模拟结果（不发送邮件）", "Local simulated outcome (no email)"), single.inviteOutcome, (inviteOutcome) => setSingle((previous) => ({ ...previous, inviteOutcome })))}
    {feedback}
    <DialogFooter><Button type="button" variant="secondary" onClick={() => setSingle((previous) => ({ ...previous, inviteOpen: false }))}>{text("取消 · 保留草稿", "Cancel · keep draft")}</Button><Button type="submit" disabled={disabled}>{text("邀请", "Invite")}</Button></DialogFooter>
  </form>
  const invitations = pendingRows(fixture.domain).map<ControlledInvitation>((invitation) => ({ id: invitation.id, email: invitation.email, role: roleValues[invitation.role], requestId: invitation.requestId ?? null, status: invitation.status === "checking" ? "unknown" : "confirmed", createdAt: invitation.invitedAt, error: null })).filter((invitation) => invitation.email.toLowerCase().includes(state.query.trim().toLowerCase()) && (state.roleFilter === null || invitation.role === state.roleFilter))
  const candidates = suggestedRows({ ...invites, query: state.query, roleFilter: state.roleFilter === null ? "all" : roleKeys[state.roleFilter] }, fixture.domain, scenario === "empty")
  const visibleIds = new Set(directoryRows(fixture.domain).filter((row) => personMatchesQuery(fixture.domain, row, state.query, locale)).map((row) => row.member.id))
  const members = fixture.members.filter((member) => visibleIds.has(member.userId) && (state.roleFilters ? !state.roleFilters.length || state.roleFilters.includes(member.role) : state.roleFilter === null || state.roleFilter === member.role) && (!state.presenceFilters?.length || !!member.presence && state.presenceFilters.includes(member.presence)) && (state.securityFilter === undefined || state.securityFilter === "any" || member.twoFactor === (state.securityFilter === "enrolled")) && (state.activeFilter === "all" || member.isActive === (state.activeFilter === "active"))).sort((a, b) => {
    const teamCount = (member: ControlledMember) => fixture.teams.filter((team) => team.members.some((entry) => entry.userId === member.userId)).length
    if (state.sort === "role") return a.role - b.role
    if (state.sort === "joined" || state.sort === "joined-desc") return (a.joinedAt ?? "").localeCompare(b.joinedAt ?? "") * (state.sort === "joined-desc" ? -1 : 1)
    if (state.sort === "teams" || state.sort === "teams-desc") return (teamCount(a) - teamCount(b)) * (state.sort === "teams-desc" ? -1 : 1)
    if (state.sort === "presence") return (a.presence ?? "").localeCompare(b.presence ?? "")
    return a.name.localeCompare(b.name, locale) * (state.sort === "name-desc" ? -1 : 1)
  })
  const accessMember = fixture.members.find((member) => member.membershipId === editor.roleId)
  return <MemberDirectoryView variant={variant} interactive={interactive} readingPosition={readingPosition} onReadingPositionChange={setReadingPosition}
    readModel={{ members, totalMemberCount: fixture.members.length, copyReceipt, sortOptions: ["name", "name-desc", "role", "joined", "joined-desc", "teams", "teams-desc", "presence"], selectedMember: fixture.members.find((member) => member.membershipId === state.selectedId), teams: fixture.teams, roles: fixture.roles, invitations, suggestedContacts: { items: candidates.map((candidate) => ({ ...candidate, role: roleValues[candidate.role] })), data: fixture.data }, data: fixture.data, sourceDescription: text("本地 Fixture · 不发送真实邮件", "Local fixture · no real email is sent") }}
    interaction={state}
    capabilities={{ invite: canWrite && (variant !== "member3" || !unknown), editRole: () => canWrite, manageAccess: () => scenario !== "loading", memberOpen: () => scenario !== "loading", reconcileInvitation: canWrite, editPresence: () => canWrite, prepareSuggestedInvite: () => canWrite && !unknown, cancelInvitation: (invitation) => canWrite && fixture.domain.pending.some((pending) => pending.id === invitation.id), copyContact: (member, kind) => scenario !== "loading" && (kind === "email" ? !!member.email : kind === "phone" ? !!member.phone : !!member.email || !!member.phone), filterPresence: true, filterSecurity: true }}
    actions={{ setInteraction: setState, manageAccess: (member, element) => { trigger.current = element; setEditor({ roleId: member.membershipId }) }, memberOpen: (member, element) => { trigger.current = element; setState((previous) => ({ ...previous, selectedId: member.membershipId, detailOpen: true })) }, editRole: (member, element) => { trigger.current = element; setEditor({ roleId: member.membershipId }) }, invite: (element) => {
      trigger.current = element
      if (disabled) return
      if (variant === "member3") {
        const form = document.getElementById("pm-member3-invite-form")
        if (form instanceof HTMLFormElement) form.requestSubmit()
      } else setSingle((previous) => openInvite(previous))
    }, reconcileInvitation: check, cancelInvitation: (invitation) => { if (!canWrite) return; const next = cancelInvite(invites, fixture.domain, invitation.id); setInvites(next.page); fixture.setDomain(next.domain) }, copyContact: async (member, kind) => {
      const value = kind === "email" ? member.email : kind === "phone" ? member.phone : [member.name, member.email, member.phone].filter(Boolean).join("\n")
      if (!value) return
      setCopyReceipt({ membershipId: member.membershipId, kind, ok: await copyText(value) })
    }, setPresence: (member, presence) => { if (canWrite) fixture.setDomain((previous) => setPeopleAvailability(previous, member.userId, presence)) }, prepareSuggestedInvite: (contact) => {
      if (disabled) return
      const candidate = candidates.find((candidate) => candidate.id === contact.id)
      if (!candidate) return
      const next = prepareSuggestedInvite(invites, candidate)
      setInvites(next)
      const row = next.rows.find((row) => row.email.trim().toLowerCase() === candidate.email)
      if (row) requestAnimationFrame(() => document.getElementById(`pm-member3-email-${row.key}`)?.focus())
    } }}
    inviteEditor={variant === "member3" ? inviteForm : undefined}
    inviteDialog={variant !== "member3" && <Dialog open={single.inviteOpen} onOpenChange={(inviteOpen) => setSingle((previous) => ({ ...previous, inviteOpen }))}><DialogContent className="max-w-2xl" finalFocus={() => trigger.current}><DialogTitle>{text("邀请成员", "Invite members")}</DialogTitle><DialogDescription>{text("本地模拟，不发送邮件，不会创建已加入成员。", "Local simulation; no email is sent and no joined member is created.")}</DialogDescription><DialogBody>{single.inviteOpen && inviteForm}</DialogBody></DialogContent></Dialog>}
    roleEditor={<Dialog open={!!accessMember} onOpenChange={(open) => { if (!open) setEditor({ roleId: null }) }}><DialogContent finalFocus={() => trigger.current}><DialogTitle>{text(`管理访问 · ${accessMember?.name ?? ""}`, `Manage access · ${accessMember?.name ?? ""}`)}</DialogTitle><DialogDescription>{text("团队职责与岗位不会改变。", "Team responsibilities and job role remain unchanged.")}</DialogDescription>{accessMember && <DialogBody><dl><div><dt>{text("岗位", "Job role")}</dt><dd>{accessMember.companyRole}</dd></div>{teamsForMember(fixture.domain, accessMember.userId).map(({ team, role }) => <div key={team.id}><dt>{team.name[locale]}</dt><dd>{team.identifier} · {role === "maintainer" ? text("维护者", "Maintainer") : text("成员", "Member")}</dd></div>)}</dl>{roleControl("pm-fixture-access-role", text("访问角色", "Access role"), roleKeys[accessMember.role], (role) => { if (canWrite) fixture.setDomain((previous) => setPeopleAccessRole(previous, accessMember.userId, role)) }, !canWrite)}</DialogBody>}</DialogContent></Dialog>}
  />
}

export function TeamCollectionFixture({ scenario, variant }: { scenario: PmScenario; variant: TeamCollectionViewProps["variant"] }) {
  const interactive = usePmControlsReady()
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const fixture = usePeopleFixture(scenario)
  const [readingPosition, setReadingPosition] = usePmScenarioState(`${variant}:reading-position`, () => 0)
  const [issueDomain] = useIssueDomain(scenario)
  const { navigate } = usePmNavigation()
  const canWrite = scenario !== "readonly" && scenario !== "loading"
  const trigger = useRef<HTMLElement | null>(null)
  const [state, setState] = usePmScenarioState<TeamCollectionInteraction>(`${variant}:controlled`, () => ({ query: "", sort: "name", display: variant === "team1" ? "table" : "cards", tab: variant === "team3" ? "workload" : "directory", teamId: null, selectedIds: [], selectedId: null, detailOpen: false, detailTab: "overview", expandedIds: fixture.members.map((member) => member.userId), workloadStateFilter: "all", selectedMemberId: null, memberDetailOpen: false }))
  const [editor, setEditor] = usePmScenarioState(`${variant}:relations-editor`, () => ({ open: false, kind: "members" as "members" | "projects", draft: null as ControlledTeam | null }))
  const [savedTeam, setTeam] = usePmScenarioState(`${variant}:team-controller`, () => createTeamList1State(scenario))
  const teamPage = { ...savedTeam, teams: fixture.domain.teams, memberships: fixture.domain.memberships }
  const locked = !canWrite || teamPage.result === "unknown"
  const [copyReceipt, setCopyReceipt] = usePmScenarioState<TeamCollectionViewProps["readModel"]["copyReceipt"]>(`${variant}:contact-copy`, () => null)
  const teams = fixture.teams.filter((team) => (state.teamId === null || state.teamId === team.id) && `${team.name} ${team.identifier} ${team.description} ${team.members.map((entry) => fixture.members.find((member) => member.userId === entry.userId)?.name ?? "").join(" ")} ${team.projectIds.map((id) => fixture.projects.find((project) => project.id === id)?.title ?? id).join(" ")}`.toLowerCase().includes(state.query.trim().toLowerCase())).sort((a, b) => state.sort === "activity" ? (b.activityAt ?? "").localeCompare(a.activityAt ?? "") : state.sort === "members" ? b.members.length - a.members.length : a.name.localeCompare(b.name, locale) * (state.sort === "name-desc" ? -1 : 1))
  const directoryState = { ...createTeamList2State(), query: state.query, teamId: state.teamId ?? "all", availabilityFilter: state.presenceFilter ?? "all" }
  const directoryRow = (memberId: string, groupTeamIds?: readonly string[]): ControlledPeopleDirectoryRow => {
    const member = fixture.members.find((member) => member.userId === memberId)!
    const related = fixture.teams.filter((team) => team.members.some((entry) => entry.userId === memberId))
    const selectedTeam = related.find((team) => state.teamId === team.id) ?? related.find((team) => !groupTeamIds || groupTeamIds.includes(team.id))
    const membership = selectedTeam?.members.find((entry) => entry.userId === memberId)
    const displayedTeams = related.filter((team) => state.teamId !== null ? team.id === state.teamId : !groupTeamIds || groupTeamIds.includes(team.id))
    return { member, teams: displayedTeams, membership: selectedTeam && membership ? { teamId: selectedTeam.id, membershipId: membership.membershipId, role: membership.role } : null }
  }
  const directory = variant === "team2" ? { grouping: "departments" as const, rows: directoryMembers(directoryState, fixture.domain, locale).map(({ member }) => directoryRow(member.id)), groups: departmentGroups(directoryState, fixture.domain, locale).map((group) => ({ id: group.focus, label: group.focus === "unassigned" ? text("未分配团队", "No team") : focusLabels[group.focus][locale], rows: group.members.map(({ member }) => directoryRow(member.id, group.teams.map((team) => team.id))) })), data: fixture.data, totalCount: fixture.members.length } : undefined
  const projectIssue = (issue: (typeof issueDomain.items)[number]): ControlledIssueRecord => ({ ...issue, version: `fixture:${issue.revision}`, title: issue.titleCopy[locale], description: issue.descriptionCopy[locale], moduleIds: issue.moduleId ? [issue.moduleId] : [], estimatePointId: null })
  const workloadState = { ...createWorkloadState(), query: state.query, stateFilter: state.workloadStateFilter ?? "all", expandedIds: [...state.expandedIds] }
  const snapshot = variant === "team3" ? workloadSnapshot(workloadState, fixture.domain, issueDomain.items, locale) : undefined
  const workload = snapshot ? {
    grouping: "departments" as const,
    rows: snapshot.rows.map((row) => ({ id: row.member.id, member: fixture.members.find((member) => member.userId === row.member.id)!, issues: row.issues.map(projectIssue), openCount: row.openCount, doneCount: row.doneCount, knownOpenPoints: row.knownOpenPoints, unknownEstimateCount: row.unknownEstimateCount, capacityPoints: row.capacityPoints, overloaded: row.overloaded })),
    unassigned: { issues: snapshot.unassigned.issues.map(projectIssue), unknownAssigneeCount: snapshot.unassigned.unknownAssigneeCount },
    summary: { uniqueTaskCount: snapshot.summary.uniqueShownCount, rowTaskCount: snapshot.summary.rowAssignments, overloadedMembers: snapshot.summary.overloadedMembers, unknownCapacityMembers: snapshot.summary.unknownCapacityMembers, unknownEstimateCount: snapshot.summary.unknownEstimateCount },
    groups: departmentWorkload(workloadState, fixture.domain, issueDomain.items, locale).map((group) => ({ id: group.focus, label: focusLabels[group.focus][locale], issues: group.issues.map(projectIssue) })),
    pool: taskPool(workloadState, issueDomain.items, locale).map(({ issue }) => projectIssue(issue)),
  } : undefined
  const openTeam = (team: ControlledTeam | null, element: HTMLElement | null) => {
    trigger.current = team ? document.getElementById(`pm-team-actions-${team.id}`) ?? element : element
    setState(previous => ({ ...previous, detailOpen: false }))
    setTeam(openTeamEditor(teamPage, locale, team ? fixture.domain.teams.find((entry) => entry.id === team.id) : undefined))
  }
  const applyTeam = (next: typeof teamPage) => {
    setTeam(next)
    if (next.teams !== fixture.domain.teams || next.memberships !== fixture.domain.memberships) fixture.setDomain((previous) => ({ ...previous, teams: next.teams, memberships: next.memberships }))
    if (next.result === "confirmed") setState((previous) => ({ ...previous, selectedId: next.selectedId }))
  }
  const openRelations = (team: ControlledTeam, kind: "members" | "projects", element: HTMLElement | null) => { trigger.current = element; setEditor({ open: true, kind, draft: team }) }
  const draft = teamPage.draft
  const teamMessage = teamPage.message === "duplicate" ? text("团队标识已被使用。", "Team identifier is already used.") : teamPage.message === "required" ? text("请输入团队名称和标识。", "Enter a team name and identifier.") : teamPage.message === "rejected" ? text("原请求已拒绝；草稿已保留。", "Original request rejected; draft retained.") : teamPage.message === "unknown" ? text("原请求结果未知；草稿已保留，禁止重放。", "Original request outcome unknown; draft retained and replay blocked.") : teamPage.message === "member-unavailable" ? text("所选维护者不可用。", "Selected maintainer is unavailable.") : ""
  const teamDialog = <>{draft && !teamPage.editorOpen && <Button disabled={!canWrite} onClick={() => setTeam((previous) => ({ ...previous, editorOpen: true }))}>{text("继续草稿", "Continue draft")}</Button>}<Dialog open={teamPage.editorOpen} onOpenChange={(editorOpen) => setTeam((previous) => ({ ...previous, editorOpen }))}><DialogContent finalFocus={() => trigger.current}><DialogTitle>{draft?.teamId ? text("编辑团队", "Edit team") : text("添加团队", "Add team")}</DialogTitle><DialogDescription>{text("本地模拟，不发送服务写入；未知请求仅检查原请求。", "Local simulation; no service writes. Unknown requests only check the original request.")}</DialogDescription><DialogBody>{draft && <form id="pm-fixture-team-form" className="space-y-4" onSubmit={(event) => {
    event.preventDefault()
    if (locked) return
    const next = submitTeamDraft(teamPage)
    applyTeam(next)
    const field = next.message === "duplicate" ? "pm-team-identifier" : next.message === "required" ? !draft.name.trim() ? "pm-team-name" : "pm-team-identifier" : null
    if (field) requestAnimationFrame(() => document.getElementById(field)?.focus())
  }}>
    <Field id="pm-team-name" label={text("团队名称", "Team name")} error={teamPage.message === "required" && !draft.name.trim() ? teamMessage : undefined}>{(control) => <Input {...control} value={draft.name} disabled={locked} onChange={(event) => setTeam((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, name: event.target.value } : null }))} />}</Field>
    <Field id="pm-team-identifier" label={text("团队标识", "Team identifier")} error={teamPage.message === "duplicate" || teamPage.message === "required" && !draft.identifier.trim() ? teamMessage : undefined}>{(control) => <Input {...control} value={draft.identifier} disabled={locked} onChange={(event) => setTeam((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, identifier: event.target.value } : null }))} />}</Field>
    <Field id="pm-team-description" label={text("团队说明", "Team description")}>{(control) => <Textarea {...control} value={draft.description} disabled={locked} onChange={(event) => setTeam((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, description: event.target.value } : null }))} />}</Field>
    <Field id="pm-team-maintainer" label={text("维护者", "Maintainer")}>{(control) => <Select value={draft.maintainerId} disabled={locked} items={[{ value: "", label: text("保留成员职责", "Keep member responsibilities") }, ...fixture.members.map((member) => ({ value: member.userId, label: `${member.name} (${member.email || member.userId})` }))]} onValueChange={(maintainerId) => { if (maintainerId !== null) setTeam((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, maintainerId } : null })) }}><SelectTrigger {...control}>{draft.maintainerId ? fixture.members.find((member) => member.userId === draft.maintainerId)?.name : text("保留成员职责", "Keep member responsibilities")}</SelectTrigger><SelectContent><SelectItem value="">{text("保留成员职责", "Keep member responsibilities")}</SelectItem>{fixture.members.map((member) => <SelectItem key={member.userId} value={member.userId}>{member.name} ({member.email || member.userId})</SelectItem>)}</SelectContent></Select>}</Field>
    <Field id="pm-team-outcome" label={text("本地模拟结果", "Local simulated outcome")}>{(control) => <Select value={teamPage.outcome} disabled={locked} items={[{ value: "confirmed", label: text("confirmed · 确认", "confirmed") }, { value: "rejected", label: text("rejected · 拒绝", "rejected") }, { value: "unknown", label: text("unknown · 结果未知", "unknown") }]} onValueChange={(outcome) => { if (outcome === "confirmed" || outcome === "rejected" || outcome === "unknown") setTeam((previous) => ({ ...previous, outcome })) }}><SelectTrigger {...control}>{teamPage.outcome}</SelectTrigger><SelectContent><SelectItem value="confirmed">{text("confirmed · 确认", "confirmed")}</SelectItem><SelectItem value="rejected">{text("rejected · 拒绝", "rejected")}</SelectItem><SelectItem value="unknown">{text("unknown · 结果未知", "unknown")}</SelectItem></SelectContent></Select>}</Field>
    {teamMessage && <p role={teamPage.result === "unknown" ? "status" : "alert"}>{teamMessage} {teamPage.request?.id}</p>}
    {teamPage.result === "unknown" && <><Field id="pm-team-check-outcome" label={text("检查原请求的模拟结果", "Simulated outcome for original request check")}>{(control) => <Select value={teamPage.checkOutcome} disabled={!canWrite} items={[{ value: "confirmed", label: text("确认原请求", "Confirm original request") }, { value: "rejected", label: text("拒绝原请求", "Reject original request") }]} onValueChange={(checkOutcome) => { if (checkOutcome === "confirmed" || checkOutcome === "rejected") setTeam((previous) => ({ ...previous, checkOutcome })) }}><SelectTrigger {...control}>{teamPage.checkOutcome}</SelectTrigger><SelectContent><SelectItem value="confirmed">{text("确认原请求", "Confirm original request")}</SelectItem><SelectItem value="rejected">{text("拒绝原请求", "Reject original request")}</SelectItem></SelectContent></Select>}</Field><Button type="button" disabled={!canWrite} onClick={() => applyTeam(checkTeamResult(teamPage))}>{text("检查模拟结果（不重新提交）", "Check simulated result (no resubmit)")}</Button></>}
  </form>}</DialogBody><DialogFooter><Button variant="secondary" onClick={() => setTeam((previous) => ({ ...previous, editorOpen: false }))}>{text("取消并保留草稿", "Cancel and keep draft")}</Button><Button type="submit" form="pm-fixture-team-form" disabled={locked}>{text("应用到本地场景", "Apply to local scene")}</Button></DialogFooter></DialogContent></Dialog></>
  const relationsDialog = <Dialog open={editor.open} onOpenChange={(open) => setEditor((previous) => ({ ...previous, open }))}><DialogContent finalFocus={() => trigger.current}><DialogTitle>{editor.kind === "members" ? text("编辑本地团队成员", "Edit local team members") : text("编辑本地关联项目", "Edit local linked projects")}</DialogTitle><DialogDescription>{text("仅本地 Fixture，不发送服务写入。", "Local fixture only; no service write is sent.")}</DialogDescription><DialogBody>{editor.draft && <form id="pm-fixture-relations-form" onSubmit={(event) => { event.preventDefault(); if (!canWrite || !editor.draft) return; const draft = editor.draft; if (editor.kind === "members") fixture.setDomain((previous) => ({ ...previous, memberships: [...previous.memberships.filter((entry) => entry.teamId !== draft.id), ...draft.members.map((entry) => ({ teamId: draft.id, memberId: entry.userId, role: entry.role }))] })); else fixture.setProjectIds((previous) => ({ ...previous, [draft.id]: draft.projectIds })); setEditor((previous) => ({ ...previous, open: false, draft: null })) }}>
    {editor.kind === "members" ? <ul className="space-y-3">{fixture.members.map((member) => { const entry = editor.draft!.members.find((entry) => entry.userId === member.userId); return <li key={member.userId} className="flex items-center gap-3"><Checkbox disabled={!canWrite} checked={!!entry} aria-label={text(`团队包含 ${member.name} (${member.userId})`, `Include ${member.name} (${member.userId}) in team`)} onCheckedChange={(checked) => setEditor((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, members: checked ? [...previous.draft.members, { membershipId: `fixture-team-membership:${previous.draft.id}:${member.userId}`, userId: member.userId, role: "member" }] : previous.draft.members.filter((entry) => entry.userId !== member.userId) } : null }))} /><span className="flex-1">{member.name}</span>{entry && <Select value={entry.role} disabled={!canWrite} items={[{ value: "maintainer", label: text("维护者", "Maintainer") }, { value: "member", label: text("成员", "Member") }]} onValueChange={(role) => { if (role === "member" || role === "maintainer") setEditor((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, members: previous.draft.members.map((entry) => entry.userId === member.userId ? { ...entry, role } : entry) } : null })) }}><SelectTrigger aria-label={text(`${member.name} (${member.userId}) 的团队职责`, `Team responsibility for ${member.name} (${member.userId})`)}>{entry.role === "maintainer" ? text("维护者", "Maintainer") : text("成员", "Member")}</SelectTrigger><SelectContent><SelectItem value="maintainer">{text("维护者", "Maintainer")}</SelectItem><SelectItem value="member">{text("成员", "Member")}</SelectItem></SelectContent></Select>}</li> })}</ul> : <ul>{fixture.projects.map((project) => <li key={project.id}><Checkbox checked={editor.draft!.projectIds.includes(project.id)} disabled={!canWrite} aria-label={text(`关联项目 ${project.title}`, `Link project ${project.title}`)} onCheckedChange={(checked) => setEditor((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, projectIds: checked ? [...previous.draft.projectIds, project.id] : previous.draft.projectIds.filter((id) => id !== project.id) } : null }))} />{project.title}</li>)}</ul>}
  </form>}</DialogBody><DialogFooter><Button variant="secondary" onClick={() => setEditor((previous) => ({ ...previous, open: false }))}>{text("取消", "Cancel")}</Button><Button type="submit" form="pm-fixture-relations-form" disabled={!canWrite}>{text("保存本地修改", "Save local changes")}</Button></DialogFooter></DialogContent></Dialog>
  return <TeamCollectionView variant={variant} interactive={interactive} readingPosition={readingPosition} onReadingPositionChange={setReadingPosition}
    readModel={{ teams, teamOptions: fixture.teams, roles: fixture.roles, selectedTeam: fixture.teams.find((team) => team.id === state.selectedId), selectedMember: fixture.members.find((member) => member.membershipId === state.selectedMemberId), members: fixture.members, projects: fixture.projects, directory, workload, copyReceipt, data: fixture.data, sourceDescription: text("本地 Fixture · 修改仅保留当前内存场景", "Local fixture · changes stay in the current in-memory scene") }}
    interaction={state}
    capabilities={{ sortActivity: true, create: !locked, edit: () => !locked, members: () => canWrite, projectRelations: () => canWrite, openProject: () => scenario !== "loading", memberOpen: () => scenario !== "loading", editMembership: (row) => canWrite && !!row.membership, filterPresence: variant === "team2", navigate: (target) => target === "workload" || canWrite, copyContact: (member, kind) => scenario !== "loading" && (kind === "email" ? !!member.email : kind === "phone" ? !!member.phone : !!member.email || !!member.phone) }}
    actions={{ setInteraction: setState, open: (team, element) => { trigger.current = element; setState((previous) => ({ ...previous, selectedId: team.id, detailOpen: true })) }, create: (element) => openTeam(null, element), edit: openTeam, members: (team, element) => openRelations(team, "members", element), projectRelations: (team, element) => openRelations(team, "projects", element), openProject: (id) => navigate("project-detail-1", id), memberOpen: (member, element) => { trigger.current = element; setState((previous) => ({ ...previous, selectedMemberId: member.membershipId, memberDetailOpen: true })) }, openIssue: (issue) => navigate("issue-detail-1", issue.id), setMembershipRole: (row, role) => { if (canWrite && row.membership) fixture.setDomain((previous) => setPeopleMembershipRole(previous, row.membership!.teamId, row.member.userId, role)) }, navigate: (target) => navigate(target === "workload" ? "team-list-3" : "member-list-3"), copyContact: async (member, kind) => { const value = kind === "email" ? member.email : kind === "phone" ? member.phone : [member.name, member.email, member.phone].filter(Boolean).join("\n"); if (value) setCopyReceipt({ membershipId: member.membershipId, kind, ok: await copyText(value) }) } }}
    editDialog={<>{teamDialog}{relationsDialog}</>}
  />
}

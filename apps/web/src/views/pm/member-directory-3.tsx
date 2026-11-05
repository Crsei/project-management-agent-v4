import { ArrowDownUp, ChevronDown, CirclePlus, Mail, Search, Shield, ShieldCheck, UserRoundPlus, X } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/blocks/data-table"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { useI18n } from "@/lib/i18n-provider"
import { ControlledFeedback } from "./controlled-presentation"
import type { ControlledInvitation, ControlledMember, ControlledSuggestedContact, MemberDirectorySort, MemberDirectoryViewProps } from "./people-controlled-contracts"
import { InvitationStatus, PeopleIdentity, PeopleRoleLabel } from "./people-views"
import { PmPage } from "./presentation-page"
import { MemberDirectoryFilter, memberDirectoryFilterFields } from "./member-directory-filters"
import { MemberDirectoryActionsMenu, MemberDirectoryContextMenu } from "./member-directory-actions"
import styles from "./member-list-3.module.css"

export function MemberList3View(props: MemberDirectoryViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { readModel: model, interaction: state, capabilities, actions } = props
  const loading = model.data.state === "loading"
  const suggestions = model.suggestedContacts
  const hasInviteEditor = props.inviteEditor != null
  const canInvite = !loading && capabilities.invite && hasInviteEditor
  const canManageAccess = (member: ControlledMember) => !loading && !!actions.manageAccess && !!capabilities.manageAccess?.(member)
  const sortChoices: readonly MemberDirectorySort[] = model.sortOptions ?? ["name", "name-desc", "role"]
  const sortLabel = (sort: MemberDirectorySort) => ({
    name: text("名称 A–Z", "Name A–Z"),
    "name-desc": text("名称 Z–A", "Name Z–A"),
    role: text("角色", "Role"),
    joined: text("最早加入", "Oldest"),
    "joined-desc": text("最近加入", "Newest"),
    teams: text("团队最少", "Fewest teams"),
    "teams-desc": text("团队最多", "Most teams"),
    presence: text("可用性", "Availability"),
  })[sort]
  const membersData = { ...model.data, state: (model.data.state ?? "success") === "success" && model.members.length === 0 ? "empty" as const : model.data.state }
  const invitationSource = model.invitationsData ?? model.data
  const invitationsData = { ...invitationSource, state: (invitationSource.state ?? "success") === "success" && model.invitations.length === 0 ? "empty" as const : invitationSource.state }
  const suggestionsData = suggestions ? { ...suggestions.data, state: (suggestions.data.state ?? "success") === "success" && suggestions.items.length === 0 ? "empty" as const : suggestions.data.state } : undefined
  const columns: DataTableColumn<ControlledMember>[] = [
    {
      id: "member", header: text(`全选（${model.members.length}）`, `Select all (${model.members.length})`), primary: true, hideable: false,
      cell: (member) => <Button
        id={`pm-member-open-${member.membershipId}`}
        variant="ghost"
        className={styles.identityButton}
        disabled={loading || !capabilities.memberOpen(member)}
        aria-current={state.selectedId === member.membershipId ? "true" : undefined}
        aria-label={text(`查看 ${member.name} (${member.email || member.membershipId}) 的成员明细`, `Member details for ${member.name} (${member.email || member.membershipId})`)}
        onClick={(event) => actions.memberOpen(member, event.currentTarget)}
      ><PeopleIdentity member={member} /></Button>,
    },
    { id: "role", header: text("角色", "Role"), minWidth: 144, cell: (member) => <PeopleRoleLabel member={member} roles={model.roles} /> },
    {
      id: "security", header: text("安全", "Security"), minWidth: 128,
      cell: (member) => <span className={styles.security} data-pm-security={member.twoFactor == null ? "unknown" : member.twoFactor ? "enrolled" : "missing"}>
        {member.twoFactor === true ? <ShieldCheck aria-hidden="true" size={18} /> : <Shield aria-hidden="true" size={18} />}
        <span>{member.twoFactor == null ? text("2FA 未提供", "2FA unavailable") : member.twoFactor ? "2FA" : text("2FA 未启用", "2FA disabled")}</span>
      </span>,
    },
    {
      id: "access", header: text("访问", "Access"), minWidth: 176, align: "right",
      cell: (member) => {
        return <div className={styles.accessCell}>
          <Button variant="outline" className={styles.manageButton} disabled={!canManageAccess(member)} onClick={(event) => { if (canManageAccess(member)) actions.manageAccess!(member, event.currentTarget) }}>{text("管理访问", "Manage Access")}</Button>
          <MemberDirectoryActionsMenu surface={props} member={member} className={styles.menuButton} />
        </div>
      },
    },
  ]
  const invitationColumns: DataTableColumn<ControlledInvitation>[] = [
    { id: "email", header: text("邮箱", "Email"), primary: true, cell: (invitation) => <span className={styles.recordIdentity} title={invitation.email}>{invitation.email}</span> },
    { id: "role", header: text("角色", "Role"), minWidth: 120, cell: (invitation) => model.roles.find((option) => option.value === invitation.role)?.label ?? `${text("角色", "Role")} ${invitation.role}` },
    {
      id: "status", header: text("邀请状态", "Invitation status"), minWidth: 240,
      cell: (invitation) => <div className={styles.invitationStatus}><InvitationStatus invitation={invitation} />{invitation.requestId && <code>{invitation.requestId}</code>}{invitation.error && <span className={styles.fieldError}>{invitation.error}</span>}</div>,
    },
    {
      id: "request", header: text("请求", "Request"), minWidth: 180,
      cell: (invitation) => invitation.status === "unknown" ? <Button variant="outline" disabled={loading || !capabilities.reconcileInvitation} onClick={() => { if (!loading && capabilities.reconcileInvitation) actions.reconcileInvitation(invitation) }}>{text("检查原请求", "Check original request")}</Button> : <span className={styles.email}><time dateTime={invitation.createdAt ?? undefined}>{invitation.createdAt ?? text("创建时间未提供", "Created date unavailable")}</time>{invitation.expiresAt && <span className="block">{text("到期：", "Expires: ")}<time dateTime={invitation.expiresAt}>{invitation.expiresAt}</time></span>}</span>,
    },
    {
      id: "cancel", header: text("操作", "Actions"), minWidth: 150, align: "right",
      cell: (invitation) => <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={loading || !actions.cancelInvitation || !capabilities.cancelInvitation?.(invitation)} onClick={(event) => {
        if (!loading && actions.cancelInvitation && capabilities.cancelInvitation?.(invitation)) actions.cancelInvitation(invitation, event.currentTarget)
      }}>{text("撤销邀请", "Revoke invitation")}</Button>{actions.resendInvitation && <Button variant="outline" disabled={loading || !capabilities.resendInvitation?.(invitation)} onClick={(event) => {
        if (!loading && capabilities.resendInvitation?.(invitation)) actions.resendInvitation!(invitation, event.currentTarget)
      }}>{text("重发", "Resend")}</Button>}</div>,
    },
  ]
  const suggestionColumns: DataTableColumn<ControlledSuggestedContact>[] = [
    { id: "contact", header: text("建议成员", "Suggested member"), primary: true, cell: (contact) => <span className={styles.suggestionIdentity}><span title={contact.name}>{contact.name}</span><span className={styles.email} title={contact.email}>{contact.email}</span></span> },
    { id: "role", header: text("邀请角色", "Invitation role"), minWidth: 144, cell: (contact) => model.roles.find((option) => option.value === contact.role)?.label ?? `${text("角色", "Role")} ${contact.role}` },
    {
      id: "prepare", header: text("邀请草稿", "Invitation draft"), minWidth: 180, align: "right",
      cell: (contact) => <Button variant="outline" disabled={loading || suggestions?.data.state === "loading" || !capabilities.invite || !actions.prepareSuggestedInvite || !capabilities.prepareSuggestedInvite?.(contact)} onClick={(event) => {
        if (!loading && suggestions?.data.state !== "loading" && capabilities.invite && actions.prepareSuggestedInvite && capabilities.prepareSuggestedInvite?.(contact)) actions.prepareSuggestedInvite(contact, event.currentTarget)
      }}>{text("准备邀请", "Prepare invite")}</Button>,
    },
  ]

  return <PmPage
    interactive={props.interactive}
    headerMode={props.embedded ? "hidden" : "default"}
    pageId="pm-member-list-3"
    className={styles.page}
    title={text("成员", "Members")}
    description={text("管理团队成员与邀请", "Manage team members and invitations")}
    readingPosition={props.readingPosition}
    onReadingPositionChange={props.onReadingPositionChange}
  >
    <ControlledFeedback surface={props} />
    <section className={styles.inviteCard} aria-label={text("邀请成员", "Invite members")} data-pm-invite-form>
      <div className={styles.inviteHead}>
        <h2>{text("通过邮箱地址邀请新成员", "Invite new members by email address")}</h2>
        {props.headerActions ?? <Button id="pm-members-invite" disabled={!canInvite} onClick={(event) => { if (canInvite) actions.invite(event.currentTarget) }}><UserRoundPlus aria-hidden="true" size={16} />{text("邀请", "Invite")}</Button>}
      </div>
      {hasInviteEditor ? <div className={styles.inviteEditor}>{props.inviteEditor}</div> : <div aria-describedby="pm-member3-invite-unavailable">
        <div className={styles.inviteRows}>
          <div className={styles.inviteRow}>
            <div className={styles.field}>
              <label htmlFor="pm-member3-email-unavailable">{text("邮箱地址", "Email Address")}</label>
              <InputGroup><InputGroupAddon><Mail aria-hidden="true" size={16} /></InputGroupAddon><InputGroupInput id="pm-member3-email-unavailable" type="email" placeholder={text("邮箱邀请不可用", "Email invitations unavailable")} disabled aria-describedby="pm-member3-invite-unavailable" /></InputGroup>
            </div>
            <div className={styles.field}>
              <label htmlFor="pm-member3-role-unavailable">{text("角色", "Role")}</label>
              <Select disabled><SelectTrigger id="pm-member3-role-unavailable" className={styles.selectTrigger} aria-describedby="pm-member3-invite-unavailable"><SelectValue placeholder={text("邀请角色不可用", "Invitation role unavailable")} /><ChevronDown aria-hidden="true" size={14} /></SelectTrigger></Select>
            </div>
          </div>
        </div>
        <div className={styles.inviteActions}><Button variant="outline" disabled><CirclePlus aria-hidden="true" size={16} />{text("添加一行", "Add more")}</Button><p id="pm-member3-invite-unavailable" className={styles.unavailable}>{text("当前来源未提供邮箱邀请；此处不会发送邮件或创建成员。", "Email invitations are unavailable from this source. No email is sent or membership created here.")}</p></div>
      </div>}
    </section>
    <Tabs value={state.tab} onValueChange={(tab) => {
      if (tab === "members" || tab === "invitations" || tab === "suggested") actions.setInteraction((previous) => ({ ...previous, tab }))
    }}>
      <div className={styles.tabScroll}>
        <TabsList className={styles.tabList} activateOnFocus={false} aria-label={text("成员与邀请", "Members and invitations")}>
          <TabsTab className={styles.tab} value="members">{text("团队成员", "Team Members")}</TabsTab>
          <TabsTab className={styles.tab} value="invitations">{text("待处理邀请", "Pending Invitations")}</TabsTab>
          <TabsTab className={styles.tab} value="suggested">{text("建议成员", "Suggested Members")}</TabsTab>
        </TabsList>
      </div>
      <div className={styles.filterRow}>
        <InputGroup className={styles.search}>
          <InputGroupAddon><Search aria-hidden="true" size={16} /></InputGroupAddon>
          <InputGroupInput value={state.query} disabled={loading} aria-label={text("筛选成员", "Filter members")} placeholder={text("筛选…", "Filter...")} onChange={(event) => actions.setInteraction((previous) => ({ ...previous, query: event.target.value }))} />
          {state.query && <Button variant="ghost" size="icon" className={styles.clearSearch} disabled={loading} aria-label={text("清除搜索", "Clear search")} onClick={() => actions.setInteraction((previous) => ({ ...previous, query: "" }))}><X aria-hidden="true" size={14} /></Button>}
        </InputGroup>
        <MemberDirectoryFilter
          text={text}
          label={text("筛选", "Filter")}
          fields={memberDirectoryFilterFields(text, {
            roles: model.roles,
            roleAvailable: capabilities.filterRole !== false,
            presenceAvailable: capabilities.filterPresence !== false,
            securityAvailable: capabilities.filterSecurity === true,
            teams: model.teamOptions,
          })}
          conditions={state.conditions ?? []}
          onChange={(next) => actions.setInteraction((previous) => ({ ...previous, conditions: next }))}
          disabled={loading}
          variant="outline"
          className={styles.filterSelect}
          dataPm
        />
        <Select value={state.sort} disabled={loading || !sortChoices.length} onValueChange={(value) => {
          const sort = sortChoices.find((choice) => choice === value)
          if (sort) actions.setInteraction((previous) => ({ ...previous, sort }))
        }}>
          <SelectTrigger className={styles.filterSelect} aria-label={`${text("日期与名称排序", "Date and name ordering")}: ${sortLabel(state.sort)}`} title={sortLabel(state.sort)}><span className={styles.selectLabel}><ArrowDownUp aria-hidden="true" size={16} /><span>{text("日期", "Date")}</span></span><ChevronDown aria-hidden="true" size={14} /></SelectTrigger>
          <SelectContent>
            {(["joined-desc", "joined"] as const).map((sort) => <SelectItem key={sort} value={sort} disabled={!sortChoices.includes(sort)}>{sortLabel(sort)}{!sortChoices.includes(sort) && text(" · 未提供", " · unavailable")}</SelectItem>)}
            {sortChoices.filter((sort) => sort !== "joined" && sort !== "joined-desc").map((sort) => <SelectItem key={sort} value={sort}>{sortLabel(sort)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <TabsPanel className={styles.panel} value="members">
        <DataTable rows={model.members} columns={columns} getRowId={(member) => member.membershipId} getRowLabel={(member) => `${member.name} (${member.email || member.membershipId})`} renderRow={(member, row) => <MemberDirectoryContextMenu surface={props} member={member}>{row}</MemberDirectoryContextMenu>} caption={text("团队成员、来源角色、安全状态与访问授权；未知安全信息保持未提供", "Team members, source roles, security and access; unknown security facts remain unavailable")} selectedIds={state.selectedIds} onSelectionChange={(selectedIds) => actions.setInteraction((previous) => ({ ...previous, selectedIds }))} isRowSelectable={() => !loading} activeRowId={state.selectedId} className={`${styles.table} ${styles.memberTable}`} data={membersData} />
      </TabsPanel>
      <TabsPanel className={styles.panel} value="invitations">
        {model.invitationsNotice && <p role="status" className={styles.sourceUnavailable}>{model.invitationsNotice}</p>}
        <DataTable rows={model.invitations} columns={invitationColumns} getRowId={(invitation) => invitation.id} getRowLabel={(invitation) => invitation.email} caption={text("邀请记录与原请求逐行状态，不表示邮件已投递或成员已加入", "Invitation records and original row outcomes; not email delivery or membership confirmation")} className={`${styles.table} ${styles.invitationTable}`} data={invitationsData} />
      </TabsPanel>
      <TabsPanel className={styles.panel} value="suggested">
        {suggestions ? <DataTable rows={suggestions.items} columns={suggestionColumns} getRowId={(contact) => contact.id} getRowLabel={(contact) => `${contact.name} (${contact.email})`} caption={text("来源提供的建议联系人；准备仅填写草稿，不提交邀请或创建成员", "Source-provided suggested contacts; preparing fills a draft without submitting or creating membership")} className={`${styles.table} ${styles.suggestionTable}`} data={suggestionsData} /> : <p role="status" className={styles.sourceUnavailable}>{text("建议联系人来源未提供；不会生成模拟联系人。", "Suggested contact source unavailable; no contacts are fabricated.")}</p>}
      </TabsPanel>
    </Tabs>
    {model.sourceDescription && <p className={styles.summary}>{model.sourceDescription}</p>}
    {props.memberInspector}{props.inviteDialog}{props.roleEditor}
  </PmPage>
}

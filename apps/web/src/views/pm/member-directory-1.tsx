import type { CSSProperties } from "react"
import { CircleCheck, CircleDashed, CircleHelp, Clock3, ContactRound, Plus, SlidersHorizontal } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DataRegion } from "@/components/ui/data-region"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCaption, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useI18n } from "@/lib/i18n-provider"
import { ControlledFeedback } from "./controlled-presentation"
import { PeopleRoleLabel } from "./people-views"
import { PmPage, PmSearch } from "./presentation-page"
import type { ControlledMember, MemberDirectoryViewProps } from "./people-controlled-contracts"
import { activeMemberConditionCount, MemberDirectoryFilter, memberDirectoryFilterFields } from "./member-directory-filters"
import { MemberDirectoryActionsMenu, MemberDirectoryContextMenu } from "./member-directory-actions"
import styles from "./member-list-1.module.css"

const presences = ["available", "away", "offline"] as const

function PresenceIcon({ presence }: { presence: ControlledMember["presence"] }) {
  const Icon = presence === "available" ? CircleCheck : presence === "away" ? Clock3 : presence === "offline" ? CircleDashed : CircleHelp
  return <Icon aria-hidden="true" size={16} className={styles.presenceIcon} data-presence={presence ?? "unknown"} />
}

export function MemberList1View(props: MemberDirectoryViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { readModel: model, interaction: state, capabilities, actions } = props
  const loading = model.data.state === "loading"
  const dataState = (model.data.state ?? "success") === "success" && model.members.length === 0 ? "empty" : model.data.state
  const presenceLabel = (presence: ControlledMember["presence"]) => presence === "available" ? text("在线", "Available") : presence === "away" ? text("离开", "Away") : presence === "offline" ? text("离线", "Offline") : text("在线状态未知", "Presence unknown")
  const columns = [
    { id: "member", label: text("成员", "Member"), weight: 36, mobileWidth: 320 },
    { id: "availability", label: text("可用性", "Availability"), weight: 16, mobileWidth: 150 },
    { id: "role", label: text("角色", "Role"), weight: 14, mobileWidth: 100 },
    { id: "teams", label: text("团队", "Teams"), weight: 20, mobileWidth: 220 },
    { id: "joined", label: text("加入时间", "Joined"), weight: 14, mobileWidth: 110 },
  ]
  const visibleColumns = columns.filter((column) => column.id === "member" || !state.hiddenColumns.includes(column.id))
  const columnLayout = {
    "--directory-columns": visibleColumns.map((column) => `minmax(0, ${column.weight}fr)`).join(" "),
    "--directory-mobile-columns": visibleColumns.map((column) => `${column.mobileWidth}px`).join(" "),
    "--directory-mobile-width": `${visibleColumns.reduce((width, column) => width + column.mobileWidth, 0)}px`,
  } as CSSProperties
  const dateFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", timeZone: "UTC" })

  function availability(member: ControlledMember) {
    const enabled = !loading && member.presence != null && !!actions.setPresence && !!capabilities.editPresence?.(member)
    const triggerId = `pm-member-presence-${member.membershipId}`
    return <DropdownMenu>
      <DropdownMenuTrigger render={<Button id={triggerId} variant="ghost" className={styles.availabilityButton} disabled={!enabled} aria-label={text(`${member.name} (${member.membershipId}) 的可用性`, `Availability for ${member.name} (${member.membershipId})`)} />}>
        <PresenceIcon presence={member.presence} /><span data-pm-availability={member.presence ?? "unknown"}>{presenceLabel(member.presence)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className={styles.menu}>
        <DropdownMenuRadioGroup value={member.presence ?? ""} onValueChange={(value) => {
          const presence = presences.find((option) => option === value)
          if (enabled && presence && presence !== member.presence) actions.setPresence!(member, presence, document.getElementById(triggerId))
        }}>
          {presences.map((presence) => <DropdownMenuRadioItem key={presence} value={presence} disabled={!enabled}><PresenceIcon presence={presence} />{presenceLabel(presence)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  }

  function cell(member: ControlledMember, columnId: string) {
    if (columnId === "member") return <div className="flex min-w-0 items-center gap-1"><Button id={`pm-member-open-${member.membershipId}`} variant="ghost" className={styles.identityButton} disabled={!capabilities.memberOpen(member)} aria-label={text(`查看 ${member.name} (${member.email || member.membershipId})`, `View ${member.name} (${member.email || member.membershipId})`)} aria-current={state.selectedId === member.membershipId ? "true" : undefined} onClick={(event) => actions.memberOpen(member, event.currentTarget)}>
      <span className={styles.identityCell} data-pm-member={member.membershipId}>
        <span className={styles.avatarWrap} data-pm-person-avatar><Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={32} />{member.presence && <span className={styles.presenceDot} data-presence={member.presence} aria-hidden="true" />}</span>
        <span className={styles.identityText}><span className={styles.memberName} title={member.name}>{member.name}</span><span className={styles.email} title={member.email}>{member.email || text("邮箱未提供", "Email unavailable")}</span></span>
      </span>
    </Button><MemberDirectoryActionsMenu surface={props} member={member} className="shrink-0" menuClassName={styles.menu} /></div>
    if (columnId === "availability") return availability(member)
    if (columnId === "role") return <Button variant="ghost" className={styles.roleCell} disabled={loading || (!member.isOwner && !model.roles.some((role) => role.value === member.role)) || !capabilities.editRole(member)} aria-label={text(`编辑 ${member.name} (${member.membershipId}) 的角色`, `Edit role for ${member.name} (${member.membershipId})`)} onClick={(event) => actions.editRole(member, event.currentTarget)}><PeopleRoleLabel member={member} roles={model.roles} /></Button>
    if (columnId === "teams") {
      if (model.teamsAvailable === false) return <span className={styles.missing} title={text("服务未提供团队信息", "Team information is not provided by the service")}>{text("未提供", "Unavailable")}</span>
      const teams = member.teams ?? model.teams.filter((team) => team.members.some((entry) => entry.userId === member.userId))
      if (teams.length === 0) return <span className={styles.missing}>{text("暂无团队", "No teams")}</span>
      return <Button variant="ghost" className={styles.teamsButton} disabled={!capabilities.memberOpen(member)} aria-label={text(`查看 ${member.name} (${member.email || member.membershipId}) 的 ${teams.length} 个团队`, `View ${teams.length} teams for ${member.name} (${member.email || member.membershipId})`)} title={teams.map((team) => team.name).join(", ")} onClick={(event) => actions.memberOpen(member, event.currentTarget)}>
        <ContactRound aria-hidden="true" size={14} /><span className={styles.teamIdentifiers}>{teams.slice(0, 2).map((team) => "identifier" in team && team.identifier || team.name).join(", ")}</span>{teams.length > 2 && <span className={styles.teamOverflow}>+{teams.length - 2}</span>}
      </Button>
    }
    return <span className={styles.joined} title={member.joinedAt ?? text("服务未提供加入时间", "Join date is not provided by the service")}>{member.joinedAt ? <time dateTime={member.joinedAt}>{dateFormat.format(new Date(member.joinedAt))}</time> : "—"}</span>
  }

  const conditions = state.conditions ?? []
  const filterFields = memberDirectoryFilterFields(text, {
    roles: model.roles,
    roleAvailable: capabilities.filterRole !== false,
    presenceAvailable: capabilities.filterPresence !== false,
    securityAvailable: capabilities.filterSecurity === true,
    teams: model.teamOptions,
  })
  const filterCount = activeMemberConditionCount(conditions) + Number(!!state.query)
  const filterMenu = <MemberDirectoryFilter
    text={text}
    label={text("筛选", "Filter")}
    fields={filterFields}
    conditions={conditions}
    onChange={(next) => actions.setInteraction((previous) => ({ ...previous, conditions: next }))}
    disabled={loading}
    variant="ghost"
    className={styles.filterTrigger}
    dataPm
    activeCount={filterCount}
    header={<div className={`${styles.searchField} px-3 pt-3`}><PmSearch value={state.query} onChange={(query) => actions.setInteraction((previous) => ({ ...previous, query }))} label={text("搜索成员或团队", "Search members or teams")} /></div>}
  />
  const displayMenu = <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="secondary" className={styles.displayTrigger} disabled={loading} data-pm-display-trigger />}><SlidersHorizontal aria-hidden="true" size={16} />{text("显示", "Display")}</DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={styles.menu}>
      <DropdownMenuLabel className={styles.menuLabel}>{text("显示列", "Visible columns")}</DropdownMenuLabel>
      {columns.filter((column) => column.id !== "member").map((column) => <DropdownMenuCheckboxItem key={column.id} checked={!state.hiddenColumns.includes(column.id)} closeOnClick={false} onCheckedChange={(checked) => actions.setInteraction((previous) => ({ ...previous, hiddenColumns: checked ? previous.hiddenColumns.filter((id) => id !== column.id) : [...new Set([...previous.hiddenColumns, column.id])] }))}>{column.label}</DropdownMenuCheckboxItem>)}
      <DropdownMenuSeparator className={styles.separator} /><DropdownMenuCheckboxItem checked={state.comfortable} closeOnClick={false} onCheckedChange={(comfortable) => actions.setInteraction((previous) => ({ ...previous, comfortable: comfortable === true }))}>{text("宽松行距", "Comfortable rows")}</DropdownMenuCheckboxItem>
      {!!model.sortOptions?.length && <><DropdownMenuSeparator className={styles.separator} /><DropdownMenuLabel className={styles.menuLabel}>{text("排序", "Sort")}</DropdownMenuLabel><DropdownMenuRadioGroup value={state.sort} onValueChange={value => {
        const sort = model.sortOptions?.find(option => option === value)
        if (sort) actions.setInteraction(previous => ({ ...previous, sort }))
      }}>{model.sortOptions.map(sort => <DropdownMenuRadioItem key={sort} value={sort}>{({
        name: text("姓名 A–Z", "Name A–Z"), "name-desc": text("姓名 Z–A", "Name Z–A"), role: text("角色", "Role"),
        joined: text("最早加入", "Oldest joined"), "joined-desc": text("最近加入", "Newest joined"),
        teams: text("团队最少", "Fewest teams"), "teams-desc": text("团队最多", "Most teams"), presence: text("可用性", "Availability"),
      })[sort]}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></>}
    </DropdownMenuContent>
  </DropdownMenu>

  return <PmPage interactive={props.interactive} headerMode={props.embedded ? "hidden" : "default"} pageId="pm-member-list-1" className={styles.page} title={text("成员", "Members")} titleSuffix={!loading ? <span className={styles.count} data-pm-member-count aria-label={model.totalMemberCount != null ? text("成员总数", "Total members") : text("可见成员数", "Visible members")}>{model.totalMemberCount ?? model.members.length}</span> : undefined} readingPosition={props.readingPosition} onReadingPositionChange={props.onReadingPositionChange} actions={<div className={styles.headerActions}>{filterMenu}{displayMenu}<div className={styles.inviteAction}>{props.headerActions ?? <Button id="pm-members-invite" disabled={loading || !capabilities.invite} aria-label={text("邀请成员", "Invite Member")} onClick={(event) => actions.invite(event.currentTarget)}><Plus aria-hidden="true" size={16} /><span className={styles.inviteLabel}>{text("邀请成员", "Invite Member")}</span></Button>}</div></div>}>
    <ControlledFeedback surface={props} />
    <DataRegion {...model.data} state={dataState} hasContent={model.members.length > 0} rowHeight={61}>
      <TableContainer role="region" aria-label={text("成员目录", "Member directory")} className={styles.tableScroll}>
        <Table role="table" className={`${styles.directory} ${state.comfortable ? styles.comfortable : ""}`} style={columnLayout}>
          <TableCaption>{text("成员目录", "Member directory")}</TableCaption>
          <TableHeader role="rowgroup"><TableRow role="row">{visibleColumns.map((column) => <TableHead role="columnheader" key={column.id}>{column.label}</TableHead>)}</TableRow></TableHeader>
          <TableBody role="rowgroup">{model.members.map((member) => <MemberDirectoryContextMenu key={member.membershipId} surface={props} member={member}><TableRow role="row" tabIndex={0} data-row-id={member.membershipId} data-member-id={member.membershipId} aria-label={`${member.name} (${member.email || member.membershipId})`}>{visibleColumns.map((column) => <TableCell role="cell" key={column.id}>{cell(member, column.id)}</TableCell>)}</TableRow></MemberDirectoryContextMenu>)}</TableBody>
        </Table>
      </TableContainer>
    </DataRegion>
    {props.memberInspector}{props.inviteDialog}{props.roleEditor}
  </PmPage>
}

import { Copy, LayoutGrid, List, ListTodo, MoreHorizontal, Search, SlidersHorizontal, UserRoundPlus, Users, X } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DataRegion } from "@/components/ui/data-region"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { useI18n } from "@/lib/i18n-provider"
import { ControlledFeedback } from "./controlled-presentation"
import type { ControlledPeopleDirectoryRow, TeamCollectionViewProps } from "./people-controlled-contracts"
import { PmPage } from "./presentation-page"
import styles from "./team-list-2.module.css"

export function TeamList2Content(props: TeamCollectionViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { readModel: model, interaction: state, capabilities, actions } = props
  const directory = model.directory
  const sourceData = directory?.data ?? model.data
  const loading = sourceData.state === "loading"
  const grouped = state.tab === "groups"
  const hasContent = !!directory && (grouped ? directory.groups.some((group) => group.rows.length > 0) : directory.rows.length > 0)
  const data = { ...sourceData, state: (sourceData.state ?? "success") === "success" && directory && !hasContent ? "empty" as const : sourceData.state }
  const teamsAvailable = model.teamsAvailable !== false
  const count = directory?.totalCount ?? directory?.rows.length
  const teamOptions = model.teamOptions ?? model.teams
  const groupLabel = directory?.grouping === "departments" ? text("部门", "Departments") : text("团队", "Teams")
  const canNavigate = (target: "members" | "workload") => !!actions.navigate && !!capabilities.navigate?.(target)
  const dateFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
  const presenceLabels = { available: text("在线", "Available"), away: text("离开", "Away"), offline: text("离线", "Offline") }
  const filtered = !!state.teamId || !!state.presenceFilter && state.presenceFilter !== "all"

  const personCard = (row: ControlledPeopleDirectoryRow, contextId: string) => {
    const { member, teams, membership } = row
    const roleTriggerId = `pm-directory-membership-${contextId}-${membership?.membershipId ?? member.membershipId}`
    const canOpen = capabilities.memberOpen(member)
    const canEditMembership = !loading && !!membership && !!actions.setMembershipRole && !!capabilities.editMembership?.(row)
    const teamNames = teams.map((team) => team.name).join(", ")
    const receipt = model.copyReceipt?.membershipId === member.membershipId ? model.copyReceipt : null
    const presence = member.presence ? presenceLabels[member.presence] : text("在线状态未知", "Presence unknown")
    const canCopyPhone = !!member.phone && !!actions.copyContact && !!capabilities.copyContact?.(member, "phone")
    return <li key={member.membershipId} className={styles.cardItem}>
      <article className={styles.card} data-pm-directory-card data-member-id={member.membershipId} data-selected={state.selectedMemberId === member.membershipId}>
        <div className={styles.cardTop}>
          <span className={styles.avatarWrap} data-pm-person-avatar>
            <Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={40} className={styles.avatar} />
            <span className={styles.presence} data-pm-availability={member.presence ?? "unknown"} title={presence}><span className="sr-only">{presence}</span></span>
          </span>
          {member.engagement && <span className={styles.engagement} data-pm-engagement={member.engagement}>{member.engagement}</span>}
        </div>
        <div className={styles.identity}>
          <h3><Button id={`pm-directory-member-${contextId}-${member.membershipId}`} variant="ghost" className={styles.personName} disabled={!canOpen} title={member.name} aria-label={text(`查看 ${member.name} 的成员明细`, `View member details for ${member.name}`)} onClick={(event) => actions.memberOpen(member, event.currentTarget)}>{member.name}</Button></h3>
          <p className={styles.companyRole} title={member.companyRole ?? undefined}>{member.companyRole ?? text("岗位未提供", "Job role unavailable")}</p>
        </div>
        <dl className={styles.facts}>
          <div><dt>{text("团队", "Team")}</dt><dd title={teamsAvailable ? teamNames : undefined}>{teamsAvailable ? teamNames || text("没有可见团队", "No visible team") : text("未提供", "Unavailable")}</dd></div>
          <div><dt>{text("加入时间", "Joined")}</dt><dd>{member.joinedAt ? <time dateTime={member.joinedAt}>{dateFormat.format(new Date(member.joinedAt))}</time> : text("未提供", "Unavailable")}</dd></div>
        </dl>
        <div className={styles.contact}>
          <div className={styles.emailRow}>
            <span className={styles.email} title={member.email || undefined}>{member.email || text("邮箱未提供", "Email unavailable")}</span>
            <Button variant="ghost" size="icon" className={styles.copyButton} disabled={!member.email || !actions.copyContact || !capabilities.copyContact?.(member, "email")} aria-label={text(`复制 ${member.name} 的邮箱`, `Copy email for ${member.name}`)} onClick={(event) => actions.copyContact?.(member, "email", event.currentTarget)}><Copy size={14} aria-hidden="true" /></Button>
          </div>
          <div className={styles.cardFooter}>
            {canCopyPhone ? <Button variant="ghost" className={styles.phoneButton} aria-label={text(`复制 ${member.name} 的电话`, `Copy phone for ${member.name}`)} title={member.phone ?? undefined} onClick={(event) => actions.copyContact?.(member, "phone", event.currentTarget)}>{member.phone}</Button> : <span className={styles.phone} title={member.phone ?? undefined}>{member.phone || text("电话未提供", "Phone unavailable")}</span>}
            <span className={styles.teamCount} title={teamsAvailable ? teamNames : undefined}>{teamsAvailable ? text(`${teams.length} 个可见团队`, `${teams.length} visible ${teams.length === 1 ? "team" : "teams"}`) : text("团队数未知", "Teams unknown")}</span>
          </div>
          {receipt && <p role="status" className={styles.copyReceipt} data-pm-copy-receipt>{receipt.ok ? text("已复制", "Copied") : text("无法复制；请手动选择联系方式。", "Copy unavailable; select the contact information manually.")}</p>}
        </div>
        {membership && <div className={styles.cardMenu}>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button id={roleTriggerId} variant="ghost" size="icon" className={styles.copyButton} aria-label={text(`${member.name} 的操作与团队角色`, `Actions and team membership for ${member.name}`)} />}><MoreHorizontal size={16} aria-hidden="true" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!canOpen} onSelect={() => actions.memberOpen(member, document.getElementById(roleTriggerId))}>{text("成员明细", "Member details")}</DropdownMenuItem>
              {canEditMembership ? <><DropdownMenuSeparator className={styles.menuSeparator} />
                <DropdownMenuGroup>
                  <DropdownMenuLabel className={styles.filterLabel}>{text("团队成员身份", "Team membership")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={membership.role} onValueChange={(role) => { if (role === "maintainer" || role === "member") actions.setMembershipRole?.(row, role, document.getElementById(roleTriggerId)) }}>
                    <DropdownMenuRadioItem value="maintainer">{text("维护者", "Maintainer")}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="member">{text("成员", "Member")}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup></> : <DropdownMenuLabel>{membership.role === "maintainer" ? text("维护者", "Maintainer") : text("团队成员", "Team member")}</DropdownMenuLabel>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>}
      </article>
    </li>
  }

  const filter = <DropdownMenu>
    <DropdownMenuTrigger render={<Button id="pm-team2-filter" variant="outline" className={styles.filterButton} disabled={loading || !teamOptions.length && !capabilities.filterPresence && !filtered} data-filtered={filtered} />}><SlidersHorizontal size={16} aria-hidden="true" />{text("筛选", "Filter")}{filtered && <span className={styles.filterDot} aria-hidden="true" />}</DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={styles.filterMenu}>
      <DropdownMenuGroup>
        <DropdownMenuLabel className={styles.filterLabel}>{text("团队", "Team")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={state.teamId ?? "all"} onValueChange={(teamId) => actions.setInteraction((previous) => ({ ...previous, teamId: teamId === "all" ? null : teamId }))}>
          <DropdownMenuRadioItem value="all">{text("所有团队", "All teams")}</DropdownMenuRadioItem>
          {teamOptions.map((team) => <DropdownMenuRadioItem key={team.id} value={team.id}>{team.name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      {capabilities.filterPresence && <>
        <DropdownMenuSeparator className={styles.menuSeparator} />
        <DropdownMenuGroup>
          <DropdownMenuLabel className={styles.filterLabel}>{text("在线状态", "Presence")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={state.presenceFilter ?? "all"} onValueChange={(presenceFilter) => { if (presenceFilter === "all" || presenceFilter === "available" || presenceFilter === "away" || presenceFilter === "offline") actions.setInteraction((previous) => ({ ...previous, presenceFilter })) }}>
            <DropdownMenuRadioItem value="all">{text("所有状态", "All statuses")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="available">{presenceLabels.available}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="away">{presenceLabels.away}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="offline">{presenceLabels.offline}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </>}
      {filtered && <><DropdownMenuSeparator className={styles.menuSeparator} /><DropdownMenuItem onSelect={() => actions.setInteraction((previous) => ({ ...previous, teamId: null, presenceFilter: "all" }))}>{text("清除筛选", "Clear filters")}</DropdownMenuItem></>}
    </DropdownMenuContent>
  </DropdownMenu>

  return <PmPage
    interactive={props.interactive}
    pageId="pm-team-list-2"
    className={styles.page}
    title={text("团队", "Teams")}
    eyebrow={<p className={styles.eyebrow}>{text("团队", "Teams")}</p>}
    readingPosition={props.readingPosition}
    onReadingPositionChange={props.onReadingPositionChange}
    actions={<div className={styles.headerActions}>{props.headerActions}<Button id="pm-team-create" className={styles.newMember} disabled={loading || !canNavigate("members")} title={!canNavigate("members") ? text("邀请需要管理权限、可用邀请来源及 SMTP 配置", "Invitations require management access, an available invitation source and configured SMTP") : undefined} onClick={() => actions.navigate?.("members")}><UserRoundPlus size={16} aria-hidden="true" />{text("邀请成员", "Invite member")}</Button></div>}
    toolbar={<>
      <div className={styles.tabs}>
        <Tabs value={grouped ? "groups" : "directory"} onValueChange={(tab) => { if (tab === "directory" || tab === "groups") actions.setInteraction((previous) => ({ ...previous, tab })) }}>
          <TabsList activateOnFocus={false} aria-label={text("团队视图", "Team views")}>
            <TabsTab id="pm-team2-directory-tab" value="directory"><Users size={16} aria-hidden="true" />{text("目录", "Directory")}</TabsTab>
            <TabsTab id="pm-team2-groups-tab" value="groups"><LayoutGrid size={16} aria-hidden="true" />{groupLabel}</TabsTab>
          </TabsList>
        </Tabs>
        <Button id="pm-team2-tasks" variant="ghost" className={styles.tasksTab} disabled={!canNavigate("workload")} onClick={() => actions.navigate?.("workload")}><ListTodo size={16} aria-hidden="true" />{text("任务", "Tasks")}</Button>
      </div>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}><h2>{text("成员", "Members")}</h2><p>{count === undefined ? text("成员目录来源未提供", "Member directory unavailable") : teamsAvailable ? text(`${count} 位成员，跨项目团队协作`, `${count} people across project teams`) : text(`${count} 位工作区成员`, `${count} workspace members`)}</p></div>
        <div className={styles.sectionControls}>
          <div className={styles.search}>
            <Search size={16} aria-hidden="true" />
            <Input id="pm-team2-search" value={state.query} placeholder={text("搜索成员…", "Search members...")} aria-label={text("搜索成员", "Search members")} onChange={(event) => actions.setInteraction((previous) => ({ ...previous, query: event.target.value }))} />
            {state.query && <Button variant="ghost" size="icon" aria-label={text("清除搜索", "Clear search")} onClick={() => actions.setInteraction((previous) => ({ ...previous, query: "" }))}><X size={14} aria-hidden="true" /></Button>}
          </div>
          {filter}
          <Button id="pm-team2-display" variant="outline" size="icon" className={styles.displayButton} aria-label={state.display === "cards" ? text("切换为列表布局", "Switch to list layout") : text("切换为网格布局", "Switch to grid layout")} aria-pressed={state.display === "cards"} onClick={() => actions.setInteraction((previous) => ({ ...previous, display: previous.display === "cards" ? "table" : "cards" }))}>{state.display === "cards" ? <LayoutGrid size={16} aria-hidden="true" /> : <List size={16} aria-hidden="true" />}</Button>
        </div>
      </div>
    </>}
  >
    <ControlledFeedback surface={props} />
    <DataRegion {...data} hasContent={hasContent}>
      {directory ? grouped ? directory.groups.map((group) => <section key={group.id} className={styles.group}>
        <div className={styles.groupHead}><h3>{group.label}</h3><span className={styles.groupCount}>{text(`${group.rows.length} 位成员`, `${group.rows.length} members`)}</span></div>
        <ul className={state.display === "cards" ? styles.grid : styles.list} aria-label={group.label} data-pm-department-groups={directory.grouping === "departments" || undefined} data-pm-team-groups={directory.grouping !== "departments" || undefined} data-pm-directory-layout={state.display}>{group.rows.map((row) => personCard(row, group.id))}</ul>
      </section>) : <ul className={state.display === "cards" ? styles.grid : styles.list} aria-label={text("成员目录", "Member directory")} data-pm-directory-grid data-pm-directory-layout={state.display}>{directory.rows.map((row) => personCard(row, "directory"))}</ul> : <p role="status" className={styles.unavailable}>{text("成员目录来源未提供；不会由团队行生成模拟人员。", "Person-directory source unavailable; no people are fabricated from team rows.")}</p>}
    </DataRegion>
    {model.sourceDescription && <p className={styles.sourceNote} data-pm-source-note>{model.sourceDescription}</p>}
  </PmPage>
}

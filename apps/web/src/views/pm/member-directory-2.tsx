import { ArrowUpDown, CircleCheck, CircleDashed, CircleHelp, Mail, Phone, Plus, Shield, SlidersHorizontal } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DataRegion } from "@/components/ui/data-region"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useI18n } from "@/lib/i18n-provider"
import { ControlledFeedback } from "./controlled-presentation"
import type { MemberDirectorySort, MemberDirectoryViewProps } from "./people-controlled-contracts"
import { PeopleRoleLabel } from "./people-views"
import { PmPage, PmSearch } from "./presentation-page"
import { MemberDirectoryFilter, memberDirectoryFilterFields } from "./member-directory-filters"
import { MemberDirectoryActionsMenu, MemberDirectoryContextMenu } from "./member-directory-actions"
import styles from "./member-list-2.module.css"

export function MemberList2View(props: MemberDirectoryViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { readModel: model, interaction: state, capabilities, actions } = props
  const loading = model.data.state === "loading"
  const data = { ...model.data, state: (model.data.state ?? "success") === "success" && model.members.length === 0 ? "empty" as const : model.data.state }
  const sortChoices: readonly MemberDirectorySort[] = model.sortOptions ?? ["name", "name-desc", "role"]
  const sortLabels: Record<MemberDirectorySort, string> = {
    name: text("姓名 A–Z", "Name A–Z"),
    "name-desc": text("姓名 Z–A", "Name Z–A"),
    role: text("角色", "Role"),
    joined: text("最早加入", "Oldest joined"),
    "joined-desc": text("最近加入", "Newest joined"),
    teams: text("团队最少", "Fewest teams"),
    "teams-desc": text("团队最多", "Most teams"),
    presence: text("可用性", "Availability"),
  }
  const canSortRecent = !loading && sortChoices.includes("joined-desc")

  return <PmPage
    interactive={props.interactive}
    headerMode={props.embedded ? "hidden" : "default"}
    pageId="pm-member-list-2"
    className={styles.page}
    title={text("成员", "Members")}
    titleSuffix={!loading ? <span className={styles.count} data-pm-member-count aria-label={model.totalMemberCount != null ? text("成员总数", "Total members") : text("可见成员数", "Visible members")}>{model.totalMemberCount ?? model.members.length}</span> : undefined}
    readingPosition={props.readingPosition}
    onReadingPositionChange={props.onReadingPositionChange}
    actions={<div className={styles.actions}>
      <MemberDirectoryFilter
        text={text}
        label={text("筛选", "Filter")}
        fields={memberDirectoryFilterFields(text, {
          roles: model.roles,
          roleAvailable: capabilities.filterRole !== false,
          presenceAvailable: capabilities.filterPresence !== false,
          securityAvailable: capabilities.filterSecurity === true,
          teams: model.teamOptions ?? model.teams.map(team => ({ id: team.id, name: team.name })),
        })}
        conditions={state.conditions ?? []}
        onChange={(next) => actions.setInteraction((previous) => ({ ...previous, conditions: next }))}
        disabled={loading}
        variant="outline"
        dataPm
      />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button id="pm-members-sort" variant="outline" disabled={loading || sortChoices.length === 0} />}><ArrowUpDown aria-hidden="true" />{text("排序", "Sort")}</DropdownMenuTrigger>
        <DropdownMenuContent className={styles.menu} align="end">
          <DropdownMenuRadioGroup value={state.sort} onValueChange={(value) => {
            const sort = sortChoices.find((choice) => choice === value)
            if (sort) actions.setInteraction((previous) => ({ ...previous, sort }))
          }}>
            {sortChoices.map((sort) => <DropdownMenuRadioItem key={sort} value={sort}>{sortLabels[sort]}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button id="pm-members-recent" variant="outline" disabled={!canSortRecent} aria-pressed={state.sort === "joined-desc"} title={!canSortRecent && !loading ? text("来源未提供按加入时间排序", "The source does not support sorting by join date") : undefined} onClick={() => {
        if (canSortRecent) actions.setInteraction((previous) => ({ ...previous, sort: "joined-desc" }))
      }}><Shield aria-hidden="true" />{text("最近", "Recent")}</Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button id="pm-members-display" variant="outline" disabled={loading} data-pm-display-trigger />}><SlidersHorizontal aria-hidden="true" />{text("显示", "Display")}</DropdownMenuTrigger>
        <DropdownMenuContent className={styles.menu} align="end">
          <DropdownMenuRadioGroup value={state.display} onValueChange={(display) => {
            if (display === "grid" || display === "list") actions.setInteraction((previous) => ({ ...previous, display }))
          }}>
            <DropdownMenuRadioItem value="grid">{text("卡片网格", "Card grid")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="list">{text("单列列表", "Single column")}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className={styles.mainActions} data-pm-custom-actions={props.headerActions ? true : undefined}>{props.headerActions ?? <Button id="pm-members-invite" disabled={loading || !capabilities.invite} aria-label={text("邀请成员", "Invite Member")} onClick={(event) => actions.invite(event.currentTarget)}><Plus aria-hidden="true" /><span className={styles.inviteLabel}>{text("邀请成员", "Invite Member")}</span></Button>}</div>
    </div>}
  >
    <ControlledFeedback surface={props} />
    <div className={styles.intro}>
      <div className={styles.heading}>{!props.embedded && <h2>{text("成员列表 2", "Member List 2")}</h2>}<p>{text("联系卡片网格，查看团队归属并快速操作成员。", "Contact-card grid with team ownership and quick member actions.")}</p></div>
      <div className={styles.search}><PmSearch value={state.query} onChange={(query) => actions.setInteraction((previous) => ({ ...previous, query }))} label={text("搜索成员…", "Search members...")} /></div>
    </div>
    <DataRegion {...data} hasContent={model.members.length > 0} rowHeight={229}>
      <ul className={styles.grid} data-view={state.display} data-pm-contact-grid aria-label={text("成员联系卡片", "Member contact cards")}>
        {model.members.map((member) => {
          const selected = state.selectedIds.includes(member.membershipId)
          const email = member.email.trim()
          const phone = member.phone?.trim()
          const presenceLabel = member.presence === "available" ? text("在线", "Available") : member.presence === "away" ? text("离开", "Away") : member.presence === "offline" ? text("离线", "Offline") : text("在线状态未知", "Presence unknown")
          const PresenceIcon = member.presence === "available" ? CircleCheck : member.presence ? CircleDashed : CircleHelp
          return <MemberDirectoryContextMenu key={member.membershipId} surface={props} member={member} selectable><li tabIndex={0} aria-label={`${member.name} (${member.email || member.membershipId})`} className={styles.card} data-pm-contact-card data-member-id={member.membershipId} data-selected={selected}>
            <MemberDirectoryActionsMenu surface={props} member={member} selectable className={styles.memberActions} menuClassName={styles.menu} />
            <div className={styles.cardTop} data-pm-contact-top>
              <span className={styles.avatarWrap} data-pm-person-avatar aria-hidden="true"><Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={40} className={styles.avatar} />{member.presence && <span className={styles.presenceDot} data-presence={member.presence} />}</span>
              <div className={styles.identity}>
                <h3><Button id={`pm-member-open-${member.membershipId}`} variant="ghost" className={styles.nameButton} title={member.name} disabled={!capabilities.memberOpen(member)} aria-current={state.selectedId === member.membershipId ? "true" : undefined} aria-label={text(`查看 ${member.name} (${member.membershipId})`, `View ${member.name} (${member.membershipId})`)} onClick={(event) => actions.memberOpen(member, event.currentTarget)}><span>{member.name}</span></Button></h3>
                <p title={member.companyRole ?? undefined}>{member.companyRole ?? text("岗位未提供", "Job role unavailable")}</p>
                {member.teams !== undefined && <p title={member.teams.map(team => team.name).join(", ")}>{member.teams.map(team => team.name).join(", ") || text("暂无团队", "No teams")}</p>}
              </div>
              <div className={styles.badgeRow}><PeopleRoleLabel member={member} roles={model.roles} /><span className={styles.presence} data-pm-availability={member.presence ?? "unknown"}><PresenceIcon aria-hidden="true" />{presenceLabel}</span></div>
            </div>
            <div className={styles.cardFooter} data-pm-contact-footer>
              {email ? <a href={`mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`} aria-label={text(`给 ${member.name} (${member.membershipId}) 发邮件`, `Email ${member.name} (${member.membershipId})`)} title={email}><Mail aria-hidden="true" />{text("邮件", "Email")}</a> : <Button variant="ghost" disabled title={text("邮箱未提供", "Email unavailable")} aria-label={text(`${member.name} 的邮箱未提供`, `Email unavailable for ${member.name}`)}><Mail aria-hidden="true" />{text("邮件", "Email")}</Button>}
              {phone ? <a href={`tel:${encodeURIComponent(phone)}`} aria-label={text(`致电 ${member.name} (${member.membershipId})`, `Call ${member.name} (${member.membershipId})`)} title={phone}><Phone aria-hidden="true" />{text("电话", "Call")}</a> : <Button variant="ghost" disabled title={text("电话未提供", "Phone unavailable")} aria-label={text(`${member.name} 的电话未提供`, `Phone unavailable for ${member.name}`)}><Phone aria-hidden="true" />{text("电话", "Call")}</Button>}
            </div>
          </li></MemberDirectoryContextMenu>
        })}
      </ul>
    </DataRegion>
    {props.memberInspector}{props.inviteDialog}{props.roleEditor}
  </PmPage>
}

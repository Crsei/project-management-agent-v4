import { ArrowDownAZ, Clock3, FolderKanban, LayoutGrid, List, ListFilter, MoreHorizontal, Plus, SlidersHorizontal, Users } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DataRegion } from "@/components/ui/data-region"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterCard, type FilterCondition, type FilterField } from "@/components/blocks/filter-card"
import { useI18n } from "@/lib/i18n-provider"
import { ControlledFeedback } from "./controlled-presentation"
import type { ControlledTeam, TeamCollectionViewProps } from "./people-controlled-contracts"
import { PmPage, PmSearch } from "./presentation-page"
import { teamFilterConditions, teamMatchesConditions, withTeamFilterConditions } from "./team-filter"
import styles from "./team-list-1.module.css"

export function TeamList1Content(props: TeamCollectionViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { readModel: model, interaction: state, capabilities, actions } = props
  const loading = model.data.state === "loading"
  const teamsAvailable = model.teamsAvailable !== false
  const membersByUserId = new Map(model.members.map((member) => [member.userId, member]))
  const dateFormat = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" })
  const conditions = teamFilterConditions(state)
  /** Idempotent guard: hosts that project teams themselves (fixtures) still honor card conditions. */
  const teams = model.teams.filter((team) => teamMatchesConditions(team, conditions, membersByUserId))
  const hasContent = teams.length > 0
  const dataState = (model.data.state ?? "success") === "success" && !hasContent ? "empty" : model.data.state
  const filtered = !!state.query || conditions.some((condition) => condition.values.length > 0)
  const emptyTitle = filtered ? text("没有匹配筛选的团队", "No teams match these filters") : undefined
  const emptyDescription = filtered ? text("调整或清除筛选条件以查看团队。", "Adjust or clear the filters to see teams.") : undefined
  const teamChoices = model.teamOptions ?? model.teams
  const filterFields: FilterField[] = [
    { id: "focus", label: text("工作方向", "Focus"), single: true, options: [...new Set(teamChoices.flatMap((team) => team.focus ? [team.focus] : []))].map((focus) => ({ value: focus, label: focus })) },
    ...(capabilities.filterPresence ? [{ id: "presence", label: text("可用性", "Presence"), single: true, options: [{ value: "available", label: text("在线", "Available") }, { value: "away", label: text("离开", "Away") }, { value: "offline", label: text("离线", "Offline") }] }] : []),
    { id: "team", label: text("团队", "Team"), single: true, options: teamChoices.map((team) => ({ value: team.id, label: team.name })) },
    { id: "member", label: text("成员", "Member"), options: model.members.map((member) => ({ value: member.userId, label: member.name })) },
  ]
  const openTab = (team: ControlledTeam, detailTab: "members" | "projects", trigger: HTMLElement) => {
    actions.setInteraction((previous) => ({ ...previous, detailTab }))
    actions.open(team, trigger)
  }
  const selectTeam = (team: ControlledTeam, checked: boolean) => actions.setInteraction((previous) => ({
    ...previous,
    selectedIds: checked ? previous.selectedIds.includes(team.id) ? previous.selectedIds : [...previous.selectedIds, team.id] : previous.selectedIds.filter((id) => id !== team.id),
  }))
  const identity = (team: ControlledTeam) => <span className={styles.teamIdentity}>
    <span className={styles.symbol}><Users size={16} aria-hidden="true" /></span>
    <span className={styles.teamText}>
      <span className={styles.teamName} title={team.name}>{team.name}</span>
      <span className={styles.identifier} title={team.identifier ?? undefined}>{team.identifier ?? text("标识未提供", "Identifier unavailable")}</span>
    </span>
  </span>
  const teamActions = (team: ControlledTeam) => {
    const triggerId = `pm-team-actions-${team.id}`
    const trigger = () => document.getElementById(triggerId)
    return <DropdownMenu>
      <DropdownMenuTrigger render={<Button id={triggerId} variant="ghost" size="icon" className={styles.rowActions} aria-label={text(`${team.name} 的操作`, `Actions for ${team.name}`)} />}><MoreHorizontal size={16} aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={styles.actionMenu}>
        <DropdownMenuItem onClick={() => actions.open(team, trigger())}>{text("团队详情", "Team details")}</DropdownMenuItem>
        {actions.teamWorkload && <DropdownMenuItem onClick={() => actions.teamWorkload?.(team)}>{text("查看团队工作量", "View team workload")}</DropdownMenuItem>}
        <DropdownMenuItem disabled={loading || !capabilities.edit(team)} onClick={() => actions.edit(team, trigger())}>{text("编辑团队", "Edit team")}</DropdownMenuItem>
        <DropdownMenuItem disabled={loading || !capabilities.members(team)} onClick={() => actions.members(team, trigger())}>{text("成员与维护者", "Members and maintainers")}</DropdownMenuItem>
        <DropdownMenuItem disabled={loading || !capabilities.projectRelations(team)} onClick={() => actions.projectRelations(team, trigger())}>{text("关联项目", "Linked projects")}</DropdownMenuItem>
        {actions.archive && <DropdownMenuItem disabled={loading || !capabilities.archive?.(team)} onClick={() => actions.archive?.(team, trigger())}>{text("归档团队", "Archive team")}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  }
  const maintainers = (team: ControlledTeam) => {
    const entries = team.members.filter((entry) => entry.role === "maintainer")
    const names = entries.map((entry) => membersByUserId.get(entry.userId)?.name ?? text("成员不可用", "Member unavailable"))
    return <Button variant="ghost" className={styles.members} title={names.join(", ")} aria-label={text(`查看 ${team.name} 的 ${entries.length} 位维护者`, `View ${entries.length} maintainers of ${team.name}`)} onClick={(event) => openTab(team, "members", event.currentTarget)}>
      {entries.length ? entries.slice(0, 3).map((entry) => {
        const member = membersByUserId.get(entry.userId)
        return <Avatar key={entry.membershipId} name={member?.name ?? text("成员不可用", "Member unavailable")} src={member?.avatarDataUrl ?? undefined} initials={member ? undefined : "?"} size={24} className={styles.avatar} />
      }) : <span className={styles.muted}>0</span>}
      {entries.length > 3 && <span className={styles.memberOverflow}>+{entries.length - 3}</span>}
    </Button>
  }
  const sla = (team: ControlledTeam) => team.responseTarget ? <span className={styles.sla}><Clock3 size={12} aria-hidden="true" />{team.responseTarget}</span> : <span className={styles.muted} title={text("响应目标未提供", "Response target unavailable")}>—</span>
  const openWork = (team: ControlledTeam) => <span className={styles.openWork}>
    <Button variant="ghost" className={styles.projectCount} aria-label={text(`查看 ${team.name} 的 ${team.projectIds.length} 个可见关联项目`, `View ${team.projectIds.length} visible linked projects of ${team.name}`)} onClick={(event) => openTab(team, "projects", event.currentTarget)}><FolderKanban size={14} aria-hidden="true" />{team.projectIds.length}</Button>
    <span className={styles.muted} title={team.openWorkCount == null ? text("未完成工作计数未知", "Open-work count unknown") : team.scopeComplete === false ? text("仅当前可见项目范围", "Currently visible projects only") : undefined}>{text(`${team.openWorkCount ?? "—"} 未完成`, `${team.openWorkCount ?? "—"} open`)}</span>
  </span>
  const activity = (team: ControlledTeam) => {
    const date = team.activityAt ? new Date(team.activityAt) : null
    return date && !Number.isNaN(date.getTime()) ? <span className={styles.activity}><Clock3 size={12} aria-hidden="true" /><time dateTime={team.activityAt!}>{dateFormat.format(date)}</time></span> : <span className={styles.muted} title={text("活动日期未提供", "Activity date unavailable")}>—</span>
  }
  const controls = <div className={styles.toolbar} role="group" aria-label={text("团队工具栏", "Team toolbar")}>
    <Popover>
      <PopoverTrigger render={<Button id="pm-team-filter" variant="ghost" className={styles.filterButton} disabled={loading} aria-label={text("筛选团队", "Filter teams")} />}><ListFilter size={14} aria-hidden="true" />{text("筛选", "Filter")}{filtered && <span className={styles.filterDot} aria-label={text("已应用筛选", "Filters applied")} />}</PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <FilterCard
          title={text("筛选团队", "Filter teams")}
          fields={filterFields}
          conditions={conditions}
          onChange={(next: FilterCondition[]) => actions.setInteraction((previous) => withTeamFilterConditions(previous, next))}
          emptyHint={text("添加条件以缩小团队列表。", "Add a condition to narrow the team list.")}
          addLabel={text("添加筛选", "Add filter")}
          clearLabel={text("清除筛选", "Clear filters")}
          whereLabel={text("条件", "Where")}
          andLabel={text("且", "and")}
          anyLabel={text("任意", "Any")}
          removeLabel={text("移除条件", "Remove filter")}
          disabled={loading}
        />
      </PopoverContent>
    </Popover>
    <PmSearch value={state.query} onChange={(query) => actions.setInteraction((previous) => ({ ...previous, query }))} label={text("搜索团队、成员或项目", "Search teams, members or projects")} />
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button id="pm-team-sort" variant="ghost" className={styles.filterButton} />}><ArrowDownAZ size={14} aria-hidden="true" />{text("排序", "Sort")}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={styles.optionMenu}>
        <DropdownMenuRadioGroup value={state.sort} onValueChange={(value) => {
          if (value === "name" || value === "name-desc" || value === "members" || (value === "activity" && capabilities.sortActivity)) actions.setInteraction((previous) => ({ ...previous, sort: value }))
        }}>
          <DropdownMenuRadioItem value="name">{text("名称 A–Z", "Name A–Z")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name-desc">{text("名称 Z–A", "Name Z–A")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="members">{text("成员数", "Member count")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="activity" disabled={!capabilities.sortActivity} title={!capabilities.sortActivity ? text("活动日期来源未提供", "Activity-date source unavailable") : undefined}>{text("最近活动", "Recent activity")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button id="pm-team-display" variant="outline" className={styles.displayButton} />}><SlidersHorizontal size={14} aria-hidden="true" />{text("显示", "Display")}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={styles.optionMenu}>
        <DropdownMenuRadioGroup value={state.display} onValueChange={(value) => {
          if (value === "table" || value === "cards") actions.setInteraction((previous) => ({ ...previous, display: value }))
        }}>
          <DropdownMenuRadioItem value="table"><List size={14} aria-hidden="true" />{text("目录表格", "Directory table")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="cards"><LayoutGrid size={14} aria-hidden="true" />{text("团队卡片", "Team cards")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator className={styles.menuSeparator} />
        <DropdownMenuItem disabled={loading || !hasContent} onClick={() => actions.setInteraction((previous) => ({ ...previous, selectedIds: [...previous.selectedIds, ...teams.filter((team) => !previous.selectedIds.includes(team.id)).map((team) => team.id)] }))}>{text("选择当前团队", "Select visible teams")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!state.selectedIds.length} onClick={() => actions.setInteraction((previous) => ({ ...previous, selectedIds: [] }))}>{text("清除选择", "Clear selection")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Button id="pm-team-create" className={styles.addButton} disabled={loading || !capabilities.create} onClick={(event) => actions.create(event.currentTarget)} aria-label={text("添加团队", "Add team")}><Plus size={14} aria-hidden="true" /><span>{text("添加团队", "Add Team")}</span></Button>
    {props.headerActions && <div className={styles.hostActions}>{props.headerActions}</div>}
  </div>

  return <PmPage interactive={props.interactive} headerMode={props.embedded ? "hidden" : "default"} pageId="pm-team-list-1" className={styles.page} title={text("团队", "Teams")} titleSuffix={<span className={styles.count} title={!teamsAvailable ? text("团队来源未提供", "Team source unavailable") : undefined}>{teamsAvailable ? teams.length : "—"}</span>} actions={controls} readingPosition={props.readingPosition} onReadingPositionChange={props.onReadingPositionChange}>
    <div className={styles.feedback}><ControlledFeedback surface={props} /></div>
      {state.display === "table" ? <div className={styles.tableViewport} role="region" aria-label={text("团队目录", "Team directory")} tabIndex={0}>
        <div className={styles.directory} role="table" aria-label={text("团队目录；未提供的工作方向、响应目标、未完成工作计数和活动保持未知", "Team directory; unavailable focus, response targets, open-work counts and activity remain unknown")} aria-colcount={6} aria-rowcount={teams.length + 1} data-pm-team-table>
          <div role="rowgroup"><div className={styles.tableHead} role="row">{[text("团队", "Team"), text("工作方向", "Focus"), text("响应目标", "Response target"), text("维护者", "Maintainers"), text("未完成工作", "Open work"), text("最近活动", "Activity")].map((label) => <div key={label} role="columnheader">{label}</div>)}</div></div>
          <DataRegion {...model.data} state={dataState} hasContent={hasContent} rowHeight={61} emptyTitle={emptyTitle} emptyDescription={emptyDescription}>
          <div role="rowgroup">{teams.map((team) => <div key={team.id} role="row" className={styles.tableRow} data-team-id={team.id} data-selected={state.selectedIds.includes(team.id) || state.selectedId === team.id}>
            <div role="cell" className={styles.identityCell}>
              <Button id={`pm-team-open-${team.id}`} variant="ghost" className={styles.teamButton} onClick={(event) => actions.open(team, event.currentTarget)}>{identity(team)}</Button>
              <span className={styles.rowSelection} data-checked={state.selectedIds.includes(team.id)}><Checkbox checked={state.selectedIds.includes(team.id)} aria-label={text(`选择 ${team.name}`, `Select ${team.name}`)} onCheckedChange={(checked) => selectTeam(team, checked === true)} /></span>
            </div>
            <div role="cell"><span className={styles.focus} title={team.focus ?? undefined}>{team.focus ?? "—"}</span></div>
            <div role="cell">{sla(team)}</div>
            <div role="cell">{maintainers(team)}</div>
            <div role="cell">{openWork(team)}</div>
            <div role="cell" className={styles.activityCell}>{activity(team)}{teamActions(team)}</div>
          </div>)}</div>
          </DataRegion>
        </div>
      </div> : <DataRegion {...model.data} state={dataState} hasContent={hasContent} emptyTitle={emptyTitle} emptyDescription={emptyDescription}><ul className={styles.cards} aria-label={text("团队卡片", "Team cards")} data-pm-team-cards>{teams.map((team) => <li key={team.id} className={styles.card} data-team-id={team.id} data-selected={state.selectedIds.includes(team.id) || state.selectedId === team.id}>
        <div className={styles.cardHeader}><Button id={`pm-team-open-${team.id}`} variant="ghost" className={styles.teamButton} onClick={(event) => actions.open(team, event.currentTarget)}>{identity(team)}</Button><Checkbox checked={state.selectedIds.includes(team.id)} aria-label={text(`选择 ${team.name}`, `Select ${team.name}`)} onCheckedChange={(checked) => selectTeam(team, checked === true)} />{teamActions(team)}</div>
        <p className={styles.cardDescription}>{team.description || text("未填写团队说明", "No team description")}</p>
        <div className={styles.cardFacts}><span className={styles.focus}>{team.focus ?? text("方向未知", "Focus unknown")}</span>{sla(team)}</div>
        <div className={styles.cardMaintainers}><span className={styles.muted}>{text("维护者", "Maintainers")}</span>{maintainers(team)}</div>
        <div className={styles.cardFooter}>{openWork(team)}{activity(team)}</div>
      </li>)}</ul></DataRegion>}
    {model.sourceDescription && <p className={styles.sourceNote}>{model.sourceDescription}</p>}
  </PmPage>
}

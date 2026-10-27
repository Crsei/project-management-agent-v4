import { ChevronDown, Circle, Copy, LayoutGrid, ListTodo, SlidersHorizontal, UserPlus, Users } from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DataRegion } from "@/components/ui/data-region"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { useI18n } from "@/lib/i18n-provider"
import { ControlledFeedback } from "./controlled-presentation"
import type { ControlledIssueRecord } from "./controlled-contracts"
import type { ControlledMember, PeopleContactKind, TeamCollectionViewProps } from "./people-controlled-contracts"
import { PmPage, PmSearch } from "./presentation-page"
import styles from "./team-list-3.module.css"

export function TeamList3Content(props: TeamCollectionViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { readModel: model, interaction: state, capabilities, actions } = props
  const workload = model.workload
  const loading = model.data.state === "loading"
  const groupLabel = workload?.grouping === "departments" ? text("部门", "Departments") : props.embedded ? text("按团队", "By team") : text("团队", "Teams")
  const tab = state.tab === "departments" || state.tab === "pool" ? state.tab : "workload"
  const hasContent = !workload || (tab === "pool" ? workload.pool.length > 0 : tab === "departments" ? workload.groups.length > 0 : workload.rows.length > 0 || workload.unassigned.issues.length > 0)
  const data = { ...model.data, state: (model.data.state ?? "success") === "success" && !hasContent ? "empty" as const : model.data.state }
  const title = tab === "pool" ? text("任务池", "Task pool") : tab === "departments" ? groupLabel : text("工作量", "Workload")
  const countLabel = !workload ? text("人员任务来源未提供", "Person-workload source unavailable") : tab === "pool" ? text(`${workload.pool.length} 个任务`, `${workload.pool.length} tasks`) : tab === "departments" ? text(`${workload.groups.length} 个分组`, `${workload.groups.length} groups`) : text(`${workload.rows.length} 张成员任务卡片`, `${workload.rows.length} teammate task cards`)
  const presenceLabels = { available: text("在线", "Available"), away: text("离开", "Away"), offline: text("离线", "Offline") }
  const teams = model.teamOptions ?? model.teams
  const canNavigateMembers = !loading && !!actions.navigate && !!capabilities.navigate?.("members")
  const activeFilters = Number((state.workloadStateFilter ?? "all") !== "all") + Number(!!state.teamId && !!capabilities.filterWorkloadTeam)
  const taskRow = (issue: ControlledIssueRecord, compact = false) => {
    const assignees = model.unavailableAssigneeTaskIds?.includes(issue.id) ? text("受派人当前不可用", "Assignee currently unavailable") : issue.assigneeIds.map((id) => model.members.find((member) => member.userId === id)?.name ?? text("受派人不可见", "Assignee unavailable")).join(", ")
    return <li key={issue.id} className={styles.taskWithActions}>
      <Button variant="ghost" className={compact ? styles.cardTaskRow : styles.taskRow} data-issue-id={issue.id} disabled={loading || !actions.openIssue} title={`${issue.identifier} · ${issue.title}`} aria-label={`${issue.identifier} · ${issue.title} · ${assignees || text("未分配", "Unassigned")}`} onClick={() => actions.openIssue?.(issue)}>
        <Circle className={styles.taskBullet} size={10} aria-hidden="true" />
        {!compact && <span className={styles.taskId} title={issue.identifier}>{issue.identifier}</span>}
        <span className={styles.taskTitle}>{issue.title}</span>
        {!compact && <span className={styles.taskAssignees} title={assignees}>{assignees || text("未分配", "Unassigned")}</span>}
      </Button>
      <span className={styles.taskEstimate} title={text("估算点数；未知不等于零", "Estimate points; unknown is not zero")}>{model.taskEstimates?.[issue.id] ?? "—"} {text("点", "pts")}</span>
      {props.taskActions?.(issue)}
    </li>
  }
  const contact = (member: ControlledMember, kind: Extract<PeopleContactKind, "email" | "phone">) => {
    const value = kind === "email" ? member.email : member.phone
    const label = kind === "email" ? text("邮箱未提供", "Email unavailable") : text("电话未提供", "Phone unavailable")
    const canCopy = !!value && !!actions.copyContact && !!capabilities.copyContact?.(member, kind)
    return <span className={styles.contactValue}>
      <span title={value || undefined}>{value || label}</span>
      {actions.copyContact && <Button variant="ghost" size="icon-sm" className={styles.copyButton} disabled={!canCopy} aria-label={text(`复制 ${member.name} (${member.membershipId}) 的${kind === "email" ? "邮箱" : "电话"}`, `Copy ${kind} for ${member.name} (${member.membershipId})`)} onClick={(event) => actions.copyContact?.(member, kind, event.currentTarget)}><Copy size={12} aria-hidden="true" /></Button>}
    </span>
  }
  const filters = <DropdownMenu>
    <DropdownMenuTrigger render={<Button id="pm-team3-filter" variant="outline" className={styles.filterButton} disabled={loading} />}><SlidersHorizontal size={16} aria-hidden="true" />{text("筛选", "Filter")}{activeFilters > 0 && <span className={styles.filterCount}>{activeFilters}</span>}</DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={styles.filterMenu}>
      <DropdownMenuGroup>
        <DropdownMenuLabel>{text("任务状态", "Task status")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={state.workloadStateFilter ?? "all"} onValueChange={(value) => { if (value === "all" || value === "open" || value === "done") actions.setInteraction((previous) => ({ ...previous, workloadStateFilter: value })) }}>
          <DropdownMenuRadioItem value="all">{text("全部任务", "All tasks")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="open">{text("未完成", "Open")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="done">{text("已完成", "Done")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      {capabilities.filterWorkloadTeam && <><DropdownMenuSeparator /><DropdownMenuGroup>
        <DropdownMenuLabel>{text("团队", "Team")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={state.teamId ?? "all"} onValueChange={(value) => actions.setInteraction((previous) => ({ ...previous, teamId: value === "all" ? null : value }))}>
          <DropdownMenuRadioItem value="all">{text("全部团队", "All teams")}</DropdownMenuRadioItem>
          {teams.map((team) => <DropdownMenuRadioItem key={team.id} value={team.id}><span className={styles.filterTeam} title={`${team.name} · ${team.id}`}>{team.name}</span></DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup></>}
    </DropdownMenuContent>
  </DropdownMenu>

  return <PmPage interactive={props.interactive} headerMode={props.embedded ? "hidden" : "default"} pageId="pm-team-list-3" className={styles.page} title={text("团队任务", "Team Tasks")} eyebrow={<p className={styles.eyebrow}>{text("团队", "Teams")}</p>} readingPosition={props.readingPosition} onReadingPositionChange={props.onReadingPositionChange}
    actions={<div className={styles.headerActions}>{props.headerActions}{!props.embedded && <Button id="pm-team3-new-member" className={styles.newMember} disabled={!canNavigateMembers} title={canNavigateMembers ? undefined : text("邀请需要管理权限、可用邀请来源及 SMTP 配置", "Invitations require management access, an available invitation source and configured SMTP")} onClick={() => actions.navigate?.("members")}><UserPlus size={16} aria-hidden="true" />{text("邀请成员", "Invite member")}</Button>}</div>}
    toolbar={<>
      <Tabs value={tab} onValueChange={(value) => { if (value === "workload" || value === "departments" || value === "pool") actions.setInteraction((previous) => ({ ...previous, tab: value })) }}>
        <TabsList activateOnFocus={false} className={styles.tabs} aria-label={text("工作量分组", "Workload grouping")}>
          <TabsTab value="workload"><Users size={16} aria-hidden="true" />{props.embedded ? text("按成员", "By member") : text("工作量", "Workload")}</TabsTab>
          <TabsTab value="departments"><LayoutGrid size={16} aria-hidden="true" />{groupLabel}</TabsTab>
          <TabsTab value="pool"><ListTodo size={16} aria-hidden="true" />{text("任务池", "Task pool")}</TabsTab>
        </TabsList>
      </Tabs>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}><h2>{title}</h2><p>{countLabel}</p></div>
        <div className={styles.sectionControls}>{tab === "pool" && props.poolActions}<div className={styles.search}><PmSearch value={state.query} onChange={(query) => actions.setInteraction((previous) => ({ ...previous, query }))} label={text("搜索任务或成员...", "Search tasks or people...")} /></div>{filters}</div>
      </div>
    </>}>
    <ControlledFeedback surface={props} />
    <DataRegion {...data} hasContent={hasContent}>
      {!workload ? <p role="status" className={styles.unavailable}>{text("当前没有可用的授权工作量快照；不会生成任务、容量或统计。", "No authorized workload snapshot is available; tasks, capacity and statistics are not fabricated.")}</p> : tab === "departments" ? <div data-pm-workload-departments={workload.grouping === "departments" || undefined} data-pm-workload-teams={workload.grouping !== "departments" || undefined}>
        {workload.groups.map((group) => <section key={group.id} className={styles.deptSection}>
          <div className={styles.deptHead}><h3>{group.label}</h3><span className={styles.deptCount}>{text(`${group.issues.length} 个任务`, `${group.issues.length} tasks`)}</span></div>
          {group.issues.length ? <ul className={styles.poolList}>{group.issues.map((issue) => taskRow(issue))}</ul> : <p className={styles.emptyRow}>{text("此分组暂无任务", "No tasks in this group")}</p>}
        </section>)}
      </div> : tab === "pool" ? <ul className={styles.poolList} data-pm-task-pool>{workload.pool.map((issue) => taskRow(issue))}</ul> : <>
        <ul className={styles.workloadList} aria-label={text("成员任务卡片", "Teammate task cards")} data-pm-workload-rows>
          {workload.rows.map((row) => {
            const { member } = row
            const expanded = state.expandedIds.includes(row.id)
            const tasksId = `pm-team3-tasks-${row.id}`
            const teamCount = model.teamsAvailable === false ? null : member.teams?.length ?? teams.filter((team) => team.members.some((entry) => entry.userId === member.userId)).length
            return <li key={row.id} className={styles.workloadRow} data-pm-workload-row data-member-id={member.membershipId}>
              <article className={styles.memberCard} data-selected={state.selectedMemberId === member.membershipId}>
                <Button id={`pm-team3-member-${member.membershipId}`} variant="ghost" className={styles.cardIdentity} disabled={loading || !capabilities.memberOpen(member)} aria-label={text(`查看 ${member.name} (${member.membershipId}) 的成员明细`, `Member details for ${member.name} (${member.membershipId})`)} onClick={(event) => actions.memberOpen(member, event.currentTarget)}>
                  <span className={styles.avatarWrap}><Avatar name={member.name} src={member.avatarDataUrl ?? undefined} size={32} className={styles.avatar} />{member.presence && <span className={styles.presenceDot} data-presence={member.presence} title={presenceLabels[member.presence]} />}</span>
                  <span className={styles.memberInfo}>
                    <span className={styles.memberName}><span className={styles.memberNameText} role="heading" aria-level={3} title={member.name}>{member.name}</span><span className={styles.status} data-presence={member.presence ?? "unknown"} data-pm-availability={member.presence ?? "unknown"} title={member.presence ? presenceLabels[member.presence] : text("在线状态未知", "Presence unknown")}>{member.engagement ?? (member.presence ? presenceLabels[member.presence] : text("在线状态未知", "Presence unknown"))}</span></span>
                    <span className={styles.joinedDate}>{member.joinedAt ? <time dateTime={member.joinedAt} title={text("加入时间", "Joined")}>{new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(member.joinedAt))}</time> : text("加入时间未提供", "Joined date unavailable")}</span>
                  </span>
                </Button>
                <div className={styles.cardTasks}>
                  <div className={styles.taskHead}><h4>{text("任务", "Tasks")}</h4><div className={styles.cardActions}>
                    {props.memberTaskActions?.(member)}
                    <Button id={`pm-team3-toggle-${row.id}`} variant="ghost" size="icon-sm" className={styles.taskAction} aria-expanded={expanded} aria-controls={tasksId} aria-label={expanded ? text(`收起 ${member.name} 的任务`, `Collapse tasks for ${member.name}`) : text(`展开 ${member.name} 的任务`, `Expand tasks for ${member.name}`)} onClick={() => actions.setInteraction((previous) => ({ ...previous, expandedIds: previous.expandedIds.includes(row.id) ? previous.expandedIds.filter((id) => id !== row.id) : [...previous.expandedIds, row.id] }))}><ChevronDown className={styles.chevron} size={16} aria-hidden="true" /></Button>
                  </div></div>
                  <div id={tasksId} hidden={!expanded}>{row.issues.length ? <ul className={styles.taskList}>{row.issues.map((issue) => taskRow(issue, true))}</ul> : <p className={styles.emptyRow}>{text("当前筛选下暂无任务", "No tasks match the current filters")}</p>}</div>
                </div>
                <dl className={styles.capacityFacts} data-pm-member-capacity>
                  <div><dt>{text("已知开放点数", "Known open points")}</dt><dd>{row.knownOpenPoints ?? "—"}</dd></div>
                  <div><dt>{text("并行容量", "Concurrent capacity")}</dt><dd>{row.capacityPoints ?? text("未知", "Unknown")}</dd></div>
                  <div><dt>{text("缺估算", "Missing estimates")}</dt><dd>{row.unknownEstimateCount ?? "—"}</dd></div>
                  <div data-overloaded={row.overloaded ?? "unknown"}><dt>{text("过载", "Overload")}</dt><dd>{row.overloaded === null ? text("未知", "Unknown") : row.overloaded ? text("已确认", "Confirmed") : text("否", "No")}</dd></div>
                </dl>
                <footer className={styles.cardFooter}>
                  <div className={styles.email}>{contact(member, "email")}</div>
                  <div className={styles.contactMeta}>{contact(member, "phone")}<span>{teamCount === null ? text("团队信息未提供", "Teams unavailable") : text(`${teamCount} 个可见团队`, `${teamCount} visible teams`)}</span></div>
                  {model.copyReceipt?.membershipId === member.membershipId && <p role="status" className={styles.copyReceipt} data-pm-copy-receipt>{model.copyReceipt.ok ? text("已复制", "Copied") : text("无法复制；请手动选择联系方式。", "Copy unavailable; select the contact information manually.")}</p>}
                </footer>
              </article>
            </li>
          })}
        </ul>
        {workload.unassigned.issues.length > 0 && <section className={styles.unassigned} data-pm-unassigned-workload><div className={styles.deptHead}><h3>{text("未分配 / 受派人不可用", "Unassigned / unavailable assignee")}</h3><span className={styles.deptCount}>{workload.unassigned.issues.length}</span></div><ul className={styles.poolList}>{workload.unassigned.issues.map((issue) => taskRow(issue))}</ul></section>}
      </>}
    </DataRegion>
    {workload && <details className={styles.workloadDetails} data-pm-workload-summary>
      <summary>{text("工作量明细", "Workload details")}</summary>
      <dl className={styles.summaryFacts}>
        <div><dt>{text("唯一任务", "Unique tasks")}</dt><dd>{workload.summary.uniqueTaskCount ?? "—"}</dd></div>
        <div><dt>{text("行任务计数", "Row assignments")}</dt><dd>{workload.summary.rowTaskCount ?? "—"}</dd></div>
        <div><dt>{text("已确认过载成员", "Confirmed overloaded members")}</dt><dd>{workload.summary.overloadedMembers ?? "—"}</dd></div>
        {workload.summary.unknownOverloadMembers !== undefined && <div><dt>{text("过载未知成员", "Members with unknown overload")}</dt><dd>{workload.summary.unknownOverloadMembers ?? "—"}</dd></div>}
        <div><dt>{text("容量未知", "Unknown capacity")}</dt><dd>{workload.summary.unknownCapacityMembers ?? "—"}</dd></div>
        <div><dt>{text("估算未知", "Unknown estimates")}</dt><dd>{workload.summary.unknownEstimateCount ?? "—"}</dd></div>
        {workload.unassigned.unknownAssigneeCount !== null && <div><dt>{text("无法解析的受派人", "Unresolved assignees")}</dt><dd>{workload.unassigned.unknownAssigneeCount}</dd></div>}
      </dl>
      {workload.rows.map((row) => <section key={row.id} className={styles.memberMetrics}><h3>{row.member.name}</h3><dl className={styles.summaryFacts}>
        <div><dt>{text("未完成", "Open")}</dt><dd>{row.openCount}</dd></div><div><dt>{text("已完成", "Done")}</dt><dd>{row.doneCount}</dd></div>
        <div><dt>{text("已知未完成点数", "Known open points")}</dt><dd>{row.knownOpenPoints ?? "—"}</dd></div><div><dt>{text("估算未知", "Unknown estimates")}</dt><dd>{row.unknownEstimateCount ?? "—"}</dd></div>
        <div><dt>{text("容量点数", "Capacity points")}</dt><dd>{row.capacityPoints ?? text("未提供", "Unavailable")}</dd></div><div><dt>{text("过载", "Overloaded")}</dt><dd>{row.overloaded === null ? text("未知", "Unknown") : row.overloaded ? text("是", "Yes") : text("否", "No")}</dd></div>
      </dl></section>)}
    </details>}
    {model.sourceDescription && <p className={styles.boundaryNote}>{model.sourceDescription}</p>}
  </PmPage>
}

import { useRef } from "react"
import { TeamList1Content } from "./team-list-1-content"
import { TeamList2Content } from "./team-list-2-content"
import { TeamList3Content } from "./team-list-3-content"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n-provider"
import { ControlledFocus } from "./controlled-presentation"
import { PeopleIdentity, PeopleMemberInspector, type PeopleContactControls } from "./people-views"
import type { ControlledMember, TeamCollectionViewProps } from "./people-controlled-contracts"
import directoryStyles from "./team-list-1.module.css"

export function TeamCollectionView(props: TeamCollectionViewProps) {
  const { locale } = useI18n()
  const text = (zh: string, en: string) => locale === "en" ? en : zh
  const { variant, readModel: model, interaction: state, capabilities, actions } = props
  const loading = (variant === "team2" ? model.directory?.data ?? model.data : model.data).state === "loading"
  const selected = model.selectedTeam === undefined ? model.teams.find(team => team.id === state.selectedId) : model.selectedTeam
  const detailTrigger = useRef<HTMLElement | null>(null)
  const openTeam: typeof actions.open = (team, trigger) => { detailTrigger.current = trigger; actions.open(team, trigger) }
  const memberTrigger = useRef<HTMLElement | null>(null)
  const selectedMember = model.selectedMember === undefined ? model.members.find(member => member.membershipId === state.selectedMemberId) : model.selectedMember
  const openMember: typeof actions.memberOpen = (member, trigger) => { memberTrigger.current = trigger; actions.memberOpen(member, trigger) }
  const contactControls = (member: ControlledMember): PeopleContactControls | undefined => actions.copyContact && capabilities.copyContact ? { canCopy: kind => capabilities.copyContact!(member, kind), copy: (kind, trigger) => actions.copyContact!(member, kind, trigger), receipt: model.copyReceipt } : undefined
  const Content = variant === "team1" ? TeamList1Content : variant === "team2" ? TeamList2Content : TeamList3Content
  return <ControlledFocus surface={props}>
    <Content {...props} actions={{ ...actions, open: openTeam, memberOpen: openMember }} />
    {props.teamInspector ?? <Dialog open={state.detailOpen && !!selected} onOpenChange={detailOpen => actions.setInteraction(previous => ({ ...previous, detailOpen }))}>
      <DialogContent className="max-w-2xl" data-pm-team-detail finalFocus={() => detailTrigger.current ?? (props.focusId ? document.getElementById(props.focusId) : null)}>
        <DialogTitle>{selected?.name}</DialogTitle><DialogDescription>{text("当前授权范围内的团队事实；团队职责不授予权限。", "Team facts in your current authorized scope; team responsibilities grant no access.")}</DialogDescription>
        {selected && <>
          <div className="mt-4 flex min-w-0 flex-wrap gap-2" role="group" aria-label={text("详情视图", "Detail view")}>{(["overview", "members", "projects"] as const).map(detailTab => <Button key={detailTab} variant={state.detailTab === detailTab ? "secondary" : "ghost"} aria-pressed={state.detailTab === detailTab} onClick={() => actions.setInteraction(previous => ({ ...previous, detailTab }))}>{detailTab === "overview" ? text("概览", "Overview") : detailTab === "members" ? text("成员与维护者", "Members and maintainers") : text("关联项目", "Linked projects")}</Button>)}</div>
          <DialogBody>
            {selected.scopeComplete === false && <p role="status" className="mb-4 text-sm text-muted-foreground">{text("以下关系和计数仅覆盖当前可见范围，不是工作区总量。", "Relations and counts below cover the current visible scope, not workspace totals.")}</p>}
            {state.detailTab === "overview" ? <>
              <dl className={directoryStyles.detailFacts}>
                <div><dt>{text("标识", "Identifier")}</dt><dd>{selected.identifier ?? "—"}</dd></div>
                <div><dt>{text("工作方向", "Focus")}</dt><dd>{selected.focus ?? "—"}</dd></div>
                <div><dt>{text("响应目标", "Response target")}</dt><dd>{selected.responseTarget ?? "—"}</dd></div>
                <div><dt>{text("可见成员 / 项目", "Visible members / projects")}</dt><dd>{selected.members.length} / {selected.projectIds.length}</dd></div>
                <div><dt>{text("未完成工作", "Open work")}</dt><dd>{selected.openWorkCount ?? text("未知", "Unknown")}</dd></div>
                <div><dt>{text("最近活动", "Recent activity")}</dt><dd>{selected.activityAt ? <time dateTime={selected.activityAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(selected.activityAt))}</time> : "—"}</dd></div>
              </dl>
              <p className="whitespace-pre-wrap break-words">{selected.description || text("未填写团队说明", "No team description")}</p>
              <p className="mt-3 text-xs text-muted-foreground">{text("响应目标是显式配置，不代表计时、告警或 SLA 达标评估。最近活动来自真实团队或当前可见项目关联记录。", "Response targets are configuration, not timers, alerts or SLA assessments. Recent activity comes from real team or currently visible project-assignment records.")}</p>
            </> : state.detailTab === "members" ? <>
              <ul className={directoryStyles.detailList}>{selected.members.map(entry => {
                const member = model.members.find(person => person.userId === entry.userId)
                return <li key={entry.membershipId}>{member ? <Button variant="ghost" className="min-w-0 max-w-full" disabled={!capabilities.memberOpen(member)} onClick={event => openMember(member, event.currentTarget)}><PeopleIdentity member={member} /></Button> : <span className="min-w-0 break-words text-muted-foreground">{text("成员资料不可用", "Member profile unavailable")}</span>}<Badge>{entry.role === "maintainer" ? text("维护者", "Maintainer") : text("成员", "Member")}</Badge></li>
              })}</ul>
              {!selected.members.length && <p className="mb-3 text-sm text-muted-foreground">{text("当前可见范围没有团队成员。", "No team members in the current visible scope.")}</p>}
              <Button disabled={loading || !capabilities.members(selected)} onClick={event => actions.members(selected, event.currentTarget)}>{text("编辑成员与维护者", "Edit members and maintainers")}</Button>
            </> : <>
              <ul className={directoryStyles.detailList}>{selected.projectIds.map(id => <li key={id}><Button variant="ghost" className="max-w-full" disabled={!capabilities.openProject(id)} onClick={() => actions.openProject(id)}><span className="truncate" title={model.projects.find(project => project.id === id)?.title}>{model.projects.find(project => project.id === id)?.title ?? text("项目资料不可用", "Project profile unavailable")}</span></Button></li>)}</ul>
              {!selected.projectIds.length && <p className="mb-3 text-sm text-muted-foreground">{text("当前可见范围没有关联项目。", "No linked projects in the current visible scope.")}</p>}
              <Button disabled={loading || !capabilities.projectRelations(selected)} onClick={event => actions.projectRelations(selected, event.currentTarget)}>{text("编辑关联项目", "Edit linked projects")}</Button>
            </>}
          </DialogBody>
          <DialogFooter><Button variant="secondary" onClick={() => actions.setInteraction(previous => ({ ...previous, detailOpen: false }))}>{text("关闭", "Close")}</Button>{actions.teamWorkload && <Button variant="outline" onClick={() => actions.teamWorkload?.(selected)}>{text("查看团队工作量", "View team workload")}</Button>}{actions.archive && <Button variant="outline" disabled={loading || !capabilities.archive?.(selected)} onClick={event => actions.archive?.(selected, event.currentTarget)}>{text("归档团队", "Archive team")}</Button>}<Button disabled={loading || !capabilities.edit(selected)} onClick={event => actions.edit(selected, event.currentTarget)}>{text("编辑团队", "Edit team")}</Button></DialogFooter>
        </>}
      </DialogContent>
    </Dialog>}
    {props.memberInspector ?? <PeopleMemberInspector member={selectedMember} teams={selectedMember ? (model.teamOptions ?? model.teams).filter(team => selectedMember.teams?.some(summary => summary.id === team.id) || team.members.some(entry => entry.userId === selectedMember.userId)) : []} teamsAvailable={model.teamsAvailable} roles={model.roles ?? []} open={state.memberDetailOpen ?? false} onOpenChange={memberDetailOpen => actions.setInteraction(previous => ({ ...previous, memberDetailOpen }))} finalFocus={() => memberTrigger.current ?? (props.focusId ? document.getElementById(props.focusId) : null)} onWorkload={selectedMember && actions.memberWorkload ? () => actions.memberWorkload!(selectedMember) : undefined} contactControls={selectedMember ? contactControls(selectedMember) : undefined} readingPosition={state.memberDetailReadingPosition} onReadingPositionChange={memberDetailReadingPosition => actions.setInteraction(previous => ({ ...previous, memberDetailReadingPosition }))} />}
    {props.editDialog}{props.membersEditor}{props.projectRelationsEditor}
  </ControlledFocus>
}

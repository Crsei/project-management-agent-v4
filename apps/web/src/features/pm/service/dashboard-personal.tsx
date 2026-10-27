import { useEffect, useRef, useState, type ReactNode } from "react"
import { Bookmark, Check, Pencil, Plus } from "lucide-react"
import type { Entity, PersonalDashboard, PrivateNote, ProjectMeeting, SelfProfile } from "@contracts"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/ui/avatar"
import d1 from "@/views/pm/dashboard-1.module.css"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { usePersonalDashboard, usePmEntities, usePmService } from "./pm-service"
import { allowed, Choice, CommandNotice, Field, Form, string, useAction, useDraftState, useText } from "./pm-ui"
import { useDisplayDateTime } from "@/features/workspace/preference-format"

function PersonalReadNotice({ loading, error, stale, retry }: { loading: boolean; error: Error | null; stale: boolean; retry: () => unknown }) {
  const t = useText()
  return <>{loading && <p role="status" className="text-sm text-muted-foreground">{t("加载个人工作台…", "Loading your dashboard…")}</p>}{error && <div role="alert" className="space-y-1 text-sm"><p>{stale ? t("刷新失败，上次快照可能过期：", "Refresh failed; previous snapshot may be stale: ") : ""}{error.message}</p><Button size="sm" variant="outline" onClick={() => { void retry() }}>{t("重试读取", "Retry read")}</Button></div>}</>
}

function EditorDialog({ title, description, open, onOpenChange, children }: { title: string; description: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-xl"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription><DialogBody><CommandNotice />{children}</DialogBody></DialogContent></Dialog>
}

function DraftConflict({ current, base, onRebase, onReload }: { current: number; base: number; onRebase: () => void; onReload: () => void }) {
  const t = useText()
  if (current === base) return null
  return <div role="status" className="space-y-2 rounded-lg border p-3 text-sm"><p>{t("服务端已更新；你的草稿和原版本仍保留。请先比较再选择。", "The server changed. Your draft and its original version are retained; compare before choosing.")}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={onRebase}>{t("保留草稿，采用最新版本", "Keep draft, use latest version")}</Button><Button type="button" variant="ghost" size="sm" onClick={onReload}>{t("放弃草稿，读取服务值", "Discard draft, load saved values")}</Button></div></div>
}

export function ProfilePanel() {
  const query = usePersonalDashboard()
  const { actor, refresh } = usePmService()
  const [open, setOpen] = useState(false)
  const t = useText()
  const profile = query.data?.profile
  const refreshedName = useRef<string | null>(null)
  // Reconciliation or another tab may commit a rename without this editor's save callback.
  useEffect(() => {
    if (!profile || profile.name === actor?.name || refreshedName.current === profile.name) return
    refreshedName.current = profile.name
    void refresh().catch(() => { refreshedName.current = null })
  }, [actor?.name, profile?.name, refresh])
  return <section className={d1.profile} aria-label={t("个人资料", "Profile")}>
    <div className={d1.profileTop}><Avatar name={profile?.name ?? actor?.name ?? t("未提供", "Not provided")} size={40} className={d1.profileAvatar} /><Button variant="ghost" size="icon" className={d1.profileEdit} aria-label={t("编辑个人资料", "Edit profile")} disabled={!profile} onClick={() => setOpen(true)}><Pencil size={16} aria-hidden="true" /></Button></div>
    <PersonalReadNotice loading={query.isPending} error={query.error} stale={!!query.data} retry={query.refetch} />
    {profile && <><h2 className={d1.profileName}>{profile.name}</h2><p className={d1.email}>{actor?.email}</p><dl className={d1.profileMeta}><dt>{t("加入时间", "Joined on")}</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: profile.timeZone }).format(new Date(profile.joinedAt))}</dd><dt>{t("时区", "Time zone")}</dt><dd className="break-words">{profile.timeZone}</dd></dl>
      <EditorDialog title={t("编辑个人资料", "Edit profile")} description={t("仅修改本人。姓名同步真实账号；时区使用 IANA 标识。", "Only your own profile changes. Your account name is updated; time zones use IANA identifiers.")} open={open} onOpenChange={setOpen}>{open && <ProfileEditor profile={profile} />}</EditorDialog></>}
  </section>
}

function ProfileEditor({ profile }: { profile: SelfProfile }) {
  const action = useAction()
  const { refresh } = usePmService()
  const t = useText()
  const [draft, setDraft] = useDraftState("self-profile", "draft", { name: profile.name, timeZone: profile.timeZone, version: profile.version })
  return <div className="space-y-3"><DraftConflict current={profile.version} base={draft.version} onRebase={() => setDraft({ ...draft, version: profile.version })} onReload={() => setDraft({ name: profile.name, timeZone: profile.timeZone, version: profile.version })} />
    {profile.version !== draft.version && <p className="break-words text-xs text-muted-foreground">{t("服务端值", "Saved values")}: {profile.name} · {profile.timeZone}</p>}
    <Form disabled={action.locked} onSubmit={async () => {
      const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: "UpdateSelfProfile", targetId: profile.userId, expectedVersions: { [profile.userId]: draft.version }, payload: { name: draft.name, timeZone: draft.timeZone } })
      if (receipt.status !== "committed") return
      const saved = receipt.result as SelfProfile
      setDraft({ name: saved.name, timeZone: saved.timeZone, version: saved.version })
      await refresh()
    }}><Field label={t("姓名", "Name")} value={draft.name} onChange={name => setDraft({ ...draft, name })} required /><Field label={t("IANA 时区，例如 Asia/Shanghai", "IANA time zone, e.g. Asia/Shanghai")} value={draft.timeZone} onChange={timeZone => setDraft({ ...draft, timeZone })} required /></Form>
  </div>
}

export function WatchControls({ task }: { task: Entity }) {
  const query = usePersonalDashboard()
  const { workspace } = usePmService()
  const action = useAction()
  const t = useText()
  const watch = query.data?.watches.find(record => record.data.taskId === task.id)
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-1"><Button size="sm" variant="ghost" aria-label={`${watch ? t("取消关注", "Unwatch") : t("关注", "Watch")} ${string(task.data.title) || task.id}`} aria-pressed={!!watch} disabled={action.locked || !query.data || !!query.error || !allowed(workspace, "domain.read", task.projectId)} onClick={() => { void action.run(() => action.execute(watch
    ? { commandId: crypto.randomUUID(), commandType: "UnwatchTask", targetId: watch.id, projectId: task.projectId!, expectedVersions: { [watch.id]: watch.version }, payload: {} }
    : { commandId: crypto.randomUUID(), commandType: "WatchTask", projectId: task.projectId!, payload: { taskId: task.id } })) }}><Bookmark className="size-3.5" fill={watch ? "currentColor" : "none"} aria-hidden="true" />{watch ? t("已关注", "Watching") : t("关注", "Watch")}</Button>{(action.localError || query.error) && <small role="alert" className="break-words text-destructive">{action.localError || query.error?.message}</small>}</span>
}

export function WatchingPanel({ issues }: { issues?: Entity[] }) {
  const query = usePersonalDashboard()
  const allIssues = usePmEntities("work_item")
  const t = useText()
  const [search, setSearch] = useState("")
  const watchedIds = new Set(query.data?.watches.map(watch => watch.data.taskId) ?? [])
  const tasks = (issues ?? allIssues.data ?? []).filter(task => `${string(task.data.title)} ${task.id}`.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => Number(watchedIds.has(b.id)) - Number(watchedIds.has(a.id)) || string(a.data.title).localeCompare(string(b.data.title)))
  return <section className="min-w-0 space-y-3" aria-label={t("关注任务", "Watching tasks")}><p className="text-sm text-muted-foreground">{t("已关注", "Watching")} · {query.data?.watches.length ?? "—"} · {t("可以关注任何有权访问的任务。", "Watch any task you can access.")}</p><PersonalReadNotice loading={query.isPending} error={query.error} stale={!!query.data} retry={query.refetch} />
    <CommandNotice />
    {!issues && <PersonalReadNotice loading={allIssues.isPending} error={allIssues.error} stale={!!allIssues.data} retry={allIssues.refetch} />}
    <Field label={t("搜索所有授权任务", "Search all authorized tasks")} value={search} onChange={setSearch} />
    {query.data && tasks.length === 0 && <p className="text-sm text-muted-foreground">{t("没有匹配的任务。", "No matching tasks.")}</p>}
    <ul className="max-h-80 space-y-1 overflow-y-auto">{tasks.map(task => <li key={task.id} className="flex min-w-0 items-center justify-between gap-2"><span className="min-w-0 truncate text-sm">{string(task.data.title) || task.id}</span><WatchControls task={task} /></li>)}</ul>
  </section>
}

export function NotesPanel() {
  const query = usePersonalDashboard()
  const [editor, setEditor] = useState<string | null>(null)
  const t = useText()
  const notes = query.data?.notes ?? []
  const note = notes.find(row => row.id === editor)
  const rows = (items: PrivateNote[]) => <ul className="space-y-2">{items.map(row => <NoteSummary key={row.id} note={row} onEdit={() => setEditor(row.id)} />)}</ul>
  return <section className="min-w-0 space-y-3" aria-label={t("私人便签", "Private notes")}><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("便签", "Notes")} · {query.data ? notes.filter(row => !row.data.completedAt).length : "—"}</h3><Button size="sm" variant="ghost" disabled={!query.data} onClick={() => setEditor("new")}><Plus className="size-3.5" aria-hidden="true" />{t("新建", "New")}</Button></div>
    <PersonalReadNotice loading={query.isPending} error={query.error} stale={!!query.data} retry={query.refetch} />{query.data && !notes.length && <p className="text-sm text-muted-foreground">{t("没有便签。仅你能读取自己的便签。", "No notes. Your notes are private to you.")}</p>}{rows(notes.slice(0, 3))}{notes.length > 3 && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t("全部便签", "All notes")} · {notes.length}</summary><div className="pt-2">{rows(notes.slice(3))}</div></details>}
    <EditorDialog title={note ? t("编辑便签", "Edit note") : t("新建便签", "New note")} description={t("服务器持久保存；只有本人可读。删除会保留事件与命令收据。", "Saved on the server and readable only by you. Deletion retains audit events and command receipts.")} open={editor !== null} onOpenChange={open => { if (!open) setEditor(null) }}>{query.data && editor !== null && (editor === "new" || note) && <NoteEditor key={editor} note={note} onCreated={() => setEditor(null)} />}{editor !== null && editor !== "new" && !note && <p>{t("便签已删除或不可访问。未提交草稿仍保留。", "The note was deleted or is inaccessible. Unsaved drafts are retained.")}</p>}</EditorDialog>
  </section>
}

function NoteSummary({ note, onEdit }: { note: PrivateNote; onEdit: () => void }) {
  const action = useAction()
  const t = useText()
  return <li className="min-w-0"><div className="flex min-w-0 items-center gap-2"><Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={note.data.completedAt ? t("重开便签", "Reopen note") : t("完成便签", "Complete note")} aria-pressed={!!note.data.completedAt} disabled={action.locked} onClick={() => { void action.run(() => action.execute({ commandId: crypto.randomUUID(), commandType: note.data.completedAt ? "ReopenPrivateNote" : "CompletePrivateNote", targetId: note.id, expectedVersions: { [note.id]: note.version }, payload: {} })) }}><Check className={`size-3.5 ${note.data.completedAt ? "opacity-100" : "opacity-30"}`} aria-hidden="true" /></Button><button type="button" onClick={onEdit} className={`min-w-0 flex-1 truncate text-left text-sm ${note.data.completedAt ? "text-muted-foreground line-through" : ""}`}>{note.data.content}</button></div>{action.localError && <p role="alert" className="text-xs text-destructive">{action.localError}</p>}</li>
}

function NoteEditor({ note, onCreated }: { note?: PrivateNote; onCreated: () => void }) {
  const action = useAction()
  const t = useText()
  const [draft, setDraft] = useDraftState(`private-note:${note?.id ?? "new"}`, "draft", { content: note?.data.content ?? "", version: note?.version ?? 0 })
  return <div className="space-y-3">{note && <><DraftConflict current={note.version} base={draft.version} onRebase={() => setDraft({ ...draft, version: note.version })} onReload={() => setDraft({ content: note.data.content, version: note.version })} />{note.version !== draft.version && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{t("服务端内容", "Saved content")}: {note.data.content}</p>}</>}
    <Form disabled={action.locked} onSubmit={async () => {
      const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: note ? "UpdatePrivateNote" : "CreatePrivateNote", ...(note ? { targetId: note.id, expectedVersions: { [note.id]: draft.version } } : {}), payload: { content: draft.content } })
      if (receipt.status !== "committed") return
      const saved = receipt.result as PrivateNote
      setDraft({ content: note ? saved.data.content : "", version: note ? saved.version : 0 })
      if (!note) onCreated()
    }}><Field label={t("内容", "Content")} value={draft.content} onChange={content => setDraft({ ...draft, content })} multiline required /></Form>
    {note && <Button variant="destructive" size="sm" disabled={action.locked} onClick={() => { void action.run(async () => { await action.execute({ commandId: crypto.randomUUID(), commandType: "DeletePrivateNote", targetId: note.id, expectedVersions: { [note.id]: draft.version }, payload: {} }); onCreated() }) }}>{t("删除便签", "Delete note")}</Button>}{action.localError && <p role="alert" className="text-sm text-destructive">{action.localError}</p>}
  </div>
}

type MeetingDraft = { title: string; description: string; startsAt: string; endsAt: string; participantIds: string; projectId: string; version: number; cancellationReason: string }

function localMeetingTime(iso: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function MeetingsPanel({ projects }: { projects?: Entity[] }) {
  const query = usePersonalDashboard()
  const display = useDisplayDateTime(query.data?.profile.timeZone)
  const projectQuery = usePmEntities("project")
  const { workspace } = usePmService()
  const [editor, setEditor] = useState<string | null>(null)
  const t = useText()
  const availableProjects = projects ?? projectQuery.data ?? []
  const editableProjects = availableProjects.filter(project => allowed(workspace, "planning.edit", project.id) && !project.data.archivedAt && !["completed", "cancelled"].includes(string(project.data.status)))
  const meetings = query.data?.meetings ?? []
  const active = meetings.filter(meeting => !meeting.data.cancelledAt && Date.parse(meeting.data.endsAt) >= Date.now())
  const meeting = meetings.find(row => row.id === editor)
  const format = display.dateTime
  const rows = (items: ProjectMeeting[]) => <ul className="space-y-2">{items.map(row => <li key={row.id} className="min-w-0"><button type="button" className="grid w-full min-w-0 gap-0.5 text-left" onClick={() => setEditor(row.id)}><span className={`truncate text-sm ${row.data.cancelledAt ? "line-through text-muted-foreground" : "font-medium"}`}>{row.data.title}</span><span className="break-words text-xs text-muted-foreground">{format(row.data.startsAt)} — {format(row.data.endsAt)}{row.data.cancelledAt ? ` · ${t("已取消", "Cancelled")}` : ""}</span></button></li>)}</ul>
  return <section className="min-w-0 space-y-3" aria-label={t("项目会议", "Project meetings")}><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("会议", "Meetings")} · {query.data ? active.length : "—"}</h3><Button size="sm" variant="ghost" disabled={!query.data || !editableProjects.length} onClick={() => setEditor("new")}><Plus className="size-3.5" aria-hidden="true" />{t("新建", "New")}</Button></div><PersonalReadNotice loading={query.isPending} error={query.error} stale={!!query.data} retry={query.refetch} />{query.data && !active.length && <p className="text-sm text-muted-foreground">{t("没有即将举行的会议。", "No upcoming meetings.")}</p>}{rows(active.slice(0, 3))}{meetings.length > 0 && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t("全部会议 / 取消记录", "All meetings / cancellations")} · {meetings.length}</summary><div className="max-h-64 space-y-2 overflow-y-auto pt-2">{rows(meetings)}</div></details>}{query.data && <p className="text-xs text-muted-foreground">{query.data.profile.timeZone} · {t("仅项目会议，不同步外部日历或邮件。", "Project meetings only; no external calendar or email sync.")}</p>}
    <EditorDialog title={meeting ? t("会议详情", "Meeting details") : t("新建项目会议", "New project meeting")} description={t("时间输入使用浏览器本地时区；列表按个人资料时区显示。参与人必须是拥有项目访问权限的有效成员。", "Time inputs use your browser's local time zone; the list uses your profile time zone. Participants must be active members with project access.")} open={editor !== null} onOpenChange={open => { if (!open) setEditor(null) }}>{query.data && editor !== null && (editor === "new" || meeting) && <MeetingEditor key={editor} meeting={meeting} projects={editableProjects} dashboard={query.data} onCreated={() => setEditor(null)} />}</EditorDialog>
  </section>
}

function MeetingEditor({ meeting, projects, dashboard, onCreated }: { meeting?: ProjectMeeting; projects: Entity[]; dashboard: PersonalDashboard; onCreated: () => void }) {
  const action = useAction()
  const { actor, workspace } = usePmService()
  const t = useText()
  const initial: MeetingDraft = { title: meeting?.data.title ?? "", description: meeting?.data.description ?? "", startsAt: localMeetingTime(meeting?.data.startsAt ?? ""), endsAt: localMeetingTime(meeting?.data.endsAt ?? ""), participantIds: meeting?.data.participantIds.join("\n") ?? actor?.id ?? "", projectId: meeting?.projectId ?? projects[0]?.id ?? "", version: meeting?.version ?? 0, cancellationReason: "" }
  const [draft, setDraft] = useDraftState(`project-meeting:${meeting?.id ?? "new"}`, "draft", initial)
  const writable = !meeting?.data.cancelledAt && allowed(workspace, "planning.edit", draft.projectId) && projects.some(project => project.id === draft.projectId)
  const participants = dashboard.meetingParticipants.filter(member => member.projectIds === null || member.projectIds.includes(draft.projectId))
  return <div className="space-y-3">{meeting?.data.cancelledAt && <p role="status" className="break-words text-sm">{t("已取消", "Cancelled")} · {meeting.data.cancellationReason}</p>}{meeting && <><DraftConflict current={meeting.version} base={draft.version} onRebase={() => setDraft({ ...draft, version: meeting.version })} onReload={() => setDraft(initial)} />{meeting.version !== draft.version && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{t("服务端值", "Saved values")}: {meeting.data.title} · {meeting.data.startsAt} — {meeting.data.endsAt} · {meeting.data.participantIds.join(", ")}<br />{meeting.data.description}</p>}</>}
    <Form disabled={action.locked || !writable} onSubmit={async () => {
      const payload = { title: draft.title, description: draft.description, startsAt: meeting && draft.startsAt === localMeetingTime(meeting.data.startsAt) ? meeting.data.startsAt : new Date(draft.startsAt).toISOString(), endsAt: meeting && draft.endsAt === localMeetingTime(meeting.data.endsAt) ? meeting.data.endsAt : new Date(draft.endsAt).toISOString(), participantIds: draft.participantIds.split(/[\s,]+/).filter(Boolean) }
      const receipt = await action.execute({ commandId: crypto.randomUUID(), commandType: meeting ? "UpdateProjectMeeting" : "CreateProjectMeeting", projectId: draft.projectId, ...(meeting ? { targetId: meeting.id, expectedVersions: { [meeting.id]: draft.version } } : {}), payload })
      if (receipt.status !== "committed") return
      const saved = receipt.result as ProjectMeeting
      setDraft({ ...draft, title: meeting ? saved.data.title : "", description: meeting ? saved.data.description : "", startsAt: meeting ? localMeetingTime(saved.data.startsAt) : "", endsAt: meeting ? localMeetingTime(saved.data.endsAt) : "", version: meeting ? saved.version : 0 })
      if (!meeting) onCreated()
    }}><Choice label={t("项目", "Project")} value={draft.projectId} disabled={!!meeting} onChange={projectId => setDraft({ ...draft, projectId })} options={projects.map(project => ({ value: project.id, label: string(project.data.name) || project.id }))} /><Field label={t("标题", "Title")} value={draft.title} onChange={title => setDraft({ ...draft, title })} required /><Field label={t("说明", "Description")} value={draft.description} onChange={description => setDraft({ ...draft, description })} multiline /><div className="grid gap-3 sm:grid-cols-2"><Field label={t("开始（浏览器时区）", "Start (browser time zone)")} type="datetime-local" value={draft.startsAt} onChange={startsAt => setDraft({ ...draft, startsAt })} required /><Field label={t("结束（浏览器时区）", "End (browser time zone)")} type="datetime-local" value={draft.endsAt} onChange={endsAt => setDraft({ ...draft, endsAt })} required /></div><Field label={t("参与人账号 ID（每行一个）", "Participant user IDs (one per line)")} value={draft.participantIds} onChange={participantIds => setDraft({ ...draft, participantIds })} multiline required />{participants.length > 0 && <div className="space-y-1 text-xs"><p>{dashboard.canListParticipants ? t("可选成员", "Available members") : t("你的账号（完整成员目录需要管理权限）", "Your account (the full directory requires access management)")}</p>{participants.map(member => <Button type="button" key={member.userId} size="sm" variant="outline" className="mr-1 mb-1 max-w-full truncate" onClick={() => { const ids = draft.participantIds.split(/[\s,]+/).filter(Boolean); if (!ids.includes(member.userId)) setDraft({ ...draft, participantIds: [...ids, member.userId].join("\n") }) }}>{member.name}</Button>)}</div>}</Form>
    {!writable && !meeting?.data.cancelledAt && <p className="text-sm text-muted-foreground">{t("此项目无会议编辑权限或已关闭。", "No meeting edit permission, or this project is closed.")}</p>}
    {meeting && writable && <details><summary className="cursor-pointer text-sm">{t("取消会议", "Cancel meeting")}</summary><div className="space-y-2 pt-2"><Field label={t("取消原因", "Cancellation reason")} value={draft.cancellationReason} onChange={cancellationReason => setDraft({ ...draft, cancellationReason })} required /><Button variant="destructive" size="sm" disabled={action.locked || !draft.cancellationReason.trim()} onClick={() => { void action.run(async () => { await action.execute({ commandId: crypto.randomUUID(), commandType: "CancelProjectMeeting", targetId: meeting.id, projectId: meeting.projectId!, expectedVersions: { [meeting.id]: draft.version }, payload: { reason: draft.cancellationReason } }); onCreated() }) }}>{t("确认取消", "Confirm cancellation")}</Button></div></details>}{action.localError && <p role="alert" className="text-sm text-destructive">{action.localError}</p>}
  </div>
}

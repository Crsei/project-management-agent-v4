import { useState } from "react"
import type { FileRecord } from "@pm-schema"
import type { Entity, ProjectManagementClient } from "@contracts"
import { MoreHorizontal, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { MessageContent } from "@/components/blocks/message-content"
import { WorkItemBoard } from "@/components/blocks/work-items-views"
import { WorkItemRow, WorkItemStateGlyph } from "@/components/blocks/work-item"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import type { ControlledIssueCatalog, ControlledIssueRecord } from "@/views/pm/controlled-contracts"
import reference from "@/views/pm/projects-views.module.css"
import workspaceStyles from "@/views/pm/project-detail-2.module.css"
import { usePmCommand, usePmService } from "./pm-service"
import { allowed, Field, Form, makeCommand, objects, QueryNotice, required, string, today, useDraftState, useText, writable } from "./pm-ui"
import styles from "./service-project-detail.module.css"
import { ProjectTaskEditingNotice, ProjectTaskInlineActions, ProjectTaskInlineField, type ProjectTaskEditing } from "./project-task-editing"

type EntityQuery = { data: Entity[] | undefined; isPending: boolean; isFetching: boolean; error: Error | null; refetch: () => unknown }
type TaskPanelProps = { items: ControlledIssueRecord[]; catalog: ControlledIssueCatalog; onOpen: (item: { id: string }) => void; onCreate: () => void; canCreate: boolean; editing?: ProjectTaskEditing }

/** Shared by controlled attachment actions and the real file cards. */
export async function downloadProjectAttachment(client: ProjectManagementClient, workspaceId: string, version: Entity) {
  const result = await client.downloadArtifactVersion(workspaceId, version.id)
  const mediaType = string(version.data.mediaType) || result.mediaType || "application/octet-stream"
  const url = URL.createObjectURL(new Blob([Uint8Array.from(result.bytes)], { type: mediaType }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = string(version.data.fileName) || version.id
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ProjectTaskBoard({ projectId, items: suppliedItems, catalog, onOpen, onCreate, canCreate, editing, hideToolbar = false, search: controlledSearch, status: controlledStatus, emptyFiltered = false }: TaskPanelProps & { projectId: string; hideToolbar?: boolean; search?: string; status?: string; emptyFiltered?: boolean }) {
  const t = useText()
  const showCompletedTasks = useWorkspaceStore(state => state.showCompletedTasks)
  const [selectedIds, setSelectedIds] = useDraftState<string[]>(`project-task-board:${projectId}`, "selectedIds", [])
  const [collapsed, setCollapsed] = useDraftState<string[]>(`project-task-board:${projectId}`, "collapsed", [])
  const [localSearch, setLocalSearch] = useDraftState(`project-task-board:${projectId}`, "search", "")
  const search = controlledSearch ?? localSearch
  const status = controlledStatus ?? ""
  const taskEditing = editing?.projectId === projectId ? editing : undefined
  const todayValue = today()
  const items = taskEditing ? taskEditing.present(suppliedItems) : suppliedItems
  const filtered = items.filter(item => (showCompletedTasks || catalog.states.find(state => state.id === item.stateId)?.category !== "completed") && (!status || item.stateId === status) && `${item.identifier} ${item.title}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const groups = catalog.states.map(state => {
    const itemIds = filtered.filter(item => item.stateId === state.id).map(item => item.id)
    return { key: state.id, label: state.label, itemIds, loadedCount: itemIds.length, totalCount: itemIds.length, dataState: "success" as const, queryKey: `project:${projectId}:tasks` }
  })
  return <div className={reference.panelStack} data-pm-tasks-panel>
    {!hideToolbar && <div className={styles.panelToolbar}><Input className="max-w-xs" value={search} onChange={event => setLocalSearch(event.target.value)} aria-label={t("搜索项目任务", "Search project tasks")} placeholder={t("搜索任务…", "Search tasks…")} /><Button disabled={!canCreate || taskEditing?.locked} onClick={onCreate}><Plus size={14} />{t("新建任务", "Add issue")}</Button></div>}
    {taskEditing && <ProjectTaskEditingNotice editing={taskEditing} onOpen={onOpen} />}
    {filtered.length ? <ScrollArea className={reference.tasksViewport} label={t("项目任务分栏", "Project task lanes")} orientation="horizontal" data-pm-task-lanes>
      <WorkItemBoard className={reference.tasksBoard} queryKey={`project:${projectId}:tasks`} items={filtered} groups={groups} manualOrder={false} allowAppend getGroupIcon={key => <WorkItemStateGlyph state={catalog.states.find(state => state.id === key)} />} interaction={{ selectedIds, activeItemId: selectedIds.at(-1) ?? null, collapsedGroupIds: collapsed }} onSelectionChange={ids => setSelectedIds([...ids])} onToggleGroup={key => setCollapsed(previous => previous.includes(key) ? previous.filter(id => id !== key) : [...previous, key])} canMove={(item, _source, target) => taskEditing?.canMove(item.id, target) ?? false} onMove={taskEditing ? intent => { void taskEditing.move(intent).catch(() => {}) } : undefined} getPresentation={item => ({
        catalog, visibleProperties: ["state", "priority", "assignees", "dueDate"], today: todayValue, onOpen,
        actions: taskEditing ? <Popover><PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t("编辑任务", "Edit task")} />}><MoreHorizontal size={14} /></PopoverTrigger><PopoverContent align="end" className="grid w-64 min-w-0 gap-2">{(["title", "status", "priority", "assignee", "x-pm-start", "due"] as const).map(field => <ProjectTaskInlineField key={field} editing={taskEditing} item={item} field={field} catalog={catalog} />)}<ProjectTaskInlineActions editing={taskEditing} item={item} /></PopoverContent></Popover> : undefined,
      })} />
    </ScrollArea> : <p className={reference.muted}>{emptyFiltered ? t("没有匹配筛选的任务。", "No tasks match these filters.") : t("本项目没有任务。新建任务进入正式 Markdown 表单。", "This project has no tasks. Add an issue using the formal Markdown form.")}</p>}
    <p className={reference.muted}>{taskEditing ? t("可拖动状态或打开卡片菜单修改字段；以原生工作流和源 revision 保存。完整源码草稿、归档或诊断会锁定行内编辑。", "Drag between workflow states or open the card menu to edit fields using its native source revision. Source drafts, archives, and diagnostics lock inline editing.") : t("点击任务打开完整编辑器；状态转换和字段校验仍由核心工作流负责。", "Open a task in the full editor; state transitions and field validation remain owned by the core workflow.")}</p>
  </div>
}

export function ProjectIssueRows({ items: suppliedItems, catalog, onOpen, onCreate, canCreate, editing, layout = "table", hideToolbar = false, search: controlledSearch, status: controlledStatus, emptyFiltered = false }: TaskPanelProps & { layout?: "list" | "table"; hideToolbar?: boolean; search?: string; status?: string; emptyFiltered?: boolean }) {
  const t = useText()
  const display = useDisplayDateTime()
  const [localSearch, setLocalSearch] = useState("")
  const [localStatus, setLocalStatus] = useState("")
  const search = controlledSearch ?? localSearch
  const status = controlledStatus ?? localStatus
  const items = editing ? editing.present(suppliedItems) : suppliedItems
  const filtered = items.filter(item => (!status || item.stateId === status) && `${item.identifier} ${item.title}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  return <div className={reference.panelStack} data-pm-issues-panel>
    {!hideToolbar && <div className={styles.panelToolbar}><Input className="max-w-xs" value={search} onChange={event => setLocalSearch(event.target.value)} aria-label={t("搜索 Issue", "Search issues")} placeholder={t("搜索 Issue…", "Search issues…")} /><label className="flex items-center gap-2 text-sm">{t("状态", "Status")}<select className="min-h-9 rounded border bg-background px-2" value={status} onChange={event => setLocalStatus(event.target.value)}><option value="">{t("全部", "All")}</option>{catalog.states.map(state => <option key={state.id} value={state.id}>{state.label}</option>)}</select></label><Button disabled={!canCreate || editing?.locked} onClick={onCreate}><Plus size={14} />{t("新建任务", "Add issue")}</Button></div>}
    {editing && <ProjectTaskEditingNotice editing={editing} onOpen={onOpen} />}
    {layout === "list" ? <div className="space-y-1">{filtered.map(item => <WorkItemRow key={item.id} item={item} catalog={catalog} capabilities={{ canCreate, canEditField: (record, field) => ["title", "state", "priority", "assignees", "startDate", "dueDate"].includes(field) && !!editing?.canEdit(record.id), canMove: (record, target) => editing?.canMove(record.id, target) ?? false }} visibleProperties={["state", "priority", "assignees", "dueDate"]} onOpen={() => onOpen(item)} onPatchItem={(_record, patch) => editing?.patch(item, patch)} />)}</div> :
    <TableContainer className={styles.issueTable}><Table><TableHeader><TableRow>{[t("任务", "Issue"), t("状态", "Status"), t("优先级", "Priority"), t("负责人", "Assignee"), t("开始日期", "Start date"), t("截止日期", "Due date")].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{filtered.map(item => <TableRow key={item.id}>
      <TableCell><Button variant="ghost" className={styles.issueLink} onClick={() => onOpen(item)}><span className="font-mono text-xs text-muted-foreground">{item.identifier}</span><span>{item.title}</span></Button>{editing && <div className="grid gap-2"><ProjectTaskInlineField editing={editing} item={item} field="title" catalog={catalog} /><ProjectTaskInlineActions editing={editing} item={item} /></div>}</TableCell>
      <TableCell>{editing ? <ProjectTaskInlineField editing={editing} item={item} field="status" catalog={catalog} /> : <Badge size="sm">{catalog.states.find(state => state.id === item.stateId)?.label ?? item.stateId}</Badge>}</TableCell>
      <TableCell>{editing ? <ProjectTaskInlineField editing={editing} item={item} field="priority" catalog={catalog} /> : item.priorityId || "—"}</TableCell>
      <TableCell>{editing ? <ProjectTaskInlineField editing={editing} item={item} field="assignee" catalog={catalog} /> : item.assigneeIds.join(", ") || t("未分配", "Unassigned")}</TableCell>
      <TableCell>{editing ? <ProjectTaskInlineField editing={editing} item={item} field="x-pm-start" catalog={catalog} /> : display.date(item.startDate)}</TableCell>
      <TableCell>{editing ? <ProjectTaskInlineField editing={editing} item={item} field="due" catalog={catalog} /> : display.date(item.dueDate)}</TableCell>
    </TableRow>)}</TableBody></Table></TableContainer>
    }
    {!filtered.length && <p className={reference.muted}>{emptyFiltered || items.length ? t("没有匹配筛选的任务。", "No tasks match these filters.") : t("本项目没有任务。", "No tasks in this project.")}</p>}
  </div>
}

export function ProjectConversations({ project, conversations }: { project: Entity; conversations: EntityQuery }) {
  const { workspace, capabilities } = usePmService()
  const command = usePmCommand()
  const t = useText()
  const [title, setTitle] = useDraftState(`project-discussion:${project.id}`, "title", "")
  const spellcheck = useWorkspaceStore(state => state.spellcheck)
  const canWrite = capabilities?.business.enabled === true && allowed(workspace, "intent.propose", project.id) && writable(project)
  return <div className={reference.panelStack} data-pm-comment-list spellCheck={spellcheck}>
    <h2 className={reference.sectionTitle}>{t("项目讨论", "Project discussion")}</h2><p className={reference.muted}>{t("项目没有独立评论接口。以下内容是该项目真实对话中的消息，不伪装成页面评论。追加消息不会自动创建任务。", "Projects have no separate comments endpoint. These are messages in actual project conversations, not invented page comments. Appending a message never creates a task.")}</p>
    <QueryNotice query={conversations}>{conversations.data?.map(conversation => <ConversationThread key={conversation.id} conversation={conversation} canWrite={canWrite} />)}</QueryNotice>
    <div className={styles.discussionComposer} data-pm-comment-composer><Form title={t("创建项目对话", "Create a project conversation")} label={t("创建对话", "Create conversation")} disabled={!canWrite || command.pending || !!command.unknownCommand} onSubmit={async () => { await command.execute(makeCommand("CreateConversation", { title: required.max(300).parse(title) }, undefined, project.id)); setTitle("") }}><Field label={t("对话标题", "Conversation title")} value={title} onChange={setTitle} required /></Form></div>
  </div>
}

function ConversationThread({ conversation, canWrite }: { conversation: Entity; canWrite: boolean }) {
  const command = usePmCommand()
  const t = useText()
  const [content, setContent] = useDraftState(`conversation:${conversation.id}`, "content", "")
  const display = useDisplayDateTime()
  const messages = objects(conversation.data.messages)
  return <section className={styles.conversation}><h3>{string(conversation.data.title) || conversation.id} <Badge>{messages.length}</Badge></h3><ul>{messages.map(message => <li key={string(message.id)}><div className={styles.messageMeta}><strong>{string(message.authorId) || "—"}</strong><time dateTime={string(message.createdAt)}>{display.dateTime(string(message.createdAt))}</time><span>v{Number(message.contentVersion)}</span></div><MessageContent content={string(message.content)} /></li>)}</ul>{!messages.length && <p className={reference.muted}>{t("该对话尚无消息。", "No messages in this conversation yet.")}</p>}<div className={styles.discussionComposer} data-pm-comment-composer><Form label={t("追加消息", "Append message")} disabled={!canWrite || command.pending || !!command.unknownCommand} onSubmit={async () => { await command.execute(makeCommand("AppendMessage", { content: required.parse(content) }, conversation, conversation.projectId!)); setContent("") }}><Field label={t("消息内容", "Message content")} value={content} onChange={setContent} multiline required /></Form></div></section>
}

export function ProjectSourceUpdates({ projectId, sourceFiles, onOpen }: { projectId: string; sourceFiles: FileRecord[]; onOpen: (id: string) => void }) {
  const t = useText()
  const files = sourceFiles.filter(file => file.id === projectId || file.entity.project === projectId)
  const lastChanges = files.map(file => ({ file, at: string(file.entity["x-pm-updated-at"]) })).filter(entry => entry.at).sort((a, b) => b.at.localeCompare(a.at))
  return <div className={reference.panelStack}>
    <section className={workspaceStyles.activity}><h2 className={reference.sectionTitle}>{t("Markdown 对象最近更新", "Latest Markdown object updates")}</h2><p className={reference.muted}>{t("当前源文件记录的更新时间；这是对象快照，不是完整历史审计。", "Update times recorded in the current source files. These are object snapshots, not a complete audit history.")}</p>{lastChanges.length ? <ol className={workspaceStyles.activityList}>{lastChanges.map(({ file, at }) => <li key={file.id} className={workspaceStyles.activityItem}><span className={workspaceStyles.activityDot} aria-hidden="true" /><div className={workspaceStyles.activityHeading}><Button variant="ghost" size="sm" onClick={() => onOpen(file.id)}>{file.entity.title}</Button><time dateTime={at}>{at}</time></div><p>{file.id} · {string(file.entity.status) || "—"}</p></li>)}</ol> : <p className={reference.muted}>{t("源文件没有可显示的更新时间记录。", "The source files have no recorded update timestamps to display.")}</p>}</section>
  </div>
}

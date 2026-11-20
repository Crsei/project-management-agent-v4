import { useEffect, useId, useRef, useState } from "react"
import { Link, useLocation, useNavigationType, useSearchParams } from "react-router-dom"
import { Columns3, FolderPlus, MessageSquare, Plus, RefreshCw, Terminal } from "lucide-react"
import type { AgentWorkspace, ChatGenerationView, RemoteThread } from "@agent-workspace/contracts/chat"
import type { ProviderInstance } from "@agent-workspace/contracts/provider"
import { getProviderInstanceDisplayName, getProviderModelShortName } from "@agent-workspace/client-runtime"
import { Board } from "@/components/blocks/work-items-board-base"
import { FilterToolbar } from "@/components/blocks/filter-toolbar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { RadixSelect } from "@/components/ui/radix-select"
import { Segmented, SegmentedItem } from "@/components/ui/segmented"
import type { GroupSnapshot } from "@/lib/grouped-items-model"
import { useI18n } from "@/lib/i18n-provider"
import { AgentRunCard } from "@/views/pm/agent-run-card"
import { PmPage } from "@/views/pm/presentation-page"
import workItemStyles from "@/components/blocks/work-items.module.css"
import boardStyles from "@/views/pm/boards-views.module.css"
import common from "@/views/pm/agent-run-board.module.css"
import { useAgentText, type AgentText } from "../i18n"
import { Assistant } from "../assistant"
import { RunExecutionDock, useKeepRunCardVisible } from "./run-execution-dock"
import { OpenFolderDialog } from "./execution-workspace"
import { useRunBoard, useRunBoardAccessError, useRunBoardExecution, useRunBoardHistory } from "./run-board-data"
import { readRunBoardSelection, runBoardActivity, runBoardGenerationFacts, runBoardTerminalWorkspace, updateRunBoardSelection, type RunBoardActivity, type RunBoardSelection } from "./run-board-model"
import { runBoardChatHref, safeRunBoardReturn } from "./run-board-navigation"
import { RunBoardHistoryOutput, RunBoardNativeOutput } from "./run-board-output"
import styles from "./run-board-page.module.css"
import BusinessRunsPage from "../collaboration/runs-page"

type Row = {
  thread: RemoteThread
  activity: RunBoardActivity
  title: string
  folderId: string
  folder: string
  path: string | null
  branch: string | null
  providerId: string
  provider: string
  model: string
}
type StopAction = { generationId: string; status: "pending" | "requested" | "uncertain"; snapshot: RemoteThread[]; recheck: boolean }
const columns = ["queued", "running", "waiting", "attention", "idle", "unknown"] as const

function columnLabel(column: RunBoardActivity["column"], t: AgentText): string {
  const labels = { queued: t("排队", "Queued"), running: t("运行中", "Running"), waiting: t("等待处理", "Needs input"), attention: t("异常 / 待关注", "Needs attention"), idle: t("空闲 / 已结束", "Idle / ended"), unknown: t("未知状态", "Unknown status") }
  return labels[column]
}

function activityLabel(activity: RunBoardActivity, t: AgentText): string {
  switch (activity.status) {
    case "queued": return t("生成已排队", "Generation queued")
    case "running": return t("Agent 正在运行", "Agent is running")
    case "waiting_approval": return t("等待审批 · 请在 Chat 中处理", "Awaiting approval · respond in Chat")
    case "waiting_input": return t("等待回答 · 请在 Chat 中处理", "Awaiting input · respond in Chat")
    case "failed": return t("生成失败 · 请在 Chat 中核对", "Generation failed · review in Chat")
    case "cancelled": return t("生成已取消 · 不代表业务任务完成", "Generation cancelled · not task completion")
    case "interrupted": return t("生成已中断 · 请在 Chat 中核对", "Generation interrupted · review in Chat")
    case "idle": return activity.generationId
      ? t("最近一代生成已结束 · 非业务完成", "Recent generation ended · not task completion")
      : t("尚未开始生成", "No generation started")
    default: return t("状态不兼容 · 无法安全停止", "Incompatible status · stop unavailable")
  }
}

function generationLabel(status: ChatGenerationView["status"], t: AgentText): string {
  switch (status) {
    case "queued": return t("已排队", "Queued")
    case "running": return t("运行中", "Running")
    case "completed": return t("已完成 · 不代表业务任务完成", "Completed · not business task completion")
    case "failed": return t("失败", "Failed")
    case "cancelled": return t("已取消", "Cancelled")
    case "interrupted": return t("已中断", "Interrupted")
    default: return t("未知状态", "Unknown status")
  }
}

function rowForThread(thread: RemoteThread, workspaces: AgentWorkspace[], providers: ProviderInstance[], t: AgentText): Row {
  const environment = thread.executionEnvironment
  const workspaceId = environment ? environment.agentWorkspaceId : thread.executionSelection?.agentWorkspaceId
  const workspace = workspaceId ? workspaces.find(item => item.id === workspaceId) : undefined
  const providerId = thread.settings?.providerInstanceId || ""
  const provider = providers.find(item => item.instanceId === providerId)
  const modelId = thread.settings?.model || ""
  const model = provider?.models.find(item => item.id === modelId || item.aliases?.includes(modelId))
  return {
    thread,
    activity: runBoardActivity(thread),
    title: thread.title?.trim() || t("未命名会话", "Untitled session"),
    folderId: workspaceId === null ? "chat-only" : workspaceId === undefined ? "unknown-folder" : `folder:${workspaceId}`,
    folder: environment?.agentWorkspaceName || workspace?.name || (workspaceId ? workspaceId : workspaceId === null ? t("仅对话", "Chat only") : t("文件夹信息未知", "Folder unknown")),
    path: environment?.sourcePath || workspace?.path || null,
    branch: environment?.worktree?.branch || null,
    providerId,
    provider: provider ? getProviderInstanceDisplayName(provider) : providerId || t("Provider 未设置", "Provider not set"),
    model: model && provider ? getProviderModelShortName(provider.driver, model) || model.label : modelId || t("模型未设置", "Model not set"),
  }
}

export default function RunBoardPage() {
  const [params] = useSearchParams()
  const t = useAgentText()
  const accessError = useRunBoardAccessError()
  if (accessError) return (
    <main className="space-y-4 p-6">
      <p role="alert">{accessError}</p>
      <Button onClick={() => window.location.reload()}>{t("重新核验 Agent 访问", "Recheck Agent access")}</Button>
    </main>
  )
  return <Assistant runBoard={params.get("view") === "business" ? <BusinessRunsPage /> : <SessionRunBoardPage />} />
}

function SessionRunBoardPage() {
  const t = useAgentText()
  const { locale } = useI18n()
  const board = useRunBoard()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const { query: urlQuery, folder, provider, attention, selectedId } = readRunBoardSelection(params)
  const [query, setQuery] = useState(urlQuery)
  const queryRef = useRef(urlQuery)
  const queryNavigationId = useId()
  const navigationType = useNavigationType()
  useEffect(() => {
    // A router transition must not replace urgent input with an older own URL.
    if (navigationType !== "POP" && location.state?.sessionRunsQueryId === queryNavigationId) return
    queryRef.current = urlQuery
    setQuery(urlQuery)
  }, [location.key, location.state, navigationType, queryNavigationId, urlQuery])
  const updateSelection = (patch: Partial<RunBoardSelection>, replace = false) => {
    const nextQuery = patch.query ?? queryRef.current
    if (patch.query !== undefined) {
      queryRef.current = nextQuery
      setQuery(nextQuery)
    }
    setParams(previous => updateRunBoardSelection(previous, { ...patch, query: nextQuery }), {
      replace,
      state: { ...(location.state && typeof location.state === "object" ? location.state : {}), sessionRunsQueryId: queryNavigationId },
    })
  }
  const returnLocation = query === urlQuery ? `${location.pathname}${location.search}`
    : `${location.pathname}?${updateRunBoardSelection(params, { query })}`
  const returnTo = safeRunBoardReturn(returnLocation)
    || safeRunBoardReturn(`/agent/runs?${updateRunBoardSelection(new URLSearchParams(), { query, folder, provider, attention, selectedId })}`)
    || "/agent/runs?view=sessions"
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newFolder, setNewFolder] = useState("")
  const [openedWorkspace, setOpenedWorkspace] = useState<AgentWorkspace | null>(null)
  const [openingFolder, setOpeningFolder] = useState(false)
  const [outputRevision, setOutputRevision] = useState(0)
  const [detailView, setDetailView] = useState<{ threadId: string | null; tab: "output" | "history" | "diagnostics" }>({ threadId: null, tab: "output" })
  const detailTab = detailView.threadId === selectedId ? detailView.tab : "output"
  const [stopActions, setStopActions] = useState<Record<string, StopAction>>({})
  const opener = useRef<HTMLButtonElement | null>(null)
  const refreshButton = useRef<HTMLButtonElement | null>(null)
  const boardElement = useRef<HTMLDivElement | null>(null)
  const rows = board.threads.filter(thread => thread.status === "regular").map(thread => rowForThread(thread, board.workspaces, board.providers, t))
  const selected = rows.find(row => row.thread.remoteId === selectedId)
  const history = useRunBoardHistory(selected?.thread.remoteId ?? null)
  const execution = useRunBoardExecution(selected?.thread.executionSelection?.agentWorkspaceId ? selected.thread.remoteId : null, selected?.thread.revision)
  useEffect(() => { void board.refresh() }, [selectedId, board.refresh])
  const previousGeneration = useRef<string | null>(null)
  const observedGeneration = selected?.activity.generationId ?? null
  useEffect(() => {
    const identity = selected ? JSON.stringify([selected.thread.remoteId, observedGeneration]) : null
    if (identity !== previousGeneration.current) {
      previousGeneration.current = identity
      if (selected) void history.refresh()
    }
  }, [selected?.thread.remoteId, observedGeneration, history.refresh])
  const stale = !!board.error && !!board.loadedAt
  const search = query.trim().toLocaleLowerCase()
  const filtered = rows.filter(row => (!folder || folder === row.folderId) && (!provider || provider === row.providerId)
    && (!attention || row.activity.column === "waiting" || row.activity.column === "attention" || row.activity.column === "unknown")
    && (!search || [row.thread.remoteId, row.title, row.folder, row.path || "", row.branch || "", row.provider, row.providerId, row.model].some(value => value.toLocaleLowerCase().includes(search))))
  useKeepRunCardVisible(boardElement, selected && filtered.includes(selected) ? selected.thread.remoteId : null)
  const folderOptions = [...new Map(rows.map(row => [row.folderId, row.folder])).entries()].sort((a, b) => a[1].localeCompare(b[1], locale))
  const providerOptions = [...new Map(rows.map(row => [row.providerId, row.provider])).entries()].filter(([id]) => !!id).sort((a, b) => a[1].localeCompare(b[1], locale))
  const unknownCount = rows.filter(row => row.activity.column === "unknown").length
  const visibleColumns = columns.filter(column => column !== "unknown" || unknownCount > 0)
  const groups: GroupSnapshot[] = visibleColumns.map(column => {
    const itemIds = filtered.filter(row => row.activity.column === column).map(row => row.thread.remoteId)
    return { key: column, label: columnLabel(column, t), itemIds, loadedCount: itemIds.length, totalCount: itemIds.length, dataState: "success", queryKey: "agent-live-runs" }
  })
  const hasFilters = !!query || !!folder || !!provider || attention
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })
  const cardDateFormatter = new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
  const formatDate = (value: string | null | undefined, short = false) => {
    if (!value || !Number.isFinite(Date.parse(value))) return t("时间未知", "Time unknown")
    return (short ? cardDateFormatter : dateFormatter).format(new Date(value))
  }
  const { generationId: currentGenerationId, generation, consistent, state: generationState } = runBoardGenerationFacts(selected?.thread ?? null, history.error ? null : history.data)
  const nativeAvailable = !!currentGenerationId && !!history.data && consistent
  const action = selectedId ? stopActions[selectedId] : undefined
  const pending = action?.status === "pending"
  const target = selected?.activity.active && selected.activity.status !== "unknown" && observedGeneration && consistent
    && generation?.id === observedGeneration && (generation.status === "queued" || generation.status === "running") ? observedGeneration : null
  const stopDisabled = !target || !!board.error || history.loading || !!action && action.generationId === target
  const expectedWorkspaceId = selected?.thread.executionEnvironment
    ? selected.thread.executionEnvironment.agentWorkspaceId : selected?.thread.executionSelection?.agentWorkspaceId
  const sessionHref = selected ? runBoardChatHref({
    threadId: selected.thread.remoteId, returnTo,
    ...(expectedWorkspaceId !== undefined ? { agentWorkspaceId: expectedWorkspaceId } : {}),
  }) : null
  const terminalWorkspace = selected && !board.error && !board.metadataError && !execution.error
    ? runBoardTerminalWorkspace(selected.thread, board.workspaces, execution.environment) : null
  const terminalHref = selected && terminalWorkspace
    ? runBoardChatHref({ threadId: selected.thread.remoteId, agentWorkspaceId: terminalWorkspace.id, terminal: true, returnTo }) : null
  const newWorkspaceOptions = [...board.workspaces, ...(openedWorkspace && !board.workspaces.some(workspace => workspace.id === openedWorkspace.id) ? [openedWorkspace] : [])]
  const newWorkspace = newWorkspaceOptions.find(workspace => `folder:${workspace.id}` === newFolder)
  const newChatOnly = newFolder === "chat-only"
  const newSelectionReady = newChatOnly || !!newWorkspace && newWorkspace.status === "available"
    && !newWorkspace.archivedAt && (openedWorkspace?.id === newWorkspace.id || !board.error && !board.metadataError && !board.loading)
  const newChatHref = newSelectionReady ? runBoardChatHref({ agentWorkspaceId: newChatOnly ? null : newWorkspace!.id, returnTo }) : null
  const newTerminalHref = newSelectionReady && newWorkspace && !newChatOnly
    ? runBoardChatHref({ agentWorkspaceId: newWorkspace.id, terminal: true, returnTo }) : null
  const generationProvider = generation ? board.providers.find(item => item.instanceId === generation.providerInstanceId) : undefined
  const generationModel = generationProvider?.models.find(model => model.id === generation?.modelId || model.aliases?.includes(generation?.modelId || ""))
  const generationProviderLabel = generation ? generationProvider ? getProviderInstanceDisplayName(generationProvider) : generation.providerInstanceId : selected?.provider
  const generationModelLabel = generation ? generationModel && generationProvider ? getProviderModelShortName(generationProvider.driver, generationModel) || generationModel.label : generation.modelId : selected?.model

  const refresh = async () => {
    setStopActions(previous => Object.fromEntries(Object.entries(previous).map(([id, action]) => [id, action.status === "uncertain" ? { ...action, snapshot: board.threads, recheck: true } : action])))
    await Promise.all([board.refresh(), history.refresh(), execution.refresh()])
    setOutputRevision(value => value + 1)
  }
  useEffect(() => {
    if (board.error && !board.loadedAt) {
      setStopActions(previous => Object.keys(previous).length ? {} : previous)
      return
    }
    if (board.error || history.error) return
    setStopActions(previous => {
      let changed = false
      const next = { ...previous }
      for (const [threadId, action] of Object.entries(previous)) {
        if (action.status !== "uncertain" || !action.recheck || action.snapshot === board.threads) continue
        delete next[threadId]
        changed = true
      }
      return changed ? next : previous
    })
  }, [board.threads, board.loadedAt, board.error, history.error, stopActions])

  const stop = async () => {
    if (!selected || !target || stopDisabled) return
    const threadId = selected.thread.remoteId
    const generationId = target
    if (!window.confirm(t(`停止「${selected.title}」的这一代生成？\nGeneration: ${generationId}\n不会自动重试，也不会把业务任务标记为完成。`, `Stop this generation of “${selected.title}”?\nGeneration: ${generationId}\nNo automatic retry; the business task will not be marked complete.`))) return
    setStopActions(previous => ({ ...previous, [threadId]: { generationId, status: "pending", snapshot: board.threads, recheck: false } }))
    try {
      await board.stop(threadId, generationId)
      await history.refresh()
      setStopActions(previous => ({ ...previous, [threadId]: { generationId, status: "requested", snapshot: board.threads, recheck: false } }))
    } catch {
      // A failed response does not establish whether the explicit cancellation landed.
      setStopActions(previous => ({ ...previous, [threadId]: { generationId, status: "uncertain", snapshot: board.threads, recheck: false } }))
    }
  }
  const close = () => {
    const currentCard = selectedId ? boardElement.current?.querySelector<HTMLButtonElement>(`[data-agent-run="${CSS.escape(selectedId)}"]`) : null
    opener.current = currentCard || refreshButton.current
    updateSelection({ selectedId: null })
    requestAnimationFrame(() => opener.current?.focus())
  }

  return <div className={styles.workspace}>
    <div className={`${common.root} ${styles.page}`} data-testid="agent-run-board">
    <PmPage pageId="agent-run-board" className={boardStyles.root} contentClassName={common.content} title={t("运行面板", "Run board")}
      actions={<div className={styles.pageActions}><Link className={styles.viewLink} to="/agent/runs?view=business">{t("业务执行（PM）", "Business Runs (PM)")}</Link><Button ref={refreshButton} size="sm" variant="outline" disabled={board.loading || board.refreshing} onClick={() => void refresh()}><RefreshCw className={board.refreshing ? styles.refreshing : undefined} aria-hidden="true" />{board.refreshing ? t("刷新中…", "Refreshing…") : t("刷新", "Refresh")}</Button><Button size="sm" onClick={() => { setNewFolder(""); setOpenedWorkspace(null); setNewSessionOpen(true) }}><Plus aria-hidden="true" />{t("新建会话", "New session")}</Button></div>}
      toolbar={<FilterToolbar className={workItemStyles.toolbar} label={t("筛选会话运行", "Filter session runs")}
        search={<><Segmented value="board" aria-label={t("运行展示方式", "Run layout")}><SegmentedItem value="board" className={common.layoutLabel}><Columns3 size={14} aria-hidden="true" />{t("看板", "Board")}</SegmentedItem></Segmented><Input className={common.search} type="search" aria-label={t("搜索会话、文件夹或分支", "Search sessions, folders or branches")} placeholder={t("搜索会话、文件夹、分支…", "Search sessions, folders, branches…")} value={query} onChange={event => updateSelection({ query: event.target.value }, true)} /></>}
        filters={<><RadixSelect className={common.select} aria-label={t("筛选文件夹", "Filter folders")} value={folder} onChange={event => updateSelection({ folder: event.target.value }, true)}><option value="">{t("全部文件夹", "All folders")}</option>{folder && !folderOptions.some(([id]) => id === folder) && <option value={folder}>{folder} · {t("不在当前列表", "Not in current list")}</option>}{folderOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</RadixSelect><RadixSelect className={common.select} aria-label={t("筛选 Provider", "Filter providers")} value={provider} onChange={event => updateSelection({ provider: event.target.value }, true)}><option value="">{t("全部 Provider", "All providers")}</option>{provider && !providerOptions.some(([id]) => id === provider) && <option value={provider}>{provider} · {t("不在当前列表", "Not in current list")}</option>}{providerOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</RadixSelect><label className={common.attentionFilter}><Checkbox checked={attention} onCheckedChange={value => updateSelection({ attention: value }, true)} />{t("需要我处理", "Needs my attention")}</label></>}
        actions={<>{hasFilters && <Button variant="ghost" onClick={() => updateSelection({ query: "", folder: "", provider: "", attention: false }, true)}>{t("清除筛选", "Clear filters")}</Button>}<span className={common.total} aria-live="polite">{filtered.length} / {rows.length} {t("个会话", "sessions")}</span></>} />}
    >
      <div className={styles.notices}>
        {board.loading && <p role="status">{t("正在读取会话运行…", "Loading session runs…")}</p>}
        {board.error && <p className={styles.warning} role="alert">{stale ? t("刷新失败；保留卡片为过期快照，停止操作已禁用。", "Refresh failed; retained cards are a stale snapshot and stop actions are disabled.") : t("无法读取会话或访问权限已失效。未显示缓存内容，请刷新或重新登录 Agent。", "Sessions cannot be read or access has expired. No cached content is shown; refresh or sign in to Agent again.")}</p>}
        {board.metadataError && <p className={styles.warning} role="status">{t("文件夹或 Provider 元数据未能刷新；会话列表单独显示，缺失项保留真实标识，不推断归属。", "Folder or provider metadata could not refresh. Sessions are shown separately; missing metadata keeps its real identifier without inferring ownership.")}</p>}
        {unknownCount > 0 && <p className={styles.warning} role="alert">{t(`${unknownCount} 个会话缺少可识别的活动状态。请核对服务端与客户端兼容性；未知状态绝不视为空闲，且不能停止。`, `${unknownCount} sessions have an unrecognized activity status. Check server/client compatibility; unknown never means idle and cannot be stopped.`)}</p>}
        {board.loadedAt && <p className={styles.snapshot} role="status">{stale ? t("过期快照时间：", "Stale snapshot at: ") : t("最近读取：", "Last read: ")}<time dateTime={board.loadedAt}>{formatDate(board.loadedAt)}</time></p>}
        {!board.loading && !board.error && !rows.length && <p role="status">{t("没有未归档会话。可前往 Chat 新建会话。", "No unarchived sessions. Go to Chat to create one.")}</p>}
        {!board.loading && rows.length > 0 && !filtered.length && <p role="status">{t("没有匹配的会话，请调整或清除筛选。", "No matching sessions. Adjust or clear the filters.")}</p>}
      </div>
      <div ref={boardElement} className={boardStyles.workArea} data-stale={stale || undefined} aria-busy={board.loading || board.refreshing}>
        <div className={`${boardStyles.viewport} ${common.viewport}`} role="region" aria-label={t("运行看板，可横向滚动", "Run board, horizontally scrollable")} tabIndex={0}>
          <Board<Row> className={`${boardStyles.board} ${common.board} ${styles.board}`} groups={groups} items={filtered} queryKey="agent-live-runs" manualOrder={false} getItemId={row => row.thread.remoteId} getItemLabel={row => row.title} getGroupIcon={status => <span className={common.statusDot} data-status={status} aria-hidden="true" />} renderItem={(row, group) => {
            const timestamp = row.thread.lastMessageAt || row.thread.createdAt
            const label = row.thread.lastMessageAt ? t("消息", "Message") : t("创建", "Created")
            return <AgentRunCard id={row.thread.remoteId} title={row.title} provider={row.provider} model={row.model} folder={row.folder} branch={row.branch || undefined} status={row.activity.column} statusLabel={group.label} metadata={`${label} ${formatDate(timestamp, true)}`} metadataLabel={`${label}: ${formatDate(timestamp)}`} metadataDateTime={Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined} step={row.branch ? `${activityLabel(row.activity, t)} · ${row.branch}` : activityLabel(row.activity, t)} previewLabel={`${t("查看会话运行", "View session run")}: ${row.title}${stale ? t("（过期快照）", " (stale snapshot)") : ""}`} onOpen={trigger => { opener.current = trigger; updateSelection({ selectedId: row.thread.remoteId }); setOutputRevision(value => value + 1) }} />
          }} />
        </div>
      </div>
    </PmPage>
    </div>
    {selectedId !== null && <RunExecutionDock title={selected?.title || (board.loading ? t("正在读取会话", "Loading session") : t("会话不可用", "Session unavailable"))} onClose={close}>
      <div className={styles.detail}>
        {!selected ? <><p role={board.loading ? "status" : "alert"}>{board.loading ? t("正在按此地址核对授权会话，请稍候。", "Checking the exact session in this address against the authorized list.") : board.error ? t("会话列表读取失败或访问已失效，无法确认此会话。没有改选其他会话；请刷新或关闭面板。", "The session list failed or access expired, so this session cannot be verified. No other session was selected; refresh or close the panel.") : t("此会话不在当前授权的未归档列表中，可能已归档、删除或当前不可访问。没有改选其他会话；关闭面板会保留原筛选。", "This session is absent from the authorized unarchived list; it may be archived, deleted or inaccessible. No other session was selected; closing preserves the filters.")}</p><Button size="sm" variant="outline" disabled={board.loading || board.refreshing} onClick={() => void refresh()}>{t("刷新核对", "Refresh to reconcile")}</Button></> : <>
          <p className={styles.sessionStatus} role="status">{activityLabel(selected.activity, t)}</p>
          <div className={common.detailActions}>
            <Button size="sm" render={<Link to={sessionHref!} />}><MessageSquare aria-hidden="true" />{selected.activity.column === "waiting" || selected.activity.column === "attention" ? t("在 Chat 处理", "Respond in Chat") : t("打开 Chat", "Open Chat")}</Button>
            <Button size="sm" variant="outline" disabled={stopDisabled || pending} onClick={() => void stop()}>{pending ? t("正在停止…", "Stopping…") : t("停止生成", "Stop generation")}</Button>
            <Button size="sm" variant="ghost" aria-label={t("刷新运行输出", "Refresh run output")} disabled={history.loading || board.refreshing || pending} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /></Button>
            {terminalHref && <Button size="sm" variant="ghost" render={<Link to={terminalHref} />}><Terminal size={14} aria-hidden="true" />{t("打开独立终端", "Open separate terminal")}</Button>}
          </div>
          {stale && <p className={styles.warning} role="alert">{t("当前为过期列表快照；停止与输出已禁用，请刷新核对。", "The list is a stale snapshot. Stop and output are disabled; refresh to reconcile.")}</p>}
          {selected.activity.status === "unknown" && <p className={styles.warning} role="alert">{t("服务端状态未知或不兼容，不能停止此会话。", "The server status is unknown or incompatible; this session cannot be stopped.")}</p>}
          {action && <p className={action.status === "uncertain" ? styles.warning : common.detailNote} role={action.status === "uncertain" ? "alert" : "status"}>{action.status === "pending" ? t("正在对已核验的生成提交一次停止请求并重新读取状态。", "Submitting one stop request for the verified generation and rereading its state.") : action.status === "uncertain" ? t("停止结果未确认，未自动重发。请刷新，核对原生成后再操作。", "Stop outcome is unconfirmed and was not resent. Refresh and reconcile the original generation before another action.") : t("已重新读取并确认这一代生成不再活动；不代表业务任务完成。", "A fresh read confirmed this generation is no longer active; this is not business task completion.")}</p>}
          <div className={styles.detailTabs} role="tablist" aria-label={t("会话运行视图", "Session run views")}>{([["output", t("执行输出", "Execution output")], ["history", t("已保存对话", "Saved conversation")], ["diagnostics", t("运行信息", "Run information")]] as const).map(([tab, label]) => <Button key={tab} size="sm" variant={detailTab === tab ? "secondary" : "ghost"} role="tab" aria-selected={detailTab === tab} onClick={() => setDetailView({ threadId: selectedId, tab })}>{label}</Button>)}</div>
          {detailTab === "diagnostics" && <>
            <dl className={common.facts}>{[
              ["Session", selected.thread.remoteId],
              ["Provider", generationProviderLabel || t("未知", "Unknown")],
              [t("模型", "Model"), generationModelLabel || t("未知", "Unknown")],
              [t("文件夹", "Folder"), selected.folder],
              [t("来源路径", "Source path"), selected.path || t("未提供", "Not provided")],
              [t("执行路径（已核验）", "Execution path (verified)"), execution.environment?.executionPath || t("未核验代码环境", "Code environment not verified")],
              [t("Worktree 分支", "Worktree branch"), selected.branch || t("未提供", "Not provided")],
              [t("最近消息时间", "Last message at"), selected.thread.lastMessageAt ? formatDate(selected.thread.lastMessageAt) : t("尚无消息", "No messages yet")],
              [t("创建时间", "Created at"), formatDate(selected.thread.createdAt)],
              [t("当前 / 最近生成", "Current / latest generation"), currentGenerationId || (!history.error && history.data ? t("尚无生成记录", "No generation record") : t("尚未核对", "Not yet verified"))],
              [t("生成状态", "Generation status"), history.loading ? t("正在核对", "Reconciling") : generationState === "never-started" ? t("尚未开始生成", "No generation started") : generationState === "unknown" ? t("未确认，请刷新核对", "Unconfirmed; refresh to reconcile") : generationLabel(generationState, t)],
              ...(consistent && generation && !history.loading ? [[t("生成创建时间", "Generation created at"), formatDate(generation.createdAt)]] : []),
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            <p className={common.detailNote}>{t("终端是已核验会话目录中的独立 Shell，不是模型输出。只有明确点击“打开独立终端”才打开；手动命令不会更新 generation 或 Issue 状态。", "A terminal is a separate shell in the verified Session folder, not model output. It opens only through Open separate terminal; manual commands never update generation or Issue status.")}</p>
            {!terminalHref && <p className={common.detailNote} role="status">{execution.loading ? t("正在核验原会话执行环境，终端暂不可用。", "Validating the original Session environment; terminal unavailable for now.") : expectedWorkspaceId === null ? t("仅对话会话没有代码终端。", "Chat-only sessions have no code terminal.") : t("原代码目录不可用、未核验或身份不一致。不会回退到其他目录。", "The original code folder is unavailable, unverified or mismatched. No other folder is substituted.")}</p>}
            {execution.error && <p className={styles.warning} role="alert">{execution.error}</p>}
            {!target && selected.activity.active && !history.loading && <p className={common.detailNote}>{t("尚未核对到一致的活动生成标识，停止不可用。请刷新或在 Chat 核对。", "A consistent active generation ID has not been verified; stop is unavailable. Refresh or inspect in Chat.")}</p>}
            {action && <p className={common.detailNote}>{t("原停止生成：", "Original stop generation: ")}<code>{action.generationId}</code></p>}
          </>}
          {detailTab !== "diagnostics" && <>
            {history.loading && <p role="status">{t("正在核对输出引用…", "Checking output references…")}</p>}
            {history.error && <p className={styles.warning} role="alert">{t("会话历史读取失败或访问已失效。输出已隐藏，请刷新核对。", "Session history could not be read or access expired. Output is hidden; refresh to reconcile.")}</p>}
            {!board.error && !history.error && history.data && <>
              {detailTab === "history" ? <><p className={common.detailNote}>{t("当前分支已保存消息，不是实时终端；正在生成的输出可能尚未保存。", "Saved messages in the current branch, not a live terminal. In-progress output may not be saved yet.")}</p><RunBoardHistoryOutput history={history.data} /></> : !consistent ? <p className={styles.warning} role="status">{t("列表与历史的生成标识尚未同步，执行输出已隐藏；请刷新核对。", "The list and history generation IDs are not synchronized. Execution output is hidden; refresh to reconcile.")}</p> : nativeAvailable && currentGenerationId ? <><p className={common.detailNote}>{t("原生运行项 · 只读。审批和回答请在原 Chat 处理；模型输出不是独立终端。", "Native run items · read-only. Handle approvals and answers in the original Chat; model output is not a separate terminal.")}</p><RunBoardNativeOutput key={`${selectedId}:${currentGenerationId}:${outputRevision}`} threadId={selected.thread.remoteId} generationId={currentGenerationId} sessionHref={sessionHref!} onUnavailable={() => { void board.refresh(); void history.refresh() }} /></> : <><p className={common.detailNote} role="status">{t("此会话尚无原生生成引用。可查看已保存对话作为历史回退，但它不是工具执行或终端证据。", "This Session has no native generation reference. Saved conversation is available as a history fallback, not as tool-execution or terminal evidence.")}</p><Button size="sm" variant="outline" onClick={() => setDetailView({ threadId: selectedId, tab: "history" })}>{t("查看已保存对话", "View saved conversation")}</Button></>}
              {consistent && generation?.error && !history.loading && <p className={styles.warning} role="alert">{t("服务端报告了生成错误；请在原 Chat 核对，错误载荷未展示。", "The server reported a generation error. Inspect in the original Chat; its error payload is not displayed.")}</p>}
            </>}
          </>}
        </>}
      </div>
    </RunExecutionDock>}
    <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
      <DialogContent className={styles.newSession}>
        <DialogHeader><DialogTitle>{t("新建会话", "New session")}</DialogTitle><DialogDescription>{t("明确选择已登记的 Agent 文件夹、打开服务器文件夹，或仅对话。只打开新会话，不发送模型消息；终端仅在显式选择后打开，不执行命令。", "Explicitly choose a registered Agent folder, open a server folder, or chat only. Opening a new session does not send a model message; terminal opens only by explicit choice and no commands are sent.")}</DialogDescription></DialogHeader>
        {board.loading && <p className={common.detailNote} role="status">{t("正在读取已登记文件夹…", "Reading registered folders…")}</p>}
        <div className={styles.newFolderActions}><label className={styles.newFolderLabel}>{t("会话文件夹", "Session folder")}<RadixSelect aria-label={t("新会话的 Agent 文件夹", "Agent folder for the new session")} value={newFolder} onChange={event => setNewFolder(event.target.value)}><option value="">{t("请选择文件夹或仅对话", "Choose a folder or chat only")}</option><option value="chat-only">{t("仅对话 · 不使用代码目录", "Chat only · no code folder")}</option>{newWorkspaceOptions.filter(workspace => !workspace.archivedAt).map(workspace => <option key={workspace.id} value={`folder:${workspace.id}`} disabled={workspace.status !== "available"}>{workspace.name} · {workspace.path}{workspace.status !== "available" ? ` · ${workspace.reason || t("不可用", "Unavailable")}` : ""}</option>)}</RadixSelect></label><Button type="button" variant="outline" disabled={openingFolder} onClick={() => { setNewSessionOpen(false); setOpeningFolder(true) }}><FolderPlus aria-hidden="true" />{t("打开其他文件夹", "Open another folder")}</Button></div>
        {newWorkspace && <p className={styles.newFolderPath}>{newWorkspace.path}</p>}
        {!newChatOnly && (board.metadataError || board.error) && <p className={styles.warning} role="alert">{t("文件夹列表尚未取得最新可用状态，请刷新后重新核对；也可明确选择仅对话或打开服务器文件夹。", "The folder list has not been verified as current. Refresh and review it, or explicitly select chat only / open a server folder.")}</p>}
        {newChatOnly && <p className={common.detailNote}>{t("仅对话不提供代码终端。", "Chat-only sessions do not provide a code terminal.")}</p>}
        {!board.loading && !newWorkspaceOptions.some(workspace => !workspace.archivedAt && workspace.status === "available") && <p className={common.detailNote}>{t("没有可用的已登记文件夹。可在此打开服务器文件夹，或先选择仅对话。", "No registered folder is available. Open a server folder here, or start chat only.")}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewSessionOpen(false)}>{t("取消", "Cancel")}</Button>
          {newChatHref ? <Button render={<Link to={newChatHref} />}><MessageSquare aria-hidden="true" />{t("在 Chat 开始", "Start in Chat")}</Button> : <Button disabled><MessageSquare aria-hidden="true" />{t("在 Chat 开始", "Start in Chat")}</Button>}
          {newTerminalHref ? <Button variant="outline" render={<Link to={newTerminalHref} />}><Terminal aria-hidden="true" />{t("在终端开始", "Start in terminal")}</Button> : <Button variant="outline" disabled><Terminal aria-hidden="true" />{t("在终端开始", "Start in terminal")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {openingFolder && <OpenFolderDialog onClose={() => { setOpeningFolder(false); setNewSessionOpen(true) }} onOpened={workspace => {
      setOpenedWorkspace(workspace)
      setNewFolder(`folder:${workspace.id}`)
      setOpeningFolder(false)
      setNewSessionOpen(true)
      void board.refresh()
    }} />}
  </div>
}

import { useEffect, useId, useRef, useState } from "react"
import { Link, useLocation, useNavigationType, useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight, CircleAlert, Columns3, FolderPlus, Keyboard, List, MessageSquare, MoreHorizontal, Plus, RefreshCw, Terminal } from "lucide-react"
import type { AgentWorkspace, RemoteThread } from "@agent-workspace/contracts/chat"
import type { ProviderInstance } from "@agent-workspace/contracts/provider"
import type { ChatDefaultsResponse } from "@agent-workspace/contracts/settings"
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
import { workspaceClient } from "../network"
import { RunExecutionDock, useKeepRunCardVisible } from "./run-execution-dock"
import { TerminalDrawer } from "./terminal-drawer"
import { RunBoardTerminal } from "./run-board-terminal"
import { verifiedSessionTerminalTarget } from "./execution-terminal-selection"
import { OpenFolderDialog } from "./execution-workspace"
import { useRunBoard, useRunBoardAccessError, useRunBoardExecution, useRunBoardHistory } from "./run-board-data"
import { readRunBoardSelection, isRunBoardAttentionColumn, isRunBoardFolderScopeValid, nextRunBoardKeyboardTarget, readRunBoardFolderScope, runBoardActivity, runBoardGenerationFacts, runBoardTerminalWorkspace, updateRunBoardSelection, writeRunBoardFolderScope, type RunBoardActivity, type RunBoardSelection } from "./run-board-model"
import { runBoardChatHref, safeRunBoardReturn } from "./run-board-navigation"
import { useRunBoardConversationHost } from "./run-board-conversation"
import { RunBoardActionsDialog } from "./run-board-actions"
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
  const updateSelectionRef = useRef(updateSelection)
  updateSelectionRef.current = updateSelection
  const rememberedScope = useRef(readRunBoardFolderScope())
  const initialScopePending = useRef(!params.has("folder") && rememberedScope.current !== "")
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const showNotice = (value: string) => {
    setNotice(value)
    if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2_600)
  }
  useEffect(() => () => { if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current) }, [])
  useEffect(() => {
    if (!initialScopePending.current) return
    initialScopePending.current = false
    updateSelectionRef.current({ folder: rememberedScope.current }, true)
  }, [])
  const returnLocation = query === urlQuery ? `${location.pathname}${location.search}`
    : `${location.pathname}?${updateRunBoardSelection(params, { query })}`
  const returnTo = safeRunBoardReturn(returnLocation)
    || safeRunBoardReturn(`/agent/runs?${updateRunBoardSelection(new URLSearchParams(), { query, folder, provider, attention, selectedId })}`)
    || "/agent/runs?view=sessions"
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newFolder, setNewFolder] = useState("")
  const [openedWorkspace, setOpenedWorkspace] = useState<AgentWorkspace | null>(null)
  const [openingFolder, setOpeningFolder] = useState(false)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [chatDefaults, setChatDefaults] = useState<ChatDefaultsResponse | null>(null)
  const [defaultsError, setDefaultsError] = useState<string | null>(null)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [layout, setLayout] = useState<"board" | "list">(() => {
    try {
      const stored = localStorage.getItem("pm-v4:run-board-layout")
      if (stored === "board" || stored === "list") return stored
    } catch { /* Layout memory is optional. */ }
    return typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches ? "list" : "board"
  })
  const [terminalHeight, setTerminalHeight] = useState(() => {
    try {
      const value = Number(localStorage.getItem("pm-v4:run-board-terminal-height"))
      return Number.isFinite(value) && value >= 300 ? Math.min(720, value) : 340
    } catch { return 340 }
  })
  const [stopActions, setStopActions] = useState<Record<string, StopAction>>({})
  const opener = useRef<HTMLButtonElement | null>(null)
  const refreshButton = useRef<HTMLButtonElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const boardElement = useRef<HTMLDivElement | null>(null)
  const rows = board.threads.filter(thread => thread.status === "regular").map(thread => rowForThread(thread, board.workspaces, board.providers, t))
  const selected = rows.find(row => row.thread.remoteId === selectedId)
  const setConversationHost = useRunBoardConversationHost()
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
  const scoped = rows.filter(row => (!folder || folder === row.folderId) && (!provider || provider === row.providerId))
  const attentionCount = scoped.filter(row => isRunBoardAttentionColumn(row.activity.column)).length
  const filtered = scoped.filter(row => (!attention || isRunBoardAttentionColumn(row.activity.column))
    && (!search || [row.thread.remoteId, row.title, row.folder, row.path || "", row.branch || "", row.provider, row.providerId, row.model].some(value => value.toLocaleLowerCase().includes(search))))
  useKeepRunCardVisible(boardElement, selected && filtered.includes(selected) ? selected.thread.remoteId : null)
  const scopeCounts = new Map<string, number>()
  for (const row of rows) scopeCounts.set(row.folderId, (scopeCounts.get(row.folderId) ?? 0) + 1)
  const scopeLabels = new Map<string, string>([["", t("全部看板", "All boards")], ["chat-only", t("仅对话", "Chat only")]])
  for (const workspace of board.workspaces) if (!workspace.archivedAt) scopeLabels.set(`folder:${workspace.id}`, workspace.name)
  for (const row of rows) if (!scopeLabels.has(row.folderId)) scopeLabels.set(row.folderId, row.folder)
  const scopeOptions = [...scopeLabels].map(([value, label]) => ({ value, label, count: scopeCounts.get(value) ?? 0 }))
  const providerOptions = [...new Map(rows.map(row => [row.providerId, row.provider])).entries()].filter(([id]) => !!id).sort((a, b) => a[1].localeCompare(b[1], locale))
  const unknownCount = scoped.filter(row => row.activity.column === "unknown").length
  const visibleColumns = columns.filter(column => column !== "unknown" || unknownCount > 0)
  const groups: GroupSnapshot[] = visibleColumns.map(column => {
    const itemIds = filtered.filter(row => row.activity.column === column).map(row => row.thread.remoteId)
    return { key: column, label: columnLabel(column, t), itemIds, loadedCount: itemIds.length, totalCount: itemIds.length, dataState: "success", queryKey: "agent-live-runs" }
  })
  const keyboardRows = groups.flatMap(group => group.itemIds.map(id => ({ id, column: group.key as RunBoardActivity["column"] })))
  const keyboardColumns = visibleColumns.filter(column => groups.some(group => group.key === column && group.itemIds.length > 0))
  const selectedKeyboardIndex = keyboardRows.findIndex(row => row.id === selectedId)
  const previousSessionId = selectedKeyboardIndex > 0 ? keyboardRows[selectedKeyboardIndex - 1]?.id : undefined
  const nextSessionId = selectedKeyboardIndex >= 0 ? keyboardRows[selectedKeyboardIndex + 1]?.id : keyboardRows[0]?.id
  useEffect(() => {
    if (!folder || !board.metadataLoadedAt || board.metadataError) return
    if (isRunBoardFolderScopeValid(folder, board.workspaces)) return
    updateSelectionRef.current({ folder: "" }, true)
    writeRunBoardFolderScope("")
  }, [folder, board.metadataLoadedAt, board.metadataError, board.workspaces])
  const hasFilters = !!query || !!folder || !!provider || attention
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })
  const cardDateFormatter = new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
  const formatDate = (value: string | null | undefined, short = false) => {
    if (!value || !Number.isFinite(Date.parse(value))) return t("时间未知", "Time unknown")
    return (short ? cardDateFormatter : dateFormatter).format(new Date(value))
  }
  const { generation, consistent } = runBoardGenerationFacts(selected?.thread ?? null, history.error ? null : history.data)
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
  const terminalTarget = selected && expectedWorkspaceId !== null && terminalWorkspace && execution.environment
    ? verifiedSessionTerminalTarget(selected.thread.remoteId, selected.thread.executionSelection, execution.environment, terminalWorkspace, expectedWorkspaceId) : null
  const terminalAvailable = !!terminalTarget
  useEffect(() => { setTerminalOpen(false) }, [selectedId])
  useEffect(() => {
    if (!terminalAvailable) setTerminalOpen(false)
  }, [terminalAvailable])
  useEffect(() => {
    try { localStorage.setItem("pm-v4:run-board-terminal-height", String(Math.round(terminalHeight))) } catch { /* The drawer still works without persistence. */ }
  }, [terminalHeight])
  useEffect(() => {
    try { localStorage.setItem("pm-v4:run-board-layout", layout) } catch { /* Layout memory is optional. */ }
  }, [layout])
  const selectedNewSessionHref = selected && expectedWorkspaceId !== undefined
    ? runBoardChatHref({ agentWorkspaceId: expectedWorkspaceId, returnTo }) : null
  const newWorkspaceOptions = [...board.workspaces, ...(openedWorkspace && !board.workspaces.some(workspace => workspace.id === openedWorkspace.id) ? [openedWorkspace] : [])]
  const newWorkspace = newWorkspaceOptions.find(workspace => `folder:${workspace.id}` === newFolder)
  const newChatOnly = newFolder === "chat-only"
  const newSelectionReady = newChatOnly || !!newWorkspace && newWorkspace.status === "available"
    && !newWorkspace.archivedAt && (openedWorkspace?.id === newWorkspace.id || !board.error && !board.metadataError && !board.loading)
  const newChatHref = newSelectionReady ? runBoardChatHref({ agentWorkspaceId: newChatOnly ? null : newWorkspace!.id, returnTo }) : null
  const newTerminalHref = newSelectionReady && newWorkspace && !newChatOnly
    ? runBoardChatHref({ agentWorkspaceId: newWorkspace.id, terminal: true, returnTo }) : null
  const defaultSelection = chatDefaults?.defaults.selection
  const defaultProvider = defaultSelection ? board.providers.find(item => item.instanceId === defaultSelection.providerInstanceId) : undefined
  const defaultModel = defaultProvider?.models.find(item => item.id === defaultSelection?.model || item.aliases?.includes(defaultSelection?.model ?? ""))
  const defaultProviderLabel = defaultSelection ? defaultProvider ? getProviderInstanceDisplayName(defaultProvider) : defaultSelection.providerInstanceId : null
  const defaultModelLabel = defaultSelection ? defaultModel && defaultProvider ? getProviderModelShortName(defaultProvider.driver, defaultModel) || defaultModel.label : defaultSelection.model : null
  useEffect(() => {
    if (!newSessionOpen) return
    const controller = new AbortController()
    setDefaultsError(null)
    void board.refreshMetadata()
    void workspaceClient.json<ChatDefaultsResponse>("/api/settings/chat-defaults", { signal: controller.signal, cache: "no-store" })
      .then(data => { if (!controller.signal.aborted) setChatDefaults(data) })
      .catch(cause => {
        if (controller.signal.aborted) return
        setChatDefaults(null)
        setDefaultsError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [newSessionOpen])

  const refresh = async () => {
    setStopActions(previous => Object.fromEntries(Object.entries(previous).map(([id, action]) => [id, action.status === "uncertain" ? { ...action, snapshot: board.threads, recheck: true } : action])))
    await Promise.all([board.refreshAll(), history.refresh(), execution.refresh()])
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
  const selectCard = (id: string) => {
    updateSelection({ selectedId: id })
    requestAnimationFrame(() => boardElement.current?.querySelector<HTMLButtonElement>(`[data-agent-run="${CSS.escape(id)}"]`)?.focus())
  }
  const openActionsFor = (id: string | null) => {
    if (!id) { showNotice(t("先选择一个会话。", "Select a session first.")); return }
    setActionsFor(id)
    if (id !== selectedId) updateSelection({ selectedId: id })
  }
  const closeActions = () => {
    const id = actionsFor
    setActionsFor(null)
    if (id) requestAnimationFrame(() => boardElement.current?.querySelector<HTMLButtonElement>(`[data-agent-run="${CSS.escape(id)}"]`)?.focus())
  }
  const quickStart = () => {
    const remembered = readRunBoardFolderScope()
    const candidate = folder && isRunBoardFolderScopeValid(folder, board.workspaces) ? folder : remembered
    setOpenedWorkspace(null)
    setNewFolder(candidate && isRunBoardFolderScopeValid(candidate, board.workspaces) ? candidate : "")
    setNewSessionOpen(true)
    void board.refreshMetadata()
  }
  const copySelectedId = () => {
    if (!selected) return
    void navigator.clipboard.writeText(selected.thread.remoteId)
      .then(() => showNotice(t("已复制会话 ID。", "Session ID copied.")))
      .catch(() => showNotice(t("无法复制会话 ID。", "Could not copy the Session ID.")))
  }
  const handleBoardKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='combobox'], [role='listbox'], [role='menu'], [role='option'], [data-terminal-surface], .xterm")) return
    if (document.querySelector('[role="dialog"]')) return
    if (event.key === "j" || event.key === "k" || event.key === "h" || event.key === "l") {
      const next = nextRunBoardKeyboardTarget(keyboardRows, keyboardColumns, selectedId, event.key)
      if (!next) return
      event.preventDefault()
      selectCard(next)
      return
    }
    switch (event.key) {
      case "Enter": {
        const next = selectedId ?? nextRunBoardKeyboardTarget(keyboardRows, keyboardColumns, null, "j")
        if (!next) return
        event.preventDefault()
        selectCard(next)
        return
      }
      case "Escape":
        if (!selectedId) return
        event.preventDefault()
        close()
        return
      case "m": event.preventDefault(); openActionsFor(selectedId); return
      case "c": event.preventDefault(); quickStart(); return
      case "y": event.preventDefault(); copySelectedId(); return
      case "r": event.preventDefault(); void refresh(); return
      case "/": event.preventDefault(); searchInput.current?.focus(); return
      case "?": event.preventDefault(); setShortcutsOpen(true); return
    }
  }
  const handleBoardKeyRef = useRef(handleBoardKey)
  handleBoardKeyRef.current = handleBoardKey
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleBoardKeyRef.current(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  const renderRunCard = (row: Row, statusLabel: string) => {
    const timestamp = row.thread.lastMessageAt || row.thread.createdAt
    const label = row.thread.lastMessageAt ? t("消息", "Message") : t("创建", "Created")
    return <div className={styles.cardSlot} data-selected={selectedId === row.thread.remoteId || undefined}>
      <AgentRunCard id={row.thread.remoteId} title={row.title} provider={row.provider} model={row.model} folder={row.folder} branch={row.branch || undefined} status={row.activity.column} statusLabel={statusLabel} metadata={`${label} ${formatDate(timestamp, true)}`} metadataLabel={`${label}: ${formatDate(timestamp)}`} metadataDateTime={Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined} step={row.branch ? `${activityLabel(row.activity, t)} · ${row.branch}` : activityLabel(row.activity, t)} previewLabel={`${t("查看会话运行", "View session run")}: ${row.title}${stale ? t("（过期快照）", " (stale snapshot)") : ""}`} onOpen={trigger => { opener.current = trigger; updateSelection({ selectedId: row.thread.remoteId }) }} />
      <button type="button" className={styles.cardMenu} aria-label={`${t("会话操作", "Session actions")}: ${row.title}`} title={t("会话操作 (m)", "Session actions (m)")} onClick={event => { event.stopPropagation(); openActionsFor(row.thread.remoteId) }}><MoreHorizontal aria-hidden="true" /></button>
    </div>
  }
  const rowById = new Map(filtered.map(row => [row.thread.remoteId, row]))

  return <div className={styles.workspace}>
    <div className={styles.boardColumn}>
    <div className={`${common.root} ${styles.page}`} data-testid="agent-run-board">
    <PmPage pageId="agent-run-board" className={boardStyles.root} contentClassName={common.content} title={t("运行面板", "Run board")} titleSuffix={attentionCount > 0 ? <span className={styles.attentionBadge} title={t(`${attentionCount} 个会话需要处理`, `${attentionCount} sessions need attention`)}>{attentionCount}</span> : undefined}
      actions={<div className={styles.pageActions}><Link className={styles.viewLink} to="/agent/runs?view=business">{t("业务执行（PM）", "Business Runs (PM)")}</Link>{(attentionCount > 0 || attention) && <Button size="sm" variant={attention ? "secondary" : "outline"} aria-pressed={attention} onClick={() => updateSelection({ attention: !attention }, true)}><CircleAlert aria-hidden="true" />{t("需要处理", "Needs attention")} {attentionCount}</Button>}<Button size="sm" variant="ghost" aria-label={t("快捷键", "Keyboard shortcuts")} title={t("快捷键 (?)", "Keyboard shortcuts (?)")} onClick={() => setShortcutsOpen(true)}><Keyboard aria-hidden="true" /></Button><Button ref={refreshButton} size="sm" variant="outline" disabled={board.loading || board.refreshing} onClick={() => void refresh()}><RefreshCw className={board.refreshing ? styles.refreshing : undefined} aria-hidden="true" />{board.refreshing ? t("刷新中…", "Refreshing…") : t("刷新", "Refresh")}</Button><Button size="sm" onClick={() => { setNewFolder(""); setOpenedWorkspace(null); setNewSessionOpen(true); void board.refreshMetadata() }}><Plus aria-hidden="true" />{t("新建会话", "New session")}</Button></div>}
      toolbar={<FilterToolbar className={workItemStyles.toolbar} label={t("筛选会话运行", "Filter session runs")}
        search={<><Segmented value={layout} onValueChange={value => { if (value === "board" || value === "list") setLayout(value) }} aria-label={t("运行展示方式", "Run layout")}><SegmentedItem value="board" className={common.layoutLabel}><Columns3 size={14} aria-hidden="true" />{t("看板", "Board")}</SegmentedItem><SegmentedItem value="list" className={common.layoutLabel}><List size={14} aria-hidden="true" />{t("列表", "List")}</SegmentedItem></Segmented><Input ref={searchInput} className={common.search} type="search" aria-label={t("搜索会话、文件夹或分支", "Search sessions, folders or branches")} placeholder={t("搜索会话、文件夹、分支…", "Search sessions, folders, branches…")} value={query} onChange={event => updateSelection({ query: event.target.value }, true)} /></>}
        filters={<><RadixSelect className={common.select} aria-label={t("看板范围", "Board scope")} value={folder} onChange={event => { const value = event.target.value; updateSelection({ folder: value }, true); writeRunBoardFolderScope(value) }}><option value="">{t("全部看板", "All boards")} ({rows.length})</option>{folder && !scopeOptions.some(option => option.value === folder) && <option value={folder}>{folder} · {t("不在当前列表", "Not in current list")}</option>}{scopeOptions.filter(option => option.value !== "").map(option => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}</RadixSelect><RadixSelect className={common.select} aria-label={t("筛选 Provider", "Filter providers")} value={provider} onChange={event => updateSelection({ provider: event.target.value }, true)}><option value="">{t("全部 Provider", "All providers")}</option>{provider && !providerOptions.some(([id]) => id === provider) && <option value={provider}>{provider} · {t("不在当前列表", "Not in current list")}</option>}{providerOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</RadixSelect><label className={common.attentionFilter}><Checkbox checked={attention} onCheckedChange={value => updateSelection({ attention: value }, true)} />{t("需要我处理", "Needs my attention")}</label></>}
        actions={<>{hasFilters && <Button variant="ghost" onClick={() => { updateSelection({ query: "", folder: "", provider: "", attention: false }, true); writeRunBoardFolderScope("") }}>{t("清除筛选", "Clear filters")}</Button>}<span className={common.total} aria-live="polite">{filtered.length} / {rows.length} {t("个会话", "sessions")}</span></>} />}
    >
      <div className={styles.notices}>
        {notice && <p role="status">{notice}</p>}
        {board.loading && <p role="status">{t("正在读取会话运行…", "Loading session runs…")}</p>}
        {board.error && <p className={styles.warning} role="alert">{stale ? t("刷新失败；保留卡片为过期快照，停止操作已禁用。", "Refresh failed; retained cards are a stale snapshot and stop actions are disabled.") : t("无法读取会话或访问权限已失效。未显示缓存内容，请刷新或重新登录 Agent。", "Sessions cannot be read or access has expired. No cached content is shown; refresh or sign in to Agent again.")}</p>}
        {board.metadataError && <p className={styles.warning} role="status">{t("文件夹或 Provider 元数据未能刷新；会话列表单独显示，缺失项保留真实标识，不推断归属。", "Folder or provider metadata could not refresh. Sessions are shown separately; missing metadata keeps its real identifier without inferring ownership.")}</p>}
        {unknownCount > 0 && <p className={styles.warning} role="alert">{t(`${unknownCount} 个会话缺少可识别的活动状态。请核对服务端与客户端兼容性；未知状态绝不视为空闲，且不能停止。`, `${unknownCount} sessions have an unrecognized activity status. Check server/client compatibility; unknown never means idle and cannot be stopped.`)}</p>}
        {board.loadedAt && <p className={styles.snapshot} role="status">{stale ? t("过期快照时间：", "Stale snapshot at: ") : t("最近读取：", "Last read: ")}<time dateTime={board.loadedAt}>{formatDate(board.loadedAt)}</time></p>}
        {!board.loading && !board.error && !rows.length && <p role="status">{t("没有未归档会话。可前往 Chat 新建会话。", "No unarchived sessions. Go to Chat to create one.")}</p>}
        {!board.loading && rows.length > 0 && !filtered.length && <p role="status">{t("没有匹配的会话，请调整或清除筛选。", "No matching sessions. Adjust or clear the filters.")}</p>}
      </div>
      <div ref={boardElement} className={boardStyles.workArea} data-stale={stale || undefined} aria-busy={board.loading || board.refreshing}>
        {layout === "board" ? <div className={`${boardStyles.viewport} ${common.viewport}`} role="region" aria-label={t("运行看板，可横向滚动", "Run board, horizontally scrollable")} tabIndex={0}>
          <Board<Row> className={`${boardStyles.board} ${common.board} ${styles.board}`} groups={groups} items={filtered} queryKey="agent-live-runs" manualOrder={false} getItemId={row => row.thread.remoteId} getItemLabel={row => row.title} getGroupIcon={status => <span className={common.statusDot} data-status={status} aria-hidden="true" />} renderItem={(row, group) => renderRunCard(row, group.label)} />
        </div> : <ul className={styles.list} aria-label={t("会话运行列表", "Session run list")}>
          {groups.map(group => <li key={group.key} className={styles.listGroup}>
            <h2 className={styles.listGroupTitle}>{group.label}<span>{group.itemIds.length}</span></h2>
            <ul className={styles.listItems}>{group.itemIds.map(id => { const row = rowById.get(id); return row ? <li key={id}>{renderRunCard(row, group.label)}</li> : null })}</ul>
          </li>)}
        </ul>}
      </div>
    </PmPage>
    </div>
    {terminalOpen && selected && terminalWorkspace && execution.environment && terminalTarget && <TerminalDrawer height={terminalHeight} onHeightChange={setTerminalHeight}><RunBoardTerminal key={selected.thread.remoteId} workspace={terminalWorkspace} threadId={selected.thread.remoteId} environment={execution.environment} onClose={() => setTerminalOpen(false)} /></TerminalDrawer>}
    </div>
    {selectedId !== null && <RunExecutionDock chat title={selected?.title || (board.loading ? t("正在读取会话", "Loading session") : t("会话不可用", "Session unavailable"))} onClose={close}>
      {!selected ? <div className={styles.detail}>
        <p role={board.loading ? "status" : "alert"}>{board.loading ? t("正在按此地址核对授权会话，请稍候。", "Checking the exact session in this address against the authorized list.") : board.error ? t("会话列表读取失败或访问已失效，无法确认此会话。没有改选其他会话；请刷新或关闭面板。", "The session list failed or access expired, so this session cannot be verified. No other session was selected; refresh or close the panel.") : t("此会话不在当前授权的未归档列表中，可能已归档、删除或当前不可访问。没有改选其他会话；关闭面板会保留原筛选。", "This session is absent from the authorized unarchived list; it may be archived, deleted or inaccessible. No other session was selected; closing preserves the filters.")}</p>
        <Button size="sm" variant="outline" disabled={board.loading || board.refreshing} onClick={() => void refresh()}>{t("刷新核对", "Refresh to reconcile")}</Button>
      </div> : <div className={styles.chatDock}>
        <div className={styles.chatDockActions}>
          <p className={styles.sessionStatus} role="status">{activityLabel(selected.activity, t)}</p>
          <div className={common.detailActions}>
            <Button size="sm" variant="ghost" aria-label={t("上一个会话", "Previous session")} title={t("上一个会话", "Previous session")} disabled={!previousSessionId} onClick={() => { if (previousSessionId) selectCard(previousSessionId) }}><ChevronLeft aria-hidden="true" /></Button>
            <Button size="sm" variant="ghost" aria-label={t("下一个会话", "Next session")} title={t("下一个会话", "Next session")} disabled={!nextSessionId} onClick={() => { if (nextSessionId) selectCard(nextSessionId) }}><ChevronRight aria-hidden="true" /></Button>
            <Button size="sm" render={<Link to={sessionHref!} />}><MessageSquare aria-hidden="true" />{selected.activity.column === "waiting" || selected.activity.column === "attention" ? t("在 Chat 处理", "Respond in Chat") : t("打开 Chat", "Open Chat")}</Button>
            <Button size="sm" variant="outline" disabled={stopDisabled || pending} onClick={() => void stop()}>{pending ? t("正在停止…", "Stopping…") : t("停止生成", "Stop generation")}</Button>
            <Button size="sm" variant="ghost" aria-label={t("刷新运行状态", "Refresh run status")} title={t("刷新运行状态", "Refresh run status")} disabled={history.loading || board.refreshing || pending} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" /></Button>
            {terminalTarget && <Button size="sm" variant={terminalOpen ? "secondary" : "outline"} aria-pressed={terminalOpen} onClick={() => setTerminalOpen(value => !value)}><Terminal size={14} aria-hidden="true" />{terminalOpen ? t("隐藏面板终端", "Hide panel terminal") : t("在面板中打开终端", "Open terminal in panel")}</Button>}
            {terminalHref && <Button size="sm" variant="ghost" render={<Link to={terminalHref} />}><Terminal size={14} aria-hidden="true" />{t("在 Chat 打开终端", "Open terminal in Chat")}</Button>}
          </div>
        </div>
        {stale && <p className={styles.warning} role="alert">{t("当前为过期列表快照；停止已禁用，请刷新核对。", "The list is a stale snapshot. Stop is disabled; refresh to reconcile.")}</p>}
        {selected.activity.status === "unknown" && <p className={styles.warning} role="alert">{t("服务端状态未知或不兼容，不能停止此会话。", "The server status is unknown or incompatible; this session cannot be stopped.")}</p>}
        {action && <p className={action.status === "uncertain" ? styles.warning : common.detailNote} role={action.status === "uncertain" ? "alert" : "status"}>{action.status === "pending" ? t("正在对已核验的生成提交一次停止请求并重新读取状态。", "Submitting one stop request for the verified generation and rereading its state.") : action.status === "uncertain" ? t("停止结果未确认，未自动重发。请刷新，核对原生成后再操作。", "Stop outcome is unconfirmed and was not resent. Refresh and reconcile the original generation before another action.") : t("已重新读取并确认这一代生成不再活动；不代表业务任务完成。", "A fresh read confirmed this generation is no longer active; this is not business task completion.")}</p>}
        <div ref={setConversationHost} className={styles.chatDockConversation} />
      </div>}
    </RunExecutionDock>}
    <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
      <DialogContent className={styles.newSession}>
        <DialogHeader><DialogTitle>{t("新建会话", "New session")}</DialogTitle><DialogDescription>{t("明确选择已登记的 Agent 文件夹、打开服务器文件夹，或仅对话。只打开新会话，不发送模型消息；终端仅在显式选择后打开，不执行命令。", "Explicitly choose a registered Agent folder, open a server folder, or chat only. Opening a new session does not send a model message; terminal opens only by explicit choice and no commands are sent.")}</DialogDescription></DialogHeader>
        {(board.loading || board.metadataLoading) && <p className={common.detailNote} role="status">{t("正在读取已登记文件夹…", "Reading registered folders…")}</p>}
        <div className={styles.newFolderActions}><label className={styles.newFolderLabel}>{t("会话文件夹", "Session folder")}<RadixSelect aria-label={t("新会话的 Agent 文件夹", "Agent folder for the new session")} value={newFolder} onChange={event => setNewFolder(event.target.value)}><option value="">{t("请选择文件夹或仅对话", "Choose a folder or chat only")}</option><option value="chat-only">{t("仅对话 · 不使用代码目录", "Chat only · no code folder")}</option>{newWorkspaceOptions.filter(workspace => !workspace.archivedAt).map(workspace => <option key={workspace.id} value={`folder:${workspace.id}`} disabled={workspace.status !== "available"}>{workspace.name} · {workspace.path}{workspace.status !== "available" ? ` · ${workspace.reason || t("不可用", "Unavailable")}` : ""}</option>)}</RadixSelect></label><Button type="button" variant="outline" disabled={openingFolder} onClick={() => { setNewSessionOpen(false); setOpeningFolder(true) }}><FolderPlus aria-hidden="true" />{t("打开其他文件夹", "Open another folder")}</Button></div>
        {newWorkspace && <p className={styles.newFolderPath}>{newWorkspace.path}</p>}
        {newSessionOpen && <p className={common.detailNote}>
          {defaultsError
            ? t("默认执行器读取失败；不阻止创建，Chat 仍会按当前设置校验。", "The default runner could not be read; creation is not blocked and Chat still validates the current settings.")
            : chatDefaults
              ? defaultSelection
                ? t(`默认执行器：${defaultProviderLabel} · ${defaultModelLabel}`, `Default runner: ${defaultProviderLabel} · ${defaultModelLabel}`)
                : t("尚未设置默认模型；创建后可在 Chat 设置中显式选择。", "No default model is set; choose one explicitly in Chat settings after creating.")
              : t("正在读取默认执行器…", "Reading the default runner…")}
          {chatDefaults?.availability.status === "unavailable" && ` · ${chatDefaults.availability.reason || t("默认模型当前不可用。", "The default model is currently unavailable.")}`}
          {!defaultsError && <>{" · "}<Link className={styles.viewLink} to="/agent/settings/general" state={{ settingsReturnTo: returnTo }}>{t("更改默认模型", "Change default model")}</Link></>}
        </p>}
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
      void board.refreshAll()
    }} />}
    {actionsFor && selected && selected.thread.remoteId === actionsFor && sessionHref && <RunBoardActionsDialog title={selected.title} sessionHref={sessionHref} terminalHref={terminalHref} panelTerminal={!!terminalTarget} newSessionHref={selectedNewSessionHref} newSessionChatOnly={expectedWorkspaceId === null} attention={selected.activity.column === "waiting" || selected.activity.column === "attention"} canStop={!!target && !stopDisabled} pending={pending} onStop={() => void stop()} onPanelTerminal={() => { setActionsFor(null); setTerminalOpen(true) }} onCopy={copySelectedId} onRefresh={() => void refresh()} onClose={closeActions} />}
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent className={styles.shortcuts}>
        <DialogHeader><DialogTitle>{t("运行面板快捷键", "Run board shortcuts")}</DialogTitle><DialogDescription>{t("输入框、弹窗或终端聚焦时不触发；卡片按钮仍可用 Tab 访问。", "Shortcuts are ignored while an input, dialog or terminal is focused; cards remain reachable with Tab.")}</DialogDescription></DialogHeader>
        <dl className={styles.shortcutList}>{([
          ["j / k", t("上 / 下一个会话", "Previous / next session")],
          ["h / l", t("上一 / 下一列", "Previous / next column")],
          ["Enter", t("选中当前会话", "Select the current session")],
          ["Esc", t("关闭会话详情", "Close the session detail")],
          ["m", t("会话操作", "Session actions")],
          ["c", t("快速新建会话", "Quick new session")],
          ["y", t("复制会话 ID", "Copy Session ID")],
          ["r", t("刷新", "Refresh")],
          ["/", t("聚焦搜索", "Focus search")],
          ["?", t("快捷键", "Shortcuts")],
        ] as const).map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
        <DialogFooter><Button variant="outline" onClick={() => setShortcutsOpen(false)}>{t("关闭", "Close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

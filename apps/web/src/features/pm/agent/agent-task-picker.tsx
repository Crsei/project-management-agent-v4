import { useCallback, useId, useMemo, useState } from "react"
import { ChevronDown, ClipboardList, Search, X } from "lucide-react"
import type { AgentChatScope } from "@contracts"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useI18n } from "@/lib/i18n-provider"
import { usePmEntities, usePmService } from "../service/pm-service"
import { string, useText } from "../service/pm-ui"
import { agentErrorText } from "./agent-chat-queries"
import { resolveAgentTaskSelection, type AgentTaskSelectionState } from "./agent-task-context"
import chatStyles from "./agent-chat.module.css"
import styles from "./agent-task-picker.module.css"

export type AgentTaskSelection = AgentTaskSelectionState & { reload: () => void }

/** Never resolve a selected task from an earlier, loading, or failed authorization snapshot. */
export function useAgentTaskSelection(taskId: string | null, scope: AgentChatScope | null): AgentTaskSelection {
  const service = usePmService()
  const projectId = scope?.projectIds.length === 1 ? scope.projectIds[0] : undefined
  const taskQuery = usePmEntities("work_item", projectId)
  const projectQuery = usePmEntities("project")
  const pending = service.loading || (!!service.actor && !!service.workspace && !service.error && (taskQuery.isPending || taskQuery.isFetching || projectQuery.isPending || projectQuery.isFetching))
  const error = service.error ?? taskQuery.error ?? projectQuery.error
  const workspace = service.actor ? service.workspace : null
  const selection = useMemo(() => resolveAgentTaskSelection({
    taskId, scope, workspace, tasks: taskQuery.data, projects: projectQuery.data, pending, error,
  }), [taskId, scope, workspace, taskQuery.data, projectQuery.data, pending, error])
  const reload = useCallback(() => {
    if (service.error || !service.actor || !service.workspace) {
      void service.refresh().catch(() => { /* Refresh failures are exposed by the service provider. */ })
      return
    }
    void taskQuery.refetch()
    void projectQuery.refetch()
  }, [service.error, service.actor, service.workspace, service.refresh, taskQuery.refetch, projectQuery.refetch])
  return { ...selection, reload }
}

export function AgentTaskPicker({ taskId, onTaskChange, selection, disabled = false }: {
  taskId: string | null
  onTaskChange: (taskId: string | null) => void
  selection: AgentTaskSelection
  disabled?: boolean
}) {
  const t = useText()
  const en = useI18n().locale === "en"
  const id = useId()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const query = search.trim().toLocaleLowerCase()
  const matches = selection.tasks.filter(task => !query || `${task.id}\n${string(task.data.title)}`.toLocaleLowerCase().includes(query))
  const label = selection.selected
    ? string(selection.selected.data.title) || selection.selected.id
    : taskId !== null
      ? selection.pending ? t("读取任务…", "Loading task…") : t("任务不可用", "Task unavailable")
      : t("选择任务", "Choose task")
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setSearch("") }}>
    <PopoverTrigger asChild>
      <button type="button" className={`${chatStyles.permissionTrigger} ${styles.trigger}`} disabled={disabled} aria-label={`${t("当前消息的任务", "Task for this message")}: ${label}`} aria-busy={selection.pending} title={label} data-unavailable={selection.blocked}>
        <ClipboardList size={14} aria-hidden="true" /><span className={chatStyles.controlLabel}>{label}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" collisionPadding={12} className={`${chatStyles.permissionPopover} ${styles.popover}`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}>
      <div className={styles.heading}>
        <h3 id={`${id}-title`}>{t("当前消息的任务", "Task for this message")}</h3>
        <PopoverClose asChild><button type="button" className={styles.close} aria-label={t("关闭任务选择", "Close task picker")}><X size={15} aria-hidden="true" /></button></PopoverClose>
      </div>
      <p id={`${id}-hint`} className={styles.hint}>{t("消息仅附加任务和项目 ID，不授予权限或发送任务正文；当前数据仍须通过已授权工具读取。", "Messages include only task and project IDs, not task contents or new permissions. Current data still requires authorized tools.")}</p>
      <label className={styles.search}>
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">{t("按任务标题或 ID 搜索", "Search by task title or ID")}</span>
        <input type="search" value={search} autoComplete="off" disabled={disabled || selection.pending || !!selection.error} placeholder={t("搜索任务标题或 ID…", "Search task title or ID…")} onChange={event => setSearch(event.target.value)} />
      </label>
      <fieldset className={styles.options} disabled={disabled} aria-busy={selection.pending}>
        <legend className="sr-only">{t("选择任务或不指定任务", "Choose a task or no task")}</legend>
        <label className={styles.option}>
          <input type="radio" name={`${id}-task`} checked={taskId === null} onChange={() => onTaskChange(null)} />
          <span><strong>{t("不指定任务", "No task")}</strong><small>{t("不在消息中附加任务目标", "Do not attach a task target to the message")}</small></span>
        </label>
        {matches.map(task => <label key={task.id} className={styles.option}>
          <input type="radio" name={`${id}-task`} checked={taskId === task.id} disabled={selection.pending || !!selection.error} onChange={() => onTaskChange(task.id)} />
          <span><strong>{string(task.data.title) || task.id}</strong><small><code>{task.id}</code>{" · "}{t("项目", "Project")} <code>{task.projectId}</code></small></span>
        </label>)}
      </fieldset>
      {selection.pending && <p className={styles.notice} role="status">{t("正在核对可读任务和项目…", "Checking readable tasks and projects…")}</p>}
      {selection.error && <p className={styles.error} role="alert">{agentErrorText(selection.error, en)}</p>}
      {selection.blocked && !selection.pending && <p className={styles.error} role="alert">{t("所选任务当前无法在可读的项目范围内核对。发送前请重试、改选任务或清除选择。", "The selected task cannot currently be verified in the readable project scope. Retry, choose another task, or clear it before sending.")} <code>{taskId}</code></p>}
      {!selection.pending && !selection.error && !matches.length && <p className={styles.notice} role="status">{query ? t("没有匹配的任务。", "No matching tasks.") : t("当前范围内没有可选的未归档任务。", "No unarchived tasks are available in the current scope.")}</p>}
      <button type="button" className={styles.reload} disabled={disabled || selection.pending} onClick={selection.reload}>{t("重新读取任务", "Reload tasks")}</button>
    </PopoverContent>
  </Popover>
}

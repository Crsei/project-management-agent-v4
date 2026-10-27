import { Fragment, useMemo, useState, type FC } from "react"
import { Loader2, Plus, Search, Trash2 } from "lucide-react"
import { ThreadListItemPrimitive, ThreadListPrimitive, useAuiState } from "@assistant-ui/react"
import { useText } from "../service/pm-ui"
import styles from "./agent-chat.module.css"

const startOfLocalDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()

const groupLabel = (value: Date | undefined, today: number): string => {
  if (!value || value.getTime() >= today) return "Today"
  if (value.getTime() >= today - 86_400_000) return "Yesterday"
  return "Earlier"
}

/** Thread list copied from agent-workspace's assistant-ui list, without archive/rename. */
export function AgentThreadList() {
  const t = useText()
  const [search, setSearch] = useState("")
  const hasThreads = useAuiState(state => state.threads.threadIds.length > 0)
  const running = useAuiState(state => state.thread.isRunning)
  return <ThreadListPrimitive.Root className={styles.threadSection}>
    <div className={styles.threadSectionHeader}>
      <ThreadListPrimitive.New asChild>
        <button type="button" className={styles.newThreadButton} data-testid="agent-new-thread" disabled={running}>
          <Plus size={15} aria-hidden="true" />
          {t("新对话", "New chat")}
        </button>
      </ThreadListPrimitive.New>
    </div>
    {hasThreads && <div className={styles.searchBox}>
      <Search aria-hidden="true" />
      <input
        type="search"
        className={styles.searchInput}
        value={search}
        onChange={event => setSearch(event.target.value)}
        aria-label={t("搜索对话", "Search conversations")}
        placeholder={t("搜索对话", "Search conversations")}
      />
    </div>}
    <div className={styles.threadScroll}>
      <AgentThreadListItems search={hasThreads ? search : ""} />
    </div>
  </ThreadListPrimitive.Root>
}

function AgentThreadListItems({ search }: { search: string }) {
  const t = useText()
  const threadIds = useAuiState(state => state.threads.threadIds)
  const threadItems = useAuiState(state => state.threads.threadItems)
  const loading = useAuiState(state => state.threads.isLoading)
  const grouped = useMemo(() => {
    const itemsById = new Map(threadItems.map(item => [item.id, item]))
    const query = search.trim().toLowerCase()
    const today = startOfLocalDay(new Date())
    const matches = threadIds.flatMap(id => {
      const item = itemsById.get(id)
      if (!item) return []
      if (query && !(item.title || "New chat").toLowerCase().includes(query)) return []
      const custom = item.custom
      const value = custom && typeof custom === "object" && "updatedAt" in custom && typeof custom.updatedAt === "string"
        ? new Date(custom.updatedAt)
        : undefined
      return [{ id, title: item.title, updatedAt: value && Number.isFinite(value.getTime()) ? value : undefined }]
    })
    if (!matches.some(item => item.updatedAt)) return { flat: matches.map(item => item.id), groups: null }
    const sorted = [...matches].sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
    const groups: { label: string; ids: string[] }[] = []
    for (const item of sorted) {
      const label = groupLabel(item.updatedAt, today)
      const last = groups.at(-1)
      if (last?.label === label) last.ids.push(item.id)
      else groups.push({ label, ids: [item.id] })
    }
    return { flat: null, groups }
  }, [search, threadIds, threadItems])

  if (loading) return <div className={styles.threadEmpty} role="status">{t("加载对话…", "Loading conversations…")}</div>
  if (threadIds.length === 0) return <p className={styles.threadEmpty}>{t("还没有对话。发送第一条消息即可开始。", "No conversations yet. Send the first message to begin.")}</p>
  if (!grouped.groups && grouped.flat?.length === 0) return <p className={styles.threadEmpty}>{t("没有匹配的对话", "No conversations found")}</p>
  if (!grouped.groups) return <>{grouped.flat?.map((id, index) => <ThreadListPrimitive.ItemByIndex key={id} index={index} components={{ ThreadListItem }} />)}</>
  return <>{grouped.groups.map(group => <Fragment key={group.label}>
    <div className={styles.threadGroupLabel}>{group.label === "Today" ? t("今天", "Today") : group.label === "Yesterday" ? t("昨天", "Yesterday") : t("更早", "Earlier")}</div>
    {group.ids.map(id => <ThreadListPrimitive.ItemByIndex key={id} index={threadIds.indexOf(id)} components={{ ThreadListItem }} />)}
  </Fragment>)}</>
}

const ThreadListItem: FC = () => {
  const t = useText()
  const active = useAuiState(state => state.threadListItem.id === state.threads.mainThreadId)
  const running = useAuiState(state => state.threadListItem.isRunning)
  const busy = useAuiState(state => state.thread.isRunning)
  return <ThreadListItemPrimitive.Root className={`${styles.threadItem}${active ? ` ${styles.threadItemActive}` : ""}`}>
    <ThreadListItemPrimitive.Trigger className={styles.threadTrigger} disabled={busy}>
      {running && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
      <span className={styles.threadTitle}><ThreadListItemPrimitive.Title fallback={t("新对话", "New chat")} /></span>
    </ThreadListItemPrimitive.Trigger>
    <ThreadListItemPrimitive.Delete asChild>
      <button type="button" className={styles.threadDelete} aria-label={t("删除对话", "Delete conversation")} title={t("删除对话", "Delete conversation")} disabled={busy}>
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </ThreadListItemPrimitive.Delete>
  </ThreadListItemPrimitive.Root>
}

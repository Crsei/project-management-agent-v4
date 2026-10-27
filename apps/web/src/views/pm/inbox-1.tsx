import { MessageSquare, PanelRightClose, PanelRightOpen, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { useI18n } from "@/lib/i18n-provider"
import {
  PmPage,
  PmDataBoundary,
  PmSearch,
  PmMemberIdentity,
  usePmScenarioState,
} from "./shared"
import { pmMembers, type PmPageProps } from "./model"
import {
  copy,
  inboxLastMessage,
  setThreadClosed,
  updateInboxDraft,
  type InboxLocale,
  type InboxThreadKind,
} from "./inbox-domain"
import {
  InboxAuthorIdentity,
  InboxComposer,
  InboxScrollArea,
  useInboxDomain,
} from "./inbox-views"
import styles from "./inbox.module.css"

export function Inbox1FixtureView({ scenario }: PmPageProps) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  const readonly = scenario === "readonly" || scenario === "loading"
  const [domain, setDomain] = useInboxDomain(scenario)
  const [query, setQuery] = usePmScenarioState("inbox-1:query", () => "")
  const [selectedId, setSelectedId] = usePmScenarioState(
    "inbox-1:selected",
    () => "thread-support-1",
  )
  const [panelOpen, setPanelOpen] = usePmScenarioState(
    "inbox-1:panel",
    () => true,
  )
  const kind: InboxThreadKind = "support"
  const threads = domain.threads.filter((thread) => {
    if (thread.kind !== kind) return false
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    const last = inboxLastMessage(domain, thread.id)
    return [
      thread.subject,
      last?.body ?? "",
      ...thread.participants.map((p) => p.name),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  })
  const selected = threads.find((item) => item.id === selectedId) ?? threads[0]
  const messages = selected
    ? domain.messages.filter((item) => item.threadId === selected.id)
    : []
  const customer = selected?.participants[0]
  const suggestion = copy(localeKey, `您好 ${customer?.name ?? ""}，想跟进一下 ${selected?.subject ?? ""}。如果问题仍未解决，请回复告知，我们会继续协助。`, `Hi ${customer?.name ?? ""}, following up about ${selected?.subject ?? ""}. If this is still unresolved, reply and we will continue to help.`)
  return (
    <PmPage
      pageId="pm-inbox-1"
      className={styles.inboxPage}
      headerMode="hidden"
      title={copy(localeKey, "客服收件箱", "Support inbox")}
      description={copy(
        localeKey,
        "客户会话、固定本地辅助面板与按线程隔离的草稿。",
        "Customer conversations, a fixed local assistance panel, and per-thread drafts.",
      )}
      sidebar={
        <section
          className={styles.paneFill}
          data-inbox-support-list
          aria-label={copy(localeKey, "会话列表", "Thread list")}
        >
          <div className={styles.paneHeader}>
            <PmSearch value={query} onChange={setQuery} label={copy(localeKey, "搜索会话…", "Search threads…")} />
          </div>
          <InboxScrollArea stateKey="inbox-1:list" className="pm-scroll-hidden">
            <PmDataBoundary scenario={scenario} empty={threads.length === 0} emptyDescription={copy(localeKey, "没有匹配的会话。", "No matching conversations.")}>
            <div role={threads.length ? "list" : undefined} aria-label={threads.length ? copy(localeKey, "会话列表", "Conversations") : undefined}>
            {threads.map((thread) => {
              const last = inboxLastMessage(domain, thread.id)
              const first = domain.messages.find((item) => item.threadId === thread.id)
              const preview = first?.body.split(/\n\n/).find((paragraph) => !/^Hi\b/i.test(paragraph)) ?? first?.body
              return (
                <div key={thread.id} role="listitem">
                <button
                  key={thread.id}
                  data-inbox-thread={thread.id}
                  type="button"
                  className={styles.listButton}
                  data-selected={selected?.id === thread.id}
                  aria-pressed={selected?.id === thread.id}
                  data-unread={thread.unread}
                  aria-label={[thread.subject, thread.lastAtLabel].join(", ")}
                  onClick={() => setSelectedId(thread.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className={styles.rowTop}>
                      <span className={styles.subject}>{thread.subject.replace(/^Re: /, "")}</span>
                      <span className={styles.time}>{thread.lastAtLabel}</span>
                    </span>
                    <span className={styles.preview}>
                      {preview?.replace(/\n+/g, " ")}
                    </span>
                    {last && (
                      <span className={styles.meta}>
                        {last.author.name}
                      </span>
                    )}
                  </span>
                  {thread.unread && (
                    <span className={styles.unreadDot} aria-hidden="true" />
                  )}
                </button>
                </div>
              )
            })}
            {threads.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                {copy(localeKey, "没有匹配的会话。", "No matching threads.")}
              </p>
            )}
            </div>
            </PmDataBoundary>
          </InboxScrollArea>
        </section>
      }
    >
      <div className={styles.supportFill}>
        <div className={styles.conversationColumn} data-inbox-conversation>
          {selected ? (
            <>
              {selected.closed && (
                <div className={styles.closedBanner} role="status">
                  <span>
                    {copy(
                      localeKey,
                      "会话已关闭。仍可阅读与回复；重新打开可恢复处理状态。",
                      "Thread closed. It can still be read and answered; reopen restores the working state.",
                    )}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={readonly}
                    onClick={() =>
                      setDomain((state) =>
                        setThreadClosed(state, selected.id, false, readonly),
                      )
                    }
                  >
                    <RotateCcw aria-hidden="true" size={14} />
                    {copy(localeKey, "重新打开", "Reopen")}
                  </Button>
                </div>
              )}
              <div className={styles.readingHeader} data-inbox-owned-header>
                <div className="flex min-w-0 items-center gap-2"><span className="flex size-6 shrink-0 items-center justify-center"><MessageSquare aria-hidden="true" size={16} /></span>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold" data-inbox-owned-title>
                    {selected.subject}
                  </h2>
                </div>
                </div>
                <div className="inline-flex items-center gap-2">
                <Select
                  value={selected.closed ? "closed" : "active"}
                  onValueChange={(value) =>
                    setDomain((state) =>
                      setThreadClosed(
                        state,
                        selected.id,
                        value === "closed",
                        readonly,
                      ),
                    )
                  }
                  disabled={readonly}
                >
                  <SelectTrigger
                    aria-label={copy(localeKey, "会话状态", "Thread status")}
                  >
                    <SelectValue>{selected.closed ? copy(localeKey, "已关闭", "Closed") : copy(localeKey, "处理中", "Active")}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">
                      {copy(localeKey, "处理中", "Active")}
                    </SelectItem>
                    <SelectItem value="closed">
                      {copy(localeKey, "已关闭", "Closed")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="icon" aria-label={copy(localeKey, "辅助面板", "Assist panel")} aria-pressed={panelOpen} onClick={() => setPanelOpen((value) => !value)}>
                  {panelOpen ? <PanelRightClose aria-hidden="true" size={16} /> : <PanelRightOpen aria-hidden="true" size={16} />}
                </Button>
                </div>
              </div>
              <InboxScrollArea stateKey={`inbox-1:reading:${selected.id}`} role="region" aria-label={copy(localeKey, "会话消息", "Conversation messages")} tabIndex={0}>
                <PmDataBoundary scenario={scenario} empty={false} emptyDescription="">
                {messages.map((message) => (
                  <section key={message.id} className={styles.messageStack}>
                    <header className="flex items-center gap-3">
                      <InboxAuthorIdentity author={message.author} detail atLabel={message.atLabel} />

                    </header>
                    <p className={styles.messageBody}>{message.body}</p>
                  </section>
                ))}
                </PmDataBoundary>
              </InboxScrollArea>
              <InboxComposer
                key={selected.id}
                threadId={selected.id}
                scenario={scenario}
                recipientRequired={false}
                recipient={customer?.email}
                presentation="support"
                closeAction={
                  <Button variant="outline" disabled={readonly} onClick={() => setDomain((state) => setThreadClosed(state, selected.id, !selected.closed, readonly))}>
                    {selected.closed ? copy(localeKey, "重新打开", "Reopen") : copy(localeKey, "关闭会话", "Close")}
                  </Button>
                }
                disabled={readonly}
                placeholder={copy(localeKey, "写回复…", "Write a reply…")}
                sendLabel={copy(localeKey, "发送", "Send")}
              />
            </>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {copy(
                localeKey,
                "从左侧选择一个会话。",
                "Select a thread on the left.",
              )}
            </p>
          )}
        </div>
        {panelOpen && (
          <aside
            className={styles.agentPanel}
            data-agent-panel
            aria-label={copy(
              localeKey,
              "本地辅助面板",
              "Local assistance panel",
            )}
          >
            <h2 className={styles.agentHeading}>{copy(localeKey, "收件箱助手", "Inbox Agent")}</h2>
            <p className={styles.agentLocalNote} role="note">
              {copy(
                localeKey,
                "固定本地辅助面板：内容来自本地fixture，不是实时AI推理，也不会发送任何数据。",
                "Fixed local assistance panel: content comes from local fixtures, not live AI inference; nothing is sent anywhere.",
              )}
            </p>
            {selected ? <>
            {customer && (
              <div>
                <p className="text-sm font-semibold">{customer.name}</p>
                {selected && (
                  <p className="text-xs text-muted-foreground">
                    {copy(localeKey, "会话 ", "Thread ") + selected.subject}
                  </p>
                )}
              </div>
            )}
            <div className={styles.agentSection}>
              <p className={styles.agentSectionTitle}>
                {copy(localeKey, "信号", "Signals")}
              </p>
              <p>
                {copy(
                  localeKey,
                  `此本地会话有 ${messages.filter((message) => message.direction === "in").length} 条收到的消息；不推断客户语气或意图。`,
                  `This local thread contains ${messages.filter((message) => message.direction === "in").length} incoming messages; customer tone and intent are not inferred.`,
                )}
              </p>
              <p>
                {copy(
                  localeKey,
                  "回复本身不能证明问题已解决；关闭前应向客户确认。",
                  "A reply does not establish resolution; confirm with the customer before closing.",
                )}
              </p>
            </div>
            <div className={styles.agentSection}>
              <p className={styles.agentSectionTitle}>
                {copy(localeKey, "建议跟进", "Suggested follow up")}
              </p>
              <p className="whitespace-pre-wrap">
                {suggestion}
              </p>
              <Button
                variant="outline"
                size="sm"
                data-insert-suggestion
                disabled={readonly || !selected}
                onClick={() => {
                  if (!selected) return
                  setDomain((state) => {
                    const current = state.drafts[`${selected.id}:reply`]
                    return updateInboxDraft(state, selected.id, "reply", {
                      body: current?.body
                        ? `${current.body}\n\n${suggestion}`
                        : suggestion,
                    })
                  })
                }}
              >
                {copy(localeKey, "插入回复", "Insert into reply")}
              </Button>
            </div>
            <div>
              <p className={styles.sectionLabel}>
                {copy(localeKey, "历史会话", "Previous conversations")}
              </p>
              <div className="flex flex-col gap-1">
                {threads
                  .filter((item) => item.id !== selected?.id)
                  .slice(0, 3)
                  .map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={styles.folderButton}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="truncate">{item.subject}</span>
                      <span className={styles.folderCount}>
                        {item.lastAtLabel}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
            {selected && (
              <>
                <p className="text-xs text-muted-foreground">
                  {copy(localeKey, "处理人", "Responder")}
                </p>
                <PmMemberIdentity member={pmMembers[0]} detail />
              </>
            )}
            </> : <p className="text-sm text-muted-foreground">{copy(localeKey, "选择会话后查看本地辅助信息。", "Select a thread to view its local assistance summary.")}</p>}
          </aside>
        )}
      </div>
    </PmPage>
  )
}

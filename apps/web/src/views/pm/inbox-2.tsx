import { Reply, MoreHorizontal, Mail, Archive } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { useI18n } from "@/lib/i18n-provider"
import { PmPage, PmSearch, PmDataBoundary, usePmScenarioState } from "./shared"
import type { PmPageProps } from "./model"
import {
  copy,
  inboxLastMessage,
  inboxUnreadCount,
  markThreadRead,
  markThreadUnread,
  setThreadFolder,
  type InboxFolder,
  type InboxLocale,
  type InboxThreadKind,
} from "./inbox-domain"
import {
  InboxAttachmentChips,
  InboxAuthorIdentity,
  InboxComposer,
  InboxScrollArea,
  InboxUnreadSwitch,
  useInboxDomain,
} from "./inbox-views"
import styles from "./inbox.module.css"

const folders: { id: InboxFolder; label: { "zh-CN": string; en: string } }[] = [
  { id: "inbox", label: { "zh-CN": "收件箱", en: "Inbox" } },
  { id: "drafts", label: { "zh-CN": "草稿", en: "Drafts" } },
  { id: "sent", label: { "zh-CN": "已发送", en: "Sent" } },
  { id: "archive", label: { "zh-CN": "归档", en: "Archive" } },
  { id: "junk", label: { "zh-CN": "垃圾邮件", en: "Junk" } },
  { id: "trash", label: { "zh-CN": "回收站", en: "Trash" } },
]

export function Inbox2FixtureView({ scenario }: PmPageProps) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  const readonly = scenario === "readonly" || scenario === "loading"
  const [domain, setDomain] = useInboxDomain(scenario)
  const [folder, setFolder] = usePmScenarioState<InboxFolder>(
    "inbox-2:folder",
    () => "inbox",
  )
  const [unreadOnly, setUnreadOnly] = usePmScenarioState(
    "inbox-2:unreadOnly",
    () => false,
  )
  const [query, setQuery] = usePmScenarioState("inbox-2:query", () => "")
  const [selectedId, setSelectedId] = usePmScenarioState(
    "inbox-2:selected",
    () => "thread-mail-1",
  )
  const [replyFocus, setReplyFocus] = usePmScenarioState(
    "inbox-2:replyOpen",
    () => false,
  )
  const kind: InboxThreadKind = "general"
  const threads = domain.threads.filter((thread) => {
    if (thread.kind !== kind || thread.folder !== folder) return false
    if (unreadOnly && !thread.unread) return false
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    const last = inboxLastMessage(domain, thread.id)
    return [thread.subject, last?.author.name ?? "", last?.body ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  })
  const selected = threads.find((item) => item.id === selectedId) ?? threads[0]
  const selectedMessages = selected
    ? domain.messages.filter((item) => item.threadId === selected.id)
    : []
  return (
    <PmPage
      pageId="pm-inbox-2"
      className={styles.inboxPage}
      headerMode="hidden"
      title={copy(localeKey, "邮件", "Mail")}
      description={copy(localeKey, "个人邮箱场景", "Personal mailbox scene")}
      toolbar={
        <div className={styles.toolbarWrap}>
          {folders.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.tabButton}
              data-folder={item.id}
              data-active={folder === item.id}
              aria-current={folder === item.id ? "page" : undefined}
              onClick={() => setFolder(item.id)}
            >
              {item.label[localeKey]}
              {item.id === "inbox" &&
                ` (${inboxUnreadCount(domain, kind, "inbox")})`}
            </button>
          ))}
          <span className="ml-auto inline-flex items-center gap-2 text-sm">
            <InboxAuthorIdentity
              author={{ name: "Jordan Lee", email: "jordan.lee@acme.example" }}
            />
          </span>
        </div>
      }
      sidebar={
        <section
          className={styles.paneFill}
          data-inbox-mail-list
          aria-label={copy(localeKey, "邮件列表", "Message list")}
        >
          <div className={styles.paneHeader}>
            <span className="text-sm font-medium">
              {folders.find((item) => item.id === folder)?.label[localeKey]}
            </span>
            <InboxUnreadSwitch checked={unreadOnly} onChange={setUnreadOnly} />
          </div>
          <div className={styles.mailSearch}>
            <PmSearch
              value={query}
              onChange={setQuery}
              label={copy(localeKey, "搜索邮件…", "Type to search…")}
            />
          </div>
          <InboxScrollArea stateKey="inbox-2:list" className="pm-scroll-hidden">
            <PmDataBoundary scenario={scenario} empty={threads.length === 0} emptyDescription={copy(localeKey, "没有匹配的会话。", "No matching conversations.")}>
            <div role={threads.length ? "list" : undefined} aria-label={threads.length ? copy(localeKey, "会话列表", "Conversations") : undefined}>
            {threads.map((thread) => {
              const last = inboxLastMessage(domain, thread.id)
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
                  aria-label={[
                    last?.author.name ?? "",
                    thread.subject,
                    thread.lastAtLabel,
                  ].join(", ")}
                  onClick={() => {
                    setSelectedId(thread.id)
                    setDomain((state) =>
                      markThreadRead(state, thread.id, readonly),
                    )
                  }}
                >
                  {last && <InboxAuthorIdentity author={last.author} avatarOnly />}
                  <span className="min-w-0 flex-1">
                    <span className={styles.rowTop}>
                      <span className={styles.subject}>{last?.author.name}</span>
                      <span className={styles.time}>{thread.lastAtLabel}</span>
                    </span>
                    <span className={styles.mailSubject}>{thread.subject}</span>
                    <span className={styles.preview}>
                      {last ? last.body.replace(/\n+/g, " ").slice(0, 140) : ""}
                    </span>
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
                {copy(
                  localeKey,
                  unreadOnly ? "没有未读邮件。" : "此文件夹在此场景中为空。",
                  unreadOnly
                    ? "No unread mail."
                    : "This folder is empty in this scene.",
                )}
              </p>
            )}
            </div>
            </PmDataBoundary>
          </InboxScrollArea>
        </section>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col" data-inbox-reading>
        {selected ? (
          <>
            <div className={styles.readingHeader} data-inbox-owned-header>
              <div className="flex min-w-0 items-center gap-2"><span className="flex size-6 shrink-0 items-center justify-center"><Mail aria-hidden="true" size={16} /></span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold" data-inbox-owned-title>
                  {selected.subject}
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {copy(localeKey, "来自 ", "From ") +
                    (selectedMessages[0]?.author.email ?? "")}
                </p>
              </div>
              </div>
              <div className="inline-flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReplyFocus(true)}
                >
                  <Reply aria-hidden="true" size={14} />
                  {copy(localeKey, "回复", "Reply")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        data-more-menu
                        aria-label={copy(localeKey, "更多操作", "More actions")}
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden="true" size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      disabled={readonly}
                      data-menu-action="mark-unread"
                      onClick={() =>
                        setDomain((state) =>
                          markThreadUnread(state, selected.id, readonly),
                        )
                      }
                    >
                      <Mail aria-hidden="true" size={14} />
                      {copy(localeKey, "标为未读", "Mark unread")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={readonly}
                      onClick={() =>
                        setDomain((state) =>
                          setThreadFolder(
                            state,
                            selected.id,
                            selected.folder === "archive" ? "inbox" : "archive",
                            readonly,
                          ),
                        )
                      }
                    >
                      <Archive aria-hidden="true" size={14} />
                      {selected.folder === "archive"
                        ? copy(localeKey, "移回收件箱", "Move to inbox")
                        : copy(localeKey, "归档", "Archive")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <InboxScrollArea stateKey={`inbox-2:reading:${selected.id}`}>
              <PmDataBoundary scenario={scenario} empty={false} emptyDescription="">
              {selectedMessages.map((message) => (
                <section key={message.id} className={styles.messageStack}>
                  <header className="flex items-center gap-3">
                    <InboxAuthorIdentity author={message.author} detail atLabel={message.atLabel} />

                  </header>
                  <p className={styles.messageBody}>{message.body}</p>
                  <InboxAttachmentChips attachments={message.attachments} />
                </section>
              ))}
              </PmDataBoundary>
            </InboxScrollArea>
            <InboxComposer
              key={selected.id}
              threadId={selected.id}
              scenario={scenario}
              recipient={selected.participants[0]?.email}
              recipientEditable={replyFocus}
              recipientRequired
              presentation="mail"
              disabled={readonly}
              placeholder={
                selected.folder === "drafts"
                  ? copy(localeKey, "继续撰写草稿…", "Continue the draft…")
                  : copy(localeKey, "写回复…", "Write a reply…")
              }
              sendLabel={copy(localeKey, "发送", "Send")}
            />
          </>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">
            {copy(
              localeKey,
              "从左侧选择一封邮件。",
              "Select a message on the left.",
            )}
          </p>
        )}
      </div>
    </PmPage>
  )
}

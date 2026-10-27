import { ArrowLeft, Archive, Star, MoreHorizontal, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { useI18n } from "@/lib/i18n-provider"
import { PmPage, PmDataBoundary, usePmScenarioState } from "./shared"
import { usePmNavigation } from "./domain-session"
import type { PmPageProps } from "./model"
import {
  copy,
  markThreadRead,
  setThreadFolder,
  toggleThreadStar,
  type InboxLocale,
  type InboxFolder,
} from "./inbox-domain"
import {
  InboxAttachmentChips,
  InboxAuthorIdentity,
  InboxComposer,
  InboxProjectMailFolders,
  useInboxProjectMailFilters,
  InboxScrollArea,
  inboxTabKeyboard,
  useInboxDomain,
} from "./inbox-views"
import styles from "./inbox.module.css"

const activityTabs = ["all", "comments", "actions"] as const

export function InboxEmail1FixtureView({ scenario }: PmPageProps) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  const readonly = scenario === "readonly" || scenario === "loading"
  const [domain, setDomain] = useInboxDomain(scenario)
  const { entityId, back } = usePmNavigation()
  const [{ folder, spaceId }, setMailFilters] = useInboxProjectMailFilters()
  const setFolder = (folder: InboxFolder) => setMailFilters((state) => ({ ...state, folder }))
  const setSpaceId = (spaceId: string | null) => setMailFilters((state) => ({ ...state, spaceId }))
  const [activityTab, setActivityTab] = usePmScenarioState<
    (typeof activityTabs)[number]
  >("inbox-email-1:activity", () => "all")
  // An explicit entity resolves strictly by ID (an invalid ID stays a missing
  // reference, never a silent fallback). With no entity the catalog entry
  // exposes a representative full surface: default to the first eligible
  // project-mail thread.
  const thread = entityId
    ? domain.threads.find((item) => item.id === entityId)
    : domain.threads.find(
        (item) => item.kind === "project" && item.folder === "inbox",
      )
  const messages = thread
    ? domain.messages.filter((item) => item.threadId === thread.id)
    : []
  const internalNotes = domain.notes.filter((note) => note.notificationId === thread?.id && note.channel === "note")
  const activity = thread
    ? domain.activity.filter(
        (item) =>
          item.threadId === thread.id &&
          (activityTab === "all" || item.kind === activityTab),
      )
    : []
  const backToInbox = (
    <Button variant="ghost" size="sm" onClick={() => back("inbox-4")}>
      <ArrowLeft aria-hidden="true" size={14} />
      {copy(localeKey, "返回收件箱", "Back to Inbox")}
    </Button>
  )
  const messageActions = (
thread ? (
          <div className={styles.floatingToolbar}>
            <Button variant="ghost" size="sm" onClick={() => back("inbox-4")}>
              <ArrowLeft aria-hidden="true" size={14} />
              {copy(localeKey, "返回", "Back")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={readonly}
              aria-pressed={thread.folder === "archive"}
              onClick={() =>
                setDomain((state) =>
                  setThreadFolder(
                    state,
                    thread.id,
                    thread.folder === "archive" ? "inbox" : "archive",
                    readonly,
                  ),
                )
              }
            >
              <Archive aria-hidden="true" size={14} />
              {thread.folder === "archive"
                ? copy(localeKey, "已归档", "Archived")
                : copy(localeKey, "归档", "Archive")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={readonly}
              aria-pressed={thread.starred}
              onClick={() =>
                setDomain((state) =>
                  toggleThreadStar(state, thread.id, readonly),
                )
              }
            >
              <Star
                aria-hidden="true"
                size={14}
                fill={thread.starred ? "currentColor" : "none"}
              />
              {thread.starred
                ? copy(localeKey, "已星标", "Starred")
                : copy(localeKey, "星标", "Star")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={copy(localeKey, "更多操作", "More actions")}
                  />
                }
              >
                <MoreHorizontal aria-hidden="true" size={16} />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  disabled={readonly}
                  onClick={() =>
                    setDomain((state) =>
                      markThreadRead(state, thread.id, readonly),
                    )
                  }
                >
                  <Mail aria-hidden="true" size={14} />
                  {copy(localeKey, "标为已读", "Mark as read")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          backToInbox
        )
  )
  // Explicit invalid entity: report the missing reference, no fallback.
  if (entityId && !thread)
    return (
      <PmPage
        pageId="pm-inbox-email-1"
        title={copy(localeKey, "邮件", "Email")}
        actions={backToInbox}
      >
        <p className={styles.noticeCard} role="status">
          {copy(
            localeKey,
            `线程 ${entityId} 在本地场景中不存在，可能已被删除。`,
            `Thread ${entityId} does not exist in this local scene; it may have been removed.`,
          )}
        </p>
      </PmPage>
    )
  return (
    <PmPage
      pageId="pm-inbox-email-1"
      className={styles.inboxPage}
      headerMode="hidden"
      sidebar={<InboxProjectMailFolders scenario={scenario} folder={folder} spaceId={spaceId} onFolderChange={setFolder} onSpaceChange={setSpaceId} onNavigate={() => back("inbox-4")} />}
      title={thread?.subject ?? copy(localeKey, "项目邮件", "Project mail")}
      description={copy(localeKey, "项目邮件详情", "Project mail detail")}
    >
      <div className={styles.projectMail}>
      <header className={styles.readingHeader} data-inbox-owned-header>{messageActions}</header>
      <InboxScrollArea stateKey={`inbox-email-1:reading:${thread?.id ?? "empty"}`}>
      <PmDataBoundary
        scenario={scenario}
        empty={!thread}
        emptyDescription={copy(
          localeKey,
          "此场景没有项目邮件。",
          "This scene has no project mail.",
        )}
      >
        <article className={styles.article} data-inbox-article>
          <header className={styles.articleHeading}>
            {messages[0] && <InboxAuthorIdentity author={messages[0].author} avatarOnly />}
            <div className="min-w-0"><h2 data-inbox-owned-title>{thread?.subject}</h2><p className={styles.messageMeta}>{messages[0]?.author.name} · {messages[0]?.atLabel}</p></div>
          </header>
          {messages.map((message, index) => (
            <section
              key={message.id}
              className={styles.messageCard}
              data-outbound={message.direction === "out" || undefined}
            >
              {index > 0 && <p className={styles.messageMeta}>
                <span className="font-medium text-foreground">
                  {message.author.name}
                </span>
                <span>{message.author.email}</span>
                <span>{message.atLabel}</span>
                {message.direction === "out" && (
                  <span>
                    {copy(localeKey, "本地场景发出", "sent in local scene")}
                  </span>
                )}
              </p>}
              <p className={styles.articleBody}>{message.body}</p>
              <InboxAttachmentChips attachments={message.attachments} />
            </section>
          ))}
            <div className={styles.tabsRow} role="tablist" aria-label={copy(localeKey, "邮件活动筛选", "Mail activity filter")}>
              {activityTabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activityTab === tab}
                  id={`inbox-activity-tab-${tab}`}
                  aria-controls="inbox-activity-panel"
                  tabIndex={activityTab === tab ? 0 : -1}
                  onKeyDown={inboxTabKeyboard}
                  className={styles.tabButton}
                  data-active={activityTab === tab}
                  onClick={() => setActivityTab(tab)}
                >
                  {tab === "all"
                    ? copy(localeKey, "全部", "All")
                    : tab === "comments"
                      ? copy(localeKey, "备注", "Comments")
                      : copy(localeKey, "动作", "Actions")}
                </button>
              ))}
            </div>
          {internalNotes.map((note) => <section key={note.id} className={styles.agentSection} data-inbox-internal-note><h3 className="text-sm font-medium">{copy(localeKey, "本地内部备注", "Local internal comment")}</h3><p className="whitespace-pre-wrap">{note.body}</p></section>)}
          {thread && (
            <div className="mt-4">
              <InboxComposer
                key={thread.id}
                threadId={thread.id}
                scenario={scenario}
                recipient={thread.participants[0]?.email}
                recipientRequired
                modeTabs
                presentation="project"
                showToolbar
                showSaveDraft
                disabled={readonly}
                placeholder={copy(localeKey, "写回复…", "Write a reply…")}
                sendLabel={copy(localeKey, "发送回复", "Send reply")}
              />
            </div>
          )}
            <div className={styles.activityFeed} data-inbox-activity role="tabpanel" id="inbox-activity-panel" aria-labelledby={`inbox-activity-tab-${activityTab}`}>
              {activity.map((entry) => (
                <p key={entry.id}>
                  {entry.text[localeKey]} · {entry.atLabel}
                </p>
              ))}
              {activity.length === 0 && (
                <p>
                  {copy(
                    localeKey,
                    "此筛选下没有活动记录。",
                    "No activity under this filter.",
                  )}
                </p>
              )}
            </div>
        </article>
      </PmDataBoundary>
      </InboxScrollArea>
      </div>
    </PmPage>
  )
}

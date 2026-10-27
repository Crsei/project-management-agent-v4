import { useI18n } from "@/lib/i18n-provider"
import { PmPage, PmSearch, PmDataBoundary, usePmScenarioState } from "./shared"
import { usePmNavigation } from "./domain-session"
import type { PmPageProps } from "./model"
import {
  copy,
  inboxLastMessage,
  setThreadFolder,
  toggleThreadStar,
  type InboxFolder,
  type InboxLocale,
  type InboxThreadKind,
} from "./inbox-domain"
import {
  InboxAttachmentChips,
  InboxAuthorIdentity,
  InboxProjectMailFolders,
  inboxProjectFolderLabel,
  useInboxProjectMailFilters,
  InboxScrollArea,
  InboxThreadActionButtons,
  useInboxDomain,
} from "./inbox-views"
import { InboxCollectionBody } from "./inbox-collection-body"
import styles from "./inbox.module.css"

export function Inbox4FixtureView({ scenario }: PmPageProps) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  const readonly = scenario === "readonly" || scenario === "loading"
  const [domain, setDomain] = useInboxDomain(scenario)
  const { navigate } = usePmNavigation()
  const [{ folder, spaceId }, setMailFilters] = useInboxProjectMailFilters()
  const setFolder = (folder: InboxFolder) => setMailFilters((state) => ({ ...state, folder }))
  const setSpaceId = (spaceId: string | null) => setMailFilters((state) => ({ ...state, spaceId }))
  const [query, setQuery] = usePmScenarioState("inbox-4:query", () => "")
  const kind: InboxThreadKind = "project"
  const threads = domain.threads.filter((thread) => {
    if (thread.kind !== kind || thread.folder !== folder) return false
    if (spaceId && thread.spaceId !== spaceId) return false
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    const last = inboxLastMessage(domain, thread.id)
    return [
      thread.subject,
      last?.body ?? "",
      ...thread.participants.map((p) => p.email),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  })
  const activeSpace = domain.spaces.find((space) => space.id === spaceId)
  return (
    <PmPage
      pageId="pm-inbox-4"
      className={styles.inboxPage}
      headerMode="hidden"
      title={
        activeSpace
          ? activeSpace.name
          : copy(localeKey, "项目邮件", "Project mail")
      }
      description={copy(
        localeKey,
        `${threads.length} 个会话 · 项目邮件工作区`,
        `${threads.length} conversations · project mail workspace`,
      )}
      sidebar={<InboxProjectMailFolders scenario={scenario} folder={folder} spaceId={spaceId} onFolderChange={setFolder} onSpaceChange={setSpaceId} />}
    >
      <InboxCollectionBody title={activeSpace?.name ?? inboxProjectFolderLabel(folder, localeKey)} description={copy(localeKey, `${threads.length} 个会话`, `${threads.length} conversations`)} search={<PmSearch value={query} onChange={setQuery} label={copy(localeKey, "搜索邮件…", "Search mail…")} />}>


      <InboxScrollArea stateKey="inbox-4:list" data-inbox-threads className="pm-scroll-hidden">
        <PmDataBoundary scenario={scenario} empty={threads.length === 0} emptyDescription={copy(localeKey, "此文件夹在此场景中没有会话。", "This folder has no conversations in this scene.")}>
        {threads.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">
            {copy(
              localeKey,
              "此文件夹在此场景中没有会话。",
              "This folder has no conversations in this scene.",
            )}
          </p>
        )}
        <div role={threads.length ? "list" : undefined} aria-label={threads.length ? copy(localeKey, "邮件会话", "Mail conversations") : undefined}>
        {threads.map((thread) => {
          const last = inboxLastMessage(domain, thread.id)
          return (
            <div key={thread.id} className={styles.threadRow} data-inbox-thread-row={thread.id} role="listitem">
              <button
                type="button"
                data-inbox-thread={thread.id}
                className={styles.listButton}
                data-unread={thread.unread}
                aria-label={[
                  thread.subject,
                  last?.author.name ?? "",
                  thread.lastAtLabel,
                ].join(", ")}
                onClick={() => navigate("inbox-email-1", thread.id)}
              >
                <InboxAuthorIdentity author={last?.author ?? thread.participants[0]} avatarOnly />
                <span className="min-w-0 flex-1">
                  <span className={styles.rowTop}>
                    <span className={styles.subject}>
                      {thread.starred && "★ "}
                      {thread.subject}
                    </span>

                  </span>
                  <span className={styles.preview}>
                    {(last?.body ?? domain.drafts[`${thread.id}:reply`]?.body ?? "").replace(/\n+/g, " ")}
                  </span>
                  {last && (
                    <InboxAttachmentChips
                      attachments={last.attachments}
                      compact
                    />
                  )}
                  <span className={styles.projectMeta}>{last?.author.name} · {thread.lastAtLabel}</span>
                </span>
              </button>
              <span className={styles.rowActions}>
                <InboxThreadActionButtons
                  starred={thread.starred}
                  archived={thread.folder === "archive"}
                  disabled={readonly}
                  onStar={() =>
                    setDomain((state) =>
                      toggleThreadStar(state, thread.id, readonly),
                    )
                  }
                  onArchive={() =>
                    setDomain((state) =>
                      setThreadFolder(
                        state,
                        thread.id,
                        thread.folder === "archive" ? "inbox" : "archive",
                        readonly,
                      ),
                    )
                  }
                />
              </span>
            </div>
          )
        })}
        </div>
        </PmDataBoundary>
      </InboxScrollArea>
      </InboxCollectionBody>
    </PmPage>
  )
}

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type HTMLAttributes, type KeyboardEvent } from "react"
import {
  Archive,
  Mail,
  Folder,
  FileEdit,
  Trash2,
  Check,
  Download,
  Link2,
  List,
  Paperclip,
  Send,
  Star,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n-provider"
import { usePmDomainState } from "./domain-session"
import { usePmScenarioState } from "./shared"
import {
  checkInboxRequest,
  createInboxDraftThread,
  inboxFolderCounts,
  inboxSpaceCounts,
  type InboxFolder,
  copy,
  createInboxDomain,
  restoreInboxDomain,
  inboxPendingRequest,
  inboxThreadDraft,
  sendInboxDraft,
  updateInboxDraft,
  validateInboxDraft,
  validateInboxRecipient,
  type InboxAttachment,
  type InboxAuthor,
  type InboxChannel,
  type InboxDomain,
  type InboxLocale,
} from "./inbox-domain"
import type { PmScenario } from "./model"
import styles from "./inbox.module.css"

export function useInboxDomain(scenario: PmScenario) {
  return usePmDomainState<InboxDomain>("inbox", () => createInboxDomain(scenario), restoreInboxDomain)
}



export function inboxTabKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"]
  if (!keys.includes(event.key)) return
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])
  const index = tabs.indexOf(event.currentTarget)
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
  event.preventDefault()
  tabs[next]?.focus()
  tabs[next]?.click()
}

type InboxScrollAreaProps = { stateKey: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>

export function InboxScrollArea(props: InboxScrollAreaProps) {
  return <RetainedInboxScrollArea key={props.stateKey} {...props} />
}

function RetainedInboxScrollArea({ stateKey, children, className, ...props }: InboxScrollAreaProps) {
  const [position, setPosition] = usePmScenarioState(stateKey, () => 0)
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (element.current) element.current.scrollTop = position }, [position])
  return <div {...props} ref={element} className={[styles.paneBody, className].filter(Boolean).join(" ")} onScroll={(event) => setPosition(event.currentTarget.scrollTop)}>{children}</div>
}

export function useInboxProjectMailFilters() {
  return usePmDomainState<{ folder: InboxFolder; spaceId: string | null }>("inbox:project-mail-filters", () => ({ folder: "inbox", spaceId: null }))
}

const projectFolders: { id: InboxFolder; icon: typeof Mail; label: { "zh-CN": string; en: string } }[] = [
  { id: "inbox", icon: Mail, label: { "zh-CN": "收件箱", en: "Inbox" } },
  { id: "sent", icon: Send, label: { "zh-CN": "已发送", en: "Sent" } },
  { id: "drafts", icon: FileEdit, label: { "zh-CN": "草稿", en: "Drafts" } },
  { id: "archive", icon: Archive, label: { "zh-CN": "归档", en: "Archive" } },
  { id: "trash", icon: Trash2, label: { "zh-CN": "回收站", en: "Trash" } },
]

export function inboxProjectFolderLabel(folder: InboxFolder, locale: InboxLocale) {
  return projectFolders.find((item) => item.id === folder)?.label[locale] ?? copy(locale, "垃圾邮件", "Junk")
}

export function InboxProjectMailFolders({ scenario, folder, spaceId, onFolderChange, onSpaceChange, onNavigate }: { scenario: PmScenario; folder: InboxFolder; spaceId: string | null; onFolderChange: (folder: InboxFolder) => void; onSpaceChange: (space: string | null) => void; onNavigate?: () => void }) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  const [domain, setDomain] = useInboxDomain(scenario)
  const counts = inboxFolderCounts(domain, "project")
  const spaceCounts = inboxSpaceCounts(domain)
  const readonly = scenario === "readonly" || scenario === "loading"
  return <nav className={styles.projectFolders} data-inbox-folders aria-label={copy(localeKey, "邮件文件夹", "Mail folders")}>
    <div className={styles.projectBrand}><span className={styles.projectBrandIcon}><Mail aria-hidden="true" size={16} /></span><div>{copy(localeKey, "项目邮件", "Project Mail")}<small>{copy(localeKey, "续约工作区", "Renewal workspace")}</small></div></div>
    <div className={styles.folderList}>
      <InboxComposeDialog disabled={readonly} onCompose={(input) => { setDomain((state) => createInboxDraftThread(state, input, readonly)); onFolderChange("drafts"); onSpaceChange(null); onNavigate?.() }} />
      {projectFolders.map(({id, icon: Icon, label}) => <button key={id} type="button" className={styles.folderButton} data-folder={id} data-active={folder === id && !spaceId} aria-current={folder === id && !spaceId ? "page" : undefined} onClick={() => { onFolderChange(id); onSpaceChange(null); onNavigate?.() }}><span className="inline-flex items-center gap-3"><Icon aria-hidden="true" size={16} />{label[localeKey]}</span><span className={styles.folderCount}>{counts[id]}</span></button>)}
      <p className={styles.sectionLabel}>{copy(localeKey, "项目空间", "Spaces")}</p>
      {domain.spaces.map((space) => <button key={space.id} type="button" className={styles.folderButton} data-space={space.id} data-active={spaceId === space.id} aria-current={spaceId === space.id ? "page" : undefined} onClick={() => {onSpaceChange(spaceId === space.id ? null : space.id); onNavigate?.()}}><span className="inline-flex items-center gap-3"><Folder aria-hidden="true" size={16} />{space.name}</span><span className={styles.folderCount}>{spaceCounts[space.id] ?? 0}</span></button>)}
    </div>
  </nav>
}

export function InboxAuthorIdentity({
  author,
  detail = false,
  avatarOnly = false,
  atLabel,
}: {
  author: InboxAuthor
  detail?: boolean
  avatarOnly?: boolean
  atLabel?: string
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2" data-inbox-author-detail={detail}>
      <Avatar name={author.name} size={avatarOnly || detail ? 40 : 24} />
      {!avatarOnly && <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {author.name}
        </span>
        {detail && (
          <span className="block truncate text-xs text-muted-foreground">
            {author.email}
          </span>
        )}
        {detail && atLabel && <span className="block text-xs text-muted-foreground">{atLabel}</span>}
      </span>}
    </span>
  )
}

export function InboxAttachmentChips({
  attachments,
  compact = false,
}: {
  attachments: readonly InboxAttachment[]
  compact?: boolean
}) {
  const { locale } = useI18n()
  const [preview, setPreview] = useState<InboxAttachment | null>(null)
  if (attachments.length === 0) return null
  return (
    <span className={styles.attachmentRow} data-inbox-attachments>
      {attachments.map((attachment) => {
        const label = (
          <>
            <Paperclip aria-hidden="true" size={12} />
            {attachment.name}
            {attachment.status === "error" && (
              <span className="text-xs">
                {copy(locale as InboxLocale, "不可用", "unavailable")}
              </span>
            )}
          </>
        )
        // Compact chips render inside a row's primary button, so they must be
        // static spans to avoid invalid nested <button> HTML. Real preview and
        // download stay available in the reading/detail pane (compact=false).
        if (compact)
          return (
            <span
              key={attachment.id}
              className={
                attachment.status === "available"
                  ? styles.attachmentChip
                  : `${styles.attachmentChip} ${styles.attachmentError}`
              }
              data-attachment-chip={attachment.id}
              data-attachment-status={attachment.status}
            >
              {label}
            </span>
          )
        return attachment.status === "available" ? (
          <button
            key={attachment.id}
            type="button"
            className={styles.attachmentChip}
            data-attachment-chip={attachment.id}
            data-attachment-status="available"
            title={copy(
              locale as InboxLocale,
              "在本地预览此附件的文本内容",
              "Preview this attachment's local text content",
            )}
            onClick={() => setPreview(attachment)}
          >
            {label}
          </button>
        ) : (
          <span
            key={attachment.id}
            className={`${styles.attachmentChip} ${styles.attachmentError}`}
            data-attachment-chip={attachment.id}
            data-attachment-status="error"
            data-attachment-error={attachment.id}
          >
            {label}
          </span>
        )
      })}
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{preview?.name}</DialogTitle>
            <DialogDescription>
              {copy(
                locale as InboxLocale,
                "本地文本预览：此场景不读取真实文件，也不上传任何内容。",
                "Local text preview: this scene never reads real files or uploads anything.",
              )}
            </DialogDescription>
          </DialogHeader>
          <pre className={styles.attachmentPreview}>{preview?.content}</pre>
          <DialogFooter>
            <a
              className={styles.attachmentDownload}
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(preview?.content ?? "")}`}
              download={preview?.name ?? "attachment.txt"}
            >
              <Download aria-hidden="true" size={14} />
              {copy(
                locale as InboxLocale,
                "下载本地文本",
                "Download local text",
              )}
            </a>
            <Button variant="outline" onClick={() => setPreview(null)}>
              {copy(locale as InboxLocale, "关闭", "Close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  )
}

const formattingActions = [
  {
    id: "bold",
    marker: "**",
    label: { "zh-CN": "加粗", en: "Bold" },
    icon: <span className="font-bold">B</span>,
  },
  {
    id: "italic",
    marker: "_",
    label: { "zh-CN": "斜体", en: "Italic" },
    icon: <span className="italic">I</span>,
  },
  {
    id: "list",
    marker: "\n- ",
    label: { "zh-CN": "列表", en: "List" },
    icon: <List aria-hidden="true" size={14} />,
  },
  {
    id: "link",
    marker: "[](",
    label: { "zh-CN": "链接", en: "Link" },
    icon: <Link2 aria-hidden="true" size={14} />,
  },
] as const

export function InboxComposer({
  threadId,
  scenario,
  channel = "reply",
  recipient,
  recipientEditable = false,
  recipientRequired = true,
  placeholder,
  sendLabel,
  modeTabs = false,
  showToolbar = false,
  showSaveDraft = false,
  disabled = false,
  rows = 3,
  presentation,
  closeAction,
}: {
  threadId: string
  scenario: PmScenario
  channel?: InboxChannel
  recipient?: string
  recipientEditable?: boolean
  recipientRequired?: boolean
  placeholder?: string
  sendLabel?: string
  modeTabs?: boolean
  showToolbar?: boolean
  showSaveDraft?: boolean
  disabled?: boolean
  rows?: number
  presentation?: "support" | "mail" | "notification" | "project"
  closeAction?: ReactNode
}) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  const [domain, setDomain] = useInboxDomain(scenario)
  const [activeChannel, setActiveChannel] = usePmScenarioState<InboxChannel>(`inbox-composer:${threadId}:channel`, () => channel)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [ccOpen, setCcOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const draft = inboxThreadDraft(domain, threadId, activeChannel)
  // Fall back to the correspondent the view supplied when no stored draft
  // recipient exists; a caller-typed recipient in the draft always wins.
  const effectiveRecipient = draft ? draft.recipient : recipient || ""
  const pending = inboxPendingRequest(domain, threadId, activeChannel)
  const locked = pending?.status === "unknown"
  const applyFormat = (marker: string) => {
    const element = textareaRef.current
    if (!element) return
    const start = element.selectionStart
    const end = element.selectionEnd
    const body = draft?.body ?? ""
    const selected = body.slice(start, end) || copy(localeKey, "文本", "text")
    const next =
      marker === "\n- "
        ? `${body.slice(0, start)}\n- ${selected}${body.slice(end)}`
        : marker === "[]("
          ? `${body.slice(0, start)}[${selected}](${copy(localeKey, "链接", "link")})${body.slice(end)}`
          : `${body.slice(0, start)}${marker}${selected}${marker}${body.slice(end)}`
    setDomain((state) =>
      updateInboxDraft(state, threadId, activeChannel, { body: next, recipient: effectiveRecipient }),
    )
    setSaved(false)
  }
  const onSend = () => {
    const error = validateInboxDraft(
      {
        recipient: effectiveRecipient,
        cc: draft?.cc ?? "",
        body: draft?.body ?? "",
      },
      recipientRequired,
    )
    if (error) {
      setDraftError(error[localeKey])
      return
    }
    setDraftError(null)
    setDomain((state) =>
      sendInboxDraft(state, threadId, activeChannel, disabled),
    )
  }
  return (
    <div className={styles.composer} data-inbox-composer={threadId} data-presentation={presentation}>
      {modeTabs && (
        <div className={styles.composerTabs} role="tablist" aria-label={copy(localeKey, "回复模式", "Reply mode")}>
          {(["reply", "note"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeChannel === tab}
              id={`inbox-composer-${threadId}-${tab}`}
              aria-controls={`inbox-composer-panel-${threadId}`}
              tabIndex={activeChannel === tab ? 0 : -1}
              onKeyDown={inboxTabKeyboard}
              className={styles.composerTab}
              data-active={activeChannel === tab}
              onClick={() => {
                setActiveChannel(tab)
                setDraftError(null)
              }}
            >
              {tab === "reply"
                ? copy(localeKey, "回复", "Reply")
                : copy(localeKey, "内部备注", "Internal comment")}
            </button>
          ))}
        </div>
      )}
      {activeChannel === "reply" && <div className={styles.recipientRow}>
      {recipientEditable ? (
        <label className={styles.composerRecipient}>
          <span className={styles.visuallyHidden}>
            {copy(localeKey, "收件人", "Recipient")}
          </span>
          <Input
            value={effectiveRecipient}
            aria-label={copy(localeKey, "收件人地址", "Recipient address")}
            placeholder={copy(
              localeKey,
              "name@example.com",
              "name@example.com",
            )}
            disabled={disabled}
            onChange={(event) => {
              setDomain((state) =>
                updateInboxDraft(state, threadId, activeChannel, {
                  recipient: event.target.value,
                }),
              )
              setSaved(false)
            }}
          />
        </label>
      ) : (
        <p className={styles.composerHint}>
          {recipientEditable === false && recipient
            ? copy(localeKey, "回复给 ", "Reply to ") + recipient
            : placeholder}
        </p>
      )}
      {presentation === "support" && <Button variant="ghost" size="sm" aria-expanded={ccOpen} onClick={() => setCcOpen((value) => !value)}>Cc</Button>}
      </div>}
      {ccOpen && activeChannel === "reply" && <Input aria-label={copy(localeKey, "抄送地址", "Cc address")} value={draft?.cc ?? ""} disabled={disabled} onChange={(event) => setDomain((state) => updateInboxDraft(state, threadId, activeChannel, {cc: event.target.value, recipient: effectiveRecipient}))} />}
      {showToolbar && (
        <div className={styles.composerToolbar}>
          {formattingActions.map((action) => (
            <Button
              key={action.id}
              variant="ghost"
              size="icon"
              aria-label={action.label[localeKey]}
              title={action.label[localeKey]}
              disabled={disabled}
              onClick={() => applyFormat(action.marker)}
            >
              {action.icon}
            </Button>
          ))}
        </div>
      )}
      <div role={modeTabs ? "tabpanel" : undefined} id={`inbox-composer-panel-${threadId}`} aria-labelledby={modeTabs ? `inbox-composer-${threadId}-${activeChannel}` : undefined}>
      <Textarea
        ref={textareaRef}
        value={draft?.body ?? ""}
        rows={rows}
        disabled={disabled}
        aria-label={placeholder ?? copy(localeKey, "写回复…", "Write a reply…")}
        placeholder={
          placeholder ?? copy(localeKey, "写回复…", "Write a reply…")
        }
        onChange={(event) => {
          setDomain((state) =>
            updateInboxDraft(state, threadId, activeChannel, {
              body: event.target.value,
              recipient: effectiveRecipient,
            }),
          )
          setSaved(false)
          if (draftError) setDraftError(null)
        }}
      />
      </div>
      {draftError && (
        <p className={styles.composerError} role="alert">
          {draftError}
        </p>
      )}
      {locked && (
        <p className={styles.composerLocked} role="status">
          {copy(
            localeKey,
            "发送结果未知：请求已保留，重放已锁定，需要明确确认。",
            "Send result unknown: the request is retained, replay is locked, and an explicit check is required.",
          )}{" "}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              setDomain((state) =>
                checkInboxRequest(state, threadId, activeChannel, "confirmed"),
              )
            }
          >
            <Check aria-hidden="true" size={14} />
            {copy(localeKey, "本地核对：已送达", "Local check: delivered")}
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => setDomain((state) => checkInboxRequest(state, threadId, activeChannel, "rejected"))}>{copy(localeKey, "本地核对：未送达", "Local check: not delivered")}</Button>
        </p>
      )}
      {pending?.status === "confirmed" && <p className={styles.composerStatus} role="status">{copy(localeKey, "本地场景已确认，不会发送真实邮件。", "Confirmed in local scene; no real email was sent.")}</p>}
      {pending?.status === "rejected" && (
        <p className={styles.composerError} role="alert">
          {pending.error?.[localeKey] ??
            copy(
              localeKey,
              "发送被拒绝，草稿已保留。",
              "Send rejected; draft kept.",
            )}
        </p>
      )}
      <div className={styles.composerActions}>
        <span className={styles.composerStatus} aria-live="polite">
          {saved
            ? copy(
                localeKey,
                "草稿已保存在本地场景。",
                "Draft saved in the local scene.",
              )
            : ""}
        </span>
        {showSaveDraft && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setSaved(true)
              setDomain((state) =>
                updateInboxDraft(state, threadId, activeChannel, {
                  savedAt: new Date().toISOString(),
                  recipient: effectiveRecipient,
                }),
              )
            }}
          >
            {copy(localeKey, "保存草稿", "Save draft")}
          </Button>
        )}
        {closeAction}
        <Button disabled={disabled || locked} data-inbox-send onClick={onSend}>
          <Send aria-hidden="true" size={14} />
          {sendLabel ?? copy(localeKey, "发送", "Send")}
        </Button>
      </div>
    </div>
  )
}

export function InboxUnreadSwitch({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  const { locale } = useI18n()
  return (
    <label className={styles.unreadSwitch}>
      <span>{copy(locale as InboxLocale, "仅未读", "Unreads")}</span>
      <Switch
        checked={checked}
        disabled={disabled}
        data-unread-switch
        aria-label={copy(
          locale as InboxLocale,
          "仅显示未读",
          "Show unreads only",
        )}
        onCheckedChange={onChange}
      />
    </label>
  )
}

export function InboxComposeDialog({
  disabled = false,
  onCompose,
}: {
  disabled?: boolean
  onCompose: (input: {
    recipient: string
    subject: string
    body: string
  }) => void
}) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  const [open, setOpen] = useState(false)
  const [recipient, setRecipient] = useState("")
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [error, setError] = useState<string | null>(null)
  const recipientError = useMemo(
    () => validateInboxRecipient(recipient),
    [recipient],
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <DialogTrigger render={<Button className="w-full" disabled={disabled} />}>
        {copy(localeKey, "写新邮件", "Compose")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {copy(localeKey, "写新邮件", "Compose new mail")}
          </DialogTitle>
          <DialogDescription>
            {copy(
              localeKey,
              "本地草稿：收件人会先校验，邮件只会存到本地场景的草稿文件夹。",
              "Local draft: the recipient is validated first and the mail only lands in this scene's drafts folder.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className={styles.composeFields}>
          <Input
            value={recipient}
            aria-label={copy(localeKey, "收件人地址", "Recipient address")}
            placeholder={copy(
              localeKey,
              "收件人 name@example.com",
              "Recipient name@example.com",
            )}
            onChange={(event) => setRecipient(event.target.value)}
          />
          {recipient.length > 0 && recipientError && (
            <p className={styles.composerError} role="alert">
              {recipientError[localeKey]}
            </p>
          )}
          <Input
            value={subject}
            aria-label={copy(localeKey, "主题", "Subject")}
            placeholder={copy(localeKey, "主题", "Subject")}
            onChange={(event) => setSubject(event.target.value)}
          />
          <Textarea
            value={body}
            rows={4}
            aria-label={copy(localeKey, "正文", "Body")}
            placeholder={copy(localeKey, "正文…", "Body…")}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {copy(localeKey, "取消", "Cancel")}
          </Button>
          <Button
            onClick={() => {
              const addressError = validateInboxRecipient(recipient)
              if (addressError) {
                setError(addressError[localeKey])
                return
              }
              onCompose({ recipient: recipient.trim(), subject, body })
              setRecipient("")
              setSubject("")
              setBody("")
              setError(null)
              setOpen(false)
            }}
          >
            {copy(localeKey, "存为草稿", "Save to drafts")}
          </Button>
        </DialogFooter>
        {error && (
          <p className={styles.composerError} role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function InboxThreadActionButtons({
  starred,
  archived,
  disabled = false,
  onStar,
  onArchive,
}: {
  starred: boolean
  archived: boolean
  disabled?: boolean
  onStar: () => void
  onArchive: () => void
}) {
  const { locale } = useI18n()
  const localeKey = locale as InboxLocale
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label={copy(localeKey, "标记星标", "Star thread")}
        aria-pressed={starred}
        disabled={disabled}
        onClick={onStar}
      >
        <Star
          aria-hidden="true"
          size={14}
          fill={starred ? "currentColor" : "none"}
        />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={copy(localeKey, "归档", "Archive thread")}
        aria-pressed={archived}
        disabled={disabled}
        onClick={onArchive}
      >
        <Archive aria-hidden="true" size={14} />
      </Button>
    </span>
  )
}

export function InboxStatusBadge({
  unread,
  children,
}: {
  unread: boolean
  children: React.ReactNode
}) {
  return (
    <Badge tone={unread ? "info" : "neutral"} shape="pill" size="sm">
      {children}
    </Badge>
  )
}

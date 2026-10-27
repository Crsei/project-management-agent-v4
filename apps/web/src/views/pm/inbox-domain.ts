import type { Copy } from "../views-model"
import { pmClock, pmMembers, type PmScenario } from "./model"

export const inboxFixtureRevision = "pm-inbox-2026-10-13-v3"

export type InboxLocale = "en" | "zh-CN"
export const copy = (locale: InboxLocale, zh: string, en: string) =>
  locale === "en" ? en : zh

export type InboxChannel = "reply" | "note"
export type InboxFolder =
  "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk"
export type InboxThreadKind = "support" | "project" | "general"
export type InboxOutcome = "confirmed" | "rejected" | "unknown"

export type InboxAttachment = {
  id: string
  name: string
  content: string
  status: "available" | "error"
}

export type InboxAuthor = {
  name: string
  email: string
  memberId?: string
  role?: "customer" | "staff" | "member" | "system"
}

export type InboxMessage = {
  id: string
  threadId: string
  author: InboxAuthor
  direction: "in" | "out"
  recipient?: string
  cc?: string | null
  at: string
  atLabel: string
  body: string
  attachments: InboxAttachment[]
}

export type InboxThread = {
  id: string
  kind: InboxThreadKind
  subject: string
  folder: InboxFolder
  spaceId?: string
  issueId?: string
  unread: boolean
  closed: boolean
  starred: boolean
  participants: InboxAuthor[]
  lastAt: string
  lastAtLabel: string
}

export type InboxNotification = {
  id: string
  issueId: string | null
  actorId: string
  reason: Copy
  summary: Copy
  at: string
  atLabel: string
  read: boolean
}

export type InboxNote = {
  id: string
  notificationId: string
  channel: InboxChannel
  body: string
  at: string
}

export type InboxDraft = {
  recipient: string
  cc: string
  body: string
  savedAt?: string
  revision: number
}

export type InboxRequest = {
  operationId: string
  threadId: string
  channel: InboxChannel
  recipient: string
  // null explicitly identifies unavailable provenance in a restored pre-envelope request.
  cc: string | null
  draftRecipient: string | null
  draftRevision: number | null
  body: string
  status: "pending" | InboxOutcome
  error?: Copy
}

export type InboxActivity = {
  id: string
  threadId: string
  actor: string
  text: Copy
  kind: "all" | "comments" | "actions"
  at: string
  atLabel: string
}

export type InboxSpace = { id: string; name: string }

export type InboxDomain = {
  schemaVersion: 3
  threads: InboxThread[]
  messages: InboxMessage[]
  notifications: InboxNotification[]
  notes: InboxNote[]
  drafts: Record<string, InboxDraft | undefined>
  requests: InboxRequest[]
  activity: InboxActivity[]
  spaces: InboxSpace[]
  sequence: number
}

export const inboxAccount: Record<InboxThreadKind, InboxAuthor> = {
  support: {
    name: "Alex Chen",
    email: "alex.chen@cloudstar.example",
    memberId: "member-alex",
    role: "staff",
  },
  project: {
    name: "Alex Morgan",
    email: "alex.morgan@example.com",
    memberId: "member-alex",
    role: "member",
  },
  general: { name: "Jordan Lee", email: "jordan.lee@acme.example" },
}

export function inboxDraftKey(threadId: string, channel: InboxChannel) {
  return `${threadId}:${channel}`
}

export function validateInboxRecipient(value: string): Copy | null {
  const trimmed = value.trim()
  if (!trimmed)
    return {
      "zh-CN": "请填写收件人地址。",
      en: "Recipient address is required.",
    }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
    return {
      "zh-CN": "收件人地址格式无效，例如 name@example.com。",
      en: "Recipient address is invalid, for example name@example.com.",
    }
  return null
}

export function validateInboxDraft(
  draft: Pick<InboxDraft, "recipient" | "cc" | "body"> | undefined,
  recipientRequired: boolean,
): Copy | null {
  if (recipientRequired) {
    const recipientError = validateInboxRecipient(draft?.recipient ?? "")
    if (recipientError) return recipientError
  }
  if (!(draft?.body ?? "").trim())
    return { "zh-CN": "回复内容不能为空。", en: "Reply text cannot be empty." }
  return null
}

/**
 * Fixture send outcomes keyed `${threadId}:${channel}`. Unknown blocks the
 * channel until checkInboxRequest resolves it explicitly.
 */
const sendOutcomes: Record<string, InboxOutcome> = {
  "thread-mail-3:reply": "unknown",
  "thread-project-2:reply": "unknown",
  "thread-support-2:reply": "rejected",
  "notification-4:reply": "unknown",
}

export function inboxSendOutcome(threadId: string, channel: InboxChannel) {
  return sendOutcomes[`${threadId}:${channel}`] ?? "confirmed"
}

const spaces: InboxSpace[] = [
  { id: "space-renewal", name: "Renewal Forecast" },
  { id: "space-qa", name: "Platform QA" },
  { id: "space-design", name: "Design Partners" },
  { id: "space-finance", name: "Finance Ops" },
]

type ThreadSeed = {
  id: string
  kind: InboxThreadKind
  subject: string
  folder: InboxFolder
  spaceId?: string
  issueId?: string
  unread?: boolean
  closed?: boolean
  starred?: boolean
  participants: InboxAuthor[]
  lastAtLabel: string
  messages: {
    author: InboxAuthor
    direction: "in" | "out"
    atLabel: string
    body: string
    attachments?: InboxAttachment[]
  }[]
}

const customers: Record<string, InboxAuthor> = {
  sarah: {
    name: "Sarah Tran",
    email: "sarah.tran@brightwave.example",
    role: "customer",
  },
  mike: {
    name: "Mike Johnson",
    email: "mike.j@techcorp.example",
    role: "customer",
  },
  nina: {
    name: "Nina Oliver",
    email: "nina.oliver@example.com",
    role: "member",
  },
  ava: { name: "Ava Reed", email: "ava.reed@example.com", role: "member" },
  kai: { name: "Kai Young", email: "kai.young@example.com", role: "member" },
  morgan: {
    name: "Morgan Lee",
    email: "morgan.lee@example.com",
    role: "member",
  },
  billing: {
    name: "Billing Desk",
    email: "billing@brightwave.example",
    role: "customer",
  },
}

const longParagraph = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1}: the reconciliation notes below repeat on purpose so the reading pane, the reply draft area and the attachment row all stay usable when the message body grows far beyond one viewport in the long-content scene.`,
).join("\n\n")

const projectSeeds: ThreadSeed[] = [
  {
    id: "thread-project-1",
    kind: "project",
    subject: "Final review before timeline architecture handoff",
    folder: "inbox",
    spaceId: "space-renewal",
    issueId: "issue-1",
    starred: true,
    unread: true,
    participants: [customers.nina],
    lastAtLabel: "09:24",
    messages: [
      {
        author: customers.nina,
        direction: "in",
        atLabel: "09:24",
        body: "Can you confirm the resize behavior notes and the remaining calendar follow-up copy before we send this to engineering?\n\nThe timeline architecture section is approved, but I want the disabled calendar state and overlap behavior to read cleanly in the implementation brief.\n\nIf the wording looks good, I will attach it to the release thread and mark the handoff ready for review.",
        attachments: [
          {
            id: "att-project-1-a",
            name: "timeline-handoff.md",
            content:
              "# Timeline handoff\n\n- Resize handles keep a 12px hit area.\n- Disabled calendar days use muted surface, not reduced opacity.\n- Overlap preview stacks vertically above 8h events.\n",
            status: "available",
          },
          {
            id: "att-project-1-b",
            name: "calendar-copy.md",
            content:
              "Calendar copy draft v3 - empty, loading and overlap states.",
            status: "available",
          },
        ],
      },
    ],
  },
  {
    id: "thread-project-2",
    kind: "project",
    subject: "Dark mode borders are ready for one more pass",
    folder: "inbox",
    spaceId: "space-qa",
    issueId: "issue-9",
    unread: true,
    participants: [customers.ava],
    lastAtLabel: "10:02",
    messages: [
      {
        author: customers.ava,
        direction: "in",
        atLabel: "10:02",
        body: "I pushed the latest screenshots. Calendar 2 now matches the quieter border model from Calendar 1.\n\nPlease double check the board columns in dark mode as well; the divider color was still one step too bright last week.",
        attachments: [
          {
            id: "att-project-2-a",
            name: "dark-mode-review.png.txt",
            content:
              "Local screenshot summary: calendar, board and gantt borders use --border at 60% contrast.",
            status: "error",
          },
        ],
      },
    ],
  },
  {
    id: "thread-project-3",
    kind: "project",
    subject: "Kanban reorder issue looks fixed in local testing",
    folder: "inbox",
    spaceId: "space-qa",
    issueId: "issue-3",
    starred: true,
    participants: [customers.kai],
    lastAtLabel: "Yesterday",
    messages: [
      {
        author: customers.kai,
        direction: "in",
        atLabel: "Yesterday",
        body: "The drag target now uses the actual item midpoint instead of the stale list index. Reorder feels consistent across columns.\n\nI attached a short recording; the second half shows the failed case from last sprint for comparison.",
      },
    ],
  },
  {
    id: "thread-project-4",
    kind: "project",
    subject: "Partner call notes and follow-up owners",
    folder: "inbox",
    spaceId: "space-design",
    issueId: "issue-8",
    participants: [customers.morgan],
    lastAtLabel: "Mon",
    messages: [
      {
        author: customers.morgan,
        direction: "in",
        atLabel: "Mon",
        body: "The customer likes the new inbox direction. They asked for clearer owners and a simpler attachment row.\n\nI will take the attachment row spec; can someone from design own the owner badges?",
        attachments: [
          {
            id: "att-project-4-a",
            name: "partner-call-notes.docx.txt",
            content:
              "Local export unavailable for .docx in this fixture scene.",
            status: "error",
          },
        ],
      },
    ],
  },
  {
    id: "thread-project-5",
    kind: "project",
    subject: "Payout reconciliation export is ready",
    folder: "inbox",
    spaceId: "space-finance",
    participants: [
      { name: "Stripe", email: "no-reply@stripe.example", role: "system" },
    ],
    lastAtLabel: "Tue",
    messages: [
      {
        author: {
          name: "Stripe",
          email: "no-reply@stripe.example",
          role: "system",
        },
        direction: "in",
        atLabel: "Tue",
        body: "Your reconciliation export for the April payout window is ready to download from the finance workspace.\n\nThe export covers payouts, refunds and fee adjustments between 2026-04-01 and 2026-04-30.",
        attachments: [
          {
            id: "att-project-5-a",
            name: "april-reconciliation.csv",
            content:
              "payout_id,amount,currency,status\nPO-4417,12450.00,USD,paid\nPO-4418,310.50,USD,paid\n",
            status: "available",
          },
        ],
      },
    ],
  },
  {
    id: "thread-project-6",
    kind: "project",
    subject: "Sent: onboarding checklist for the renewal workspace",
    folder: "sent",
    spaceId: "space-renewal",
    participants: [customers.nina],
    lastAtLabel: "3d",
    messages: [
      {
        author: inboxAccount.project,
        direction: "out",
        atLabel: "3d",
        body: "Sharing the onboarding checklist we discussed: workspace roles, first-week metrics and the escalation path.\n\nReply here if any step is missing for your team.",
      },
    ],
  },
]

const supportSeeds: ThreadSeed[] = [
  {
    id: "thread-support-1",
    kind: "support",
    subject: "Trouble connecting Slack integration",
    folder: "inbox",
    unread: true,
    participants: [customers.sarah],
    lastAtLabel: "6h",
    messages: [
      {
        author: customers.sarah,
        direction: "in",
        atLabel: "6h",
        body: 'Hi CloudStar Support,\n\nOur team is trying to connect Slack with CloudStar, but the authorization process fails with the following error message: "OAuth token invalid." We\'ve tried reconnecting a couple of times and even restarted the workspace, but no luck.\n\nCould you help us get this integration working?\n\nThanks,\nSarah Tran\nOps Manager, BrightWave Marketing',
      },
      {
        author: inboxAccount.support,
        direction: "out",
        atLabel: "5h",
        body: "Hi Sarah,\n\nThanks for reaching out - happy to help! That error usually happens when Slack doesn't grant CloudStar the right permissions during the connection step. Reconnect once more and accept every requested permission, then let me know the result.",
      },
    ],
  },
  {
    id: "thread-support-2",
    kind: "support",
    subject: "Billing discrepancy on latest invoice",
    folder: "inbox",
    unread: true,
    participants: [customers.billing],
    lastAtLabel: "8h",
    messages: [
      {
        author: customers.billing,
        direction: "in",
        atLabel: "8h",
        body: "Our invoice for this month shows 10 Pro licenses, but we only have 8 active users. Can you review the seat list and issue a credit for the difference?\n\nThe seat export from our admin page is attached.",
        attachments: [
          {
            id: "att-support-2-a",
            name: "seat-export.csv",
            content:
              "user,role,status\nalex@brightwave.example,admin,active\n8 rows total in fixture export.\n",
            status: "available",
          },
        ],
      },
    ],
  },
  {
    id: "thread-support-3",
    kind: "support",
    subject: "Missing files in shared workspace",
    folder: "inbox",
    participants: [customers.mike],
    lastAtLabel: "6h",
    messages: [
      {
        author: customers.mike,
        direction: "in",
        atLabel: "6h",
        body: "Yesterday I uploaded a set of project files to our shared workspace. Today, two of the files are no longer visible to anyone on our side.\n\nThe activity log still shows the upload, but the files don't appear in search or in the folder where I placed them.",
      },
    ],
  },
  {
    id: "thread-support-4",
    kind: "support",
    subject: "Can't reset my password",
    folder: "inbox",
    participants: [customers.sarah],
    lastAtLabel: "12h",
    messages: [
      {
        author: customers.sarah,
        direction: "in",
        atLabel: "12h",
        body: 'I tried to reset my password using the "Forgot Password" link, but the reset email never arrives. I checked the spam folder too.\n\nCould you reset it manually for sarah.tran@brightwave.example?',
      },
    ],
  },
  {
    id: "thread-support-5",
    kind: "support",
    subject: "Closed: webhook delivery failing for staging",
    folder: "inbox",
    closed: true,
    participants: [customers.mike],
    lastAtLabel: "2d",
    messages: [
      {
        author: customers.mike,
        direction: "in",
        atLabel: "2d",
        body:
          "Deliveries to our staging webhook started returning 401 after yesterday's secret rotation.\n\n" +
          longParagraph,
      },
      {
        author: inboxAccount.support,
        direction: "out",
        atLabel: "2d",
        body: "Rotated the staging secret and re-sent the pending deliveries. Everything is green again; closing this thread unless the errors return.",
      },
    ],
  },
]

const generalSeeds: ThreadSeed[] = [
  {
    id: "thread-mail-1",
    kind: "general",
    subject: "Q4 Product Roadmap Review",
    folder: "inbox",
    unread: true,
    participants: [
      { name: "Sarah Mitchell", email: "sarah.mitchell@acme.example" },
    ],
    lastAtLabel: "09:30",
    messages: [
      {
        author: {
          name: "Sarah Mitchell",
          email: "sarah.mitchell@acme.example",
        },
        direction: "in",
        atLabel: "09:30",
        body: "Hey team,\n\nI have put together the draft roadmap for Q4 and would love your input before we finalize it next week.\n\nCan you review the attached summary and leave comments by Thursday afternoon?\n\nThanks, Sarah",
        attachments: [
          {
            id: "att-mail-1-a",
            name: "q4-roadmap-draft.pdf.txt",
            content:
              "Local text preview of q4-roadmap-draft.pdf: three themes - analytics refresh, workspace permissions, mobile search.",
            status: "available",
          },
          {
            id: "att-mail-1-b",
            name: "launch-dependencies.csv",
            content:
              "dependency,owner,status\ncalendar-copy,Nina,in review\nboard-drag,Kai,done\n",
            status: "available",
          },
        ],
      },
    ],
  },
  {
    id: "thread-mail-2",
    kind: "general",
    subject: "New brand assets ready for review",
    folder: "inbox",
    unread: true,
    participants: [{ name: "Alex Thompson", email: "alex.t@studio.example" }],
    lastAtLabel: "Yesterday",
    messages: [
      {
        author: { name: "Alex Thompson", email: "alex.t@studio.example" },
        direction: "in",
        atLabel: "Yesterday",
        body: "The updated brand guidelines and asset library are now available. I included the new color palette and usage notes.\n\nLet me know if any product surface still needs the legacy marks.",
      },
    ],
  },
  {
    id: "thread-mail-3",
    kind: "general",
    subject: "Your December payout has been initiated",
    folder: "inbox",
    participants: [
      { name: "Stripe", email: "no-reply@stripe.example", role: "system" },
    ],
    lastAtLabel: "2d",
    messages: [
      {
        author: {
          name: "Stripe",
          email: "no-reply@stripe.example",
          role: "system",
        },
        direction: "in",
        atLabel: "2d",
        body: "A payout of $12,450.00 USD has been initiated to your bank account ending in 4521.\n\nPayouts typically settle within two business days.",
      },
    ],
  },
  {
    id: "thread-mail-4",
    kind: "general",
    subject: "Weekly project digest",
    folder: "inbox",
    participants: [
      { name: "Linear", email: "digest@linear.example", role: "system" },
    ],
    lastAtLabel: "3d",
    messages: [
      {
        author: {
          name: "Linear",
          email: "digest@linear.example",
          role: "system",
        },
        direction: "in",
        atLabel: "3d",
        body: "Here is your weekly summary: 23 issues completed, 8 in progress, and 5 new issues created this week.",
      },
    ],
  },
  {
    id: "thread-mail-5",
    kind: "general",
    subject: "Contract renewal - Action required",
    folder: "inbox",
    unread: true,
    participants: [{ name: "Emma Watson", email: "emma.watson@legal.example" }],
    lastAtLabel: "4d",
    messages: [
      {
        author: { name: "Emma Watson", email: "emma.watson@legal.example" },
        direction: "in",
        atLabel: "4d",
        body:
          "Our annual contract is coming up for renewal next month. I wanted to discuss the new pricing tiers before we sign.\n\n" +
          longParagraph,
      },
    ],
  },
  {
    id: "thread-mail-6",
    kind: "general",
    subject: "Sent: Re: Series A discussion",
    folder: "sent",
    participants: [{ name: "Marcus Johnson", email: "marcus@venture.example" }],
    lastAtLabel: "5d",
    messages: [
      {
        author: inboxAccount.general,
        direction: "out",
        atLabel: "5d",
        body: "Great meeting you at TechCrunch Disrupt last week. Sharing the growth deck we discussed; happy to set up a follow-up call.",
      },
    ],
  },
  {
    id: "thread-mail-7",
    kind: "general",
    subject: "Draft: intro mail for the design partners call",
    folder: "drafts",
    participants: [{ name: "Ava Reed", email: "ava.reed@example.com" }],
    lastAtLabel: "1d",
    messages: [
      {
        author: inboxAccount.general,
        direction: "out",
        atLabel: "1d",
        body: "Hi Ava, quick intro before Thursday's call -",
      },
    ],
  },
]

const notificationSeeds: {
  id: string
  issueId: string | null
  actorId: string
  reason: Copy
  summary: Copy
  atLabel: string
  read: boolean
}[] = [
  {
    id: "notification-1",
    issueId: "issue-1",
    actorId: "member-sarah",
    reason: { "zh-CN": "附件", en: "Attachment" },
    summary: {
      "zh-CN": "Nina 附加了修订后的发布路线图",
      en: "Nina attached the revised rollout map",
    },
    atLabel: "10h",
    read: false,
  },
  {
    id: "notification-2",
    issueId: "issue-1",
    actorId: "member-michael",
    reason: { "zh-CN": "提及", en: "Mention" },
    summary: {
      "zh-CN": "Morgan 在发布交接讨论中提到了依赖关系图",
      en: "Morgan mentioned the dependency map in the launch handoff thread",
    },
    atLabel: "1w",
    read: false,
  },
  {
    id: "notification-3",
    issueId: "issue-2",
    actorId: "member-lisa",
    reason: { "zh-CN": "状态变更", en: "Status change" },
    summary: {
      "zh-CN": "交互状态已为甘特评审重命名",
      en: "Interaction states renamed for the Gantt review",
    },
    atLabel: "1d",
    read: true,
  },
  {
    id: "notification-4",
    issueId: "issue-3",
    actorId: "member-emily",
    reason: { "zh-CN": "评审", en: "Review" },
    summary: {
      "zh-CN": "筛选器现已匹配已保存的项目视图规则",
      en: "Filters now match the saved project view rules",
    },
    atLabel: "2d",
    read: false,
  },
  {
    id: "notification-5",
    issueId: "issue-3",
    actorId: "member-james",
    reason: { "zh-CN": "提及", en: "Mention" },
    summary: {
      "zh-CN": "签字前 James 标记了一个工作区筛选边界情况",
      en: "James flagged one workspace filter edge case before sign-off",
    },
    atLabel: "3d",
    read: true,
  },
  {
    id: "notification-6",
    issueId: "issue-4",
    actorId: "member-sarah",
    reason: { "zh-CN": "提及", en: "Mention" },
    summary: {
      "zh-CN": "Sarah 还需要一个拖拽调整边界情况",
      en: "Sarah asked for one more resize edge case",
    },
    atLabel: "4d",
    read: true,
  },
  {
    id: "notification-7",
    issueId: "issue-11",
    actorId: "member-emily",
    reason: { "zh-CN": "重开", en: "Reopen" },
    summary: {
      "zh-CN": "Emily 因视觉偏差重开了加载骨架评审",
      en: "Emily reopened the loading skeleton review after visual drift",
    },
    atLabel: "1w",
    read: false,
  },
  {
    id: "notification-8",
    issueId: "issue-6",
    actorId: "member-james",
    reason: { "zh-CN": "交接", en: "Handoff" },
    summary: {
      "zh-CN": "交接说明已被发布负责人接受",
      en: "Handoff notes accepted by the release owner",
    },
    atLabel: "1w",
    read: true,
  },
  {
    id: "notification-9",
    issueId: "issue-999",
    actorId: "member-lisa",
    reason: { "zh-CN": "提及", en: "Mention" },
    summary: {
      "zh-CN": "该任务已从工作区移除，通知仅在本地留存",
      en: "The issue was removed from the workspace; this notification is kept locally",
    },
    atLabel: "2w",
    read: false,
  },
  {
    id: "notification-10",
    issueId: "issue-8",
    actorId: "member-emily",
    reason: { "zh-CN": "状态变更", en: "Status change" },
    summary: {
      "zh-CN": "日历跟进页面已加入待规划",
      en: "Calendar follow-up screen was added to backlog",
    },
    atLabel: "2w",
    read: true,
  },
]

const activitySeeds: (InboxActivity & { text: Copy })[] = [
  {
    id: "activity-1",
    threadId: "thread-project-1",
    actor: "Nina Oliver",
    text: {
      "zh-CN": "Nina Oliver 从续约预测空间发起了这封邮件",
      en: "Nina Oliver raised this email from Renewal Forecast",
    },
    kind: "all",
    at: "2026-01-12T08:48:00Z",
    atLabel: "12 min",
  },
  {
    id: "activity-2",
    threadId: "thread-project-1",
    actor: "Ava Reed",
    text: {
      "zh-CN": "Ava Reed 添加了内部备注：边框对比度已复核",
      en: "Ava Reed added an internal note: border contrast reviewed",
    },
    kind: "comments",
    at: "2026-01-12T08:52:00Z",
    atLabel: "8 min",
  },
  {
    id: "activity-3",
    threadId: "thread-project-1",
    actor: "Automation",
    text: {
      "zh-CN": "自动化将该线程归入发布交接检查表",
      en: "Automation filed this thread under the release handoff checklist",
    },
    kind: "actions",
    at: "2026-01-12T08:55:00Z",
    atLabel: "5 min",
  },
]

function buildMessages(
  scenario: PmScenario,
  seed: ThreadSeed,
  atBase: number,
): { messages: InboxMessage[]; lastAt: string } {
  const extra =
    scenario === "long-content"
      ? Array.from({ length: 8 }, (_, i): ThreadSeed["messages"][number] => ({
          author: seed.participants[0] ?? seed.messages[0].author,
          direction: "in" as const,
          atLabel: `+${i + 1}h`,
          body: longParagraph,
        }))
      : []
  const all = [...seed.messages, ...extra]
  const messages = all.map((message, index): InboxMessage => ({
    id: `message-${seed.id}-${index + 1}`,
    threadId: seed.id,
    author: message.author,
    direction: message.direction,
    at: new Date(atBase + index * 3600_000).toISOString(),
    atLabel: message.atLabel,
    body:
      scenario === "long-content" && index === all.length - 1
        ? `${message.body}\n\n${longParagraph}`
        : message.body,
    attachments: message.attachments ?? [],
  }))
  return {
    messages,
    lastAt: messages[messages.length - 1]?.at ?? pmClock,
  }
}

const inboxEpoch = new Date(pmClock).getTime()
function notificationTimestamp(label: string): string | null {
  const age = /^(\d+)(h|d|w)$/.exec(label)
  if (!age) return null
  const hours = Number(age[1]) * (age[2] === "h" ? 1 : age[2] === "d" ? 24 : 168)
  return new Date(inboxEpoch - hours * 3_600_000).toISOString()
}

export function restoreInboxDomain(cached: unknown): InboxDomain {
  const state = cached as InboxDomain
  let notifications = state.notifications
  for (let index = 0; index < state.notifications.length; index += 1) {
    const notification = state.notifications[index]
    const at = notificationTimestamp(notification.atLabel)
    if (!at || at === notification.at) continue
    if (notifications === state.notifications) notifications = [...state.notifications]
    notifications[index] = { ...notification, at }
  }
  if (state.schemaVersion === 3 && notifications === state.notifications) return state
  return {
    ...state,
    schemaVersion: 3,
    notifications,
    drafts: state.schemaVersion === 3 ? state.drafts : Object.fromEntries(Object.entries(state.drafts).map(([key, draft]) => [key, draft ? { ...draft, revision: draft.revision ?? 0 } : undefined])),
    requests: state.schemaVersion === 3 ? state.requests : state.requests.map((request) => ({ ...request, cc: request.cc ?? null, draftRecipient: request.draftRecipient ?? null, draftRevision: request.draftRevision ?? null })),
  }
}

export function createInboxDomain(scenario: PmScenario): InboxDomain {
  if (scenario === "empty")
    return {
      schemaVersion: 3,
      threads: [],
      messages: [],
      notifications: [],
      notes: [],
      drafts: {},
      requests: [],
      activity: [],
      spaces,
      sequence: 0,
    }
  const scale = scenario === "long-content" ? 3 : 1
  const seeds = [...projectSeeds, ...supportSeeds, ...generalSeeds]
  const threads: InboxThread[] = []
  const messages: InboxMessage[] = []
  const atBase = new Date(pmClock).getTime() - 86_400_000
  seeds.forEach((seed, index) => {
    const built = buildMessages(scenario, seed, atBase + index * 3600_000)
    threads.push({
      id: seed.id,
      kind: seed.kind,
      subject: seed.kind === "support" ? `Re: ${seed.subject}` : seed.subject,
      folder: seed.folder,
      spaceId: seed.spaceId,
      issueId: seed.issueId,
      unread: seed.unread ?? false,
      closed: seed.closed ?? false,
      starred: seed.starred ?? false,
      participants: seed.participants,
      lastAt: built.lastAt,
      lastAtLabel: seed.lastAtLabel,
    })
    messages.push(...built.messages)
  })
  if (scenario === "long-content") {
    // Re-synthesize duplicate-id-free filler threads instead of reusing seeds.
    for (let extra = seeds.length; extra < seeds.length * scale; extra += 1) {
      const seed = seeds[extra % seeds.length]
      const suffix = Math.floor(extra / seeds.length) + 1
      const id = `${seed.id}-x${suffix}`
      const built = buildMessages(
        scenario,
        { ...seed, id },
        atBase + extra * 3600_000,
      )
      threads.push({
        id,
        kind: seed.kind,
        subject: `${seed.subject} (${suffix})`,
        folder: seed.folder,
        spaceId: seed.spaceId,
        issueId: seed.issueId,
        unread: extra % 3 === 0,
        closed: seed.closed ?? false,
        starred: false,
        participants: seed.participants,
        lastAt: built.lastAt,
        lastAtLabel: seed.lastAtLabel,
      })
      messages.push(...built.messages)
    }
  }
  const notifications =
    scenario === "long-content"
      ? Array.from({ length: 36 }, (_, index) => {
          const seed = notificationSeeds[index % notificationSeeds.length]
          return {
            ...seed,
            id: `notification-${index + 1}`,
            read: index % 4 === 0,
            atLabel: `${index + 1}d`,
          }
        })
      : notificationSeeds
  return {
    schemaVersion: 3,
    threads,
    messages,
    notifications: notifications.map((seed) => {
      const at = notificationTimestamp(seed.atLabel)
      if (!at) throw new Error(`Invalid notification fixture age: ${seed.atLabel}`)
      return {
      id: seed.id,
      issueId: seed.issueId,
      actorId: seed.actorId,
      reason: seed.reason,
      summary: seed.summary,
      at,
      atLabel: seed.atLabel,
      read: seed.read,
      }
    }),
    notes: [],
    drafts: {},
    requests: [],
    activity: activitySeeds.map((entry) => ({ ...entry })),
    spaces,
    sequence: 0,
  }
}

export function inboxThreadMessages(state: InboxDomain, threadId: string) {
  return state.messages.filter((message) => message.threadId === threadId)
}

export function inboxLastMessage(state: InboxDomain, threadId: string) {
  const list = inboxThreadMessages(state, threadId)
  return list[list.length - 1]
}

export function inboxFolderCounts(state: InboxDomain, kind: InboxThreadKind) {
  const counts: Record<InboxFolder, number> = {
    inbox: 0,
    sent: 0,
    drafts: 0,
    archive: 0,
    trash: 0,
    junk: 0,
  }
  for (const thread of state.threads)
    if (thread.kind === kind) counts[thread.folder] += 1
  return counts
}

export function inboxSpaceCounts(state: InboxDomain) {
  const counts: Record<string, number> = {}
  for (const thread of state.threads)
    if (thread.kind === "project" && thread.spaceId)
      counts[thread.spaceId] = (counts[thread.spaceId] ?? 0) + 1
  return counts
}

export function inboxUnreadCount(
  state: InboxDomain,
  kind: InboxThreadKind,
  folder: InboxFolder,
) {
  return state.threads.filter(
    (thread) =>
      thread.kind === kind && thread.folder === folder && thread.unread,
  ).length
}

export function inboxThreadDraft(
  state: InboxDomain,
  threadId: string,
  channel: InboxChannel,
) {
  return state.drafts[inboxDraftKey(threadId, channel)]
}

export function updateInboxDraft(
  state: InboxDomain,
  threadId: string,
  channel: InboxChannel,
  patch: Partial<InboxDraft>,
): InboxDomain {
  const key = inboxDraftKey(threadId, channel)
  const current = state.drafts[key] ?? { recipient: "", cc: "", body: "", revision: 0 }
  return {
    ...state,
    drafts: { ...state.drafts, [key]: { ...current, ...patch, revision: current.revision + 1 } },
  }
}

function pushRequest(
  state: InboxDomain,
  request: Omit<InboxRequest, "operationId">,
): { state: InboxDomain; request: InboxRequest } {
  const operationId = `send-${state.sequence + 1}`
  const full: InboxRequest = { ...request, operationId }
  return {
    state: {
      ...state,
      sequence: state.sequence + 1,
      requests: [...state.requests, full],
    },
    request: full,
  }
}

export function inboxPendingRequest(
  state: InboxDomain,
  threadId: string,
  channel: InboxChannel,
) {
  const list = state.requests.filter(
    (request) => request.threadId === threadId && request.channel === channel,
  )
  return list[list.length - 1]
}

/**
 * Sending is an explicit confirm. Unknown outcomes retain the request and lock
 * the channel; rejected outcomes retain the request error and the draft.
 * Readonly/loading scenes never mutate.
 */
export function sendInboxDraft(
  state: InboxDomain,
  threadId: string,
  channel: InboxChannel,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  const pending = inboxPendingRequest(state, threadId, channel)
  if (pending?.status === "unknown") return state
  const draft = inboxThreadDraft(state, threadId, channel)
  if (!draft) return state
  const thread = state.threads.find((item) => item.id === threadId)
  // Support replies and notification notes address an existing correspondent;
  // project/general mail must carry a validated recipient. Resolve the
  // recipient before validating so a reply that never edited the recipient
  // field still sends to the thread's correspondent.
  const recipientRequired =
    thread?.kind === "project" || thread?.kind === "general"
  const recipient = recipientRequired
    ? draft.recipient
    : draft.recipient || thread?.participants[0]?.email || ""
  if (
    validateInboxDraft(
      { recipient, cc: draft.cc, body: draft.body },
      recipientRequired,
    )
  )
    return state
  const outcome = inboxSendOutcome(threadId, channel)
  const pushed = pushRequest(state, {
    threadId,
    channel,
    recipient,
    cc: draft.cc,
    draftRecipient: draft.recipient,
    draftRevision: draft.revision,
    body: draft.body,
    status: outcome,
    error:
      outcome === "rejected"
        ? {
            "zh-CN": "本地模拟服务器拒绝了这次发送，草稿已保留。",
            en: "The local simulated server rejected this send; your draft is kept.",
          }
        : undefined,
  })
  let next = pushed.state
  if (outcome === "confirmed") next = applyInboxSend(next, pushed.request)
  return next
}

function applyInboxSend(
  state: InboxDomain,
  request: InboxRequest,
): InboxDomain {
  const key = inboxDraftKey(request.threadId, request.channel)
  const drafts = Object.fromEntries(
    Object.entries(state.drafts).filter(([draftKey, draft]) => draftKey !== key || !draft || request.draftRevision === null ||
      draft.revision !== request.draftRevision || draft.body !== request.body ||
      draft.recipient !== request.draftRecipient || draft.cc !== request.cc),
  ) as InboxDomain["drafts"]
  const thread = state.threads.find((item) => item.id === request.threadId)
  if (thread && request.channel === "note") {
    const note: InboxNote = { id: `note-${request.operationId}`, notificationId: request.threadId, channel: "note", body: request.body, at: pmClock }
    return { ...state, drafts, notes: [...state.notes, note], activity: [...state.activity, { id: `activity-${request.operationId}`, threadId: request.threadId, actor: inboxAccount[thread.kind].name, kind: "comments", text: { "zh-CN": "添加了本地内部备注", en: "Added a local internal comment" }, at: pmClock, atLabel: "now" }] }
  }
  if (thread) {
    const message: InboxMessage = {
      id: `message-${request.operationId}`,
      threadId: request.threadId,
      author: inboxAccount[thread.kind],
      direction: "out",
      recipient: request.recipient,
      cc: request.cc,
      at: pmClock,
      atLabel: copy("en" as InboxLocale, "刚刚", "now"),
      body: request.body,
      attachments: [],
    }
    return {
      ...state,
      drafts,
      messages: [...state.messages, message],
      threads: state.threads.map((item) =>
        item.id === request.threadId
          ? {
              ...item,
              lastAt: message.at,
              lastAtLabel: message.atLabel,
              unread: false,
              folder: item.folder === "drafts" ? "sent" : item.folder,
            }
          : item,
      ),
    }
  }
  const note: InboxNote = {
    id: `note-${request.operationId}`,
    notificationId: request.threadId,
    channel: request.channel,
    body: request.body,
    at: pmClock,
  }
  return { ...state, drafts, notes: [...state.notes, note] }
}

/** Explicit resolution of an unknown send. Exactly once per request. */
export function checkInboxRequest(
  state: InboxDomain,
  threadId: string,
  channel: InboxChannel,
  resolution: "confirmed" | "rejected" = "confirmed",
): InboxDomain {
  const request = inboxPendingRequest(state, threadId, channel)
  if (!request || request.status !== "unknown") return state
  const resolved: InboxRequest =
    resolution === "confirmed"
      ? { ...request, status: "confirmed" }
      : {
          ...request,
          status: "rejected",
          error: {
            "zh-CN": "确认后仍未送达，草稿保留在本地。",
            en: "Delivery still failed after checking; the draft stays local.",
          },
        }
  const requests = state.requests.map((item) =>
    item.operationId === request.operationId ? resolved : item,
  )
  if (resolution === "rejected") return { ...state, requests }
  return applyInboxSend({ ...state, requests }, resolved)
}

export function markNotificationRead(
  state: InboxDomain,
  notificationId: string,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  return {
    ...state,
    notifications: state.notifications.map((item) =>
      item.id === notificationId ? { ...item, read: true } : item,
    ),
  }
}

export function markAllNotificationsRead(
  state: InboxDomain,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  return {
    ...state,
    notifications: state.notifications.map((item) => ({ ...item, read: true })),
  }
}

export function markThreadRead(
  state: InboxDomain,
  threadId: string,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  return {
    ...state,
    threads: state.threads.map((item) =>
      item.id === threadId ? { ...item, unread: false } : item,
    ),
  }
}

export function markThreadUnread(
  state: InboxDomain,
  threadId: string,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  return {
    ...state,
    threads: state.threads.map((item) =>
      item.id === threadId ? { ...item, unread: true } : item,
    ),
  }
}

export function toggleThreadStar(
  state: InboxDomain,
  threadId: string,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  return {
    ...state,
    threads: state.threads.map((item) =>
      item.id === threadId ? { ...item, starred: !item.starred } : item,
    ),
  }
}

export function setThreadFolder(
  state: InboxDomain,
  threadId: string,
  folder: InboxFolder,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  return {
    ...state,
    threads: state.threads.map((item) =>
      item.id === threadId ? { ...item, folder } : item,
    ),
  }
}

export function setThreadClosed(
  state: InboxDomain,
  threadId: string,
  closed: boolean,
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  return {
    ...state,
    threads: state.threads.map((item) =>
      item.id === threadId ? { ...item, closed } : item,
    ),
  }
}

export function createInboxDraftThread(
  state: InboxDomain,
  input: { recipient: string; subject: string; body: string },
  readonly: boolean,
): InboxDomain {
  if (readonly) return state
  const id = `thread-draft-${state.sequence + 1}`
  const thread: InboxThread = {
    id,
    kind: "project",
    subject: input.subject || copy("en", "无主题草稿", "Untitled draft"),
    folder: "drafts",
    spaceId: "space-renewal",
    unread: false,
    closed: false,
    starred: false,
    participants: [{ name: input.recipient, email: input.recipient }],
    lastAt: pmClock,
    lastAtLabel: copy("en", "刚刚", "now"),
  }
  return {
    ...state,
    sequence: state.sequence + 1,
    threads: [thread, ...state.threads],
    drafts: { ...state.drafts, [inboxDraftKey(id, "reply")]: { recipient: input.recipient, cc: "", body: input.body, revision: 0, savedAt: pmClock } },
  }
}

export function notificationActor(notification: InboxNotification) {
  return pmMembers.find((member) => member.id === notification.actorId)
}

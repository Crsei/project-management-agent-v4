"use client"
import { useId, useState } from "react"
import {
  Check,
  ChevronDown,
  Copy,
  FileText,
  ListChecks,
  RefreshCw,
  Settings2,
  Share2,
  Sparkles,
} from "lucide-react"
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Label,
} from "./ui"
import { Markdown } from "./markdown"
import { ConversationInput } from "./input"
import { LocalArtifactPreview } from "./artifacts"
import type { ComposerHost } from "../composer-workspace-view"
import { ThreadMessage, ThreadView } from "./shared"
import type { Conversation4Controller } from "./conversation-4-controller"
import styles from "./conversation-4.module.css"

export function Conversation4View({
  controller,
  host,
}: {
  controller: Conversation4Controller
  host: ComposerHost
}) {
  const { copy, label, meeting, attachDetailScroll } = controller
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const actionsId = useId()
  const actionControlId = useId()
  const transcriptId = useId()
  const inputHelpId = useId()
  const groups = [
    { id: "today", title: label("今天", "Today") },
    { id: "yesterday", title: label("昨天", "Yesterday") },
    { id: "week", title: label("本周", "This week") },
  ]
  return (
    <>
      <ThreadView
        page="conversation-4"
        controller={controller}
        host={host}
        layout="document"
        title={{
          "zh-CN": "会议洞察与行动",
          en: "Custom artifacts and actions",
        }}
        showSessionNavigation={false}
        pageHeader={
          <header className={styles.header}>
            <span>
              {label("会议洞察与行动", "Custom artifacts and actions")}
            </span>
            <Button
              variant="ghost"
              onClick={() => void controller.copyEmail()}
              aria-label={label(
                "分享邮件草稿（复制到本地剪贴板）",
                "Share email draft (copy to local clipboard)",
              )}
            >
              <Share2 />
              {label("分享", "Share")}
            </Button>
          </header>
        }
        renderMessage={(message) => (
          <ThreadMessage message={message} controller={controller} />
        )}
        body={
          <div className={styles.workspace}>
            <nav
              className={styles.navigation}
              aria-label={label("会议导航", "Meeting navigation")}
            >
              <div className={styles.navigationTools}>
                <Button
                  variant="ghost"
                  onClick={() =>
                    document
                      .getElementById(actionsId)
                      ?.scrollIntoView({ block: "start" })
                  }
                >
                  <ListChecks />
                  {label("行动", "Actions")}
                </Button>
                <Button variant="ghost" onClick={controller.scrollToInsights}>
                  <Sparkles />
                  {label("洞察", "Insights")}
                </Button>
              </div>
              <div className={styles.meetingList}>
                {groups.map((group) => (
                  <section key={group.id} aria-label={group.title}>
                    <h2>{group.title}</h2>
                    {controller.meetings
                      .filter((item) => item.group === group.id)
                      .map((item) => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          className={styles.meetingButton}
                          aria-current={
                            item.id === meeting.id ? "page" : undefined
                          }
                          onClick={() => controller.selectMeeting(item.id)}
                        >
                          {copy(item.title)}
                        </Button>
                      ))}
                  </section>
                ))}
              </div>
              <Button
                variant="ghost"
                className={styles.settings}
                onClick={controller.openSettings}
              >
                <Settings2 />
                {label("工作空间设置", "Workspace settings")}
              </Button>
            </nav>
            <div className={styles.main}>
              <div
                ref={attachDetailScroll}
                className={styles.scroll}
                tabIndex={0}
                role="region"
                aria-label={label("会议洞察详情", "Meeting insight details")}
              >
                {controller.empty ? (
                  <div className={styles.document}>
                    <h1>{label("暂无会议洞察", "No meeting insights")}</h1>
                    <p>
                      {label(
                        "此空场景没有生成的纪要。仍可编辑本地问题草稿或查看转录来源。",
                        "This empty scenario has no generated notes. You can still edit a local question draft or inspect the transcript source.",
                      )}
                    </p>
                  </div>
                ) : (
                  <article className={styles.document}>
                    <p className={styles.metadata}>
                      {copy(meeting.time)} · {meeting.duration}{" "}
                      {label("分钟", "minutes")}
                    </p>
                    <div className={styles.titleRow}>
                      <h1>{copy(meeting.title)}</h1>
                      <Button
                        variant="outline"
                        disabled={controller.readState === "loading"}
                        onClick={controller.regenerate}
                      >
                        <RefreshCw />
                        {label("重新生成", "Regenerate")}
                      </Button>
                    </div>
                    <p className={styles.summary}>
                      {copy(
                        controller.revision % 2
                          ? meeting.regeneratedSummary
                          : meeting.summary,
                      )}
                    </p>
                    <section
                      className={styles.summarySection}
                      aria-label={label("摘要", "Summary")}
                    >
                      <h2>{label("摘要", "Summary")}</h2>
                      <ol className={styles.points}>
                        {meeting.points.map((point, index) => (
                          <li key={index}>
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            <p>{copy(point)}</p>
                          </li>
                        ))}
                      </ol>
                    </section>
                    <section
                      id={actionsId}
                      className={styles.actions}
                      aria-label={label("行动项", "Action items")}
                    >
                      <div className={styles.sectionHeading}>
                        <h2>{label("行动", "Actions")}</h2>
                        <span>
                          {label("从转录生成", "Generated from transcript")}
                        </span>
                      </div>
                      <section
                        className={styles.email}
                        aria-label={label("跟进邮件", "Follow-up email")}
                      >
                        <div className={styles.emailHeader}>
                          <h3>{label("跟进邮件", "Follow-up email")}</h3>
                          <span>
                            <Check size={14} />
                            {label("待审阅", "Ready to review")}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={label(
                              "复制邮件草稿",
                              "Copy email draft",
                            )}
                            onClick={() => void controller.copyEmail()}
                          >
                            <Copy />
                          </Button>
                        </div>
                        <dl className={styles.emailFields}>
                          <div>
                            <dt>To</dt>
                            <dd>{meeting.email.to}</dd>
                          </div>
                          <div>
                            <dt>Subject</dt>
                            <dd>{copy(meeting.email.subject)}</dd>
                          </div>
                        </dl>
                        <div className={styles.emailBody}>
                          <Markdown
                            content={copy(meeting.email.body)}
                            locale={controller.locale}
                          />
                        </div>
                        <p className={styles.localNotice}>
                          {label(
                            "本地邮件草稿 · 未发送",
                            "Local email draft · not sent",
                          )}
                        </p>
                      </section>
                      <div className={styles.checklist}>
                        {controller.actions.map((item) => (
                          <div key={item.id} className={styles.actionItem}>
                            <Checkbox
                              id={`${actionControlId}-${item.id}`}
                              checked={item.done}
                              onCheckedChange={(value) =>
                                controller.setDone(item.id, value === true)
                              }
                              aria-label={
                                label("完成", "Complete") +
                                ": " +
                                copy(item.title)
                              }
                            />
                            <Label htmlFor={`${actionControlId}-${item.id}`}>
                              {copy(item.title)}
                            </Label>
                            <small>{item.owner}</small>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section
                      className={styles.artifacts}
                      aria-label={label("会议产物", "Meeting artifacts")}
                    >
                      <h2>{label("会议产物", "Meeting artifacts")}</h2>
                      {controller.artifacts.map((item) => (
                        <div key={item.id} className={styles.artifact}>
                          <Button
                            variant="outline"
                            className={styles.artifactButton}
                            disabled={!item.available}
                            aria-describedby={
                              !item.available
                                ? `${actionControlId}-artifact-${item.id}`
                                : undefined
                            }
                            onClick={() => controller.openArtifact(item.id)}
                          >
                            <FileText aria-hidden="true" />
                            <span>
                              <strong>{item.name}</strong>
                              <small>{copy(item.title)}</small>
                            </span>
                          </Button>
                          {!item.available && (
                            <p
                              id={`${actionControlId}-artifact-${item.id}`}
                              className={styles.artifactError}
                              role="status"
                            >
                              {label(
                                "产物引用已失效，会议和草稿保留。",
                                "Artifact unavailable; the meeting and draft are preserved.",
                              )}
                            </p>
                          )}
                        </div>
                      ))}
                    </section>
                    {controller.revision > 0 && (
                      <p className={styles.localNotice}>
                        {label("本地生成版本", "Local generation revision")}{" "}
                        {controller.revision + 1}
                      </p>
                    )}
                  </article>
                )}
                <div className={styles.document}>
                  <Collapsible
                    open={transcriptOpen}
                    onOpenChange={setTranscriptOpen}
                  >
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost">
                        <FileText />
                        {label("转录", "Transcript")} · {copy(meeting.title)}
                        <ChevronDown
                          aria-hidden="true"
                          className={styles.transcriptChevron}
                        />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent id={transcriptId}>
                      <div className={styles.transcript}>
                        <Markdown
                          content={copy(meeting.transcript)}
                          locale={controller.locale}
                        />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                  {controller.followUps.map((message) => (
                    <ThreadMessage
                      key={message.id}
                      message={message}
                      controller={controller}
                      author={
                        message.role === "assistant"
                          ? label("会议助手", "Meeting assistant")
                          : undefined
                      }
                      agentRole={label("本地示例", "Local demo")}
                    />
                  ))}
                </div>
              </div>
              <div className={styles.input}>
                {controller.notice && (
                  <p role="status" className={styles.localNotice}>
                    {copy(controller.notice)}
                  </p>
                )}
                <ConversationInput
                  controller={controller}
                  helpId={inputHelpId}
                  options={{
                    hideSuggestion: true,
                    showBlocksControl: false,
                    placeholder: {
                      "zh-CN": `询问${meeting.title["zh-CN"]}`,
                      en: `Ask about the ${meeting.title.en.toLowerCase()}`,
                    },
                    inputLabel: {
                      "zh-CN": "会议问题草稿",
                      en: "Meeting question draft",
                    },
                    tools: (
                      <Button
                        variant="ghost"
                        aria-expanded={transcriptOpen}
                        aria-controls={transcriptId}
                        onClick={() => {
                          setTranscriptOpen((value) => !value)
                          controller.scrollToTranscript()
                        }}
                      >
                        <FileText />
                        {label("转录", "Transcript")}
                      </Button>
                    ),
                    helpText: {
                      "zh-CN":
                        "本地会议示例 · 不调用模型、不发送邮件。Enter 提交，Shift+Enter 换行。",
                      en: "Local meeting demo · no model calls or email sending. Enter submits; Shift+Enter adds a line.",
                    },
                  }}
                />
              </div>
            </div>
          </div>
        }
      />
      <LocalArtifactPreview
        controller={controller}
        messageId="conversation-4-answer"
      />
    </>
  )
}

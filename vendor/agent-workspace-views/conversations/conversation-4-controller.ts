"use client"
import { useLayoutEffect, useRef, useState, type RefObject } from "react"
import { useArtifactPreview } from "./artifacts"
import { useThreadController, type ThreadController } from "./shared"
import type { ChatEntry, Copy, Draft } from "../model"
import type {
  Conversation4Fixture,
  Conversation4Scenario,
  MeetingAction,
  MeetingArtifact,
  MeetingInsight,
} from "./conversation-4-fixtures"

export interface Conversation4Controller extends ThreadController {
  meetings: MeetingInsight[]
  meeting: MeetingInsight
  empty: boolean
  actions: MeetingAction[]
  revision: number
  followUps: ChatEntry[]
  notice: Copy | null
  attachDetailScroll: (element: HTMLDivElement | null) => void
  scrollToInsights: () => void
  scrollToTranscript: () => void
  selectMeeting: (id: string) => void
  regenerate: () => void
  setDone: (id: string, done: boolean) => void
  copyEmail: () => Promise<void>
  artifacts: readonly MeetingArtifact[]
  artifact: MeetingArtifact | undefined
  setArtifactId: (id: string | null) => void
  finalFocus: RefObject<HTMLElement | null>
  openArtifact: (id: string) => void
}

export function useConversation4Controller(
  fixture: Conversation4Fixture,
  scenario: Conversation4Scenario,
  active: boolean,
): Conversation4Controller {
  const base = useThreadController(fixture.source, scenario, active)
  const [meetingId, setMeetingId] = useState(fixture.meetings[0].id)
  const [actionsByMeeting, setActions] = useState<
    Record<string, MeetingAction[]>
  >(() =>
    Object.fromEntries(
      fixture.meetings.map((meeting) => [
        meeting.id,
        structuredClone(meeting.actions),
      ]),
    ),
  )
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const [followUps, setFollowUps] = useState<Record<string, ChatEntry[]>>({})
  const [notice, setNotice] = useState<Copy | null>(null)
  const drafts = useRef<Record<string, Draft>>({})
  const positions = useRef<Record<string, number>>({})
  const detailScroll = useRef<HTMLDivElement | null>(null)
  const meeting =
    fixture.meetings.find((item) => item.id === meetingId) ??
    fixture.meetings[0]
  const revision = revisions[meetingId] ?? 0
  const summary = revision % 2 ? meeting.regeneratedSummary : meeting.summary
  const artifacts: MeetingArtifact[] = fixture.artifacts.map((item) => ({
    ...item,
    content:
      item.id === "email"
        ? {
            "zh-CN": `To: ${meeting.email.to}\nSubject: ${meeting.email.subject["zh-CN"]}\n\n${meeting.email.body["zh-CN"]}\n\n本地草稿，未发送。`,
            en: `To: ${meeting.email.to}\nSubject: ${meeting.email.subject.en}\n\n${meeting.email.body.en}\n\nLocal draft; not sent.`,
          }
        : {
            "zh-CN": `# ${meeting.title["zh-CN"]}\n\n${summary["zh-CN"]}\n\n${meeting.points.map((point, index) => `${index + 1}. ${point["zh-CN"]}`).join("\n")}`,
            en: `# ${meeting.title.en}\n\n${summary.en}\n\n${meeting.points.map((point, index) => `${index + 1}. ${point.en}`).join("\n")}`,
          },
  }))
  const artifact = useArtifactPreview(artifacts)
  useLayoutEffect(() => {
    if (detailScroll.current)
      detailScroll.current.scrollTop = positions.current[meetingId] ?? 0
  }, [meetingId])
  return {
    ...base,
    ...artifact,
    meetings: fixture.meetings,
    meeting,
    empty: fixture.empty,
    actions: actionsByMeeting[meetingId],
    revision,
    followUps: followUps[meetingId] ?? [],
    notice,
    attachDetailScroll: (element) => {
      detailScroll.current = element
    },
    scrollToInsights: () => detailScroll.current?.scrollTo({ top: 0 }),
    scrollToTranscript: () =>
      requestAnimationFrame(() =>
        detailScroll.current?.scrollTo({
          top: detailScroll.current.scrollHeight,
        }),
      ),
    selectMeeting: (id) => {
      if (!fixture.meetings.some((item) => item.id === id) || id === meetingId)
        return
      drafts.current[meetingId] = {
        ...base.draft,
        contextIds: [...base.draft.contextIds],
      }
      positions.current[meetingId] = detailScroll.current?.scrollTop ?? 0
      base.updateDraft(
        drafts.current[id] ?? { ...base.draft, text: "", contextIds: [] },
      )
      artifact.setArtifactId(null)
      setNotice(null)
      setMeetingId(id)
    },
    regenerate: () => {
      if (base.readState === "loading") return
      setRevisions((previous) => ({
        ...previous,
        [meetingId]: (previous[meetingId] ?? 0) + 1,
      }))
      setNotice({
        "zh-CN":
          "已从本地转录重新生成洞察；行动项与草稿保持不变，未调用模型服务。",
        en: "Insights regenerated from the local transcript; actions and drafts are unchanged. No model service was called.",
      })
    },
    setDone: (id, done) =>
      setActions((previous) => ({
        ...previous,
        [meetingId]: previous[meetingId].map((item) =>
          item.id === id ? { ...item, done } : item,
        ),
      })),
    copyEmail: async () => {
      try {
        await navigator.clipboard.writeText(
          `To: ${meeting.email.to}\nSubject: ${base.copy(meeting.email.subject)}\n\n${base.copy(meeting.email.body)}`,
        )
        setNotice({
          "zh-CN": "邮件草稿已复制，未发送邮件。",
          en: "Email draft copied. No email was sent.",
        })
      } catch {
        setNotice({
          "zh-CN": "无法访问剪贴板，请选择邮件正文手动复制。草稿未改变。",
          en: "Clipboard access failed. Select the email text to copy manually; the draft is unchanged.",
        })
      }
    },
    sendMessage: () => {
      if (!base.canSend || !base.draft.text.trim()) return
      const count = (followUps[meetingId]?.length ?? 0) / 2
      const question: ChatEntry = {
        id: `${meetingId}-question-${count}`,
        role: "user",
        text: base.draft.text,
      }
      const answer: ChatEntry = {
        id: `${meetingId}-answer-${count}`,
        role: "assistant",
        text: {
          "zh-CN": `本地会议转录摘要：${summary["zh-CN"]}\n\n这是固定会议示例回复，未调用模型或发送邮件。`,
          en: `Local meeting transcript summary: ${summary.en}\n\nThis is a fixed meeting demo response. No model was called and no email was sent.`,
        },
      }
      setFollowUps((previous) => ({
        ...previous,
        [meetingId]: [...(previous[meetingId] ?? []), question, answer],
      }))
      base.updateDraft({ text: "" })
    },
  }
}

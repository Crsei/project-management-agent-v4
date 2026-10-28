import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
import type { ComposerDemoSource } from "../demo-source"
import type { Copy } from "../model"
import type { LocalArtifact } from "./artifact-model.ts"

export const conversation4Scenarios = [
  ...commonScenarios,
  { id: "unavailable", name: { "zh-CN": "产物失效", en: "Unavailable" } },
] as const
export type Conversation4Scenario = CommonScenario | "unavailable"
export type MeetingArtifact = LocalArtifact
export type MeetingAction = {
  id: string
  title: Copy
  owner: string
  done: boolean
}
export interface MeetingInsight {
  id: string
  group: "today" | "yesterday" | "week"
  title: Copy
  time: Copy
  duration: number
  summary: Copy
  regeneratedSummary: Copy
  points: Copy[]
  actions: MeetingAction[]
  email: { to: string; subject: Copy; body: Copy }
  transcript: Copy
}
export interface Conversation4Fixture {
  source: ComposerDemoSource
  meetings: MeetingInsight[]
  artifacts: MeetingArtifact[]
  actions: MeetingAction[]
  empty: boolean
}

const kickoff: MeetingInsight = {
  id: "weekly-kickoff",
  group: "today",
  title: { "zh-CN": "每周启动会", en: "Weekly kickoff" },
  time: { "zh-CN": "周一，上午 9:30", en: "Monday, 9:30 AM" },
  duration: 42,
  summary: {
    "zh-CN":
      "团队的激活率有所提升，支持请求量下降。本周重点是发布模板合集、明确企业入门流程的负责人，并验证新的产品表格密度系统。",
    en: "The team reported stronger activation and lower support volume. This week centers on shipping the template collection, clarifying enterprise onboarding ownership, and validating the new product table density system.",
  },
  regeneratedSummary: {
    "zh-CN":
      "激活率提升 12.5%，支持请求量下降 18%。模板合集仍计划周四发布；发布候选版之前，团队将确认企业安全审查负责人，并验证平衡表格密度。",
    en: "Activation is up 12.5% and support volume is down 18%. The template collection is still scheduled for Thursday; before the release candidate, the team will confirm enterprise security review ownership and validate balanced table density.",
  },
  points: [
    {
      "zh-CN": "简化首次使用清单后，激活率提升了 12.5%",
      en: "Activation improved 12.5% after simplifying the first-run checklist",
    },
    {
      "zh-CN": "模板发布仍按计划于周四进行",
      en: "The template launch remains on schedule for Thursday",
    },
    {
      "zh-CN": "导航更新后，支持请求量下降了 18%",
      en: "Support volume fell 18% after the navigation update",
    },
    {
      "zh-CN": "企业入门流程需要明确安全审查的负责人",
      en: "Enterprise onboarding needs a clearer owner for security reviews",
    },
    {
      "zh-CN": "团队将在本周测试新的表格密度默认值",
      en: "The team will test the new table density defaults this week",
    },
  ],
  actions: [
    {
      id: "design",
      title: { "zh-CN": "完成界面审阅", en: "Complete UI review" },
      owner: "Design",
      done: true,
    },
    {
      id: "security",
      title: {
        "zh-CN": "确认企业安全审查负责人",
        en: "Confirm enterprise security review owner",
      },
      owner: "Product",
      done: false,
    },
    {
      id: "keyboard",
      title: {
        "zh-CN": "验证表格密度、键盘与失败恢复",
        en: "Validate table density, keyboard and recovery",
      },
      owner: "Engineering",
      done: false,
    },
  ],
  email: {
    to: "product-team@acme.co",
    subject: {
      "zh-CN": "每周启动会 — 决策与下一步",
      en: "Weekly kickoff — decisions and next steps",
    },
    body: {
      "zh-CN":
        "团队各位好，\n\n感谢这次高效的启动会。激活率与支持请求趋势正在向好的方向发展，模板发布仍按计划在周四进行。\n\n本周我们将确认企业安全审查的负责人，并在发布候选版之前验证平衡表格密度。\n\n谢谢！",
      en: "Hi team,\n\nThanks for a focused kickoff. Activation and support trends are moving in the right direction, and the template launch remains on track for Thursday.\n\nThis week we’ll confirm an owner for enterprise security reviews and validate the balanced table density before the release candidate is cut.\n\nThanks!",
    },
  },
  transcript: {
    "zh-CN":
      "09:30 · 产品：首次使用清单简化后，激活率提升 12.5%。\n09:38 · 工程：模板合集预计周四发布。\n09:45 · 支持：导航更新让支持请求量下降 18%。\n09:55 · 产品：企业安全审查需要明确负责人。\n10:04 · 设计：本周验证平衡表格密度。\n10:12 · 会议结束。",
    en: "09:30 · Product: Activation improved 12.5% after the first-run checklist was simplified.\n09:38 · Engineering: The template collection is on track for Thursday.\n09:45 · Support: Navigation updates reduced support volume by 18%.\n09:55 · Product: Enterprise security reviews need a clear owner.\n10:04 · Design: Validate balanced table density this week.\n10:12 · Meeting ends.",
  },
}

const otherMeetings: {
  id: string
  group: MeetingInsight["group"]
  title: Copy
  time: Copy
  duration: number
  focus: Copy
  owner: string
}[] = [
  {
    id: "all-hands",
    group: "today",
    title: { "zh-CN": "公司全员会", en: "Company all-hands" },
    time: { "zh-CN": "周一，上午 11:00", en: "Monday, 11:00 AM" },
    duration: 55,
    focus: {
      "zh-CN": "季度目标与模板发布",
      en: "quarterly goals and the template launch",
    },
    owner: "Leadership",
  },
  {
    id: "audio-test",
    group: "yesterday",
    title: { "zh-CN": "音频测试会议", en: "Audio test meeting" },
    time: { "zh-CN": "周日，上午 10:00", en: "Sunday, 10:00 AM" },
    duration: 12,
    focus: {
      "zh-CN": "录音清晰度与转录质量",
      en: "recording clarity and transcript quality",
    },
    owner: "Engineering",
  },
  {
    id: "brian",
    group: "yesterday",
    title: { "zh-CN": "与 Brian 的一对一", en: "1:1 with Brian" },
    time: { "zh-CN": "周日，下午 1:00", en: "Sunday, 1:00 PM" },
    duration: 30,
    focus: {
      "zh-CN": "企业入门流程与安全审查交接",
      en: "enterprise onboarding and security review handoff",
    },
    owner: "Brian",
  },
  {
    id: "alex",
    group: "yesterday",
    title: { "zh-CN": "与 Alex 的一对一", en: "1:1 with Alex" },
    time: { "zh-CN": "周日，下午 2:00", en: "Sunday, 2:00 PM" },
    duration: 25,
    focus: {
      "zh-CN": "导航支持反馈与问题分派",
      en: "navigation support feedback and issue ownership",
    },
    owner: "Alex",
  },
  {
    id: "project-kickoff",
    group: "week",
    title: { "zh-CN": "项目启动会", en: "Project kickoff" },
    time: { "zh-CN": "周五，上午 9:00", en: "Friday, 9:00 AM" },
    duration: 45,
    focus: {
      "zh-CN": "模板合集范围与发布验收",
      en: "template collection scope and release acceptance",
    },
    owner: "Product",
  },
  {
    id: "jordan",
    group: "week",
    title: { "zh-CN": "与 Jordan 的团队同步", en: "Team sync with Jordan" },
    time: { "zh-CN": "周四，上午 10:00", en: "Thursday, 10:00 AM" },
    duration: 35,
    focus: {
      "zh-CN": "发布依赖与工程验证",
      en: "release dependencies and engineering validation",
    },
    owner: "Jordan",
  },
  {
    id: "maya",
    group: "week",
    title: { "zh-CN": "与 Maya 的设计审阅", en: "Design review with Maya" },
    time: { "zh-CN": "周三，下午 2:00", en: "Wednesday, 2:00 PM" },
    duration: 40,
    focus: {
      "zh-CN": "产品表格密度与键盘体验",
      en: "product table density and keyboard experience",
    },
    owner: "Maya",
  },
  {
    id: "concepts",
    group: "week",
    title: { "zh-CN": "初步概念讨论", en: "Initial concepts discussion" },
    time: { "zh-CN": "周二，上午 11:00", en: "Tuesday, 11:00 AM" },
    duration: 50,
    focus: {
      "zh-CN": "模板概念与首次使用体验",
      en: "template concepts and the first-run experience",
    },
    owner: "Design",
  },
]

export function createConversation4Fixture(
  scenario: Conversation4Scenario,
): Conversation4Fixture {
  const meetings: MeetingInsight[] = [
    structuredClone(kickoff),
    ...otherMeetings.map((item): MeetingInsight => ({
      ...item,
      summary: {
        "zh-CN": `团队审阅了${item.focus["zh-CN"]}，确认当前范围、负责人及下一次审阅前需要完成的工作。`,
        en: `The team reviewed ${item.focus.en}, confirmed scope and ownership, and agreed on work to complete before the next review.`,
      },
      regeneratedSummary: {
        "zh-CN": `${item.owner} 负责推进${item.focus["zh-CN"]}。本次会议明确范围、待处理风险、验证证据和下次审阅的交接安排。`,
        en: `${item.owner} owns progress on ${item.focus.en}. The meeting clarified scope, outstanding risks, validation evidence, and the handoff for the next review.`,
      },
      points: [
        {
          "zh-CN": `确认${item.focus["zh-CN"]}的当前范围`,
          en: `Confirm the scope of ${item.focus.en}`,
        },
        {
          "zh-CN": `${item.owner} 负责下一步交接`,
          en: `${item.owner} owns the next handoff`,
        },
        {
          "zh-CN": "记录当前反馈与未解决的问题",
          en: "Record current feedback and unresolved questions",
        },
        {
          "zh-CN": "下次审阅前补齐验证证据",
          en: "Complete validation evidence before the next review",
        },
        {
          "zh-CN": "在下一次同步中审阅结果",
          en: "Review results at the next sync",
        },
      ],
      actions: [
        {
          id: `${item.id}-review`,
          title: {
            "zh-CN": `准备${item.focus["zh-CN"]}的审阅材料`,
            en: `Prepare review evidence for ${item.focus.en}`,
          },
          owner: item.owner,
          done: false,
        },
      ],
      email: {
        to: "product-team@acme.co",
        subject: {
          "zh-CN": `${item.title["zh-CN"]} — 决策与下一步`,
          en: `${item.title.en} — decisions and next steps`,
        },
        body: {
          "zh-CN": `团队各位好，\n\n本次会议讨论了${item.focus["zh-CN"]}。${item.owner} 将整理待处理问题与验证证据，并在下次审阅中汇报。\n\n谢谢！`,
          en: `Hi team,\n\nWe reviewed ${item.focus.en}. ${item.owner} will collect unresolved questions and validation evidence, then share results at the next review.\n\nThanks!`,
        },
      },
      transcript: {
        "zh-CN": `${item.owner}：今天审阅${item.focus["zh-CN"]}。\n团队：确认范围，记录反馈，并补齐验证证据。\n${item.owner}：我来负责下一次审阅的交接。`,
        en: `${item.owner}: Today we review ${item.focus.en}.\nTeam: Confirm scope, record feedback, and complete validation evidence.\n${item.owner}: I will own the handoff for the next review.`,
      },
    })),
  ]
  if (scenario === "long")
    meetings[0].transcript = {
      "zh-CN": Array.from(
        { length: 12 },
        (_, index) => `片段 ${index + 1}\n${kickoff.transcript["zh-CN"]}`,
      ).join("\n\n"),
      en: Array.from(
        { length: 12 },
        (_, index) => `Segment ${index + 1}\n${kickoff.transcript.en}`,
      ).join("\n\n"),
    }
  const source = createThreadFixture(
    "conversation-4",
    scenario,
    kickoff.title,
    kickoff.summary,
  )
  source.sessions[0].messages = []
  source.contextItems = [
    {
      id: "transcript",
      name: "Weekly kickoff transcript",
      description: {
        "zh-CN": "产品团队 · 本地会议转录",
        en: "Product team · local meeting transcript",
      },
      kind: { "zh-CN": "转录", en: "Transcript" },
    },
  ]
  return {
    source,
    meetings,
    empty: scenario === "empty",
    actions: meetings[0].actions,
    artifacts: [
      {
        id: "minutes",
        name: "launch-meeting.md",
        title: { "zh-CN": "会议纪要", en: "Meeting notes" },
        content: {
          "zh-CN": `# ${kickoff.title["zh-CN"]}\n\n${kickoff.summary["zh-CN"]}\n\n${kickoff.points.map((point, index) => `${index + 1}. ${point["zh-CN"]}`).join("\n")}`,
          en: `# ${kickoff.title.en}\n\n${kickoff.summary.en}\n\n${kickoff.points.map((point, index) => `${index + 1}. ${point.en}`).join("\n")}`,
        },
        available: true,
      },
      {
        id: "email",
        name: "follow-up-email.md",
        title: { "zh-CN": "跟进邮件草稿", en: "Follow-up email draft" },
        content: {
          "zh-CN": `To: ${kickoff.email.to}\nSubject: ${kickoff.email.subject["zh-CN"]}\n\n${kickoff.email.body["zh-CN"]}\n\n本地草稿，未发送。`,
          en: `To: ${kickoff.email.to}\nSubject: ${kickoff.email.subject.en}\n\n${kickoff.email.body.en}\n\nLocal draft; not sent.`,
        },
        available: scenario !== "unavailable",
      },
    ],
  }
}

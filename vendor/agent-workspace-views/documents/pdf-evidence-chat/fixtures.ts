export type Copy = { "zh-CN": string; en: string }
export type Passage = { id: string; page: number; title: Copy; text: Copy }
export type ReportPage = {
  number: number
  section: Copy
  title: Copy
  subtitle: Copy
  passageIds: readonly string[]
}

export const reportPages: readonly ReportPage[] = [
  {
    number: 1,
    section: { "zh-CN": "概览", en: "Overview" },
    title: { "zh-CN": "新团队在哪里受阻", en: "Where new teams get stuck" },
    subtitle: {
      "zh-CN": "深入了解首周体验",
      en: "A closer look at the first week",
    },
    passageIds: ["first-result", "study", "recommendation"],
  },
  {
    number: 2,
    section: { "zh-CN": "观察到的阻力", en: "Observed friction" },
    title: {
      "zh-CN": "阻力发生在交接环节",
      en: "The friction is in the handoff",
    },
    subtitle: {
      "zh-CN": "团队停在配置与协作之间",
      en: "Teams stall between setup and collaboration",
    },
    passageIds: ["setup", "invitations", "import"],
  },
  {
    number: 3,
    section: { "zh-CN": "试点与局限", en: "Pilot and limitations" },
    title: {
      "zh-CN": "目标明确、边界清晰的试点",
      en: "A focused pilot, with clear limits",
    },
    subtitle: {
      "zh-CN": "先验证首次成果，再扩大推出范围",
      en: "Prove the first result before expanding the rollout",
    },
    passageIds: ["pilot", "limitations", "checkpoint"],
  },
]

export const passages: readonly Passage[] = [
  {
    id: "first-result",
    page: 1,
    title: {
      "zh-CN": "有用的首次成果来得太晚",
      en: "A useful first result comes too late",
    },
    text: {
      "zh-CN":
        "新团队理解共享工作空间的价值，但首次使用体验要求他们在真正一起完成工作之前先做出配置决策。机会在于缩短从空白工作空间到完成一项任务的路径。",
      en: "New teams understand the value of a shared workspace, but the first-run experience asks them to make configuration decisions before they have done meaningful work together. The opportunity is to shorten the path from a blank workspace to one completed task.",
    },
  },
  {
    id: "study",
    page: 1,
    title: { "zh-CN": "研究概览", en: "Study at a glance" },
    text: {
      "zh-CN":
        "我们观察了 12 个团队的首周使用情况，并进行了简短访谈。观察涵盖创建项目、邀请队友、导入小型数据集和完成共享任务。本报告描述这些场景中的模式，而非总体估计。",
      en: "We observed 12 teams during their first week and followed up with a short interview. Sessions covered project creation, inviting a teammate, importing a small dataset, and completing a shared task. This report describes patterns in those sessions, not a population estimate.",
    },
  },
  {
    id: "recommendation",
    page: 1,
    title: { "zh-CN": "建议", en: "Recommendation" },
    text: {
      "zh-CN":
        "测试一份三步清单：创建一个项目、邀请一位队友、完成一项共享任务。保留高级配置，但不要将其纳入首次使用的必经路径。衡量团队能否更早取得共享成果。",
      en: "Test a three-step checklist: create one project, invite one teammate, and complete one shared task. Keep advanced configuration available, but remove it from the required first-run path. Measure whether teams reach a shared result sooner.",
    },
  },
  {
    id: "setup",
    page: 2,
    title: {
      "zh-CN": "01 / 配置挤占了第一项任务",
      en: "01 / Setup crowds out the first task",
    },
    text: {
      "zh-CN":
        "观察到的 12 个团队中，有 8 个在完成第一项共享任务前打开了高级设置。其中 6 个团队询问主持人哪些设置是必需的。问题集中在能否安全地继续，而不是如何使用某个控件。",
      en: "Eight of the 12 observed teams opened advanced settings before completing their first shared task. Six of those teams asked the facilitator which settings were required. The questions were about whether it was safe to proceed, rather than how to use a specific control.",
    },
  },
  {
    id: "invitations",
    page: 2,
    title: {
      "zh-CN": "02 / 邀请缺少明确的下一步",
      en: "02 / Invitations arrive without a next step",
    },
    text: {
      "zh-CN":
        "5 个团队邀请了队友，但没有在同一次会话中分配或共享任务。受邀者可以进入工作空间，然而邀请并未解释他们首先应该做什么。一项小而具体的共享任务能为双方提供有用的起点。",
      en: "Five teams invited a teammate but did not assign or share a task in the same session. Invitees could enter the workspace, yet the invitation did not explain what they should do first. A small, concrete shared task would give both people a useful starting point.",
    },
  },
  {
    id: "import",
    page: 2,
    title: {
      "zh-CN": "03 / 导入错误迫使团队重走流程",
      en: "03 / Import errors force teams to retrace steps",
    },
    text: {
      "zh-CN":
        "4 个团队在首次导入时遇到了无效行。3 个团队因为不知道有效行是否已经保存而重新上传。预览需要清楚列出已接受和已拒绝的行数，并允许仅重试被拒绝的行。",
      en: "Four teams encountered an invalid row during their first import. Three restarted the upload because they could not tell whether valid rows had been saved. The preview needs a clear count of accepted and rejected rows, plus a way to retry only the rejected rows.",
    },
  },
  {
    id: "pilot",
    page: 3,
    title: { "zh-CN": "试点计划", en: "Pilot plan" },
    text: {
      "zh-CN":
        "在 20 个新工作空间开展为期两周的试点。比较七天内完成共享任务的团队占比，以及取得首次成果所需的时间。同时跟踪关于配置和导入恢复的支持请求。在解释数据变化之前，请先审阅录屏。",
      en: "Run a two-week pilot in 20 new workspaces. Compare the share of teams that complete a shared task within seven days and their time to that first result. Also track support requests about setup and import recovery. Review recordings before interpreting a change in the numbers.",
    },
  },
  {
    id: "checkpoint",
    page: 3,
    title: { "zh-CN": "决策检查点", en: "Decision checkpoint" },
    text: {
      "zh-CN":
        "只有在清单减少困惑且不隐藏必需控件时才继续。如果团队更快地完成了配置，但依然没有协作，应修改通往第一项共享任务的交接。在整个试点期间保留当前配置流程。",
      en: "Continue only if the checklist reduces confusion without hiding required controls. If teams finish setup faster but still fail to collaborate, revise the handoff to the first shared task. Keep the current setup flow available throughout the pilot.",
    },
  },
  {
    id: "limitations",
    page: 3,
    title: {
      "zh-CN": "这项研究无法说明什么",
      en: "What this study cannot tell us",
    },
    text: {
      "zh-CN":
        "样本仅包含首次使用产品的小型团队，不代表企业管理员、回访团队或长期留存。观察识别了可能的阻力，但并不能证明清单会改善激活情况。",
      en: "The sample includes only small teams using the product for the first time. It does not represent enterprise administrators, returning teams, or long-term retention. The observations identify possible friction; they do not establish that a checklist will improve activation.",
    },
  },
]

export const initialQuestion: Copy = {
  "zh-CN": "是什么阻碍了团队取得第一项共享成果？请使用这份报告，并展示证据。",
  en: "What is getting in the way of a team's first shared result? Use the report and show me the evidence.",
}
export type AnswerKind = "handoffs" | "limitations" | "pilot" | "scope"
export type Answer = {
  intro: Copy
  points: readonly { text: Copy; passageId: string }[]
}
export const answers: Record<AnswerKind, Answer> = {
  handoffs: {
    intro: {
      "zh-CN": "在增加更多引导步骤之前，有三个交接环节值得修复：",
      en: "Three handoffs are worth fixing before adding more onboarding steps:",
    },
    points: [
      {
        text: {
          "zh-CN":
            "团队在取得第一项共享成果前就进入高级设置。观察到的 12 个团队中有 8 个如此，其中 6 个需要帮助才能理解哪些设置是必需的。",
          en: "Teams reach advanced settings before their first shared result. Eight of the 12 observed teams did this, and six needed help understanding what was required.",
        },
        passageId: "setup",
      },
      {
        text: {
          "zh-CN":
            "邀请需要明确的下一步。5 个团队邀请了队友，却没有在同一次会话中共享或分配任务。",
          en: "An invitation needs a concrete next step. Five teams invited someone without sharing or assigning a task in that session.",
        },
        passageId: "invitations",
      },
      {
        text: {
          "zh-CN":
            "导入恢复需要清晰地呈现部分成功。3 个团队因为不知道哪些行已经保存而重新上传。",
          en: "Import recovery needs to make partial success clear. Three teams restarted an upload because they could not tell which rows had been saved.",
        },
        passageId: "import",
      },
    ],
  },
  limitations: {
    intro: {
      "zh-CN": "这些发现用于指导试点，不应被视为总体结论：",
      en: "Use these findings to guide a pilot, not as a population estimate:",
    },
    points: [
      {
        text: {
          "zh-CN":
            "研究观察了 12 个团队，涵盖项目创建、邀请、导入和共享任务。样本不是总体估计。",
          en: "The report follows 12 teams across project creation, invitations, imports, and shared tasks. It is not a population estimate.",
        },
        passageId: "study",
      },
      {
        text: {
          "zh-CN":
            "样本仅为首次使用的小型团队，不能说明企业需求、回访行为、长期留存，也不能证明激活收益的因果关系。",
          en: "The sample is limited to small first-time teams; it does not establish enterprise needs, returning-team behavior, long-term retention, or a causal activation benefit.",
        },
        passageId: "limitations",
      },
    ],
  },
  pilot: {
    intro: {
      "zh-CN": "从一项更小的试点开始，让团队更快地一起完成工作：",
      en: "Start with a smaller pilot that gets teams doing useful work together sooner:",
    },
    points: [
      {
        text: {
          "zh-CN":
            "使用三步清单：创建一个项目、邀请一位队友、完成一项共享任务。保留高级配置，但移出必经路径。",
          en: "Use a three-step checklist: create one project, invite one teammate, and complete one shared task. Keep advanced configuration out of the required path.",
        },
        passageId: "recommendation",
      },
      {
        text: {
          "zh-CN":
            "在 20 个新工作空间开展两周试点，衡量首次共享成果、配置疑问及导入恢复；先审阅录屏再解释变化。",
          en: "Run a two-week pilot in 20 new workspaces and measure first shared results, setup questions, and import recovery. Review recordings before interpreting changes.",
        },
        passageId: "pilot",
      },
      {
        text: {
          "zh-CN":
            "只有在减少困惑且不隐藏必需控件时才继续；在整个试点期间保留当前流程。",
          en: "Continue only if the checklist reduces confusion without hiding required controls, and keep the current flow available throughout the pilot.",
        },
        passageId: "checkpoint",
      },
    ],
  },
  scope: {
    intro: {
      "zh-CN":
        "这是一份本地预设回答，不能从报告中推断未记录的事实。可以先核对研究范围：",
      en: "This is a prepared local answer, not a live model response. The report cannot establish facts it did not record. Start by checking the study's scope:",
    },
    points: [
      {
        text: {
          "zh-CN":
            "报告描述 12 个团队在首周的观察模式，而不是总体估计。对于报告范围外的问题，需要额外的证据。",
          en: "The report describes patterns from 12 teams during their first week, not a population estimate. Questions outside that scope need additional evidence.",
        },
        passageId: "study",
      },
    ],
  },
}

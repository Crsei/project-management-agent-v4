import type { Copy } from "../../model"

export type Passage = {
  id: string
  heading: Copy
  text: Copy
  explanation?: Copy
  checklist?: Copy
}
export type ComparisonDocument = {
  id: string
  label: Copy
  author: string
  date: Copy
  passages: Passage[]
}
const copy = (en: string, zh: string): Copy => ({ en, "zh-CN": zh })
const shared: Passage[] = [
  {
    id: "title",
    heading: copy("Title", "标题"),
    text: copy("Team onboarding guide", "团队入职指南"),
  },
  {
    id: "subtitle",
    heading: copy("Subtitle", "副标题"),
    text: copy("First-week working agreement", "第一周工作约定"),
  },
  {
    id: "purpose",
    heading: copy("Purpose", "目的"),
    text: copy(
      "Make the first week useful for teams joining Northstar. This guide defines the setup sequence, shared document permissions, and the point at which a team is ready to work independently.",
      "让加入 Northstar 的团队度过有价值的第一周。本指南规定了设置顺序、共享文档权限，以及团队能够独立工作的标准。",
    ),
  },
]
const help: Passage = {
  id: "help",
  heading: copy("Getting help", "获取帮助"),
  text: copy(
    "Use the help menu to contact the onboarding team. Include the workspace name and the step you were trying to complete. Never include passwords or private customer documents.",
    "通过帮助菜单联系入职支持团队。请说明工作区名称及正在进行的步骤。切勿提供密码或客户的私密文档。",
  ),
}

export function createDocuments(longContent = false): ComparisonDocument[] {
  const before: Passage[] = [
    ...shared,
    {
      id: "session",
      heading: copy("First session", "首次使用"),
      text: copy(
        "Create a workspace and invite one teammate before importing a document. A team invitation is required to complete setup. The checklist closes after the invitation is sent.",
        "创建工作区后，先邀请一位同事，再导入文档。团队邀请是完成设置的必要条件。邀请发出后即可完成检查清单。",
      ),
    },
    {
      id: "visibility",
      heading: copy("Document visibility", "文档可见性"),
      text: copy(
        "Imported documents are shared with everyone in the workspace. Workspace members can edit shared documents. Review the member list before adding sensitive material.",
        "导入的文档对工作区中的所有人共享。工作区成员可以编辑共享文档。添加敏感资料前，请检查成员列表。",
      ),
    },
    {
      id: "training",
      heading: copy("Live training", "现场培训"),
      text: copy(
        "Every new team must attend a 60-minute live training session before the end of its first week. The workspace owner schedules the session for all invited members.",
        "每个新团队必须在第一周结束前参加一次 60 分钟的现场培训。工作区所有者为所有受邀成员安排培训。",
      ),
      explanation: copy(
        "The proposed guide removes mandatory live training. Teams can finish setup independently instead of waiting for a scheduled session.",
        "提议稿取消了强制现场培训。团队可以独立完成设置，无需等待安排好的培训。",
      ),
      checklist: copy(
        "Check that self-service guidance covers the former training content and that office hours remain available when requested.",
        "检查自助指南是否涵盖原培训内容，并确认团队提出需求时仍可预约答疑。",
      ),
    },
    {
      id: "checkin",
      heading: copy("First-week check-in", "第一周回访"),
      text: copy(
        "On Friday, the workspace owner reports how many invitations were sent and whether the setup checklist was completed. The onboarding team reviews the report on Monday.",
        "周五，工作区所有者报告发出了多少邀请，以及设置检查清单是否完成。入职团队在周一审核报告。",
      ),
    },
    help,
  ]
  const after: Passage[] = [
    ...shared,
    {
      id: "session",
      heading: copy("First session", "首次使用"),
      text: copy(
        "Create a workspace and import a document before inviting a teammate. A team invitation is optional during setup. The checklist closes after the first document is ready to use.",
        "创建工作区后，先导入文档，再邀请同事。设置期间可以选择不邀请团队成员。首份文档可使用时即可完成检查清单。",
      ),
      explanation: copy(
        "The sequence changes from inviting a teammate first to importing a document first. Invitations become optional, and completion now depends on a usable document rather than a sent invitation.",
        "顺序从先邀请同事变为先导入文档。邀请成为可选步骤；完成设置的标准从发出邀请变为文档可供使用。",
      ),
      checklist: copy(
        "Check that document import works without an invitation, that the checklist closes only when the document is usable, and that invitations can still be sent later.",
        "检查是否能在未邀请成员时导入文档、清单是否仅在文档可用时完成，以及是否仍可在之后发出邀请。",
      ),
    },
    {
      id: "visibility",
      heading: copy("Document visibility", "文档可见性"),
      text: copy(
        "Imported documents are private to their owner. Owners choose which documents to share and whether collaborators can view or edit. Show the audience and access level before sending an invitation.",
        "导入的文档默认仅所有者可见。所有者选择共享哪些文档，以及协作者是否可以查看或编辑。发送邀请前应显示受众及访问权限。",
      ),
      explanation: copy(
        "The default changes from workspace-wide sharing to owner-only access. Sharing becomes explicit, with separate view and edit permissions and an audience check before invitations.",
        "默认权限从工作区内共享变为仅所有者可见。共享需要明确操作，查看与编辑权限分开，并在邀请前检查受众。",
      ),
      checklist: copy(
        "Check owner-only visibility after import, view-versus-edit permissions, and the audience confirmation shown before an invitation is sent.",
        "检查导入后的所有者私有权限、查看和编辑权限的区别，以及发送邀请前的受众确认。",
      ),
    },
    {
      id: "checkin",
      heading: copy("First-week check-in", "第一周回访"),
      text: copy(
        "On Friday, the workspace owner reports whether the team completed a shared task and records any setup blockers. The onboarding team reviews the report on Monday before recommending another cohort.",
        "周五，工作区所有者报告团队是否完成了共同任务，并记录设置中的阻碍。入职团队在周一审核报告，然后再建议启动下一批团队。",
      ),
      explanation: copy(
        "The report moves from invitation and checklist counts to a completed shared task and setup blockers. The Monday review now informs the next cohort recommendation.",
        "报告从邀请和清单数量转为关注完成的共同任务与设置障碍。周一审核的结果将用于决定是否推荐下一批团队。",
      ),
      checklist: copy(
        "Check that the report captures a concrete shared task and blockers, and that the next cohort is not recommended before Monday's review.",
        "检查报告是否记录具体共同任务及阻碍，并确认下一批推荐不会早于周一审核。",
      ),
    },
    help,
    {
      id: "stalls",
      heading: copy("If setup stalls", "设置受阻时"),
      text: copy(
        "Keep the imported document and save the unfinished checklist. The owner can resume from the last completed step. Offer a 15-minute office-hours session when the team asks for help.",
        "保留已导入的文档并保存尚未完成的检查清单。所有者可以从上次完成的步骤继续。团队请求帮助时，提供 15 分钟的答疑时段。",
      ),
      explanation: copy(
        "A new recovery passage preserves the imported document and unfinished checklist. The owner can resume setup, with a short office-hours session available on request.",
        "新增恢复说明：保留导入文档和未完成清单。所有者可继续设置，并在提出需求时获得短时间答疑。",
      ),
      checklist: copy(
        "Check that a interrupted setup preserves the document and last completed step, and that office hours are offered without making them a requirement.",
        "检查中断设置后是否保留文档及最后完成步骤，并确认答疑是可选支持而非强制要求。",
      ),
    },
  ]
  if (longContent) {
    const topics = [
      [
        "Ownership handoff",
        "所有权移交",
        "Record the current owner before moving a workspace to another team.",
        "工作区转交其他团队前记录当前所有者。",
      ],
      [
        "Document retention",
        "文档保留",
        "Keep onboarding source documents until the team confirms its shared task is complete.",
        "在团队确认共同任务完成前保留入职源文档。",
      ],
      [
        "Access audit",
        "访问权限审核",
        "Review document access with the workspace owner after the first-week check-in.",
        "第一周回访后，与工作区所有者一起审核文档访问权限。",
      ],
      [
        "Cohort readiness",
        "批次准备情况",
        "Document unresolved blockers and assign a responsible owner before the next cohort starts.",
        "下一批团队开始前记录未解决的阻碍并明确责任人。",
      ],
    ]
    topics.forEach(([heading, zhHeading, text, zhText], index) => {
      const passage = {
        id: `appendix-${index}`,
        heading: copy(heading!, zhHeading!),
        text: copy(text!, zhText!),
      }
      before.push(passage)
      after.push({
        ...passage,
        text: copy(
          `${text} Add the decision and follow-up date to the workspace notes. Share the notes only with the responsible team, and retain the original document for context.`,
          `${zhText} 在工作区记录中添加决定及跟进日期。仅向负责团队共享记录，并保留原始文档作为上下文。`,
        ),
        explanation: copy(
          "This appendix adds a recorded decision, follow-up date, and explicit audience while preserving the original source document.",
          "附录新增决定记录、跟进日期和明确受众，同时保留原始源文档。",
        ),
        checklist: copy(
          "Check the decision owner, follow-up date, and the audience of the workspace notes.",
          "检查决定负责人、跟进日期及工作区记录的受众。",
        ),
      })
    })
  }
  return [
    {
      id: "original",
      label: copy("Onboarding guide · Original", "入职指南 · 原稿"),
      author: "Maya Chen",
      date: copy("September 2", "9月2日"),
      passages: before,
    },
    {
      id: "proposed",
      label: copy("Onboarding guide · Proposed", "入职指南 · 提议稿"),
      author: "Alex Rivera",
      date: copy("September 6", "9月6日"),
      passages: after,
    },
  ]
}

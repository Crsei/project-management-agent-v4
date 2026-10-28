import type { ApCopy, ApScenario } from "../model"

export type ReviewRecord = {
  reviewId: string
  responseId: string
  exampleId: string
  topic: ApCopy
  title: ApCopy
  customerName: string
  company: string
  time: string
  messages: { speaker: string; content: ApCopy }[]
  source: {
    sourceId: string
    version: string | null
    available: boolean
    title: ApCopy
    path: ApCopy
    quote: ApCopy
    updatedAt: string
  }
  reasonTitle: ApCopy
  reason: ApCopy
  suggestedCorrection: ApCopy | null
}

export const reviewDataset = {
  datasetId: "ds_support_review",
  version: 1,
  evaluationId: null,
  label: {
    en: "Customer support · September review",
    "zh-CN": "客户支持 · 九月审查",
  },
} as const
export const reviewFixtureRevision = "response-review-reference-2026-10-13"
const records: ReviewRecord[] = [
  {
    reviewId: "RV-1042",
    responseId: "response-RV-1042",
    exampleId: "review-support-1",
    topic: {
      en: "Workspace access",
      "zh-CN": "工作区访问",
    },
    title: {
      en: "Inviting teammates to a workspace",
      "zh-CN": "邀请团队成员加入工作区",
    },
    customerName: "Maya Chen",
    company: "Northstar Studio",
    time: "10:42 AM",
    messages: [
      {
        speaker: "Maya",
        content: {
          en: "I’m the owner of our design workspace, but not an organization admin. Can I invite two contractors to just this workspace?",
          "zh-CN":
            "我是设计工作区的所有者，但不是组织管理员。我可以只邀请两位合同工加入这个工作区吗？",
        },
      },
      {
        speaker: "Support assistant",
        content: {
          en: "Only organization administrators can invite new members. Ask your organization admin to open Settings → Members and send invitations to the contractors. Once they join, your admin can add them to the design workspace.",
          "zh-CN":
            "只有组织管理员可以邀请新成员。请让组织管理员打开设置 → 成员，向合同工发送邀请。加入组织后，管理员就可以将他们添加到设计工作区。",
        },
      },
      {
        speaker: "Maya",
        content: {
          en: "Does that mean I need to contact our IT team every time? I thought workspace owners could manage their own members.",
          "zh-CN":
            "这是不是意味着每次都要联系 IT 团队？我以为工作区所有者可以管理自己的成员。",
        },
      },
    ],
    source: {
      sourceId: "knowledge-1",
      version: "2026-09-v1",
      available: true,
      title: {
        en: "Invite people to a workspace",
        "zh-CN": "邀请成员加入工作区",
      },
      path: {
        en: "Roles & permissions / Workspace members",
        "zh-CN": "角色与权限 / 工作区成员",
      },
      quote: {
        en: "Workspace owners and organization administrators can invite people to a workspace. Owners can invite members and guests to workspaces they own. Guest access is limited to the selected workspace and does not grant access to other organization resources.",
        "zh-CN":
          "工作区所有者和组织管理员都可以邀请成员加入工作区。所有者可以邀请成员和访客加入自己拥有的工作区。访客仅能访问所选工作区，不会获得其他组织资源的访问权限。",
      },
      updatedAt: "2026-09-12",
    },
    reasonTitle: {
      en: "Customer questioned the answer",
      "zh-CN": "客户质疑了答复",
    },
    reason: {
      en: "Source contradicts the stated permission requirement.",
      "zh-CN": "来源与答复中所述的权限要求相矛盾。",
    },
    suggestedCorrection: {
      en: "As the workspace owner, you can invite both contractors directly. Open your workspace, go to Settings → Members, and choose Invite people. Select Guest to limit their access to this workspace. You don’t need an organization administrator to do this.",
      "zh-CN":
        "作为工作区所有者，你可以直接邀请两位合同工。打开工作区，进入设置 → 成员，选择邀请成员。选择访客即可将他们的访问权限限制在此工作区。无需组织管理员操作。",
    },
  },
  {
    reviewId: "RV-1043",
    responseId: "response-RV-1043",
    exampleId: "review-support-2",
    topic: {
      en: "Billing",
      "zh-CN": "账单",
    },
    title: {
      en: "A duplicate charge on a monthly plan",
      "zh-CN": "月度套餐的重复扣款",
    },
    customerName: "Daniel Park",
    company: "Forma Labs",
    time: "10:38 AM",
    messages: [
      {
        speaker: "Daniel",
        content: {
          en: "There are two $129 charges for our subscription this month. Can you reverse the duplicate?",
          "zh-CN":
            "本月的订阅出现了两笔129美元的扣款。可以退回重复的那一笔吗？",
        },
      },
      {
        speaker: "Support assistant",
        content: {
          en: "I can help you check the duplicate charge. Please share the two transaction dates and the last four digits of the payment method. Don’t send your full card number. Once we confirm a duplicate settled payment, we can refund it to the original payment method.",
          "zh-CN":
            "我可以帮你核查重复扣款。请提供两笔交易的日期和付款方式的末四位数字。不要发送完整卡号。确认重复付款已结算后，我们可以退回到原付款方式。",
        },
      },
      {
        speaker: "Daniel",
        content: {
          en: "Both are from September 17, ending in 4242. Thank you for checking.",
          "zh-CN": "都是9月17日，末四位4242。谢谢你帮忙核查。",
        },
      },
    ],
    source: {
      sourceId: "knowledge-2",
      version: "2026-09-v1",
      available: true,
      title: {
        en: "Duplicate subscription payments",
        "zh-CN": "重复订阅付款",
      },
      path: {
        en: "Billing / Refunds",
        "zh-CN": "账单 / 退款",
      },
      quote: {
        en: "Verify both transaction IDs and confirm that both payments have settled. Refund a confirmed duplicate to the original payment method. An authorization hold is not a settled charge. Never request a full card number or card security code.",
        "zh-CN":
          "核实两笔交易的ID，并确认两笔付款都已结算。将确认的重复付款退回原付款方式。预授权不是已结算的扣款。不得索要完整卡号或安全码。",
      },
      updatedAt: "2026-09-09",
    },
    reasonTitle: {
      en: "Sampled for quality review",
      "zh-CN": "抽样质量审查",
    },
    reason: {
      en: "Check whether the response asks for enough information to verify a duplicate.",
      "zh-CN": "检查答复是否要求了足够的信息来核实重复扣款。",
    },
    suggestedCorrection: null,
  },
  {
    reviewId: "RV-1044",
    responseId: "response-RV-1044",
    exampleId: "review-support-3",
    topic: {
      en: "Data exports",
      "zh-CN": "数据导出",
    },
    title: {
      en: "Exporting a customer report",
      "zh-CN": "导出客户报告",
    },
    customerName: "Leah Ortiz",
    company: "Fieldwork",
    time: "10:31 AM",
    messages: [
      {
        speaker: "Leah",
        content: {
          en: "Can I export all 3,120 customers to our Tableau workspace?",
          "zh-CN": "我能将全部3120位客户导出到我们的Tableau工作区吗？",
        },
      },
      {
        speaker: "Support assistant",
        content: {
          en: "Yes. Open Customers, select all records, and choose Export → Tableau. The full dataset will be sent immediately to your connected workspace.",
          "zh-CN":
            "可以。打开客户，选择所有记录，然后选择导出 → Tableau。完整数据集会立即发送到已连接的工作区。",
        },
      },
      {
        speaker: "Leah",
        content: {
          en: "The export is showing ‘Needs review’ instead. Is something wrong?",
          "zh-CN": "导出显示“需要审查”。出问题了吗？",
        },
      },
    ],
    source: {
      sourceId: "knowledge-3",
      version: "2026-09-v1",
      available: true,
      title: {
        en: "Customer data export policy",
        "zh-CN": "客户数据导出政策",
      },
      path: {
        en: "Security / Data handling",
        "zh-CN": "安全 / 数据处理",
      },
      quote: {
        en: "Exports of more than 700 customer records require approval before data leaves the reporting workspace. A pending approval displays Needs review. The export resumes after an authorized reviewer approves the request.",
        "zh-CN":
          "超过700条客户记录的导出必须经过批准，数据才可以离开报告工作区。待批准请求显示需要审查。授权审阅人批准请求后，导出会继续。",
      },
      updatedAt: "2026-09-15",
    },
    reasonTitle: {
      en: "Policy mismatch detected",
      "zh-CN": "检测到政策不符",
    },
    reason: {
      en: "The answer promises an immediate export without mentioning approval.",
      "zh-CN": "答复承诺立即导出，却没有提及审批要求。",
    },
    suggestedCorrection: {
      en: "You can request the export, but 3,120 records exceeds the 700-record approval threshold. ‘Needs review’ is expected. An authorized reviewer needs to approve it before the data is sent to Tableau.",
      "zh-CN":
        "你可以申请导出，但3120条记录超过700条的审批阈值。“需要审查”是正常状态。授权审阅人必须先批准，数据才会发送到Tableau。",
    },
  },
  {
    reviewId: "RV-1045",
    responseId: "response-RV-1045",
    exampleId: "review-support-4",
    topic: {
      en: "Documents",
      "zh-CN": "文档",
    },
    title: {
      en: "Finding a previous version of a report",
      "zh-CN": "查找报告的旧版本",
    },
    customerName: "Sam Rivera",
    company: "Common Ground",
    time: "10:24 AM",
    messages: [
      {
        speaker: "Sam",
        content: {
          en: "I replaced a section of our quarterly report by mistake. Can I get yesterday’s version back?",
          "zh-CN": "我不小心替换了季度报告的一节内容。可以恢复昨天的版本吗？",
        },
      },
      {
        speaker: "Support assistant",
        content: {
          en: "Open the report and select Version history from the document menu. Choose yesterday’s version to preview it, then select Restore. Restoring creates a new version, so your current draft remains available in the history.",
          "zh-CN":
            "打开报告，在文档菜单中选择版本历史。选择昨天的版本进行预览，再选择恢复。恢复会创建一个新版本，因此当前草稿仍然保留在历史记录中。",
        },
      },
      {
        speaker: "Sam",
        content: {
          en: "Found it. That’s exactly what I needed.",
          "zh-CN": "找到了。这正是我需要的。",
        },
      },
    ],
    source: {
      sourceId: "knowledge-4",
      version: "2026-09-v1",
      available: true,
      title: {
        en: "Restore a document version",
        "zh-CN": "恢复文档版本",
      },
      path: {
        en: "Documents / Version history",
        "zh-CN": "文档 / 版本历史",
      },
      quote: {
        en: "Select a saved version to preview its contents. Restore creates a new current version using the selected content. Existing versions, including the draft that was current before restoration, remain in the history.",
        "zh-CN":
          "选择已保存的版本以预览内容。恢复会使用所选内容创建新的当前版本。原有版本（包括恢复前的当前草稿）均保留在历史记录中。",
      },
      updatedAt: "2026-09-07",
    },
    reasonTitle: {
      en: "Sampled for quality review",
      "zh-CN": "抽样质量审查",
    },
    reason: {
      en: "Check the restore behavior against the document history guide.",
      "zh-CN": "根据文档历史指南检查恢复行为。",
    },
    suggestedCorrection: null,
  },
]

export function createReviewRecords(scenario: ApScenario): ReviewRecord[] {
  if (scenario === "empty") return []
  const result = structuredClone(records)
  if (scenario === "missing-data") {
    result[0].source.available = false
    result[0].source.version = null
    result[0].source.quote = {
      en: "The original source version is unavailable. The citation identity is retained; no evidence has been substituted.",
      "zh-CN": "原始来源版本不可用。引用身份仍被保留，未用其他证据替代。",
    }
    result[0].suggestedCorrection = null
  }
  if (scenario === "long-content") {
    result[0].title = {
      en: "Inviting teammates to a workspace with delegated ownership and cross-organization access restrictions",
      "zh-CN": "在委托所有权和跨组织访问限制下邀请团队成员加入工作区",
    }
    result[0].messages[1].content.en = Array(7)
      .fill(result[0].messages[1].content.en)
      .join("\n\n")
    result[0].messages[1].content["zh-CN"] = Array(7)
      .fill(result[0].messages[1].content["zh-CN"])
      .join("\n\n")
  }
  return result
}

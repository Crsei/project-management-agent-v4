import type { Copy } from "../../model"

export type ArtifactSection = { id: string; title: Copy; body: Copy }
export type ArtifactVersion = {
  id: number
  title: Copy
  subtitle: Copy
  category: Copy
  sections: ArtifactSection[]
  reason: Copy
  restoredFrom?: number
}
const c = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })
export const artifactFile = "onboarding-rollout.md"
const objective: ArtifactSection = {
  id: "objective",
  title: c("目标", "Objective"),
  body: c(
    "帮助新团队减少设置步骤，更快获得第一个协作成果。新的入门清单聚焦于创建项目、邀请一位队友，以及完成一项共同任务。",
    "Help new teams reach their first shared result with less setup. The new onboarding checklist focuses on creating a project, inviting one teammate, and completing one shared task.",
  ),
}
const measures: ArtifactSection = {
  id: "measures",
  title: c("成功指标", "Success measures"),
  body: c(
    "跟踪七天内完成共同任务的团队比例、获得第一个协作成果所需的时间，以及有关设置的支持请求。与之前的入门流程比较；仅仅缩短设置时间不足以支持扩大范围。",
    "Track the share of teams that complete a shared task within seven days, time to first shared result, and support requests about setup. Compare with the previous onboarding flow; a faster setup alone is not enough to expand.",
  ),
}
const owners: ArtifactSection = {
  id: "owners",
  title: c("负责人", "Owners"),
  body: c(
    "产品团队负责决定是否扩大推出范围。工程团队负责功能开关和事件跟踪。支持团队审阅第一周的问题并报告令人困惑的步骤。",
    "Product owns the decision to expand the rollout. Engineering owns the feature flag and event tracking. Support reviews the first-week questions and reports confusing steps.",
  ),
}
const pilot: ArtifactSection = {
  id: "rollout",
  title: c("推出计划", "Rollout"),
  body: c(
    "先面向 20 个新工作空间试点两周。用工作空间开关控制清单，审阅会话录像后再邀请第二批团队。已有团队继续使用当前流程。",
    "Start with 20 new workspaces for two weeks. Keep the checklist behind a workspace flag and review session recordings before inviting a second cohort. Existing teams stay on their current flow.",
  ),
}
const fallback: ArtifactSection = {
  id: "fallback",
  title: c("回退与决策关卡", "Fallback and decision gate"),
  body: c(
    "试点期间保留当前设置流程。如果团队无法访问必要控件或支持请求增加，则暂停扩大范围。产品负责人在每批新团队加入前审阅证据。",
    "Keep the current setup flow available throughout the pilot. Pause expansion if teams lose access to required controls or support requests increase. The product owner reviews the evidence before each new cohort.",
  ),
}
export function artifactVersions(long = false): ArtifactVersion[] {
  const common = {
    title: c("入门流程推出计划", "Onboarding rollout"),
    category: c("产品 / 发布计划", "Product / Release plan"),
  }
  const versions: ArtifactVersion[] = [
    {
      ...common,
      id: 1,
      subtitle: c(
        "更快获得第一个协作成果",
        "A shorter path to the first shared result",
      ),
      reason: c("初始草稿", "First draft"),
      sections: [
        objective,
        {
          ...pilot,
          body: c(
            "在下一次发布后向新团队推出新清单。先从一小批团队开始，收集反馈，在体验稳定后扩大范围。",
            "Introduce the new checklist to new teams after the next release. Start with a small group, gather feedback, and expand when the experience is stable.",
          ),
        },
        {
          ...measures,
          body: c(
            "衡量清单完成情况以及团队花在设置上的时间。发布后审阅支持问题。",
            "Measure checklist completion and the time teams spend in setup. Review support questions after launch.",
          ),
        },
        owners,
      ],
    },
    {
      ...common,
      id: 2,
      subtitle: c(
        "两周试点，明确的决策关卡",
        "A two-week pilot with a clear decision gate",
      ),
      reason: c("试点计划", "Pilot plan"),
      sections: [objective, pilot, measures, fallback, owners],
    },
    {
      ...common,
      id: 3,
      subtitle: c(
        "为每个新工作空间缩短设置流程",
        "A shorter setup for every new workspace",
      ),
      reason: c("扩大推出范围", "Expanded launch"),
      sections: [
        objective,
        {
          ...pilot,
          body: c(
            "在下一次发布中为所有新工作空间启用清单。审阅第一周的使用情况，并跟进未完成清单的团队。已有团队继续使用当前流程。",
            "Enable the checklist for all new workspaces in the next release. Review the first week of usage and follow up with teams that do not complete the checklist. Existing teams stay on their current flow.",
          ),
        },
        measures,
        {
          id: "announcement",
          title: c("发布公告", "Launch announcement"),
          body: c(
            "在发布当天公布更新说明，并向新的工作空间负责人发送一封简短的产品邮件。附上清单链接，解释如何邀请队友。",
            "Publish the release note on launch day and send a short product email to new workspace owners. Link to the checklist and explain how to invite a teammate.",
          ),
        },
        owners,
      ],
    },
  ]
  if (!long) return versions
  return versions.map((version) => ({
    ...version,
    sections: [
      ...version.sections,
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `evidence-${index}`,
        title: c(`试点证据 ${index + 1}`, `Pilot evidence ${index + 1}`),
        body: c(
          "逐批审阅清单完成率、共享任务完成时间和支持请求。记录团队反馈，保留当前流程，并由产品负责人确认扩大范围的条件。",
          "Review checklist completion, time to shared task, and support requests for each cohort. Record team feedback, keep the current flow available, and have the product owner confirm the conditions for expansion.",
        ),
      })),
    ],
  }))
}
export const initialMessages = [
  {
    id: "request",
    role: "user" as const,
    text: c(
      "在分享 onboarding-rollout.md 之前，帮我审阅一下。有哪些变化，有什么内容应该恢复？",
      "Help me review onboarding-rollout.md before we share it. What changed, and is there anything we should bring back?",
    ),
  },
  {
    id: "opened",
    role: "agent" as const,
    text: c(
      "我已打开产物和它的已保存版本。我们可以先审阅差异，再决定保留哪个版本。",
      "I’ve opened the artifact and its saved versions. We can review the differences before deciding which version to keep.",
    ),
  },
]

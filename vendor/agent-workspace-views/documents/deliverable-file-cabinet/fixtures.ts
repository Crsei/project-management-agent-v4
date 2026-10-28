import type { Copy } from "../../model"

export type Deliverable = { id: string; name: string; conversationId: string; title: Copy; kind: "documents" | "data"; renderer: "markdown" | "csv" | "json" | "text"; createdMinutes: number; content: Copy }

export const cabinetConversations = [
  {
    "id": "pilot",
    "title": {
      "en": "Prepare the onboarding pilot",
      "zh-CN": "准备入职试点"
    },
    "prompt": {
      "en": "Put together the files we need to run the onboarding pilot: a plan, a customer invitation, and a cohort tracker.",
      "zh-CN": "整理开展入职试点所需的文件：一份计划、一封客户邀请函和一个群组跟踪表。"
    },
    "response": {
      "en": "The pilot kit is ready: a plan with the decision gate, an invitation explaining the two-week commitment, and a tracker for the two cohorts.\n\nEach file is ready to review and download.",
      "zh-CN": "试点工具包已准备好：包含决策关卡的计划、说明两周参与要求的邀请函，以及两个群组的跟踪表。\n\n每份文件都可以查看和下载。"
    }
  },
  {
    "id": "research",
    "title": {
      "en": "Hand off the research findings",
      "zh-CN": "交接研究发现"
    },
    "prompt": {
      "en": "Turn the onboarding research into a short handoff. Include the findings, a checklist configuration, and the open questions for our next review.",
      "zh-CN": "将入职研究整理成简短交接资料，包含研究发现、清单配置以及下次评审的待解决问题。"
    },
    "response": {
      "en": "I’ve organized the handoff into three files: a findings brief, a checklist configuration, and the open questions.\n\nThe brief separates observations from next steps. The configuration is a draft for engineering review, and the questions capture what we still need to learn.",
      "zh-CN": "我将交接内容整理成三份文件：研究简报、清单配置和待解决问题。\n\n简报区分观察与后续行动。配置是供工程评审的草案，问题清单记录了我们仍需了解的内容。"
    }
  }
] as const

export const cabinetFiles: readonly Deliverable[] = [
  {
    "id": "onboarding-pilot",
    "name": "onboarding-pilot.md",
    "conversationId": "pilot",
    "title": {
      "en": "Onboarding pilot",
      "zh-CN": "入职试点"
    },
    "kind": "documents",
    "renderer": "markdown",
    "createdMinutes": 642,
    "content": {
      "en": "# Onboarding pilot\n\nA two-week test of a shorter path to the first shared result.\n\n## The plan\n\nInvite 20 new workspaces in two cohorts. Keep the existing setup flow available, and introduce the checklist behind a workspace flag. Review the first cohort before enabling the second.\n\n## What we want to learn\n\n- Can teams create a project, invite a teammate, and finish a shared task?\n- Which step causes people to pause or ask for help?\n- Does the shorter flow preserve the controls larger teams need?\n\n## Responsibilities\n\n| Owner | Responsibility |\n| --- | --- |\n| Product | Select cohorts and decide whether to expand |\n| Engineering | Feature flag, event tracking, and fallback |\n| Support | Review questions and identify confusing steps |\n\n## Decision gate\n\nTrack first shared task completion within seven days, time to first shared result, and setup-related support requests. Pause expansion if required controls become inaccessible or support requests increase.\n\nA faster setup alone is not enough to expand. The product owner reviews the evidence before each new cohort.\n",
      "zh-CN": "# 入职试点\n\n用两周时间验证更短的流程能否帮助团队完成第一个共享成果。\n\n## 计划\n\n分两个群组邀请 20 个新工作空间。保留原有设置流程，通过工作空间标记启用清单。启用第二组之前先评审第一组。\n\n## 我们希望了解\n\n- 团队能否创建项目、邀请同事并完成共享任务？\n- 哪个步骤会让人停下来或寻求帮助？\n- 更短的流程是否保留大型团队需要的控制能力？\n\n## 职责\n\n| 负责人 | 职责 |\n| --- | --- |\n| 产品 | 选择群组并决定是否扩大试点 |\n| 工程 | 功能标记、事件跟踪和回退 |\n| 支持 | 评审问题并发现令人困惑的步骤 |\n\n## 决策关卡\n\n跟踪七天内首个共享任务的完成情况、首次共享成果的耗时和与设置相关的支持请求。必要控制不可访问或支持请求增加时暂停扩展。\n\n设置更快并不足以扩大试点。产品负责人须在每个新群组开始前评审证据。\n"
    }
  },
  {
    "id": "pilot-invitation",
    "name": "pilot-invitation.md",
    "conversationId": "pilot",
    "title": {
      "en": "Help us improve your first week",
      "zh-CN": "帮助我们改善您的第一周"
    },
    "kind": "documents",
    "renderer": "markdown",
    "createdMinutes": 640,
    "content": {
      "en": "# Help us improve your first week\n\nSubject: Join a two-week onboarding pilot\n\nHi there,\n\nWe’re inviting a small group of teams to try a shorter path to their first shared task.\n\nFor two weeks, your workspace can try a checklist for creating a project, inviting a teammate, and completing a shared task. Your existing setup flow will remain available.\n\nWe’ll ask which steps felt clear and where you needed help. You can leave the pilot at any time.\n\nReply with your workspace name if you’d like to join. We’ll confirm the start date and share a short guide before enabling the pilot.\n\nThanks,\nThe product team\n",
      "zh-CN": "# 帮助我们改善您的第一周\n\n主题：参与两周的入职试点\n\n您好，\n\n我们邀请少量团队尝试更短的流程，完成第一个共享任务。\n\n在两周内，您的工作空间可以使用清单来创建项目、邀请同事并完成共享任务。原有设置流程仍然可用。\n\n我们会询问哪些步骤清晰，哪些地方需要帮助。您可以随时退出试点。\n\n如愿意参与，请回复您的工作空间名称。我们会确认开始日期，并在启用前分享简短指南。\n\n谢谢，\n产品团队\n"
    }
  },
  {
    "id": "cohort-tracker",
    "name": "cohort-tracker.csv",
    "conversationId": "pilot",
    "title": {
      "en": "Pilot cohort tracker",
      "zh-CN": "试点群组跟踪表"
    },
    "kind": "data",
    "renderer": "csv",
    "createdMinutes": 638,
    "content": {
      "en": "Cohort,Workspaces,Owner,Start,Review,Status\nPilot A,10,Maya Chen,Sep 14,Sep 28,Ready\nPilot B,10,Alex Rivera,Sep 21,Oct 5,Pending first review\nExpansion,TBD,Maya Chen,After pilot,Before enablement,Not approved\n",
      "zh-CN": "群组,工作空间,负责人,开始,评审,状态\n试点 A,10,Maya Chen,9月14日,9月28日,就绪\n试点 B,10,Alex Rivera,9月21日,10月5日,待首次评审\n扩展,待定,Maya Chen,试点后,启用前,未批准\n"
    }
  },
  {
    "id": "research-brief",
    "name": "first-week-findings.md",
    "conversationId": "research",
    "title": {
      "en": "First-week findings",
      "zh-CN": "第一周研究发现"
    },
    "kind": "documents",
    "renderer": "markdown",
    "createdMinutes": 595,
    "content": {
      "en": "# First-week findings\n\nA fictional research handoff for the onboarding team.\n\n## Three places teams need help\n\n- **Import recovery.** Teams want to understand which rows failed without restarting the entire import.\n- **Inviting a teammate.** People are unsure what an invited teammate will be able to see and change.\n- **Finding the first shared task.** Completing setup does not always lead to a useful shared result.\n\n## What to test next\n\nGive import errors a recoverable state. Explain teammate access before sending an invitation. Make the first shared task explicit in the checklist.\n\n## Limits\n\nThese observations are prepared demo content, not measurements from real users. Validate the hypotheses with a small pilot before expanding the flow.\n",
      "zh-CN": "# 第一周研究发现\n\n一份供入职团队使用的虚构研究交接资料。\n\n## 团队需要帮助的三个环节\n\n- **导入恢复。** 团队希望了解失败的行，而不必重新执行整个导入。\n- **邀请同事。** 用户不确定受邀同事能看到和修改哪些内容。\n- **找到首个共享任务。** 完成设置不一定带来有价值的共享成果。\n\n## 下一步验证\n\n为导入错误提供可恢复状态。在发送邀请前解释同事的访问权限。在清单中明确第一个共享任务。\n\n## 局限\n\n这些观察是预先准备的示例内容，并非真实用户的测量。扩大流程前先通过小规模试点验证假设。\n"
    }
  },
  {
    "id": "pilot-checklist",
    "name": "pilot-checklist.json",
    "conversationId": "research",
    "title": {
      "en": "Pilot checklist configuration",
      "zh-CN": "试点清单配置"
    },
    "kind": "data",
    "renderer": "json",
    "createdMinutes": 592,
    "content": {
      "en": "{\n  \"name\": \"onboarding-pilot\",\n  \"enabled\": false,\n  \"cohortLimit\": 20,\n  \"durationDays\": 14,\n  \"fallback\": \"existing-setup\",\n  \"steps\": [\n    {\n      \"id\": \"create-project\",\n      \"label\": \"Create a project\",\n      \"required\": true\n    },\n    {\n      \"id\": \"invite-teammate\",\n      \"label\": \"Invite a teammate\",\n      \"required\": true\n    },\n    {\n      \"id\": \"shared-task\",\n      \"label\": \"Complete a shared task\",\n      \"required\": true\n    }\n  ],\n  \"expansionRequires\": \"product-owner-review\"\n}\n",
      "zh-CN": "{\n  \"name\": \"onboarding-pilot\",\n  \"enabled\": false,\n  \"cohortLimit\": 20,\n  \"durationDays\": 14,\n  \"fallback\": \"existing-setup\",\n  \"steps\": [\n    {\n      \"id\": \"create-project\",\n      \"label\": \"Create a project\",\n      \"required\": true\n    },\n    {\n      \"id\": \"invite-teammate\",\n      \"label\": \"Invite a teammate\",\n      \"required\": true\n    },\n    {\n      \"id\": \"shared-task\",\n      \"label\": \"Complete a shared task\",\n      \"required\": true\n    }\n  ],\n  \"expansionRequires\": \"product-owner-review\"\n}\n"
    }
  },
  {
    "id": "open-questions",
    "name": "open-questions.txt",
    "conversationId": "research",
    "title": {
      "en": "Questions for the next review",
      "zh-CN": "下次评审的问题"
    },
    "kind": "documents",
    "renderer": "text",
    "createdMinutes": 588,
    "content": {
      "en": "QUESTIONS FOR THE NEXT REVIEW\n\n1. Who owns recovery when an import is only partly successful?\n2. Which permission details should appear before an invitation is sent?\n3. What counts as a useful shared task for different kinds of teams?\n4. Which events let us distinguish setup completion from a shared result?\n5. Who can pause the pilot, and how quickly can the old flow be restored?\n\nOwner: Maya Chen\nNext review: September 11\nStatus: Open for discussion\n",
      "zh-CN": "下次评审的问题\n\n1. 部分导入成功时由谁负责恢复？\n2. 发送邀请前应显示哪些权限信息？\n3. 对不同团队而言，什么才是有价值的共享任务？\n4. 哪些事件能区分设置完成和共享成果？\n5. 谁可以暂停试点，原有流程能多快恢复？\n\n负责人：Maya Chen\n下次评审：9月11日\n状态：开放讨论\n"
    }
  }
]

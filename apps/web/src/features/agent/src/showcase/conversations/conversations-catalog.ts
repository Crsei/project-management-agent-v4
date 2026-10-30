import { conversation23Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-23-fixtures";
import { conversation22Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-22-fixtures";
import { conversation21Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-21-fixtures";
import { conversation20Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-20-fixtures";
import { conversation19Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-19-fixtures";
import { conversation18Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-18-fixtures";
import { conversation17Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-17-fixtures";
import { conversation16Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-16-fixtures";
import { conversation15Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-15-fixtures";
import { conversation14Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-14-fixtures";
import { conversation13Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-13-fixtures";
import { conversation12Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-12-fixtures";
import { conversation11Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-11-fixtures";
import { conversation10Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-10-fixtures";
import { conversation9Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-9-fixtures";
import { conversation8Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-8-fixtures";
import { conversation7Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-7-fixtures";
import { conversation6Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-6-fixtures";
import { conversation5Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-5-fixtures";
import { conversation4Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-4-fixtures";
import { conversation1Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-1-fixtures";
import { conversation2Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-2-fixtures";
import { conversation3Scenarios } from "@easyuse-ui/agent-workspace-views/conversations/conversation-3-fixtures";
import { threadTitles } from "@easyuse-ui/agent-workspace-views/conversations/fixtures";
export const conversationShowcases = (
  [
    {
      id: "conversation-1",
      scenarios: conversation1Scenarios,
      description: {
        "zh-CN": "结构化消息、安全 Markdown 子集与本地规范审阅。",
        en: "Typed messages, a safe Markdown subset and local specification review.",
      },
    },
    {
      id: "conversation-2",
      scenarios: conversation2Scenarios,
      description: {
        "zh-CN": "分组工具活动、结果展开与未知结果查询。",
        en: "Grouped tool activity, expandable results and unknown outcome reconciliation.",
      },
    },
    {
      id: "conversation-3",
      scenarios: conversation3Scenarios,
      description: {
        "zh-CN": "选项提问、自定义回答、失败重试与草稿保持。",
        en: "Interactive choices, custom answers, failure recovery and retained drafts.",
      },
    },
    {
      id: "conversation-4",
      scenarios: conversation4Scenarios,
      description: {
        "zh-CN": "会议纪要、行动清单与跟进邮件草稿；本地预览与下载。",
        en: "Meeting summary and action items \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-5",
      scenarios: conversation5Scenarios,
      description: {
        "zh-CN": "文件树、代码与 Diff 审阅，保留侧区选择和会话草稿。",
        en: "Code changes and repository context \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-6",
      scenarios: conversation6Scenarios,
      description: {
        "zh-CN": "只读终端记录重播、文件树和代码切换；不提供真实 PTY。",
        en: "Conversation with a side terminal \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-7",
      scenarios: conversation7Scenarios,
      description: {
        "zh-CN": "隔离的固定 HTML 预览、源码与加载失败恢复。",
        en: "Live preview and code artifacts \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-8",
      scenarios: conversation8Scenarios,
      description: {
        "zh-CN": "本地音频播放、时间定位、转录与文稿预览；未接入语音服务。",
        en: "Recording transcript and editorial brief \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-9",
      scenarios: conversation9Scenarios,
      description: {
        "zh-CN": "范围审阅、明确推进、未知结果查询与本地检查点。",
        en: "Agent plan execution and checkpoints \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-10",
      scenarios: conversation10Scenarios,
      description: {
        "zh-CN": "行内引用、来源摘记、失效说明与固定上下文快照。",
        en: "Research citations and context usage \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-11",
      scenarios: conversation11Scenarios,
      description: {
        "zh-CN": "文件选择、固定旧版本、新示例版本与本地文件导出。",
        en: "Generated artifacts and code output \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-12",
      scenarios: conversation12Scenarios,
      description: {
        "zh-CN": "通过与失败用例、错误栈定位和本地修复记录；不运行真实测试。",
        en: "Code execution and verification \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-13",
      scenarios: conversation13Scenarios,
      description: {
        "zh-CN": "按会话隔离的指令队列、编辑、排序、取消与明确投递。",
        en: "Queued follow-ups and conversation steering \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-14",
      scenarios: conversation14Scenarios,
      description: {
        "zh-CN": "主区 Diff、逐文件审阅与本地交接草稿；不创建真实提交。",
        en: "Change review and commit handoff \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-15",
      scenarios: conversation15Scenarios,
      description: {
        "zh-CN": "工单筛选、选择、优先级和本地分派；不写真实支持系统。",
        en: "Interactive support triage \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-16",
      scenarios: conversation16Scenarios,
      description: {
        "zh-CN": "编辑生成本地分支、版本切换和主区响应比较，保留原版本。",
        en: "Response branching and message editing \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-17",
      scenarios: conversation17Scenarios,
      description: {
        "zh-CN": "明确分段推进、停止保留部分输出、失败与未知结果恢复。",
        en: "Response lifecycle \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-18",
      scenarios: conversation18Scenarios,
      description: {
        "zh-CN": "库存预览、主区完整表格、列设置、筛选、排序和选择保持。",
        en: "Adaptive component workspace \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-19",
      scenarios: conversation19Scenarios,
      description: {
        "zh-CN": "本地会话/文件快照恢复、撤销/重做、保存和未知结果检查。",
        en: "Session checkpoints and recovery \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-20",
      scenarios: conversation20Scenarios,
      description: {
        "zh-CN": "固定用量快照、摘要审阅、本地压缩、原始归档和续接草稿保持。",
        en: "Context compaction and continuation \u00b7 fixed local scenarios",
      },
    },
    {
      id: "parent-child-conversations",
      scenarios: conversation21Scenarios,
      description: {
        "zh-CN": "父子草稿与阅读独立、本地任务委派、状态推进和未知查询。",
        en: "Parent child conversations \u00b7 fixed local scenarios",
      },
    },
    {
      id: "web-answer",
      scenarios: conversation22Scenarios,
      description: {
        "zh-CN": "复用来源列表和行内引用；刷新失败保持已有答复与草稿。",
        en: "Web answer with sources \u00b7 fixed local scenarios",
      },
    },
    {
      id: "conversation-23",
      scenarios: conversation23Scenarios,
      description: {
        "zh-CN": "上下文包、公开步骤、工具记录、停止与明确推进；不执行真实工具。",
        en: "Task context reconstruction and progress \u00b7 fixed local scenarios",
      },
    },
  ] as const
).map((item) => ({
  ...item,
  group: "Conversations",
  title: {
    "zh-CN": `${item.id === "parent-child-conversations" ? "Conversation 21" : item.id === "web-answer" ? "Conversation 22" : item.id.replace("conversation-", "Conversation ")} · ${threadTitles[item.id as keyof typeof threadTitles]["zh-CN"]}`,
    en: `${item.id === "parent-child-conversations" ? "Conversation 21" : item.id === "web-answer" ? "Conversation 22" : item.id.replace("conversation-", "Conversation ")} · ${threadTitles[item.id as keyof typeof threadTitles].en}`,
  },
  lifecycle: "showcase" as const,
  href: `/agent/showcase/${item.id}`,
  referenceUrl: `https://shadcnblocks-admin.vercel.app/ai-chat/${item.id}`,
  pageContractPath: `plans/reference/ai-chat-contracts/${item.id}.json`,
}));

import type { Copy } from "../model"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures"
export const conversation18Scenarios = commonScenarios
export type Conversation18Scenario = CommonScenario
export interface ComponentRecord {
  id: string
  name: Copy
  surfaces: string
  changed: Copy
  confidence: "Ready" | "In review" | "Needs owner" | "Blocked"
  source: string
  notes: Copy
}
export interface Conversation18Fixture {
  source: ComposerDemoSource
  rows: ComponentRecord[]
}
const names = [
  "Activity feed",
  "Approval drawer",
  "Audit log",
  "Bulk toolbar",
  "Command menu",
  "Data table",
  "Date range picker",
  "Empty state",
  "Filter bar",
  "Form builder",
  "Import dialog",
  "Metric strip",
  "Navigation tree",
  "Permission matrix",
  "Release banner",
  "Resource picker",
  "Review panel",
  "Role selector",
  "Run timeline",
  "Saved view menu",
  "Search field",
  "Status banner",
  "Step indicator",
  "Webhook log",
]
const zh = [
  "活动流",
  "审批抽屉",
  "审计日志",
  "批量工具栏",
  "命令菜单",
  "数据表",
  "日期范围选择器",
  "空状态",
  "筛选栏",
  "表单构建器",
  "导入对话框",
  "指标条",
  "导航树",
  "权限矩阵",
  "发布横幅",
  "资源选择器",
  "审阅面板",
  "角色选择器",
  "运行时间轴",
  "已存视图菜单",
  "搜索字段",
  "状态横幅",
  "步骤指示器",
  "Webhook 日志",
]
const surfaces = [
  "Admin · Security",
  "Admin · Commerce",
  "Security · Admin",
  "Admin",
  "Shared · Navigation",
  "Admin · Shared",
  "Commerce · Admin",
  "Shared",
  "Shared · Admin",
  "Forms · Admin",
  "Commerce",
  "Admin · Marketing",
  "Navigation · Shared",
  "Security · Admin",
  "Marketing",
  "Commerce · Shared",
  "Admin · Shared",
  "Security · Forms",
  "Automations",
  "Admin · Navigation",
  "Shared · Commerce",
  "Shared",
  "Commerce",
  "Automations · Security",
]
export function createConversation18Fixture(
  scenario: Conversation18Scenario,
): Conversation18Fixture {
  return {
    source: createThreadFixture(
      "conversation-18",
      scenario,
      {
        "zh-CN": "打开组件清单，让我审阅发布准备度时保持此会话可用。",
        en: "Open the component inventory and keep this conversation available while I review release readiness.",
      },
      {
        "zh-CN":
          "我找到了共享产品界面的 24 条组件记录。工作网格可排序记录、调整列宽、配置属性、刷新生成值及添加发布说明列，无需关闭此会话。",
        en: "I found 24 component records across the shared product surfaces. The working grid can sort records, resize columns, configure properties, refresh generated values, and add a release-notes column without closing this thread.",
      },
    ),
    rows:
      scenario === "empty"
        ? []
        : names.map((name, index) => ({
            id: "component-" + (index + 1),
            name: { "zh-CN": zh[index], en: name },
            surfaces: surfaces[index],
            changed: {
              "zh-CN": index < 7 ? "今天" : "本月",
              en: index < 7 ? "Today" : "This month",
            },
            confidence: [8, 10, 18, 19, 20].includes(index)
              ? "Needs owner"
              : [4, 5, 6, 9, 15, 16].includes(index)
                ? "In review"
                : [13, 17].includes(index)
                  ? "Blocked"
                  : "Ready",
            source:
              "ui.shadcnblocks.com/components/" +
              name.toLowerCase().replaceAll(" ", "-"),
            notes: {
              "zh-CN": "核对负责人、发布证据与键盘状态。",
              en: "Confirm owner, release evidence, and keyboard states.",
            },
          })),
  }
}

import type { ToolRecord } from "./tool-activity"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation2Scenarios = [
  ...commonScenarios,
  { id: "running", name: { "zh-CN": "执行中", en: "Running" } },
  { id: "failed", name: { "zh-CN": "工具失败", en: "Tool failure" } },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown" } },
] as const
export type Conversation2Scenario =
  CommonScenario | "running" | "failed" | "unknown"
export interface Conversation2Fixture {
  source: ComposerDemoSource
  calls: ToolRecord[]
}
export function createConversation2Fixture(
  scenario: Conversation2Scenario,
): Conversation2Fixture {
  const source = createThreadFixture(
    "conversation-2",
    scenario,
    {
      "zh-CN": "检查产品表格的密度，在效率与状态、行操作的可读性之间找到平衡。",
      en: "Review product table density and balance efficiency with readable statuses and row actions.",
    },
    {
      "zh-CN":
        "最合适的默认值是项目已有的 Compact 模式：让常用视口中的记录保持易于扫描，同时为双行商品信息、状态、价格与主要操作留出空间。\n\n## 建议的密度系统\n\n- 默认复用 Compact；高频操作表格可以明确提供更紧凑的局部模式。\n- 密度允许用户选择，但切换时保持列宽与行操作位置。\n- 次要元数据移入详情面板，不通过增加列或挤压内容来堆叠信息。",
      en: "The best default is the existing Compact mode. It keeps common viewports easy to scan while leaving room for a two-line product identity, status, price and one primary action.\n\n## Recommended density system\n\n- Reuse Compact as the shared default; offer a declared denser mode for high-volume operational tables.\n- Keep density user-selectable, but preserve column widths and row-action placement between modes.\n- Move secondary metadata into a detail panel instead of compressing it into additional columns.",
    },
  )
  const calls: ToolRecord[] = [
    {
      id: "table-search",
      name: "search_tables",
      source: "local-demo",
      target: "catalog / orders / inventory / customers",
      status: "completed",
      duration: "12s",
      arguments: { scope: "fixture tables" },
      output: {
        tables: ["catalog", "orders", "inventory", "customers"],
        source: "local fixture",
      },
    },
    {
      id: "density-audit",
      name: "audit_density",
      source: "local-demo",
      target: "UI density contract",
      status:
        scenario === "running"
          ? "running"
          : scenario === "failed"
            ? "failed"
            : scenario === "unknown"
              ? "waiting"
              : "completed",
      outcome: scenario === "unknown" ? "unknown" : "known",
      duration: "3m 38s",
      arguments: {
        dimensions: ["row height", "action placement", "keyboard focus"],
      },
      output:
        scenario === "failed" ||
        scenario === "unknown" ||
        scenario === "running"
          ? undefined
          : "Fixed local audit: compact rows; stable action column; visible keyboard focus.",
      error:
        scenario === "failed"
          ? "Fixture audit stopped: one table definition is missing."
          : undefined,
    },
  ]
  return structuredClone({ source, calls })
}

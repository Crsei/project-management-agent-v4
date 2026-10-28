import type { CanvasDocument, CanvasNodeDefinition } from "@easyuse-ui/ui/lib/canvas-model"
import type { Copy } from "../../model"

export type Role = "research" | "design" | "review"
export type Task = { id: string; title: Copy | string; assignment: Copy | string; role: Role; agent: string; version: number }
export type LogEntry = { id: string; kind: "text" | "tool" | "handoff"; text: Copy; output?: Copy }
const c = (en: string, zh: string): Copy => ({ en, "zh-CN": zh })
export const roleNames = { research: c("Research", "研究"), design: c("Design", "设计"), review: c("Review", "审查") }
export const sharedBrief = c("Ship a usage and billing dashboard for shadcnblocks-admin. Claude maps the owner’s decisions, Codex implements the overview, and Grok checks the handoff. Clearly distinguish invoice estimates from confirmed charges.", "为 shadcnblocks-admin 交付用量与账单仪表盘。Claude 梳理所有者的决策，Codex 实现概览，Grok 审查交接。明确区分预估账单与已确认费用。")
export const tasks: Task[] = [
  { id: "research", role: "research", agent: "Claude Code", version: 0, title: c("Map billing decisions", "梳理账单决策"), assignment: c("Review the billing journey. Identify what a workspace owner needs to know about usage, estimates, overages, and changing plans. Hand the requirements to Codex.", "审查账单流程。确定工作区所有者需要了解的用量、预估、超额与套餐变更信息。将需求交给 Codex。") },
  { id: "design", role: "design", agent: "Codex", version: 0, title: c("Build the usage overview", "构建用量概览"), assignment: c("Use Claude’s requirements to build the billing overview with existing dashboard components. Separate estimates from confirmed charges and hand the implementation to Grok.", "依据 Claude 的需求，用现有仪表盘组件构建账单概览。将预估与已确认费用分开，并将实现交给 Grok。") },
  { id: "review", role: "review", agent: "Grok", version: 0, title: c("Check the billing edge cases", "检查账单边界情况"), assignment: c("Review Claude’s requirements and Codex’s implementation. Check zero usage, over-limit states, stale billing periods, and narrow layouts. Return any actionable findings to Codex.", "审查 Claude 的需求与 Codex 的实现。检查零用量、超额、过期账期及窄布局。将可操作的发现返回 Codex。") },
]
export const outputs: Record<string, Copy> = {
  research: c("Lead with current usage, the billing period, and a clearly labelled estimate. Explain overages before offering an upgrade. Keep invoice history and payment issues available without interrupting the primary decision.", "优先展示当前用量、账期及明确标注的预估。先解释超额，再建议升级。保留发票历史与付款问题入口，不打断主要决策。"),
  design: c("Added usage cards, a billing-period selector, and an estimated-invoice breakdown. Confirmed charges and forecasts are separated. Empty, loading, and over-limit states are covered.", "已添加用量卡片、账期选择器及预估发票明细。已确认费用与预测分开展示，并覆盖空数据、加载及超额场景。"),
  review: c("The totals are consistent. One fix before handoff: keep the Estimate label visible in the narrow layout. Zero usage, overages, and billing-period changes all pass the review.", "总额一致。交接前需修复一处：窄布局仍须显示“预估”标签。零用量、超额与账期变更通过样例审查。"),
}
export const logs: Record<string, LogEntry[]> = {
  research: [
    { id: "r1", kind: "text", text: c("I’ll map the owner’s decisions first, then check which numbers the current billing page exposes. That should keep the design focused on clarity before conversion.", "我将先梳理所有者的决策，再检查当前账单页面展示的数字。先关注清晰度，再考虑转化。") },
    { id: "r2", kind: "tool", text: c("Read(src/features/billing/billing-page.tsx)", "Read(src/features/billing/billing-page.tsx)"), output: c("Read 146 lines. Found plan summary, usage meter, invoice history, and payment method.", "读取 146 行。找到套餐摘要、用量计量、发票历史和付款方式。") },
    { id: "r3", kind: "text", text: c("There are three questions to answer: what have I used, what will I pay, and what changes if I upgrade? The current page mixes confirmed charges with the forecast. I’d separate those before adding another chart.", "需要回答三个问题：用了多少、将支付多少、升级会改变什么？当前页面混合已确认费用与预测，应先将它们分开，再增加图表。") },
    { id: "r4", kind: "text", text: outputs.research },
    { id: "r5", kind: "handoff", text: c("Handoff → Codex", "交接 → Codex"), output: c("The next terminal can use this output when its dependencies finish.", "依赖完成后，下一个终端即可使用此输出。") },
  ],
  design: [
    { id: "d1", kind: "tool", text: c("Received Claude’s billing requirements", "收到 Claude 的账单需求"), output: c("Separate estimates from confirmed charges. Cover zero usage, overages, and period changes.", "区分预估与已确认费用。覆盖零用量、超额和账期变更。") },
    { id: "d2", kind: "text", text: c("I’ll separate the estimate from confirmed charges, then add the usage and overage states.", "我将区分预估与已确认费用，然后增加用量与超额状态。") },
    { id: "d3", kind: "tool", text: c("Edited src/features/billing/usage-overview.tsx", "Edited src/features/billing/usage-overview.tsx"), output: c('+ <UsageSummary period={period} />\n+ <InvoiceEstimate label="Estimated next invoice" />\n+ <OverageNotice usage={usage} limit={plan.limit} />', '+ <UsageSummary period={period} />\n+ <InvoiceEstimate label="预估下次账单" />\n+ <OverageNotice usage={usage} limit={plan.limit} />') },
    { id: "d4", kind: "tool", text: c("pnpm test -- billing-overview", "pnpm test -- billing-overview"), output: c("16 passed · 0 failed · authored sample, not executed", "16 通过 · 0 失败 · 编写的样例，未执行测试") },
    { id: "d5", kind: "text", text: outputs.design },
    { id: "d6", kind: "handoff", text: c("Handoff → Grok", "交接 → Grok"), output: c("The next terminal can use this output when its dependencies finish.", "依赖完成后，下一个终端即可使用此输出。") },
  ],
  review: [
    { id: "v1", kind: "tool", text: c("Received Codex’s implementation + Claude’s requirements", "收到 Codex 的实现与 Claude 的需求"), output: c("Usage overview, invoice estimate, and billing-period states are ready for review.", "用量概览、预估账单与账期状态已准备好进行审查。") },
    { id: "v2", kind: "text", text: c("I’m checking the cases that make a billing screen misleading: zero usage, overages, and a period change halfway through loading.", "我正在检查可能使账单页面产生误导的情况：零用量、超额和加载中途变更账期。") },
    { id: "v3", kind: "tool", text: c("Run tests/billing-edge-cases.test.ts", "Run tests/billing-edge-cases.test.ts"), output: c('Zero usage: pass\nOver-limit estimate: pass\nStale period response: pass\nNarrow layout: Estimate label hidden\nAuthored sample; no command was executed.', '零用量：通过\n超额预估：通过\n过期账期响应：通过\n窄布局：预估标签被隐藏\n编写的样例；没有执行命令。') },
    { id: "v4", kind: "text", text: c('One issue: the mobile layout hides “Estimate” but leaves the price. That can read like a confirmed charge. Keep the label next to the amount; the rest of the flow is consistent.', '发现一个问题：窄布局隐藏“预估”却保留价格，可能被误读为已确认费用。应将标签保留在金额旁，其余流程一致。') },
    { id: "v5", kind: "text", text: outputs.review },
    { id: "v6", kind: "handoff", text: c("Review → Codex", "审查 → Codex"), output: c("Keep the Estimate label visible on mobile. Send Codex a follow-up to apply the change.", "在窄布局中保留预估标签。向 Codex 发送后续消息以应用修改。") },
  ],
}
export const definitions: CanvasNodeDefinition[] = ["research", "design", "review"].map(type => ({ type, label: type, category: "Agents", defaults: {}, ports: [{ id: "in", label: "IN", direction: "input", type: "message" }, { id: "out", label: "OUT", direction: "output", type: "message" }] }))
export function createDocument(): CanvasDocument {
  return { schemaVersion: 1, id: "mixed-agent-canvas", revision: 0, nodes: tasks.map(task => ({ id: task.id, title: typeof task.title === "string" ? task.title : task.title.en, type: task.role, config: {}, position: task.id === "design" ? { x: 0, y: 0 } : { x: 680, y: task.id === "review" ? 530 : 0 } })), edges: [{ id: "research-design", source: "research", sourcePort: "out", target: "design", targetPort: "in" }, { id: "design-review", source: "design", sourcePort: "out", target: "review", targetPort: "in" }], frames: [], notes: [] }
}

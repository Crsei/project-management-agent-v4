export type Copy = { "zh-CN": string; en: string }
export const text = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })
export type TraceSpan = {
  id: string
  parentId?: string
  name: Copy
  status: string
  start: number
  duration: number
  input: Copy
  output: Copy
  timeline: boolean
}
export type TraceRecord = {
  id: string
  task: Copy
  agent: Copy
  request: Copy
  outcome: Copy
  status: string
  day: number
  time: string
  elapsed: number
  tokens: number
  cost: number
  spans: TraceSpan[]
}

type Seed = {
  id: string
  task: Copy
  agent: Copy
  context: Copy
  outcome: Copy
  status: string
  time: string
  elapsed: number
  tokens: number
  steps: Copy[]
  tool: string
  interruptedStep?: number
}
const seeds: Seed[] = [
  { id: "84f2", task: text("准备客户报告", "Prepare customer report"), agent: text("客户报告", "Customer reporting"), context: text("3,120 条活跃客户记录 · 1.8 秒。遵循客户数据导出规则。", "3,120 active customer records · 1.8s. Follow the customer data export."), outcome: text("超过 700 条客户记录的导出需要审核，数据才能离开报告工作区。", "Exports above 700 customer records require review before data leaves the reporting workspace."), status: "paused", time: "12:42", elapsed: 120, tokens: 1800, tool: "BigQuery", steps: [text("读取客户数据", "Read customer data"), text("计算指标", "Calculate metrics"), text("导出 3,120 条记录", "Export 3,120 records"), text("通知仪表盘负责人", "Notify dashboard owner")] },
  { id: "91ac", task: text("处理客户退款", "Process customer refund"), agent: text("退款处理器", "Refund processor"), context: text("付款 pi_84kc · $129.00。遵循工作区审批和数据处理规则。", "Payment pi_84kc · $129.00. Follow the workspace approval and data handling rules."), outcome: text("将 $129.00 退回原付款方式", "Returning $129.00 to the original payment method"), status: "running", time: "12:44", elapsed: 8, tokens: 2200, tool: "Stripe", steps: [text("查找原付款", "Find original payment"), text("发起退款", "Issue refund"), text("更新账单记录", "Update billing record")] },
  { id: "78de", task: text("为交易 #9031 应用折扣", "Apply discount to Deal #9031"), agent: text("交易审批", "Deal desk"), context: text("Harborline Apps · 年度团队计划。遵循折扣政策。", "Harborline Apps · annual team plan. Follow the discount policy."), outcome: text("交易审批台可应用最高 20% 的折扣。更大的折扣不能按此规则继续，请修改请求。", "Deal desk can apply discounts up to 20%. A larger discount cannot proceed under this rule. Revise the request to continue."), status: "waiting", time: "12:39", elapsed: 300, tokens: 2600, tool: "Salesforce", interruptedStep: 1, steps: [text("读取交易详情", "Read deal details"), text("应用 35% 折扣", "Apply 35% discount"), text("重新计算报价", "Recalculate quote"), text("通知账户负责人", "Notify account owner")] },
  { id: "c31f", task: text("核对 Stripe 付款", "Reconcile Stripe payouts"), agent: text("发票核对", "Invoice reconciliation"), context: text("24 笔交易 · $18,420.00。遵循工作区审批和数据处理规则。", "24 transactions · $18,420.00. Follow the workspace approval and data handling rules."), outcome: text("payout,invoices,amount,status\npo_91ad,24,18420.00,reconciled", "payout,invoices,amount,status\npo_91ad,24,18420.00,reconciled"), status: "completed", time: "12:35", elapsed: 42, tokens: 3000, tool: "Stripe", steps: [text("读取付款交易", "Read payout transactions"), text("匹配发票记录", "Match invoice records"), text("保存核对结果", "Save reconciliation")] },
  { id: "b7a1", task: text("刷新续约预测", "Refresh renewal forecast"), agent: text("客户报告", "Customer reporting"), context: text("本季度 86 个账户续约。遵循工作区审批和数据处理规则。", "86 accounts renewing this quarter. Follow the workspace approval and data handling rules."), outcome: text("季度预测已更新", "Quarterly forecast updated"), status: "completed", time: "12:28", elapsed: 31, tokens: 3400, tool: "Salesforce", steps: [text("载入续约管线", "Load renewal pipeline"), text("计算续约风险", "Calculate renewal risk"), text("发布预测", "Publish forecast")] },
  { id: "a19c", task: text("归档已解决工单", "Archive resolved tickets"), agent: text("支持分诊", "Support triage"), context: text("42 个已解决超过 30 天的工单。遵循工作区审批和数据处理规则。", "42 tickets resolved more than 30 days ago. Follow the workspace approval and data handling rules."), outcome: text("42 个工单已归档", "42 tickets archived"), status: "completed", time: "12:16", elapsed: 18, tokens: 3800, tool: "Zendesk", steps: [text("查找已解决工单", "Find resolved tickets"), text("核对保留政策", "Check retention policy"), text("归档工单", "Archive tickets")] },
  { id: "f42b", task: text("同步采购订单记录", "Sync purchase order records"), agent: text("采购订单审查", "Purchase order review"), context: text("12 个已批准采购订单。遵循工作区审批和数据处理规则。", "12 approved purchase orders. Follow the workspace approval and data handling rules."), outcome: text("—", "—"), status: "failed", time: "11:58", elapsed: 12, tokens: 4200, tool: "Coupa", steps: [text("读取已批准采购订单", "Read approved purchase orders"), text("同步供应商记录", "Sync vendor records"), text("发布同步摘要", "Publish sync summary")] },
  { id: "02cd", task: text("准备每周账户摘要", "Prepare weekly account digest"), agent: text("客户报告", "Customer reporting"), context: text("18 条账户更新。遵循工作区审批和数据处理规则。", "18 account updates. Follow the workspace approval and data handling rules."), outcome: text("已发布到 #customer-success", "Posted to #customer-success"), status: "completed", time: "11:45", elapsed: 54, tokens: 4500, tool: "Slack", steps: [text("收集账户更新", "Collect account updates"), text("汇总活动", "Summarize activity"), text("发送账户摘要", "Send account digest")] },
  { id: "d310", task: text("分配新支持请求", "Route incoming support requests"), agent: text("支持分诊", "Support triage"), context: text("16 条新的支持请求。遵循工作区审批和数据处理规则。", "16 new support requests. Follow the workspace approval and data handling rules."), outcome: text("全部 16 条请求已分配", "All 16 requests assigned"), status: "completed", time: "10:32", elapsed: 26, tokens: 4900, tool: "Zendesk", steps: [text("读取新请求", "Read new requests"), text("分类优先级", "Classify priority"), text("分配支持负责人", "Assign support owners")] },
  { id: "2e17", task: text("审核供应商入驻", "Review vendor onboarding"), agent: text("采购订单审查", "Purchase order review"), context: text("Vela Design Co. · 供应商资料。遵循工作区审批和数据处理规则。", "Vela Design Co. · vendor profile. Follow the workspace approval and data handling rules."), outcome: text("供应商 V-2048 已创建", "Vendor V-2048 created"), status: "completed", time: "09:14", elapsed: 72, tokens: 5300, tool: "Coupa", steps: [text("读取供应商提交内容", "Read vendor submission"), text("校验必填字段", "Verify required fields"), text("创建供应商记录", "Create vendor record")] },
  { id: "62ca", task: text("校验月度账单导出", "Validate monthly billing export"), agent: text("发票核对", "Invoice reconciliation"), context: text("月度账单摘要。遵循工作区审批和数据处理规则。", "Monthly billing summary. Follow the workspace approval and data handling rules."), outcome: text("账单导出已校验", "Billing export validated"), status: "completed", time: "16:20", elapsed: 38, tokens: 5700, tool: "Internal tool", steps: [text("载入账单导出", "Load billing export"), text("校验总额", "Validate totals"), text("保存报告", "Save report")] },
  { id: "519f", task: text("刷新客户健康评分", "Refresh customer health scores"), agent: text("客户报告", "Customer reporting"), context: text("使用和支持活动。遵循工作区审批和数据处理规则。", "Usage and support activity. Follow the workspace approval and data handling rules."), outcome: text("客户健康仪表盘已更新", "Customer health dashboard updated"), status: "completed", time: "14:10", elapsed: 46, tokens: 6100, tool: "BigQuery", steps: [text("读取账户信号", "Read account signals"), text("计算健康评分", "Calculate health scores"), text("发布仪表盘", "Publish dashboard")] },
]

function makeRecord(seed: Seed, day: number): TraceRecord {
  const request = text(`${seed.task["zh-CN"]}。${seed.context["zh-CN"]}`, `${seed.task.en}. ${seed.context.en}`)
  const plan = text(`执行${seed.steps.map(step => step["zh-CN"]).join(" → ")}。继续前执行工作区权限和数据处理规则。`, `Execute ${seed.steps.map(step => step.en.toLowerCase()).join(" → ")}. ${seed.id === "84f2" ? "Enforce customer data export before continuing." : "Apply the workspace's connected-app permissions."}`)
  const span = (id: string, name: Copy, status: string, start: number, duration: number, input: Copy, output: Copy, timeline = true, parentId?: string): TraceSpan => ({ id, name, status, start, duration, input, output, timeline, parentId })
  const spans: TraceSpan[] = [
    span("plan", text("理解请求", "Interpret request"), "completed", 0, seed.elapsed * .12, request, plan),
    span("agent", seed.agent, seed.status, seed.elapsed * .12, seed.elapsed * .8, request, seed.outcome, false),
  ]
  seed.steps.forEach((name, index) => {
    const interventionIndex = seed.interruptedStep ?? seed.steps.length - 2
    const pending = seed.status !== "completed" && index > interventionIndex
    const intervention = seed.status !== "completed" && index === interventionIndex
    const status = pending ? "queued" : intervention ? seed.status : "completed"
    const output = status === "failed" ? text("连接的应用拒绝了供应商同步请求。未发布同步摘要。检查连接权限后再运行。", "The connected app rejected the vendor sync request. No sync summary was published. Inspect connected-app permissions before another run.") : pending ? text("此步骤尚未开始；正在等待前序步骤。", "This step has not started; it is waiting for the preceding step.") : intervention ? seed.outcome : text(`${name["zh-CN"]}：已从本地执行记录读取结果。`, `${name.en}: result read from the fixture execution record.`)
    const duration = pending ? 0 : seed.elapsed * (.68 / seed.steps.length)
    const start = seed.elapsed * (.14 + index * (.8 / seed.steps.length))
    spans.push(span(`step-${index}`, name, status, start, duration, request, output, true, "agent"))
    if (status === "completed" && index < 2) spans.push(span(`tool-${index}`, text(`${index ? "内部工具" : seed.tool} · 结果校验`, `${index ? "Internal tool" : seed.tool} · result validation`), "completed", start + duration, seed.elapsed * .02, name, text("输入与输出校验已通过。", "Input and output validation passed."), false, `step-${index}`))
  })
  return { id: `run_${seed.id}${day === 18 ? "" : `_${day}`}`, task: seed.task, agent: seed.agent, request, outcome: seed.outcome, status: seed.status, day, time: seed.time, elapsed: seed.elapsed, tokens: seed.tokens, cost: seed.tokens >= 4200 ? .02 : .01, spans }
}

export function createTraceRecords(longContent = false): TraceRecord[] {
  const records = [18, 17, 16].flatMap(day => seeds.map(seed => makeRecord(seed, day)))
  if (!longContent) return records
  return records.map((record, index) => index === 0 ? {
    ...record,
    task: text("准备跨区域客户报告与数据保留审核 — 北美、欧洲及亚太工作区完整运行记录", "Prepare cross-region customer report and data-retention review — North America, Europe and Asia-Pacific workspace execution"),
    spans: record.spans.map(span => ({ ...span, output: text(Array.from({ length: 12 }, (_, i) => `检查 ${i + 1}：${span.output["zh-CN"]}`).join("\n"), Array.from({ length: 12 }, (_, i) => `Check ${i + 1}: ${span.output.en}`).join("\n")) })),
  } : record)
}

// Aggregate history is a distinct fixture series, not a count of the sampled rows.
export const traceHistory = [3,5,2,8,4,11,7,4,2,6,9,14,12,8,16,7,4,5,18,9,3,7,4,15,16,9,3,5,8,13,12,6,4,7,2,6,7,9,5,3,5,8,6,4,11,3,7,6,8,2,4,9].map((success, index) => ({ id: `history-${index}`, success, error: index === 5 || index === 30 ? 2 : index === 23 ? 1 : 0 }))

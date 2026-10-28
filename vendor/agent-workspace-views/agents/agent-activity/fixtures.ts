export type Copy = { "zh-CN": string; en: string }
export const copy = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })
export type RunStatus = "running" | "review" | "blocked" | "completed" | "failed" | "cancelled"
export type StepStatus = "completed" | "running" | "waiting" | "review" | "blocked" | "failed" | "cancelled"
export type RunStep = { id: string; title: Copy; tool: string; detail: Copy; status: StepStatus; action?: "review" | "rule" | "retry" }
export type ActivityRun = {
  id: string; time: string; ageMinutes: number; relative: Copy; agent: Copy; title: Copy; integrations: string
  status: RunStatus; duration: string; steps: RunStep[]; output?: { filename: string; content: string }
}
const step = (id: string, title: Copy, tool: string, detail: Copy, status: StepStatus = "completed", action?: RunStep["action"]): RunStep => ({ id, title, tool, detail, status, action })
export function activityFixtures(): ActivityRun[] {
  return [
    { id: "run_91ac", time: "12:44", ageMinutes: 1, relative: copy("1 分钟前", "1 min ago"), agent: copy("退款处理", "Refund processor"), title: copy("处理客户退款", "Process customer refund"), integrations: "Stripe → NetSuite", status: "running", duration: "8s", steps: [
      step("payment", copy("查找原始付款", "Find original payment"), "Stripe", copy("付款 pi_84kc · $129.00", "Payment pi_84kc · $129.00")),
      step("refund", copy("发起退款", "Issue refund"), "Stripe", copy("向原付款方式退回 $129.00", "Returning $129.00 to the original payment method"), "running"),
      step("billing", copy("更新账单记录", "Update billing record"), "NetSuite", copy("等待退款确认", "Waiting for refund confirmation"), "waiting"),
    ] },
    { id: "run_84f2", time: "12:42", ageMinutes: 3, relative: copy("3 分钟前", "3 mins ago"), agent: copy("客户报告", "Customer reporting"), title: copy("准备客户报告", "Prepare customer report"), integrations: "BigQuery → Internal tool → Tableau → Slack", status: "review", duration: "2m", steps: [
      step("data", copy("读取客户数据", "Read customer data"), "BigQuery", copy("3,120 条活跃客户记录 · 1.8s", "3,120 active customer records · 1.8s")),
      step("metrics", copy("计算指标", "Calculate metrics"), "Internal tool", copy("收入、留存和账户健康 · 4.1s", "Revenue, retention, and account health · 4.1s")),
      step("export", copy("导出 3,120 条记录", "Export 3,120 records"), "Tableau", copy("2,420 条记录超过审核阈值", "2,420 records over the review threshold"), "review", "review"),
      step("notify", copy("通知仪表板负责人", "Notify dashboard owner"), "Slack", copy("尚未开始 · 等待导出决定", "Not started · waiting for the export decision"), "waiting"),
    ] },
    { id: "run_78de", time: "12:39", ageMinutes: 6, relative: copy("6 分钟前", "6 mins ago"), agent: copy("交易支持", "Deal desk"), title: copy("为交易 #9031 应用折扣", "Apply discount to Deal #9031"), integrations: "Salesforce → Internal tool → Slack", status: "blocked", duration: "5m", steps: [
      step("deal", copy("读取交易详情", "Read deal details"), "Salesforce", copy("Harborline Apps · 年度团队套餐", "Harborline Apps · annual team plan")),
      step("discount", copy("应用 35% 折扣", "Apply 35% discount"), "Salesforce", copy("请求 35% · 允许上限 20%", "Requested 35% · maximum allowed 20%"), "blocked", "rule"),
      step("quote", copy("重新计算报价", "Recalculate quote"), "Internal tool", copy("等待合规折扣", "Waiting for a compliant discount"), "waiting"),
      step("owner", copy("通知客户负责人", "Notify account owner"), "Slack", copy("等待更新报价", "Waiting for the updated quote"), "waiting"),
    ] },
    { id: "run_c31f", time: "12:35", ageMinutes: 10, relative: copy("10 分钟前", "10 mins ago"), agent: copy("发票对账", "Invoice reconciliation"), title: copy("核对 Stripe 结算", "Reconcile Stripe payouts"), integrations: "Stripe → NetSuite", status: "completed", duration: "42s", steps: [
      step("payout", copy("读取结算交易", "Read payout transactions"), "Stripe", copy("24 笔交易 · $18,420.00", "24 transactions · $18,420.00")),
      step("match", copy("匹配发票记录", "Match invoice records"), "NetSuite", copy("24 张发票全部匹配", "24 of 24 invoices matched")),
      step("save", copy("保存对账结果", "Save reconciliation"), "NetSuite", copy("未发现差异", "No discrepancies found")),
    ], output: { filename: "payout-reconciliation.csv", content: "payout,invoices,amount,status\npo_91ad,24,18420.00,reconciled" } },
    { id: "run_b7a1", time: "12:28", ageMinutes: 17, relative: copy("17 分钟前", "17 mins ago"), agent: copy("客户报告", "Customer reporting"), title: copy("刷新续约预测", "Refresh renewal forecast"), integrations: "Salesforce → Internal tool → Tableau", status: "completed", duration: "31s", steps: [
      step("pipeline", copy("加载续约管线", "Load renewal pipeline"), "Salesforce", copy("本季度 86 个账户将续约", "86 accounts renewing this quarter")),
      step("risk", copy("计算续约风险", "Calculate renewal risk"), "Internal tool", copy("7 个账户需要关注", "7 accounts need attention")),
      step("publish", copy("发布预测", "Publish forecast"), "Tableau", copy("季度预测已更新", "Quarterly forecast updated")),
    ] },
    { id: "run_a19c", time: "12:16", ageMinutes: 29, relative: copy("29 分钟前", "29 mins ago"), agent: copy("支持分流", "Support triage"), title: copy("归档已解决工单", "Archive resolved tickets"), integrations: "Zendesk → Internal tool", status: "completed", duration: "18s", steps: [
      step("tickets", copy("查找已解决工单", "Find resolved tickets"), "Zendesk", copy("42 张工单已解决超过 30 天", "42 tickets resolved more than 30 days ago")),
      step("policy", copy("检查保留策略", "Check retention policy"), "Internal tool", copy("所有记录均可归档", "All records eligible for archive")),
      step("archive", copy("归档工单", "Archive tickets"), "Zendesk", copy("42 张工单已归档", "42 tickets archived")),
    ] },
    { id: "run_f42b", time: "11:58", ageMinutes: 47, relative: copy("47 分钟前", "47 mins ago"), agent: copy("采购单审核", "Purchase order review"), title: copy("同步采购单记录", "Sync purchase order records"), integrations: "Coupa → NetSuite → Slack", status: "failed", duration: "12s", steps: [
      step("orders", copy("读取已批准采购单", "Read approved purchase orders"), "Coupa", copy("12 张已批准采购单", "12 approved purchase orders")),
      step("vendors", copy("同步供应商记录", "Sync vendor records"), "NetSuite", copy("连接在 10s 后超时 · 可安全重试", "Connection timed out after 10s · safe to retry"), "failed", "retry"),
      step("summary", copy("发布同步摘要", "Publish sync summary"), "Slack", copy("尚未开始 · 等待供应商记录", "Not started · waiting for vendor records"), "waiting"),
    ] },
    { id: "run_02cd", time: "11:45", ageMinutes: 60, relative: copy("1 小时前", "1 hour ago"), agent: copy("客户报告", "Customer reporting"), title: copy("准备每周账户摘要", "Prepare weekly account digest"), integrations: "Salesforce → Internal tool → Slack", status: "completed", duration: "54s", steps: [
      step("updates", copy("收集账户更新", "Collect account updates"), "Salesforce", copy("18 条账户更新", "18 account updates")),
      step("digest", copy("汇总活动", "Summarize activity"), "Internal tool", copy("每周摘要已准备", "Weekly digest prepared")),
      step("send", copy("发送账户摘要", "Send account digest"), "Slack", copy("已发布到 #customer-success", "Posted to #customer-success")),
    ] },
    { id: "run_d310", time: "10:32", ageMinutes: 133, relative: copy("2 小时前", "2 hours ago"), agent: copy("支持分流", "Support triage"), title: copy("分配新支持请求", "Route incoming support requests"), integrations: "Zendesk → Internal tool", status: "completed", duration: "26s", steps: [
      step("requests", copy("读取新请求", "Read new requests"), "Zendesk", copy("16 条新支持请求", "16 new support requests")),
      step("priority", copy("分类优先级", "Classify priority"), "Internal tool", copy("2 条紧急 · 6 条普通 · 8 条低优先级", "2 urgent · 6 normal · 8 low")),
      step("assign", copy("分配支持负责人", "Assign support owners"), "Zendesk", copy("16 条请求已全部分配", "All 16 requests assigned")),
    ] },
    { id: "run_2e17", time: "09:14", ageMinutes: 211, relative: copy("3 小时前", "3 hours ago"), agent: copy("采购单审核", "Purchase order review"), title: copy("审核供应商入驻", "Review vendor onboarding"), integrations: "Coupa → Internal tool → NetSuite", status: "completed", duration: "1m 12s", steps: [
      step("submission", copy("读取供应商申请", "Read vendor submission"), "Coupa", copy("Vela Design Co. · 供应商资料", "Vela Design Co. · vendor profile")),
      step("fields", copy("核实必填字段", "Verify required fields"), "Internal tool", copy("税务及联系信息齐全", "Tax details and contact information present")),
      step("vendor", copy("创建供应商记录", "Create vendor record"), "NetSuite", copy("供应商 V-2048 已创建", "Vendor V-2048 created")),
    ] },
    { id: "run_62ca", time: "16:20", ageMinutes: 1225, relative: copy("昨天", "Yesterday"), agent: copy("发票对账", "Invoice reconciliation"), title: copy("验证月度账单导出", "Validate monthly billing export"), integrations: "Stripe → NetSuite → Internal tool", status: "completed", duration: "38s", steps: [
      step("load", copy("加载账单导出", "Load billing export"), "Stripe", copy("月度账单摘要", "Monthly billing summary")),
      step("totals", copy("验证总额", "Validate totals"), "NetSuite", copy("已匹配总账", "Matched general ledger")),
      step("report", copy("保存报告", "Save report"), "Internal tool", copy("账单导出已验证", "Billing export validated")),
    ] },
  ]
}
export const statusLabels: Record<RunStatus, Copy> = {
  running: copy("运行中", "Running"), review: copy("等待审核", "Awaiting review"), blocked: copy("被规则阻止", "Blocked by rule"), completed: copy("已完成", "Completed"), failed: copy("失败", "Failed"), cancelled: copy("已取消", "Cancelled"),
}
export const runtimeByStatus: Record<RunStatus, string> = { running: "running", review: "waiting", blocked: "waiting", completed: "completed", failed: "failed", cancelled: "cancelled" }

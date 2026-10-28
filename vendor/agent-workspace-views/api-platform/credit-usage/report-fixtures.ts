import { apScope, type ApCopy, type ApScenario } from "../model.ts"

/** Local run-report facts, separate from the API request ledger. */
export const creditReportSource = {
  source: "local-credit-run-report",
  revision: "credit-run-report-2026-09-v1",
  from: "2026-09-01",
  to: "2026-10-01",
  timeZone: "UTC",
  renewsAt: "2026-09-28",
} as const

export type CreditReportIdentity = {
  id: string
  name: ApCopy
  group: ApCopy
}
export type CreditReportBucket = {
  id: string
  orgId: string
  projectId: string
  date: string
  agentId: string
  memberId: string | null
  runs: number
  hoursSaved: number | null
  agentCredits: number | null
  organizationCredits: number | null
}

const agentNames = [
  ["Inbox triage", "收件箱分流", "Customer support", "客户支持"],
  ["Release notes writer", "发布说明撰写", "Content", "内容"],
  ["Account research", "客户研究", "Research", "研究"],
  ["Meeting follow-ups", "会议跟进", "Operations", "运营"],
  ["Product feedback digest", "产品反馈摘要", "Research", "研究"],
  ["Help center editor", "帮助中心编辑", "Content", "内容"],
  ["Pipeline health check", "流程健康检查", "Operations", "运营"],
  ["Onboarding guide", "入门指南", "Customer support", "客户支持"],
]
const memberNames = [
  ["Maya Chen", "Customer experience", "客户体验"],
  ["Arjun Patel", "Engineering", "工程"],
  ["Sofia Martins", "Growth", "增长"],
  ["Ethan Brooks", "Operations", "运营"],
  ["Zara Ahmed", "Product", "产品"],
  ["Leo Fischer", "Content", "内容"],
  ["Nina Park", "Operations", "运营"],
  ["Sam Rivera", "Customer experience", "客户体验"],
]
export const creditReportAgents: CreditReportIdentity[] = agentNames.map((row, index) => ({
  id: `credit-agent-${index + 1}`,
  name: { en: row[0], "zh-CN": row[1] },
  group: { en: row[2], "zh-CN": row[3] },
}))
export const creditReportMembers: CreditReportIdentity[] = memberNames.map((row, index) => ({
  id: `credit-member-${index + 1}`,
  name: { en: row[0], "zh-CN": row[0] },
  group: { en: row[1], "zh-CN": row[2] },
}))

// The final-day snapshot is measured; the preceding six days are deterministic
// local allocations, not a claim about the reference site's individual days.
const weekly = [
  [842, 164, 12740, 55300], [367, 73, 6380, 37860],
  [596, 208, 9120, 37730], [224, 56, 4280, 27030],
  [413, 119, 7960, 27300], [178, 42, 3510, 19190],
  [309, 87, 5820, 18560], [127, 31, 2140, 11080],
]
const daily = [
  [152, 30, 2293, 9954], [40, 8, 702, 4165],
  [95, 33, 1459, 6037], [47, 12, 899, 5677],
  [54, 15, 1035, 3549], [16, 4, 316, 1727],
  [53, 15, 989, 3155], [18, 4, 300, 1552],
]
function portion(total: number, index: number) {
  return Math.floor(total / 6) + (index < total % 6 ? 1 : 0)
}
export function createCreditReportBuckets(scenario: ApScenario): CreditReportBucket[] {
  if (scenario === "empty") return []
  const buckets: CreditReportBucket[] = []
  for (let agent = 0; agent < weekly.length; agent++) {
    for (let day = 0; day < 7; day++) {
      const values = weekly[agent].map((value, field) => day === 6
        ? daily[agent][field]
        : portion(value - daily[agent][field], day))
      buckets.push({
        id: `credit-report-${agent + 1}-2026-09-${10 + day}`,
        orgId: apScope.orgId,
        projectId: apScope.projectId,
        date: `2026-09-${10 + day}`,
        agentId: creditReportAgents[agent].id,
        memberId: scenario === "missing-data" && agent === 7 ? null : creditReportMembers[agent].id,
        runs: values[0],
        hoursSaved: scenario === "missing-data" && agent === 0 && day === 6 ? null : values[1],
        agentCredits: scenario === "missing-data" && agent === 0 && day === 6 ? null : values[2],
        organizationCredits: values[3] - values[2],
      })
    }
  }
  return buckets
}

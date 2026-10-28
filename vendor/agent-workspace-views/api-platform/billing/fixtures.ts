import type { ApScenario } from "../model.ts"
import {
  createApUsageRequests,
  apUsagePeriod,
} from "../fixtures/usage-ledger.ts"

export type BillingCard = {
  cardId: string
  brand: "Visa" | "Mastercard" | "American Express"
  label: string
  lastFour: string
  expiry: string
}
export type BillingStatement = {
  statementId: string
  month: string
  date: string
  description: { en: string; "zh-CN": string }
  status: "draft" | "paid"
  currency: "USD" | "EUR"
  amountMinor: number | null
  lines: { label: string; amountMinor: number | null }[]
  note: { en: string; "zh-CN": string }
  source: "fixture"
}
export const billingFixtureRevision = "billing-v1-2026-10-13"
export const billingDelayMs = 650
export const billingCards: BillingCard[] = [
  {
    cardId: "card-demo-visa",
    brand: "Visa",
    label: "Studio operations",
    lastFour: "4242",
    expiry: "12/2028",
  },
  {
    cardId: "card-demo-mastercard",
    brand: "Mastercard",
    label: "Backup card",
    lastFour: "4444",
    expiry: "08/2029",
  },
]

/** USD costs, credit units and tokens are independent facts, never converted. */
export function billingUsage(scenario: ApScenario, orgId: string) {
  const requests = createApUsageRequests(scenario).filter(
    (request) =>
      request.orgId === orgId &&
      request.startedAt >= apUsagePeriod.from &&
      request.startedAt < apUsagePeriod.to,
  )
  const sum = (
    field: "costMicroUsd" | "credits" | "inputTokens" | "outputTokens",
  ) =>
    requests.some((request) => request[field] === null)
      ? null
      : requests.reduce(
          (total, request) => total + (request[field] as number),
          0,
        )
  const inputTokens = sum("inputTokens")
  const outputTokens = sum("outputTokens")
  const providers = [
    ...new Set(requests.map((request) => request.providerId)),
  ].map((provider) => {
    const rows = requests.filter((request) => request.providerId === provider)
    return {
      label: `${provider} requests`,
      amountMinor: rows.some((request) => request.costMicroUsd === null)
        ? null
        : rows.reduce(
            (total, request) => total + (request.costMicroUsd as number),
            0,
          ),
    }
  })
  return {
    costMicroUsd: sum("costMicroUsd"),
    credits: sum("credits"),
    tokens:
      inputTokens === null || outputTokens === null
        ? null
        : inputTokens + outputTokens,
    requestCount: requests.length,
    providers,
    source: apUsagePeriod,
  }
}

export function billingStatements(
  scenario: ApScenario,
  orgId: string,
): BillingStatement[] {
  if (scenario === "empty") return []
  const usage = billingUsage(scenario, orgId)
  return [
    {
      statementId: "INV-2026-09",
      month: "2026-09",
      date: "2026-09-11",
      description: {
        en: "September usage · in progress",
        "zh-CN": "九月用量 · 结算草稿",
      },
      status: "draft",
      currency: "USD",
      amountMinor: usage.costMicroUsd,
      lines: usage.providers,
      note: {
        en: "In-progress statement. Usage has already been deducted from prepaid credits.",
        "zh-CN": "账单草稿。用量已从美元预付余额中扣除。",
      },
      source: "fixture",
    },
    {
      statementId: "RCPT-2026-09",
      month: "2026-09",
      date: "2026-09-01",
      description: {
        en: "Prepaid credit purchase",
        "zh-CN": "美元预付余额充值",
      },
      status: "paid",
      currency: "USD",
      amountMinor: 500000000,
      lines: [{ label: "Prepaid USD balance", amountMinor: 500000000 }],
      note: {
        en: "Fictional demo receipt. No payment was processed.",
        "zh-CN": "本地演示收据，未处理真实付款。",
      },
      source: "fixture",
    },
    {
      statementId: "INV-2026-08",
      month: "2026-08",
      date: "2026-08-31",
      description: { en: "August usage", "zh-CN": "八月用量" },
      status: "paid",
      currency: "USD",
      amountMinor: 241200000,
      lines: [{ label: "August usage", amountMinor: 241200000 }],
      note: {
        en: "Archived fixture statement; not part of the September request ledger.",
        "zh-CN": "历史演示账单，不计入九月请求账本。",
      },
      source: "fixture",
    },
    {
      statementId: "INV-2026-07",
      month: "2026-07",
      date: "2026-07-31",
      description: { en: "July usage", "zh-CN": "七月用量" },
      status: "paid",
      currency: "USD",
      amountMinor: 198650000,
      lines: [{ label: "July usage", amountMinor: 198650000 }],
      note: {
        en: "Archived fixture statement; not part of the September request ledger.",
        "zh-CN": "历史演示账单，不计入九月请求账本。",
      },
      source: "fixture",
    },
  ]
}

export const euroStatement: BillingStatement = {
  statementId: "INV-DEMO-EUR",
  month: "2026-07",
  date: "2026-07-15",
  description: {
    en: "EUR archive · separate currency",
    "zh-CN": "欧元历史样例 · 独立币种",
  },
  status: "paid",
  currency: "EUR",
  amountMinor: 85000000,
  lines: [{ label: "EUR archived balance", amountMinor: 85000000 }],
  note: {
    en: "Separate EUR fixture. Not converted into or deducted from the USD account balance.",
    "zh-CN": "独立欧元演示记录，不折算或扣减美元账户余额。",
  },
  source: "fixture",
}

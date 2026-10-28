import { apScope, type ApScenario } from "../model.ts"
import {
  billingCards,
  billingStatements,
  billingUsage,
  euroStatement,
  type BillingCard,
  type BillingStatement,
} from "./fixtures.ts"

export type BillingTab = "overview" | "methods" | "history"
export type BillingDialog = "credits" | "card" | "contact" | "remove" | null
export type BillingOutcome = "confirmed" | "rejected" | "unknown"
export type BillingPayload =
  | {
      kind: "credits"
      amountMicroUsd: number
      currency: "USD"
      cardId: string | null
    }
  | { kind: "card"; card: BillingCard }
  | { kind: "default"; cardId: string }
  | { kind: "remove"; cardId: string }
  | { kind: "recharge"; enabled: boolean }
  | { kind: "contact"; email: string }
export type BillingOperation = {
  operationId: string
  orgId: string
  projectId: string
  payload: BillingPayload
  status: "pending" | BillingOutcome
  outcome: BillingOutcome
  intent: "submit" | "query"
  applied: boolean
}
export type BillingState = {
  tab: BillingTab
  month: string
  dialog: BillingDialog
  selectedStatement: string | null
  selectedCard: string | null
  cards: BillingCard[]
  defaultCardId: string | null
  statements: BillingStatement[]
  purchasedMicroUsd: number
  recharge: boolean
  contactDraft: string
  amountDraft: string
  cardDraft: { label: string; brand: BillingCard["brand"]; lastFour: string }
  validation: string | null
  operation: BillingOperation | null
  operationCount: number
  outcome: BillingOutcome
  loading: boolean
  refreshError: boolean
  zeroBalance: boolean
  showEuro: boolean
  notice: string | null
}

export function createBillingState(
  scenario: ApScenario,
  orgId: string,
  contactEmail: string,
): BillingState {
  const cards =
    scenario === "empty" ? [] : billingCards.map((card) => ({ ...card }))
  if (scenario === "long-content" && cards[0])
    cards[0].label =
      "Studio operations · International research and development division · Long billing label for overflow verification"
  return {
    tab: "overview",
    month: "all",
    dialog: null,
    selectedStatement: null,
    selectedCard: null,
    cards,
    defaultCardId: cards[0]?.cardId ?? null,
    statements: billingStatements(scenario, orgId),
    purchasedMicroUsd: scenario === "empty" ? 0 : 500000000,
    recharge: scenario !== "empty",
    contactDraft: contactEmail,
    amountDraft: "100",
    cardDraft: { label: "", brand: "Visa", lastFour: "4242" },
    validation: null,
    operation: null,
    operationCount: 0,
    outcome: "confirmed",
    loading: scenario === "loading",
    refreshError: scenario === "refresh-error",
    zeroBalance: false,
    showEuro: false,
    notice: null,
  }
}

/** Decimal input is parsed to integer microUSD without a floating multiplication. */
export function parseBillingAmount(value: string): number | null {
  const match = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  if (cents < 1000 || cents > 1000000 || cents % 1000 !== 0) return null
  return cents * 10000
}

export function formatBillingMoney(
  amountMinor: number | null,
  currency: "USD" | "EUR",
  locale: "en" | "zh-CN",
) {
  if (amountMinor === null) return locale === "en" ? "Unknown" : "未知"
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 1000000)
}

/** Submit captures immutable identity and payload; unknown never replays it. */
export function beginBillingOperation(
  state: BillingState,
  payload: BillingPayload,
  scenario: ApScenario,
  orgId: string,
): BillingState {
  if (
    scenario === "readonly" ||
    !apScope.canWrite ||
    state.loading ||
    state.operation?.status === "pending" ||
    state.operation?.status === "unknown"
  )
    return state
  if (
    (payload.kind === "default" || payload.kind === "remove") &&
    !state.cards.some((card) => card.cardId === payload.cardId)
  )
    return state
  const count = state.operationCount + 1
  return {
    ...state,
    validation: null,
    operationCount: count,
    operation: {
      operationId: `billing-${orgId}-${count}`,
      orgId,
      projectId: apScope.projectId,
      payload:
        payload.kind === "card"
          ? { ...payload, card: { ...payload.card } }
          : { ...payload },
      status: "pending",
      outcome: state.outcome,
      intent: "submit",
      applied: false,
    },
  }
}

/** A receipt may apply the captured operation at most once, never the live draft. */
export function settleBillingOperation(
  state: BillingState,
  operationId: string,
  scenario: ApScenario,
  orgId: string,
): BillingState {
  const op = state.operation
  if (
    !op ||
    op.operationId !== operationId ||
    op.orgId !== orgId ||
    op.status !== "pending"
  )
    return state
  const status = op.intent === "query" ? "confirmed" : op.outcome
  const next = { ...state, operation: { ...op, status } }
  if (status !== "confirmed" || op.applied) return next
  const payload = op.payload
  next.operation.applied = true
  next.dialog = null
  switch (payload.kind) {
    case "credits": {
      next.purchasedMicroUsd += payload.amountMicroUsd
      next.zeroBalance = false
      next.statements = [
        {
          statementId: `RCPT-DEMO-${state.operationCount}`,
          month: "2026-09",
          date: "2026-09-30",
          description: {
            en: "Demo prepaid credit purchase",
            "zh-CN": "演示美元预付充值",
          },
          status: "paid",
          currency: "USD",
          amountMinor: payload.amountMicroUsd,
          lines: [
            {
              label: "Prepaid USD balance",
              amountMinor: payload.amountMicroUsd,
            },
          ],
          note: {
            en: `Local receipt · ${op.operationId}. No payment was processed.`,
            "zh-CN": `本地收据 · ${op.operationId}。未处理真实付款。`,
          },
          source: "fixture",
        },
        ...state.statements,
      ]
      break
    }
    case "card":
      next.cards = [...state.cards, payload.card]
      if (!next.defaultCardId) next.defaultCardId = payload.card.cardId
      next.cardDraft = { label: "", brand: "Visa", lastFour: "4242" }
      break
    case "default":
      next.defaultCardId = payload.cardId
      break
    case "remove":
      next.cards = state.cards.filter((card) => card.cardId !== payload.cardId)
      if (state.defaultCardId === payload.cardId)
        next.defaultCardId = next.cards[0]?.cardId ?? null
      if (!next.cards.length) next.recharge = false
      break
    case "recharge":
      next.recharge = payload.enabled
      break
    case "contact":
      next.contactDraft = payload.email
      break
  }
  if (payload.kind === "credits" && state.zeroBalance) {
    const usage = billingUsage(scenario, orgId).costMicroUsd
    if (usage !== null) next.purchasedMicroUsd = usage + payload.amountMicroUsd
  }
  return next
}

export function queryBillingOperation(state: BillingState): BillingState {
  if (state.operation?.status !== "unknown") return state
  return {
    ...state,
    operation: { ...state.operation, status: "pending", intent: "query" },
  }
}

export function visibleBillingStatements(
  state: BillingState,
): BillingStatement[] {
  const statements = state.showEuro
    ? [...state.statements, euroStatement]
    : state.statements
  return state.month === "all"
    ? statements
    : statements.filter((statement) => statement.month === state.month)
}

/** CSV keeps original currency and precision; spreadsheet formula prefixes are neutralized. */
export function billingStatementCsv(statement: BillingStatement): string {
  const quote = (value: string) =>
    `"${(/^[=+@-]/.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`
  return [
    "statement_id,date,status,currency,amount_microunits,line,source",
    ...statement.lines.map((line) =>
      [
        statement.statementId,
        statement.date,
        statement.status,
        statement.currency,
        line.amountMinor === null ? "unknown" : String(line.amountMinor),
        line.label,
        "fixture",
      ]
        .map(quote)
        .join(","),
    ),
  ].join("\r\n")
}

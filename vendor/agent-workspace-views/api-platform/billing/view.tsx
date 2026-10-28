"use client"

import { useEffect, useMemo, useRef, type MouseEvent } from "react"
import {
  ArrowUpRight,
  CreditCard,
  Download,
  Plus,
  WalletCards,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@easyuse-ui/ui/components/ui/card"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@easyuse-ui/ui/components/ui/sheet"
import {
  TableContainer,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@easyuse-ui/ui/components/ui/table"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Alert } from "@easyuse-ui/ui/components/ui/alert"
import { Empty } from "@easyuse-ui/ui/components/ui/empty"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSelect } from "../shared"
import { useApState } from "../state"
import { useApAccountState } from "../account-state"
import { apScenarios, apScope, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  billingDelayMs,
  billingUsage,
  euroStatement,
  type BillingCard,
  type BillingStatement,
} from "./fixtures"
import {
  beginBillingOperation,
  billingStatementCsv,
  createBillingState,
  formatBillingMoney,
  parseBillingAmount,
  queryBillingOperation,
  settleBillingOperation,
  visibleBillingStatements,
  type BillingDialog,
  type BillingOutcome,
  type BillingPayload,
  type BillingTab,
} from "./controller"
import styles from "./billing.module.css"

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  const selectedScenario =
    apScenarios.find((entry) => entry.id === scenario)?.id ?? "default"
  return <BillingView scenario={selectedScenario} active={active} />
}

export function BillingView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [account, setAccount] = useApAccountState()
  const orgId = account.organization.orgId
  const [state, setState] = useApState(
    `billing:${scenario}:${orgId}:${apScope.projectId}`,
    () =>
      createBillingState(scenario, orgId, account.organization.contactEmail),
  )
  const opener = useRef<HTMLElement | null>(null)
  const usage = useMemo(() => billingUsage(scenario, orgId), [scenario, orgId])
  const money = (amount: number | null, currency: "USD" | "EUR" = "USD") =>
    formatBillingMoney(amount, currency, locale)
  const balance =
    usage.costMicroUsd === null
      ? null
      : state.zeroBalance
        ? 0
        : Math.max(0, state.purchasedMicroUsd - usage.costMicroUsd)
  const cards = state.cards
  const defaultCard = cards.find((card) => card.cardId === state.defaultCardId)
  const selectedCard = cards.find((card) => card.cardId === state.selectedCard)
  const statements = visibleBillingStatements(state)
  const selectedStatement = [
    ...state.statements,
    ...(state.showEuro ? [euroStatement] : []),
  ].find((statement) => statement.statementId === state.selectedStatement)
  const pending = state.operation?.status === "pending"
  const unknown = state.operation?.status === "unknown"
  const writeDisabled =
    scenario === "readonly" ||
    !apScope.canWrite ||
    state.loading ||
    pending ||
    unknown

  useEffect(() => {
    const operation = state.operation
    if (operation?.status !== "pending") return
    const timer = setTimeout(() => {
      if (
        operation.payload.kind === "contact" &&
        (operation.intent === "query" || operation.outcome === "confirmed")
      ) {
        const email = operation.payload.email
        setAccount((before) =>
          before.organization.orgId === operation.orgId
            ? {
                ...before,
                organization: { ...before.organization, contactEmail: email },
              }
            : before,
        )
      }
      setState((before) =>
        settleBillingOperation(before, operation.operationId, scenario, orgId),
      )
    }, billingDelayMs)
    return () => clearTimeout(timer)
  }, [state.operation, scenario, orgId, setState, setAccount])

  const openDialog = (
    dialog: BillingDialog,
    event: MouseEvent<HTMLButtonElement>,
    cardId?: string,
  ) => {
    opener.current = event.currentTarget
    setState((before) => ({
      ...before,
      dialog,
      selectedCard: cardId ?? before.selectedCard,
      validation: null,
      operation:
        before.operation?.status === "confirmed" ? null : before.operation,
    }))
  }
  const submit = (payload: BillingPayload) =>
    setState((before) =>
      beginBillingOperation(before, payload, scenario, orgId),
    )
  const download = (statement: BillingStatement) => {
    const blob = new Blob([billingStatementCsv(statement)], {
      type: "text/csv;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${statement.statementId}-fixture.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    setState((before) => ({
      ...before,
      notice: en
        ? `Downloaded ${statement.statementId} · fixture CSV`
        : `已下载 ${statement.statementId} · 演示 CSV`,
    }))
  }
  const result = state.operation
  const operationStatus = result ? (
    <Alert
      tone={
        result.status === "rejected"
          ? "error"
          : result.status === "unknown"
            ? "warning"
            : result.status === "confirmed"
              ? "success"
              : "info"
      }
      data-billing-operation={result.status}
      className={styles.operation}
    >
      <span>
        {result.status === "pending"
          ? result.intent === "query"
            ? en
              ? "Checking recorded result…"
              : "正在查询已记录结果…"
            : en
              ? "Demo operation pending…"
              : "演示操作处理中…"
          : result.status === "rejected"
            ? en
              ? "Rejected · balance and saved data unchanged. Your draft is preserved."
              : "已拒绝 · 余额和已保存数据未变，草稿已保留。"
            : result.status === "unknown"
              ? en
                ? "Unknown result · balance unchanged. Check the recorded result before submitting again."
                : "结果未知 · 余额未变。再次提交前请显式查询已记录结果。"
              : en
                ? "Confirmed locally · no real payment or authorization."
                : "本地已确认 · 未进行真实付款或授权。"}
      </span>
      <code data-billing-operation-id>{result.operationId}</code>
      {result.status === "unknown" && (
        <Button
          variant="outline"
          onClick={() => setState(queryBillingOperation)}
          data-billing-query
        >
          {en ? "Check recorded result" : "查询已记录结果"}
        </Button>
      )}
    </Alert>
  ) : null

  return (
    <ApPage
      pageId="billing"
      variant="reference"
      title={en ? "Billing" : "账单"}
      description={
        en
          ? "Workspace credits, payment methods, and monthly statements."
          : "工作区预付余额、付款方式和月度账单。"
      }
      actions={
        <Button
          variant="outline"
          render={<a href="/showcase/credit-usage" />}
          className={styles.smallButton}
        >
          {en ? "View usage" : "查看用量"}
          <ArrowUpRight size={14} />
        </Button>
      }
    >
      <div className={styles.content} data-billing-content>
        {scenario === "readonly" && (
          <Alert className={styles.banner}>
            {en
              ? "Read-only account. You can inspect statements and download fixture data, but cannot change billing."
              : "只读账户：可查看账单和下载演示数据，不能更改计费设置。"}
          </Alert>
        )}
        {state.refreshError && (
          <Alert tone="error" className={styles.banner}>
            {en
              ? "Refresh failed. Last fixture snapshot is preserved · Sep 30, 2026 UTC."
              : "刷新失败，已保留上次演示快照 · 2026 年 9 月 30 日 UTC。"}
            <Button
              variant="outline"
              onClick={() =>
                setState((before) => ({
                  ...before,
                  refreshError: false,
                  notice: en
                    ? "Fixture refreshed; drafts and selection preserved."
                    : "演示快照已刷新，草稿和选择已保留。",
                }))
              }
            >
              {en ? "Retry refresh" : "重试刷新"}
            </Button>
          </Alert>
        )}
        {usage.costMicroUsd === null && (
          <Alert tone="warning" className={styles.banner}>
            {en
              ? "Some request costs are missing. The full period charge and remaining USD balance are unknown, not zero."
              : "部分请求费用缺失。完整周期费用和美元余额未知，不等于零。"}
          </Alert>
        )}
        <Tabs
          value={state.tab}
          onValueChange={(value) =>
            setState((before) => ({ ...before, tab: value as BillingTab }))
          }
        >
          <TabsList
            aria-label={en ? "Billing sections" : "账单分区"}
            className={styles.tabs}
          >
            <TabsTab value="overview" className={styles.tab}>
              {en ? "Overview" : "概览"}
            </TabsTab>
            <TabsTab
              value="methods"
              disabled={state.loading}
              className={styles.tab}
            >
              {en ? "Payment methods" : "付款方式"}
            </TabsTab>
            <TabsTab
              value="history"
              disabled={state.loading}
              className={styles.tab}
            >
              {en ? "Billing history" : "账单历史"}
            </TabsTab>
          </TabsList>
          <TabsPanel
            value="overview"
            aria-label={en ? "Overview" : "概览"}
            className={styles.panel}
          >
            {state.loading ? (
              <div
                className={styles.grid}
                aria-busy="true"
                aria-label={en ? "Loading billing" : "正在加载账单"}
              >
                <Card className={styles.loadingCard}>
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="mt-8 h-10 w-48" />
                  <Skeleton className="mt-8 h-16 w-full" />
                  <Button
                    variant="outline"
                    className="mt-6"
                    onClick={() =>
                      setState((before) => ({ ...before, loading: false }))
                    }
                  >
                    {en ? "Load fixture" : "加载演示数据"}
                  </Button>
                </Card>
                <div className={styles.side}>
                  <Card className={styles.loadingCard}>
                    <Skeleton className="h-6 w-44" />
                    <Skeleton className="mt-6 h-12 w-full" />
                  </Card>
                  <Card className={styles.loadingCard}>
                    <Skeleton className="h-6 w-36" />
                    <Skeleton className="mt-6 h-16 w-full" />
                  </Card>
                </div>
              </div>
            ) : (
              <div className={styles.grid}>
                <Card
                  className={styles.balanceCard}
                  aria-labelledby="billing-balance-title"
                  data-billing-balance-card
                >
                  <CardHeader className={styles.cardHeader}>
                    <div className={styles.cardTop}>
                      <WalletCards size={18} aria-hidden="true" />
                      <Badge className={styles.prepaid}>
                        {en ? "Prepaid" : "预付"}
                      </Badge>
                    </div>
                    <CardTitle
                      id="billing-balance-title"
                      role="heading"
                      aria-level={2}
                      className={styles.cardTitle}
                    >
                      {en ? "Available credits" : "可用预付余额"}
                    </CardTitle>
                    <CardDescription className={styles.cardDescription}>
                      {en
                        ? "Usage is deducted from this balance as it occurs."
                        : "产生用量时即从此美元余额中扣除。"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className={styles.cardContent}>
                    <p
                      className={styles.balance}
                      data-billing-balance
                      data-micro-usd={balance ?? "unknown"}
                    >
                      {money(balance)}
                    </p>
                    <p className={styles.used} data-billing-used>
                      {en
                        ? `${money(usage.costMicroUsd)} used in the current billing period.`
                        : `本计费周期已使用 ${money(usage.costMicroUsd)}。`}
                    </p>
                    <dl className={styles.period}>
                      <div>
                        <dt>{en ? "Current period" : "当前周期"}</dt>
                        <dd>
                          {en ? "Sep 1 – 30, 2026" : "2026 年 9 月 1 – 30 日"}
                        </dd>
                      </div>
                      <div>
                        <dt>{en ? "Next statement" : "下一账单"}</dt>
                        <dd>{en ? "Oct 1, 2026" : "2026 年 10 月 1 日"}</dd>
                      </div>
                    </dl>
                  </CardContent>
                  <CardFooter className={styles.cardFooter}>
                    <Button
                      disabled={writeDisabled}
                      onClick={(event) => openDialog("credits", event)}
                      className={styles.smallButton}
                      data-billing-add-credits
                    >
                      <Plus size={14} />
                      {en ? "Add demo credits" : "添加演示预付余额"}
                    </Button>
                    <Button
                      variant="outline"
                      className={styles.smallButton}
                      onClick={() =>
                        setState((before) => ({ ...before, tab: "history" }))
                      }
                    >
                      {en ? "View statements" : "查看账单"}
                    </Button>
                  </CardFooter>
                </Card>
                <div className={styles.side}>
                  <Card
                    className={styles.rechargeCard}
                    aria-labelledby="billing-recharge-title"
                    data-billing-recharge-card
                  >
                    <CardHeader className={styles.cardHeader}>
                      <CardTitle
                        id="billing-recharge-title"
                        role="heading"
                        aria-level={2}
                        className={styles.cardTitle}
                      >
                        {en ? "Automatic recharge" : "自动充值"}
                      </CardTitle>
                      <CardDescription className={styles.cardDescription}>
                        {en
                          ? "Keep a planning buffer for ongoing work."
                          : "为持续工作保留规划缓冲余额。"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className={styles.cardContent}>
                      <div className={styles.rechargeRow}>
                        <div>
                          <label htmlFor="billing-recharge">
                            {en
                              ? "Recharge when below $50"
                              : "美元余额低于 $50 时充值"}
                          </label>
                          <p className={styles.cardDescription}>
                            {en
                              ? "Add $100 using the default demo payment method."
                              : "使用默认演示付款方式添加 $100。"}
                          </p>
                        </div>
                        <Switch
                          id="billing-recharge"
                          aria-label={
                            en
                              ? "Recharge when below $50"
                              : "美元余额低于 $50 时充值"
                          }
                          checked={state.recharge}
                          disabled={writeDisabled || !defaultCard}
                          onCheckedChange={(enabled) =>
                            submit({ kind: "recharge", enabled })
                          }
                        />
                      </div>
                      <p className={styles.finePrint}>
                        {en
                          ? "This preference is illustrative; no charges are scheduled."
                          : "此偏好仅为演示，不会安排任何扣款。"}
                      </p>
                      {!defaultCard && (
                        <p className={styles.finePrint}>
                          {en
                            ? "Add a demo card to enable this preference."
                            : "添加演示卡片后可开启此偏好。"}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                  <Card
                    className={styles.detailsCard}
                    aria-labelledby="billing-details-title"
                    data-billing-details-card
                  >
                    <CardHeader className={styles.cardHeader}>
                      <CardTitle
                        id="billing-details-title"
                        role="heading"
                        aria-level={2}
                        className={styles.cardTitle}
                      >
                        {en ? "Billing details" : "账单信息"}
                      </CardTitle>
                      <CardDescription className={styles.cardDescription}>
                        {account.organization.name}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className={styles.cardContent}>
                      <div className={styles.cardIdentity}>
                        <CreditCard size={16} aria-hidden="true" />
                        {defaultCard
                          ? `${defaultCard.brand} •••• ${defaultCard.lastFour}`
                          : en
                            ? "No payment method"
                            : "暂无付款方式"}
                      </div>
                      <p className={styles.contactEmail} data-billing-contact>
                        {account.organization.contactEmail}
                      </p>
                    </CardContent>
                    <CardFooter className={styles.cardFooter}>
                      <Button
                        variant="outline"
                        className={styles.smallButton}
                        onClick={() =>
                          setState((before) => ({ ...before, tab: "methods" }))
                        }
                      >
                        {en ? "Manage cards" : "管理卡片"}
                      </Button>
                      <Button
                        variant="ghost"
                        className={styles.smallButton}
                        disabled={writeDisabled}
                        onClick={(event) => openDialog("contact", event)}
                      >
                        {en ? "Edit contact" : "编辑联系人"}
                      </Button>
                    </CardFooter>
                  </Card>
                </div>
              </div>
            )}
          </TabsPanel>
          <TabsPanel
            value="methods"
            aria-label={en ? "Payment methods" : "付款方式"}
            className={styles.panel}
          >
            <div className={styles.sectionHeading}>
              <div>
                <h2>{en ? "Payment methods" : "付款方式"}</h2>
                <p>
                  {en
                    ? "All cards shown here are fictional demo records."
                    : "此处所有卡片均为虚构的演示记录。"}
                </p>
              </div>
              <Button
                disabled={writeDisabled}
                onClick={(event) => openDialog("card", event)}
                className={styles.smallButton}
                data-billing-add-card
              >
                <Plus size={14} />
                {en ? "Add demo card" : "添加演示卡片"}
              </Button>
            </div>
            {cards.length === 0 ? (
              <Empty
                title={en ? "No payment methods" : "暂无付款方式"}
                description={
                  en
                    ? "Add a fictional demo card. No card number or security code is collected."
                    : "可添加虚构演示卡片；不收集卡号或安全码。"
                }
              />
            ) : (
              <ul className={styles.methods}>
                {cards.map((card) => (
                  <li
                    key={card.cardId}
                    className={styles.method}
                    data-billing-card={card.cardId}
                  >
                    <span className={styles.brand}>{card.brand}</span>
                    <div className={styles.methodText}>
                      <div className={styles.methodTitle}>
                        <p>
                          {en
                            ? `${card.brand} ending in ${card.lastFour}`
                            : `${card.brand} 尾号 ${card.lastFour}`}
                        </p>
                        {card.cardId === state.defaultCardId && (
                          <Badge className={styles.defaultBadge}>
                            {en ? "Default" : "默认"}
                          </Badge>
                        )}
                      </div>
                      <p className={styles.finePrint}>
                        {card.label} · {en ? "Expires" : "到期"} {card.expiry}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className={styles.smallButton}
                      disabled={
                        writeDisabled || card.cardId === state.defaultCardId
                      }
                      onClick={() =>
                        submit({ kind: "default", cardId: card.cardId })
                      }
                    >
                      {en ? "Make default" : "设为默认"}
                    </Button>
                    <Button
                      variant="ghost"
                      className={styles.smallButton}
                      disabled={writeDisabled}
                      onClick={(event) =>
                        openDialog("remove", event, card.cardId)
                      }
                    >
                      {en ? "Remove" : "移除"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </TabsPanel>
          <TabsPanel
            value="history"
            aria-label={en ? "Billing history" : "账单历史"}
            className={styles.panel}
          >
            <div className={styles.sectionHeading}>
              <div>
                <h2>{en ? "Billing history" : "账单历史"}</h2>
                <p>
                  {en
                    ? "Statements and credit receipts for this workspace."
                    : "此工作区的账单和预付充值收据。"}
                </p>
              </div>
              <ApSelect
                label={en ? "Billing month" : "账单月份"}
                value={state.month}
                onChange={(month) =>
                  setState((before) => ({ ...before, month }))
                }
                options={[
                  { value: "all", label: en ? "All months" : "所有月份" },
                  {
                    value: "2026-09",
                    label: en ? "September 2026" : "2026 年 9 月",
                  },
                  {
                    value: "2026-08",
                    label: en ? "August 2026" : "2026 年 8 月",
                  },
                  {
                    value: "2026-07",
                    label: en ? "July 2026" : "2026 年 7 月",
                  },
                ]}
              />
            </div>
            {statements.length === 0 ? (
              <Empty
                title={
                  state.statements.length === 0
                    ? en
                      ? "No statements yet"
                      : "暂无账单"
                    : en
                      ? "No statements for this month"
                      : "此月份无账单"
                }
                description={
                  en
                    ? "Statements and demo receipts appear here. Changing the filter never changes your balance."
                    : "账单和演示收据将显示在此处。筛选不会更改余额。"
                }
                action={
                  state.month !== "all" ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setState((before) => ({ ...before, month: "all" }))
                      }
                    >
                      {en ? "All months" : "所有月份"}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <TableContainer className={styles.tableContainer}>
                <Table
                  className={styles.table}
                  aria-label={en ? "Billing statements" : "账单记录"}
                >
                  <TableHeader className={styles.tableHeader}>
                    <TableRow>
                      <TableHead>{en ? "Statement" : "账单"}</TableHead>
                      <TableHead>{en ? "Date" : "日期"}</TableHead>
                      <TableHead>{en ? "Status" : "状态"}</TableHead>
                      <TableHead className={styles.amountCell}>
                        {en ? "Amount" : "金额"}
                      </TableHead>
                      <TableHead className={styles.actionsCell}>
                        {en ? "Actions" : "操作"}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statements.map((statement) => (
                      <TableRow
                        key={statement.statementId}
                        data-billing-statement={statement.statementId}
                      >
                        <TableCell>
                          <Button
                            variant="ghost"
                            className={styles.statementTrigger}
                            onClick={(event) => {
                              opener.current = event.currentTarget
                              setState((before) => ({
                                ...before,
                                selectedStatement: statement.statementId,
                              }))
                            }}
                          >
                            <p>{statement.statementId}</p>
                            <p className={styles.finePrint}>
                              {statement.description[locale]}
                            </p>
                          </Button>
                        </TableCell>
                        <TableCell className={styles.dateCell}>
                          {statement.date}
                        </TableCell>
                        <TableCell>
                          <Badge className={styles.statementBadge}>
                            {statement.status === "draft"
                              ? en
                                ? "Draft"
                                : "草稿"
                              : en
                                ? "Paid"
                                : "已付"}
                          </Badge>
                        </TableCell>
                        <TableCell className={styles.amountCell}>
                          {money(statement.amountMinor, statement.currency)}
                          {statement.currency !== "USD" && (
                            <span className={styles.currency}> EUR</span>
                          )}
                        </TableCell>
                        <TableCell className={styles.actionsCell}>
                          <div className={styles.tableActions}>
                            <Button
                              variant="ghost"
                              className={styles.smallButton}
                              onClick={(event) => {
                                opener.current = event.currentTarget
                                setState((before) => ({
                                  ...before,
                                  selectedStatement: statement.statementId,
                                }))
                              }}
                            >
                              {en ? "View" : "查看"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={
                                en
                                  ? `Download ${statement.statementId} CSV`
                                  : `下载 ${statement.statementId} CSV`
                              }
                              onClick={() => download(statement)}
                            >
                              <Download size={14} />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </TabsPanel>
        </Tabs>
        {!state.dialog && operationStatus}
        {state.notice && (
          <p role="status" className={styles.notice}>
            {state.notice}
          </p>
        )}
        <details
          className={styles.fixtureControls}
          data-billing-fixture-controls
        >
          <summary>
            {en
              ? "Fixture controls · no real payments"
              : "演示控制 · 不进行真实付款"}
          </summary>
          <div className={styles.fixtureOptions}>
            <ApSelect
              label={en ? "Demo operation result" : "演示操作结果"}
              value={state.outcome}
              disabled={pending || unknown}
              onChange={(outcome) =>
                setState((before) => ({
                  ...before,
                  outcome: outcome as BillingOutcome,
                }))
              }
              options={[
                { value: "confirmed", label: en ? "Confirmed" : "已确认" },
                { value: "rejected", label: en ? "Rejected" : "已拒绝" },
                { value: "unknown", label: en ? "Unknown" : "未知" },
              ]}
            />
            <label>
              <Checkbox
                checked={state.zeroBalance}
                disabled={pending || unknown}
                onCheckedChange={(zeroBalance) =>
                  setState((before) => ({ ...before, zeroBalance }))
                }
              />
              {en ? "Zero balance fixture" : "零余额样例"}
            </label>
            <label>
              <Checkbox
                checked={state.showEuro}
                onCheckedChange={(showEuro) =>
                  setState((before) => ({ ...before, showEuro }))
                }
              />
              {en ? "Separate EUR statement" : "独立欧元账单"}
            </label>
          </div>
          <p>
            {en
              ? "USD prepaid money, request credit units and tokens are distinct. EUR is never added to USD. Drafts live only in this Lab session."
              : "美元预付金额、请求积分和 Token 为不同单位。欧元不与美元相加。草稿仅保留在当前 Lab 会话。"}
          </p>
        </details>
      </div>
      <Dialog
        open={active && state.dialog !== null}
        onOpenChange={(open) => {
          if (active && !open && !pending)
            setState((before) => ({
              ...before,
              dialog: null,
              validation: null,
            }))
        }}
      >
        <DialogContent
          className={styles.dialog}
          finalFocus={() =>
            opener.current?.isConnected ? opener.current : null
          }
          data-billing-dialog
        >
          <DialogTitle className={styles.dialogTitle}>
            {state.dialog === "credits"
              ? en
                ? "Add demo credits"
                : "添加演示预付余额"
              : state.dialog === "card"
                ? en
                  ? "Add a demo payment method"
                  : "添加演示付款方式"
                : state.dialog === "contact"
                  ? en
                    ? "Billing contact"
                    : "账单联系人"
                  : en
                    ? "Remove demo payment method"
                    : "移除演示付款方式"}
          </DialogTitle>
          <DialogDescription className={styles.dialogDescription}>
            {state.dialog === "credits"
              ? en
                ? "This updates the demo ledger. No payment will be processed."
                : "此操作仅更新演示账本，不会处理真实付款。"
              : state.dialog === "card"
                ? en
                  ? "Use fictional card details only. No card number or security code is collected."
                  : "仅使用虚构信息，不收集卡号或安全码。"
                : state.dialog === "contact"
                  ? en
                    ? "Update the contact shown on this workspace’s billing page."
                    : "更新此工作区账单页面显示的联系人。"
                  : en
                    ? "Remove this fictional card from the local demo account only."
                    : "仅从本地演示账户中移除此虚构卡片。"}
          </DialogDescription>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              if (writeDisabled) return
              if (state.dialog === "credits") {
                const amount = parseBillingAmount(state.amountDraft)
                if (amount === null) {
                  setState((before) => ({ ...before, validation: "amount" }))
                  return
                }
                submit({
                  kind: "credits",
                  amountMicroUsd: amount,
                  currency: "USD",
                  cardId: state.defaultCardId,
                })
              } else if (state.dialog === "card") {
                if (
                  !state.cardDraft.label.trim() ||
                  !/^\d{4}$/.test(state.cardDraft.lastFour)
                ) {
                  setState((before) => ({ ...before, validation: "card" }))
                  return
                }
                submit({
                  kind: "card",
                  card: {
                    cardId: `card-demo-${state.operationCount + 1}`,
                    ...state.cardDraft,
                    label: state.cardDraft.label.trim(),
                    expiry: "12/2028",
                  },
                })
              } else if (state.dialog === "contact") {
                if (
                  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.contactDraft.trim())
                ) {
                  setState((before) => ({ ...before, validation: "contact" }))
                  return
                }
                submit({ kind: "contact", email: state.contactDraft.trim() })
              } else if (state.dialog === "remove" && selectedCard)
                submit({ kind: "remove", cardId: selectedCard.cardId })
            }}
          >
            <DialogBody className={styles.dialogBody}>
              {state.dialog === "credits" && (
                <>
                  <Field
                    label={en ? "Amount (USD)" : "金额（USD）"}
                    error={
                      state.validation === "amount"
                        ? en
                          ? "Enter $10–$10,000 in increments of $10."
                          : "请输入 $10 至 $10,000，按 $10 递增。"
                        : undefined
                    }
                  >
                    {(props) => (
                      <Input
                        {...props}
                        type="number"
                        min="10"
                        max="10000"
                        step="10"
                        value={state.amountDraft}
                        disabled={pending || unknown}
                        onChange={(event) =>
                          setState((before) => ({
                            ...before,
                            amountDraft: event.target.value,
                            validation: null,
                          }))
                        }
                        className={styles.input}
                      />
                    )}
                  </Field>
                  <p className={styles.dialogFinePrint}>
                    {en ? "Demo method:" : "演示方式："}{" "}
                    {defaultCard
                      ? `${defaultCard.brand} •••• ${defaultCard.lastFour}`
                      : en
                        ? "No demo card · local grant only"
                        : "无演示卡片 · 仅本地赠额"}
                  </p>
                </>
              )}
              {state.dialog === "contact" && (
                <Field
                  label={en ? "Contact email" : "联系邮箱"}
                  error={
                    state.validation === "contact"
                      ? en
                        ? "Enter a valid email address."
                        : "请输入有效邮箱地址。"
                      : undefined
                  }
                >
                  {(props) => (
                    <Input
                      {...props}
                      type="email"
                      value={state.contactDraft}
                      disabled={pending || unknown}
                      onChange={(event) =>
                        setState((before) => ({
                          ...before,
                          contactDraft: event.target.value,
                          validation: null,
                        }))
                      }
                      className={styles.input}
                    />
                  )}
                </Field>
              )}
              {state.dialog === "card" && (
                <div className={styles.cardForm}>
                  <Field
                    label={en ? "Card label" : "卡片标签"}
                    error={
                      state.validation === "card" &&
                      !state.cardDraft.label.trim()
                        ? en
                          ? "A label is required."
                          : "请输入标签。"
                        : undefined
                    }
                  >
                    {(props) => (
                      <Input
                        {...props}
                        value={state.cardDraft.label}
                        placeholder={
                          en ? "e.g. Team expenses" : "例如：团队费用"
                        }
                        disabled={pending || unknown}
                        onChange={(event) =>
                          setState((before) => ({
                            ...before,
                            cardDraft: {
                              ...before.cardDraft,
                              label: event.target.value,
                            },
                            validation: null,
                          }))
                        }
                        className={styles.input}
                      />
                    )}
                  </Field>
                  <div className={styles.formColumns}>
                    <div>
                      <p className={styles.formLabel}>
                        {en ? "Brand" : "品牌"}
                      </p>
                      <ApSelect
                        label={en ? "Card brand" : "卡片品牌"}
                        value={state.cardDraft.brand}
                        disabled={pending || unknown}
                        onChange={(brand) =>
                          setState((before) => ({
                            ...before,
                            cardDraft: {
                              ...before.cardDraft,
                              brand: brand as BillingCard["brand"],
                            },
                          }))
                        }
                        options={[
                          { value: "Visa", label: "Visa" },
                          { value: "Mastercard", label: "Mastercard" },
                          {
                            value: "American Express",
                            label: "American Express",
                          },
                        ]}
                      />
                    </div>
                    <Field
                      label={en ? "Demo last four" : "演示尾号四位"}
                      error={
                        state.validation === "card" &&
                        !/^\d{4}$/.test(state.cardDraft.lastFour)
                          ? en
                            ? "Use exactly four digits."
                            : "请输入四位数字。"
                          : undefined
                      }
                    >
                      {(props) => (
                        <Input
                          {...props}
                          inputMode="numeric"
                          maxLength={4}
                          value={state.cardDraft.lastFour}
                          disabled={pending || unknown}
                          onChange={(event) =>
                            setState((before) => ({
                              ...before,
                              cardDraft: {
                                ...before.cardDraft,
                                lastFour: event.target.value,
                              },
                              validation: null,
                            }))
                          }
                          className={styles.input}
                        />
                      )}
                    </Field>
                  </div>
                  <p className={styles.dialogFinePrint}>
                    {en
                      ? "Demo expiration: December 2028."
                      : "演示有效期：2028 年 12 月。"}
                  </p>
                </div>
              )}
              {state.dialog === "remove" && (
                <p>
                  {selectedCard?.brand} •••• {selectedCard?.lastFour}
                  {selectedCard?.cardId === state.defaultCardId && (
                    <span className={styles.dialogFinePrint}>
                      {en
                        ? " · The next available card becomes default; removing the last card turns off automatic recharge."
                        : " · 下张可用卡片将设为默认；移除最后一张卡片将关闭自动充值。"}
                    </span>
                  )}
                </p>
              )}
              {state.operation?.payload.kind === state.dialog &&
                operationStatus}
            </DialogBody>
            <DialogFooter className={styles.dialogFooter}>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                className={styles.smallButton}
                onClick={() =>
                  setState((before) => ({
                    ...before,
                    dialog: null,
                    validation: null,
                  }))
                }
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                type="submit"
                disabled={writeDisabled}
                loading={pending}
                className={styles.smallButton}
              >
                {state.dialog === "credits"
                  ? en
                    ? "Add demo credits"
                    : "添加演示预付余额"
                  : state.dialog === "remove"
                    ? en
                      ? "Remove"
                      : "移除"
                    : en
                      ? "Save"
                      : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Sheet
        open={active && Boolean(selectedStatement)}
        onOpenChange={(open) => {
          if (active && !open)
            setState((before) => ({ ...before, selectedStatement: null }))
        }}
      >
        <SheetContent
          size={512}
          className={styles.sheet}
          finalFocus={() =>
            opener.current?.isConnected ? opener.current : null
          }
          data-billing-statement-sheet
        >
          {selectedStatement && (
            <>
              <SheetHeader className={styles.sheetHeader}>
                <SheetTitle className={styles.dialogTitle}>
                  {selectedStatement.statementId}
                </SheetTitle>
                <SheetDescription className={styles.sheetDescription}>
                  {selectedStatement.description[locale]}
                </SheetDescription>
              </SheetHeader>
              <SheetBody className={styles.sheetBody}>
                <div className={styles.statementMeta}>
                  <Badge className={styles.statementBadge}>
                    {selectedStatement.status === "paid"
                      ? en
                        ? "Paid"
                        : "已付"
                      : en
                        ? "Draft"
                        : "草稿"}
                  </Badge>
                  <span>{selectedStatement.date}</span>
                </div>
                <div className={styles.statementTotal}>
                  <p>
                    {en ? "Total" : "总额"} ({selectedStatement.currency})
                  </p>
                  <strong data-billing-statement-total>
                    {money(
                      selectedStatement.amountMinor,
                      selectedStatement.currency,
                    )}
                  </strong>
                </div>
                <dl className={styles.statementLines}>
                  {selectedStatement.lines.map((line) => (
                    <div key={line.label}>
                      <dt>{line.label}</dt>
                      <dd>
                        {money(line.amountMinor, selectedStatement.currency)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className={styles.statementNote}>
                  {selectedStatement.note[locale]}
                </p>
                <Button
                  variant="outline"
                  className={styles.downloadButton}
                  onClick={() => download(selectedStatement)}
                >
                  <Download size={14} />
                  {en ? "Download statement CSV" : "下载账单 CSV"}
                </Button>
                {selectedStatement.statementId === "INV-2026-09" && (
                  <dl className={styles.unitDetails}>
                    <div>
                      <dt>
                        {en
                          ? "Request credit units (not USD)"
                          : "请求积分（非美元）"}
                      </dt>
                      <dd>
                        {usage.credits === null
                          ? en
                            ? "Unknown"
                            : "未知"
                          : usage.credits}
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {en
                          ? "Tokens (input + output)"
                          : "Token（输入 + 输出）"}
                      </dt>
                      <dd>
                        {usage.tokens === null
                          ? en
                            ? "Unknown"
                            : "未知"
                          : usage.tokens.toLocaleString(locale)}
                      </dd>
                    </div>
                    <div>
                      <dt>{en ? "Requests" : "请求数"}</dt>
                      <dd>{usage.requestCount}</dd>
                    </div>
                    <div>
                      <dt>{en ? "Period / timezone" : "周期 / 时区"}</dt>
                      <dd>2026-09-01 → 2026-10-01 · UTC</dd>
                    </div>
                    <p>
                      {en
                        ? "Cached tokens are included in input tokens, not added again. Source: shared request ledger · fixture."
                        : "缓存 Token 包含在输入 Token 中，不重复相加。来源：共享请求演示账本。"}
                    </p>
                  </dl>
                )}
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </ApPage>
  )
}

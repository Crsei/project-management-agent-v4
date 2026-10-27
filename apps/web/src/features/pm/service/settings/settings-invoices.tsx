import { useId, useState } from "react"
import { Link } from "react-router"
import { Receipt } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

type InvoiceStatus = "paid" | "open"
type Invoice = { number: string; date: string; cents: number; status: InvoiceStatus }
const exampleInvoices: Invoice[] = [
  { number: "LAB-INV-2026-009", date: "2026-10-01", cents: 9600, status: "paid" },
  { number: "LAB-INV-2026-008", date: "2026-09-01", cents: 9600, status: "paid" },
  { number: "LAB-INV-2026-007", date: "2026-08-01", cents: 8000, status: "paid" },
]

function InvoiceTable({ invoices }: { invoices: Invoice[] | null }) {
  const t = useText()
  const captionId = useId()
  return <div className="space-y-2">
    <p id={captionId} className="text-xs leading-5 text-muted-foreground">{t("窄屏可横向滚动表格；日期为 YYYY-MM-DD，金额单位为美元 USD。", "On narrow screens, scroll the table horizontally. Dates use YYYY-MM-DD; amounts are in US dollars (USD).")}</p>
    <div role="region" aria-label={t("发票表格", "Invoice table")} aria-describedby={captionId} tabIndex={0} className="min-w-0 overflow-x-auto rounded-lg border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <table className="w-full min-w-[480px] border-collapse text-left text-sm">
        <caption className="sr-only">{invoices === null ? t("发票查询不可用，不代表没有发票", "Invoice lookup unavailable; not an empty invoice history") : t("Lab 虚构发票样例，不是财务凭证", "Fictional Lab invoices, not financial documents")}</caption>
        <thead className="bg-surface-raised text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">{t("发票号", "Invoice number")}</th>
            <th scope="col" className="px-4 py-3 font-medium">{t("日期", "Date")}</th>
            <th scope="col" className="px-4 py-3 font-medium">{t("金额", "Amount")}</th>
            <th scope="col" className="px-4 py-3 font-medium">{t("状态", "Status")}</th>
          </tr>
        </thead>
        <tbody>
          {invoices === null ? <tr><td colSpan={4} className="border-t px-4 py-8">
            <div className="max-w-md space-y-2 whitespace-normal leading-6">
              <p className="font-medium">{t("发票数据未知 · 服务未接入", "Invoice data unknown · Service not connected")}</p>
              <p className="text-muted-foreground">{t("当前无法查询发票号、开票日期、金额或支付状态。此处不是“暂无发票”，也不意味着账单已结清。", "Invoice numbers, issue dates, amounts, and payment statuses cannot currently be queried. This is not “no invoices” and does not mean the account is paid up.")}</p>
            </div>
          </td></tr> : invoices.length === 0 ? <tr><td colSpan={4} className="border-t px-4 py-8">
            <p className="font-medium">{t("当前筛选下没有样例发票", "No example invoices match this filter")}</p>
            <p className="mt-2 max-w-md whitespace-normal leading-6 text-muted-foreground">{t("仅为空态演示；切回“全部样例”可查看固定数据，不代表正式工作区没有发票。", "This is an empty-state demonstration only. Choose “All examples” to see the fixed rows. It does not describe the real workspace’s invoice history.")}</p>
          </td></tr> : invoices.map(invoice => <tr key={invoice.number} className="border-t">
            <th scope="row" className="whitespace-nowrap px-4 py-4 font-mono text-xs font-medium">{invoice.number}</th>
            <td className="whitespace-nowrap px-4 py-4 tabular-nums"><time dateTime={invoice.date}>{invoice.date}</time></td>
            <td className="whitespace-nowrap px-4 py-4 tabular-nums">${(invoice.cents / 100).toFixed(2)} USD</td>
            <td className="px-4 py-4"><span className="whitespace-nowrap rounded-pill border bg-surface-raised px-2 py-1 text-xs">{invoice.status === "paid" ? t("已支付 · 示例", "Paid · Example") : t("待支付 · 示例", "Open · Example")}</span></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>
}

function InvoiceNavigation() {
  const t = useText()
  return <nav aria-label={t("相关计费设置", "Related billing settings")} className="flex flex-wrap gap-2 border-t pt-5">
    <Button variant="outline" render={<Link to="../plans" relative="path" />}>{t("查看订阅方案", "View plans")}</Button>
    <Button variant="outline" render={<Link to="../billing" relative="path" />}>{t("账单与付款方式", "Billing & payment methods")}</Button>
  </nav>
}

function ServiceInvoices() {
  const t = useText()
  return <SettingsSection wide title={t("发票", "Invoices")}>
    <SettingsNotice>
      <p className="flex items-start gap-2 font-medium text-foreground"><Receipt aria-hidden="true" className="mt-1 size-4 shrink-0" />{t("发票服务尚未接入", "Invoice service is not connected")}</p>
      <p>{t("当前后端没有发票列表或财务凭证读取合同，不会把未接入当作空账单，不展示 Lab 发票，也不提供不存在的下载或支付入口。", "The backend has no invoice-list or financial-document API. An unavailable integration is not an empty billing history. No Lab invoices, nonexistent downloads, or payment actions are presented here.")}</p>
    </SettingsNotice>
    <InvoiceTable invoices={null} />
    <InvoiceNavigation />
  </SettingsSection>
}

function LabInvoices() {
  const t = useText()
  const id = useId()
  const [filter, setFilter] = useState<"all" | InvoiceStatus>("all")
  const invoices = filter === "all" ? exampleInvoices : exampleInvoices.filter(invoice => invoice.status === filter)
  return <SettingsSection wide title={t("发票", "Invoices")} description={t("Lab：预览历史发票列表与筛选空态，不是正式账单。", "Lab: preview an invoice list and filtered empty state, not real billing history.")}>
    <SettingsNotice>
      <p className="font-medium text-foreground">{t("固定虚构样例 · 非财务凭证", "Fixed fictional examples · Not financial documents")}</p>
      <p>{t("下列发票号、日期、金额及已支付状态均为展示数据，与账号无关。筛选仅在当前页面内存中生效，离页或刷新后重置；不查询发票、不付款、不生成收据或下载文件。", "All invoice numbers, dates, amounts, and paid statuses below are illustrative and unrelated to any account. Filters remain in this page’s memory and reset on navigation or refresh. No invoice lookup, payment, receipt generation, or file download occurs.")}</p>
    </SettingsNotice>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label htmlFor={`${id}-filter`} className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{t("样例状态", "Example status")}</span>
        <select id={`${id}-filter`} value={filter} onChange={event => setFilter(event.target.value as "all" | InvoiceStatus)} className="h-10 max-w-full rounded-control border bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <option value="all">{t("全部样例", "All examples")}</option>
          <option value="paid">{t("已支付样例", "Paid examples")}</option>
          <option value="open">{t("待支付样例（空态）", "Open examples (empty state)")}</option>
        </select>
      </label>
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{t(`${invoices.length} 条样例`, `${invoices.length} example invoices`)}</p>
    </div>
    <InvoiceTable invoices={invoices} />
    <InvoiceNavigation />
  </SettingsSection>
}

export function SettingsInvoices({ mode }: SettingsPageProps) {
  return mode === "service" ? <ServiceInvoices /> : <LabInvoices />
}

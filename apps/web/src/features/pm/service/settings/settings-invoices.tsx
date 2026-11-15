import { Link } from "react-router"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

export function SettingsInvoices({ mode }: SettingsPageProps) {
  const t = useText()
  const linkClass = "block min-w-0 rounded-module border bg-surface p-4 text-sm font-medium hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  return <SettingsSection title={t("发票", "Invoices")} description={t("发票查询与财务凭证服务尚未接入。", "Invoice lookup and financial-document services are not connected.")}>
    {mode === "lab" && <SettingsNotice>{t("Lab · 与正式页使用同一份未接入说明，不展示虚构发票、金额或已支付状态。", "Lab · The same unavailable-service guidance as the service page, without fictional invoices, amounts, or paid statuses.")}</SettingsNotice>}
    <SettingsNotice>
      <p className="font-medium text-foreground">{t("发票数据未知，不是“暂无发票”", "Invoice data is unknown, not “no invoices”")}</p>
      <p>{t("当前后端没有发票列表或财务凭证读取合同，无法核对发票号、开票日期、金额或付款状态。没有查询结果不意味着账单已结清、未发生收费或不存在历史发票。", "The backend has no invoice-list or financial-document API, so invoice numbers, issue dates, amounts, and payment statuses cannot be checked. Missing query results do not mean a settled balance, no charges, or no historical invoices.")}</p>
    </SettingsNotice>
    <p className="text-sm leading-6 text-muted-foreground">{t("本页不生成财务凭证，也不提供未实现的下载、补开、支付或退款入口。未来云套餐仍处于规划、未生效且不可购买；AI Provider 的费用由供应商单独结算，不在此虚构供应商发票。", "This page generates no financial documents and offers no unimplemented download, invoice-issue, payment, or refund actions. Future cloud plans remain planned, inactive, and unavailable for purchase. AI Provider costs are billed separately by the supplier; supplier invoices are not fabricated here.")}</p>
    <nav aria-label={t("相关说明", "Related information")} className="grid min-w-0 gap-3 border-t pt-5 sm:grid-cols-2">
      <Link to="../plans" relative="path" className={linkClass}>{t("套餐与用量说明", "Plans & usage guidance")}</Link>
      <Link to="../billing" relative="path" className={linkClass}>{t("账单服务状态", "Billing service status")}</Link>
    </nav>
  </SettingsSection>
}

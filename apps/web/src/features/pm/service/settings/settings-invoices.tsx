import { Link } from "react-router"
import { useText } from "../pm-ui"
import { SettingsSection } from "./settings-shared"

export function SettingsInvoices() {
  const t = useText()
  const linkClass = "block min-w-0 rounded-module border bg-surface p-4 text-sm font-medium hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  return <SettingsSection title={t("发票", "Invoices")} description={t("发票查询与财务凭证服务尚未接入。", "Invoice lookup and financial-document services are not connected.")}>
    <p className="text-sm leading-6 text-muted-foreground">{t("无法核对发票号、金额或付款状态；没有结果不代表没有发票。", "Invoice numbers, amounts and payment status cannot be checked; no result does not mean no invoices.")}</p>
    <p className="text-sm leading-6 text-muted-foreground">{t("本页不提供下载、补开、支付或退款入口。", "This page offers no download, invoice-issue, payment or refund actions.")}</p>
    <nav aria-label={t("相关说明", "Related information")} className="grid min-w-0 gap-3 border-t pt-5 sm:grid-cols-2">
      <Link to="../plans" relative="path" className={linkClass}>{t("套餐与用量说明", "Plans & usage guidance")}</Link>
      <Link to="../billing" relative="path" className={linkClass}>{t("账单服务状态", "Billing service status")}</Link>
    </nav>
  </SettingsSection>
}

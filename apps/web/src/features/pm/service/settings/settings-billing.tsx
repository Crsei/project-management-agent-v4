import { Link } from "react-router"
import { useText } from "../pm-ui"
import { SettingsSection } from "./settings-shared"

export function SettingsBilling() {
  const t = useText()
  const linkClass = "block min-w-0 rounded-module border bg-surface p-4 text-sm font-medium hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  return <SettingsSection title={t("账单服务", "Billing service")} description={t("付款、账单资料与订阅管理尚未接入。", "Payment, billing details and subscription management are not connected.")}>
    <div className="space-y-3 text-sm leading-6 text-muted-foreground">
      <p>{t("未接入不代表免费或账单已结清；不收集银行卡或账单资料。", "Not connected does not mean free or settled; no card or billing details are collected.")}</p>
      <p>{t("未来云套餐按工作区订阅，当前均不可购买。", "Future cloud plans are per workspace and cannot be purchased.")}</p>
    </div>
    <nav aria-label={t("相关说明", "Related information")} className="grid min-w-0 gap-3 border-t pt-5 sm:grid-cols-2">
      <Link to="../plans" relative="path" className={linkClass}>{t("套餐与用量说明", "Plans & usage guidance")}</Link>
      <Link to="../invoices" relative="path" className={linkClass}>{t("发票服务状态", "Invoice service status")}</Link>
    </nav>
  </SettingsSection>
}

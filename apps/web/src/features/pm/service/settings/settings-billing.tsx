import { Link } from "react-router"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

export function SettingsBilling({ mode }: SettingsPageProps) {
  const t = useText()
  const linkClass = "block min-w-0 rounded-module border bg-surface p-4 text-sm font-medium hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  return <SettingsSection title={t("账单服务", "Billing service")} description={t("当前没有可用的付款、账单资料或订阅管理服务。", "Payment, billing-details, and subscription-management services are not connected.")}>
    {mode === "lab" && <SettingsNotice>{t("Lab · 与正式页使用同一份未接入说明，不展示虚构银行卡、账单资料或支付流程。", "Lab · The same unavailable-service guidance as the service page, without fictional cards, billing details, or payment flows.")}</SettingsNotice>}
    <SettingsNotice>
      <p className="font-medium text-foreground">{t("账单与付款服务尚未接入", "Billing and payments are not connected")}</p>
      <p>{t("当前后端没有付款方式、账单资料或扣款合同。本页不收集、保存或发送银行卡、地址及税务资料，也不发起购买、扣款或权益修改。", "The backend has no payment-method, billing-details, or charging contract. This page does not collect, save, or send card, address, or tax details, and sends no purchase, charge, or entitlement-change requests.")}</p>
    </SettingsNotice>
    <div className="space-y-3 text-sm leading-6 text-muted-foreground">
      <p>{t("未接入不等于未绑卡、免费或账单已结清；真实付款方式、账单资料、余额及续费状态均未知，不使用个人资料或 Lab 样例替代。", "Not connected does not mean no saved card, a free account, or a settled balance. Real payment methods, billing details, balances, and renewal status are unknown; profile details and Lab samples are not substituted.")}</p>
      <p>{t("未来云套餐按工作区订阅，目前均为规划、未生效、不可购买。支付页面返回或浏览器提示不等于生效，必须以核验后的真实服务端权益为准；结果未知先核对原操作，不重复付款。", "Future cloud plans would be subscribed per workspace. All are currently planned, inactive, and unavailable for purchase. A payment-page return or browser message does not activate entitlements; verified server-side entitlements are authoritative. Reconcile an unknown original outcome instead of paying again.")}</p>
    </div>
    <nav aria-label={t("相关说明", "Related information")} className="grid min-w-0 gap-3 border-t pt-5 sm:grid-cols-2">
      <Link to="../plans" relative="path" className={linkClass}>{t("套餐与用量说明", "Plans & usage guidance")}</Link>
      <Link to="../invoices" relative="path" className={linkClass}>{t("发票服务状态", "Invoice service status")}</Link>
    </nav>
  </SettingsSection>
}

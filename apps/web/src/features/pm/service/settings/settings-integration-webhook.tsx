import { Link, useParams } from "react-router"
import { useText } from "../pm-ui"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { PluginWebhookStatus } from "./plugin-webhook-status"

export function SettingsIntegrationWebhook({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const catalog = mode === "service" ? `/pm/${encodeURIComponent(workspaceSlug)}/settings/plugins` : undefined
  return <SettingsSection title={t("Webhook", "Webhook")} description={t("受限出站 Webhook 只发送部署批准目标的最小历史事实；这里管理端点、投递状态与原投递核对，不执行任意 HTTP 请求。", "Restricted outbound Webhooks send only minimal historical facts to deployment-approved targets. This page manages endpoints, delivery state and original-delivery reconciliation; it does not execute arbitrary HTTP requests.")}>
    {mode === "service" && <PluginWebhookStatus mode={mode} />}
    {mode === "lab" && <PluginWebhookStatus mode={mode} />}
    {catalog && <p className="text-sm"><Link className="text-primary hover:text-foreground" to={catalog}>{t("返回集成目录", "Back to integration catalog")}</Link></p>}
  </SettingsSection>
}

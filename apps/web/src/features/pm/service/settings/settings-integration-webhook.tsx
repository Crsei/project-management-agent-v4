import { Link, useParams } from "react-router"
import { useText } from "../pm-ui"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { PluginWebhookStatus } from "./plugin-webhook-status"

export function SettingsIntegrationWebhook({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const catalog = mode === "service" ? `/pm/${encodeURIComponent(workspaceSlug)}/settings/plugins` : undefined
  return <SettingsSection title={t("Webhook", "Webhook")} description={t("受限出站 Webhook 仅向部署批准的目标发送最小历史事实。", "Restricted outbound Webhooks send minimal historical facts to deployment-approved targets.")}>
    {mode === "service" && <PluginWebhookStatus mode={mode} />}
    {mode === "lab" && <PluginWebhookStatus mode={mode} />}
    {catalog && <p className="text-sm"><Link className="text-primary hover:text-foreground" to={catalog}>{t("返回集成目录", "Back to integration catalog")}</Link></p>}
  </SettingsSection>
}

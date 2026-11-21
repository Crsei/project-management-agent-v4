import { Link, useParams } from "react-router"
import { useText } from "../pm-ui"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { PluginSmtpStatus } from "./plugin-smtp-status"

export function SettingsIntegrationEmail({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const catalog = mode === "service" ? `/pm/${encodeURIComponent(workspaceSlug)}/settings/plugins` : undefined
  return <SettingsSection title={t("邮件", "Email")} description={t("实例级 SMTP 成员邀请；不含个人邮箱或 Agent 邮件工具。", "Instance-level SMTP member invitations; personal mailboxes and Agent email tools are excluded.")}>
    {mode === "service" && <PluginSmtpStatus mode={mode} />}
    {mode === "lab" && <PluginSmtpStatus mode={mode} />}
    {catalog && <p className="text-sm"><Link className="text-primary hover:text-foreground" to={catalog}>{t("返回集成目录", "Back to integration catalog")}</Link></p>}
  </SettingsSection>
}

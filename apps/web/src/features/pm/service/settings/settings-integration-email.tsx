import { Link, useParams } from "react-router"
import { useText } from "../pm-ui"
import { SettingsSection, type SettingsPageProps } from "./settings-shared"
import { PluginSmtpStatus } from "./plugin-smtp-status"

export function SettingsIntegrationEmail({ mode }: SettingsPageProps) {
  const t = useText()
  const { workspaceSlug = "" } = useParams()
  const catalog = mode === "service" ? `/pm/${encodeURIComponent(workspaceSlug)}/settings/plugins` : undefined
  return <SettingsSection title={t("邮件", "Email")} description={t("SMTP 成员邀请是已有的实例级出站实现；这里读取部署配置、邀请记录和真实权限状态，不包含个人邮箱或 Agent 邮件工具。", "SMTP member invitations are the existing instance-level outbound implementation. This page reads deployment configuration, invitation records and current permissions; it does not include personal mailboxes or Agent email tools.")}>
    {mode === "service" && <PluginSmtpStatus mode={mode} />}
    {mode === "lab" && <PluginSmtpStatus mode={mode} />}
    {catalog && <p className="text-sm"><Link className="text-primary hover:text-foreground" to={catalog}>{t("返回集成目录", "Back to integration catalog")}</Link></p>}
  </SettingsSection>
}

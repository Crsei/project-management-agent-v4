import { Link } from "react-router"
import { useText } from "../service/pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "../service/settings/settings-shared"

export function SettingsAgent({ mode }: SettingsPageProps) {
  const t = useText()
  return <SettingsSection title={t("Agent", "Agent")} description={t("模型和对话设置由 Agent Chat 管理。", "Models and chat settings are managed in Agent Chat.")} wide>
    <SettingsNotice>{mode === "service" ? t("PM 工具使用当前登录用户的业务权限和所选工作区范围。", "PM tools use the current signed-in user's business permissions and workspace scope.") : t("请登录后使用真实工作区。", "Sign in to use a real workspace.")}</SettingsNotice>
    <p><Link className="text-primary hover:text-foreground" to="/agent/settings/providers">{t("配置 Chat Provider", "Configure Chat providers")}</Link></p>
    <p><Link className="text-primary hover:text-foreground" to="/agent/workspace">{t("打开 Agent Chat", "Open Agent Chat")}</Link></p>
  </SettingsSection>
}

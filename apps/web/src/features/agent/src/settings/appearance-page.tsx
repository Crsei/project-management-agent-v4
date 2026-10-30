import { useTheme } from "@agent/hooks/use-theme";
import { useAgentText } from "../i18n";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { setChatBrowserPreferences, useChatBrowserPreferences } from "./browser-preferences";

const promptFontSizes = Array.from({ length: 9 }, (_, index) => 12 + index);
const codeFontSizes = Array.from({ length: 9 }, (_, index) => 10 + index);
const terminalFontSizes = Array.from({ length: 13 }, (_, index) => 8 + index);

export default function AppearancePage() {
  const t = useAgentText();
  const shared = useTheme();
  const { preferences, storageError } = useChatBrowserPreferences();
  return <div className="agent-preferences-page">
    <SettingsSection title={t("共享外观", "Shared appearance")} scope="browser">
      <div className="agent-preference-row"><label htmlFor="agent-theme">{t("主题", "Theme")}</label><select id="agent-theme" value={shared.preference} onChange={(event) => shared.setTheme(event.target.value as "light" | "dark" | "system")}><option value="light">{t("浅色", "Light")}</option><option value="dark">{t("深色", "Dark")}</option><option value="system">{t("跟随系统", "System")}</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-motion">{t("动态效果", "Motion")}</label><select id="agent-motion" value={shared.motion} onChange={(event) => shared.setPreferences({ motion: event.target.value as "system" | "reduce" })}><option value="system">{t("跟随系统", "System")}</option><option value="reduce">{t("减少动态效果", "Reduce motion")}</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-density">{t("侧栏密度", "Sidebar density")}</label><select id="agent-density" value={shared.sidebarDensity} onChange={(event) => shared.setPreferences({ sidebarDensity: event.target.value as "comfortable" | "compact" })}><option value="comfortable">{t("舒适", "Comfortable")}</option><option value="compact">{t("紧凑", "Compact")}</option></select></div>
      {shared.preferenceStorage === "unavailable" && <SettingsNotice kind="error">{t("PM 浏览器偏好无法持久保存；当前页面仍会应用更改，请检查浏览器存储权限。", "PM browser preferences cannot be persisted. Changes still apply on this page; check browser storage permissions.")}</SettingsNotice>}
      {shared.preferenceStorage === "recovered" && <SettingsNotice kind="info">{t("已恢复可识别的 PM 偏好。重新选择后将保存完整有效值。", "Recognized PM preferences were recovered. Selecting again saves complete values.")}</SettingsNotice>}
    </SettingsSection>
    <SettingsSection title={t("对话显示", "Chat display")} scope="browser">
      <div className="agent-preference-row"><label htmlFor="agent-chat-font">{t("正文字号", "Message font size")}</label><select id="agent-chat-font" value={preferences.fontSize} onChange={(event) => setChatBrowserPreferences({ fontSize: event.target.value as "small" | "medium" | "large" })}><option value="small">{t("小", "Small")} · 13 px</option><option value="medium">{t("标准", "Standard")} · 14 px</option><option value="large">{t("大", "Large")} · 16 px</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-prompt-font">{t("输入框字号", "Composer font size")}</label><select id="agent-chat-prompt-font" value={preferences.promptFontSize} onChange={(event) => setChatBrowserPreferences({ promptFontSize: Number(event.target.value) })}>{promptFontSizes.map((size) => <option key={size} value={size}>{size} px{size === 14 ? ` · ${t("默认", "Default")}` : ""}</option>)}</select></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-code-font">{t("代码字号", "Code font size")}</label><select id="agent-chat-code-font" value={preferences.codeFontSize} onChange={(event) => setChatBrowserPreferences({ codeFontSize: Number(event.target.value) })}>{codeFontSizes.map((size) => <option key={size} value={size}>{size} px{size === 13 ? ` · ${t("默认", "Default")}` : ""}</option>)}</select></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-terminal-font">{t("终端字号", "Terminal font size")}</label><select id="agent-chat-terminal-font" value={preferences.terminalFontSize} onChange={(event) => setChatBrowserPreferences({ terminalFontSize: Number(event.target.value) })}>{terminalFontSizes.map((size) => <option key={size} value={size}>{size} px{size === 12 ? ` · ${t("默认", "Default")}` : ""}</option>)}</select></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-width">{t("对话宽度", "Chat width")}</label><select id="agent-chat-width" value={preferences.contentWidth} onChange={(event) => setChatBrowserPreferences({ contentWidth: event.target.value as "standard" | "wide" | "full" })}><option value="standard">{t("标准", "Standard")} · 808 px</option><option value="wide">{t("宽", "Wide")} · 1040 px</option><option value="full">{t("填满可用空间", "Fill available space")}</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-code-wrap">{t("代码自动换行", "Wrap code")}</label><input id="agent-chat-code-wrap" type="checkbox" checked={preferences.codeWrap} onChange={(event) => setChatBrowserPreferences({ codeWrap: event.target.checked })} /></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-diff-layout">{t("Diff 布局", "Diff layout")}</label><select id="agent-chat-diff-layout" value={preferences.diffLayout} onChange={(event) => setChatBrowserPreferences({ diffLayout: event.target.value as "unified" | "split" })}><option value="unified">{t("统一视图", "Unified")} · {t("默认", "Default")}</option><option value="split">{t("左右分栏", "Split")}</option></select></div>
      <div className="agent-appearance-preview" aria-label={t("对话显示预览", "Chat display preview")}><pre><code>const preview = &quot;code sample&quot;;</code></pre></div>
      {storageError && <SettingsNotice kind="error">{storageError}</SettingsNotice>}
    </SettingsSection>
  </div>;
}

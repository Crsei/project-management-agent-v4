import { useTheme } from "@/hooks/use-theme";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { setChatBrowserPreferences, useChatBrowserPreferences } from "./browser-preferences";

export default function AppearancePage() {
  const shared = useTheme();
  const { preferences, storageError } = useChatBrowserPreferences();
  return <div className="agent-preferences-page">
    <SettingsSection title="共享外观" description="与 Project Management 使用同一份浏览器偏好；修改立即生效。不会更改服务或会话参数。" scope="browser">
      <div className="agent-preference-row"><label htmlFor="agent-theme">主题</label><select id="agent-theme" value={shared.preference} onChange={(event) => shared.setTheme(event.target.value as "light" | "dark" | "system")}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-motion">动态效果</label><select id="agent-motion" value={shared.motion} onChange={(event) => shared.setPreferences({ motion: event.target.value as "system" | "reduce" })}><option value="system">跟随系统</option><option value="reduce">减少动态效果</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-density">侧栏密度</label><select id="agent-density" value={shared.sidebarDensity} onChange={(event) => shared.setPreferences({ sidebarDensity: event.target.value as "comfortable" | "compact" })}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></div>
      {shared.preferenceStorage === "unavailable" && <SettingsNotice kind="error">PM 浏览器偏好无法持久保存；当前页面仍会应用更改，请检查浏览器存储权限。</SettingsNotice>}
      {shared.preferenceStorage === "recovered" && <SettingsNotice kind="info">已恢复可识别的 PM 偏好。重新选择后将保存完整有效值。</SettingsNotice>}
    </SettingsSection>
    <SettingsSection title="对话显示" description="仅影响此浏览器中的 Agent Chat，不改变消息内容、模型输入或 PM 正文。" scope="browser">
      <div className="agent-preference-row"><label htmlFor="agent-chat-font">正文字号</label><select id="agent-chat-font" value={preferences.fontSize} onChange={(event) => setChatBrowserPreferences({ fontSize: event.target.value as "small" | "medium" | "large" })}><option value="small">小 · 13 px</option><option value="medium">标准 · 14 px</option><option value="large">大 · 16 px</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-width">对话宽度</label><select id="agent-chat-width" value={preferences.contentWidth} onChange={(event) => setChatBrowserPreferences({ contentWidth: event.target.value as "standard" | "wide" | "full" })}><option value="standard">标准 · 808 px</option><option value="wide">宽 · 1040 px</option><option value="full">填满可用空间</option></select></div>
      <div className="agent-preference-row"><label htmlFor="agent-chat-code-wrap">代码自动换行</label><input id="agent-chat-code-wrap" type="checkbox" checked={preferences.codeWrap} onChange={(event) => setChatBrowserPreferences({ codeWrap: event.target.checked })} /></div>
      <div className="agent-appearance-preview" aria-label="对话显示预览"><p>对话正文预览：显示设置不会改写已保存的消息。</p><pre><code>const display = "代码换行仅用于阅读；复制内容保持原样。";</code></pre></div>
      {storageError && <SettingsNotice kind="error">{storageError}</SettingsNotice>}
    </SettingsSection>
  </div>;
}

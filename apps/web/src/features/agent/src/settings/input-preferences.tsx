import { useAgentText } from "../i18n";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { setChatBrowserPreferences, useChatBrowserPreferences } from "./browser-preferences";
import { RadixSelect } from "@/components/ui/radix-select"

export function ShortcutCatalog() {
  const t = useAgentText();
  const { preferences } = useChatBrowserPreferences();
  return <div className="agent-shortcuts">
    <dl>
      <div><dt>{t("发送消息", "Send message")}</dt><dd><kbd>{preferences.sendShortcut === "enter" ? "Enter" : "Ctrl / ⌘ + Enter"}</kbd></dd></div>
      <div><dt>{t("输入换行", "Insert line break")}</dt><dd><kbd>{preferences.sendShortcut === "enter" ? "Shift + Enter" : "Enter"}</kbd></dd></div>
      <div><dt>{t("当前作用域新建会话", "New session in current scope")}</dt><dd><kbd>Ctrl / ⌘ + Shift + O</kbd></dd></div>
      <div><dt>{t("搜索已保存会话", "Search saved sessions")}</dt><dd><kbd>Ctrl / ⌘ + K</kbd></dd></div>
      <div><dt>{t("请求停止当前生成", "Stop current generation")}</dt><dd><kbd>Ctrl / ⌘ + .</kbd></dd></div>
      <div><dt>{t("切换会话详情", "Toggle session details")}</dt><dd><kbd>Ctrl / ⌘ + Shift + B</kbd></dd></div>
      <div><dt>{t("切换终端抽屉", "Toggle terminal drawer")}</dt><dd><kbd>Ctrl / ⌘ + J</kbd></dd></div>
      <div><dt>{t("切换右侧面板", "Toggle right panel")}</dt><dd><kbd>Ctrl / ⌘ + Alt + B</kbd></dd></div>
      <div><dt>{t("打开快捷键帮助", "Open shortcut help")}</dt><dd><kbd>?</kbd></dd></div>
    </dl>
  </div>;
}
export default function InputPreferences() {
  const t = useAgentText();
  const { preferences, storageError } = useChatBrowserPreferences();
  return <SettingsSection title={t("输入与快捷键", "Input & shortcuts")} scope="browser">
    <div className="agent-preference-row"><label htmlFor="agent-send-shortcut">{t("发送方式", "Send with")}</label><RadixSelect id="agent-send-shortcut" value={preferences.sendShortcut} onChange={(event) => setChatBrowserPreferences({ sendShortcut: event.target.value as "enter" | "ctrlEnter" })}><option value="enter">{t("Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for a line break")}</option><option value="ctrlEnter">{t("Ctrl / ⌘+Enter 发送 · Enter 换行", "Ctrl / ⌘+Enter to send · Enter for a line break")}</option></RadixSelect></div>
    {storageError && <SettingsNotice kind="error">{storageError}</SettingsNotice>}
    <ShortcutCatalog />
  </SettingsSection>;
}

import { SettingsNotice, SettingsSection } from "./settings-layout";
import { setChatBrowserPreferences, useChatBrowserPreferences } from "./browser-preferences";

export function ShortcutCatalog() {
  const { preferences } = useChatBrowserPreferences();
  return <div className="agent-shortcuts">
    <dl>
      <div><dt>发送消息</dt><dd><kbd>{preferences.sendShortcut === "enter" ? "Enter" : "Ctrl / ⌘ + Enter"}</kbd></dd></div>
      <div><dt>输入换行</dt><dd><kbd>{preferences.sendShortcut === "enter" ? "Shift + Enter" : "Enter"}</kbd></dd></div>
      <div><dt>当前作用域新建会话</dt><dd><kbd>Ctrl / ⌘ + Shift + O</kbd></dd></div>
      <div><dt>搜索已保存会话</dt><dd><kbd>Ctrl / ⌘ + K</kbd></dd></div>
      <div><dt>请求停止当前生成</dt><dd><kbd>Ctrl / ⌘ + .</kbd></dd></div>
      <div><dt>切换终端抽屉</dt><dd><kbd>Ctrl / ⌘ + J</kbd></dd></div>
      <div><dt>切换右侧面板</dt><dd><kbd>Ctrl / ⌘ + Alt + B</kbd></dd></div>
      <div><dt>打开快捷键帮助</dt><dd><kbd>?</kbd></dd></div>
    </dl>
    <p>发送仅在消息输入框生效，中文等输入法选字时不会发送。其余快捷键仅在对话页面、焦点不在输入控件且没有弹窗或菜单时生效。停止须等待服务端确认，不会回滚已发生的操作。</p>
  </div>;
}
export default function InputPreferences() {
  const { preferences, storageError } = useChatBrowserPreferences();
  return <SettingsSection title="输入与快捷键" description="保存在此浏览器，立即应用于新消息与消息编辑。" scope="browser">
    <div className="agent-preference-row"><label htmlFor="agent-send-shortcut">发送方式</label><select id="agent-send-shortcut" value={preferences.sendShortcut} onChange={(event) => setChatBrowserPreferences({ sendShortcut: event.target.value as "enter" | "ctrlEnter" })}><option value="enter">Enter 发送 · Shift+Enter 换行</option><option value="ctrlEnter">Ctrl / ⌘+Enter 发送 · Enter 换行</option></select></div>
    {storageError && <SettingsNotice kind="error">{storageError}</SettingsNotice>}
    <ShortcutCatalog />
  </SettingsSection>;
}

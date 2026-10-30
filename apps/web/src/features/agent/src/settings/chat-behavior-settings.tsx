import type { ResponseStreamingMode } from "@agent-workspace/contracts/output";
import { setResponseStreamingMode, useResponseStreamingMode } from "../chat/response-streaming";
import { useAgentText } from "../i18n";
import { setChatBrowserPreferences, useChatBrowserPreferences } from "./browser-preferences";
import { SettingsNotice, SettingsSection } from "./settings-layout";

export default function ChatBehaviorSettings() {
  const t = useAgentText();
  const { preferences, storageError } = useChatBrowserPreferences();
  const streamingMode = useResponseStreamingMode();
  return <SettingsSection title={t("会话与回复", "Sessions & replies")} scope="browser">
    <div className="agent-preference-row"><label htmlFor="agent-response-streaming">{t("回复显示方式", "Response display")}</label><select id="agent-response-streaming" value={streamingMode} onChange={(event) => setResponseStreamingMode(event.target.value as ResponseStreamingMode)}><option value="paragraph">{t("逐段显示 · 完成一段显示一段", "Paragraph · show each completed paragraph")}</option><option value="turn">{t("整轮显示 · 等完整回复后显示", "Turn · show after the full reply")}</option></select></div>
    <div className="agent-preference-row"><label htmlFor="agent-thread-sort">{t("会话排序", "Session order")}</label><select id="agent-thread-sort" value={preferences.threadSortOrder} onChange={(event) => setChatBrowserPreferences({ threadSortOrder: event.target.value as "updated_at" | "created_at" })}><option value="updated_at">{t("按最近更新", "Recently updated")}</option><option value="created_at">{t("按创建时间", "Recently created")}</option></select></div>
    <div className="agent-preference-row"><label htmlFor="agent-confirm-archive">{t("归档前确认", "Confirm before archiving")}</label><input id="agent-confirm-archive" type="checkbox" checked={preferences.confirmThreadArchive} onChange={(event) => setChatBrowserPreferences({ confirmThreadArchive: event.target.checked })} /></div>
    {storageError && <SettingsNotice kind="error">{storageError}</SettingsNotice>}
  </SettingsSection>;
}

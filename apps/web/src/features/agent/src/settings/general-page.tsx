import ChatBehaviorSettings from "./chat-behavior-settings";
import DefaultModelSettings from "./default-model-settings";
import InputPreferences from "./input-preferences";
import LanguageSettings from "./language-settings";

import { useAgentText } from "../i18n";

export default function GeneralPage() {
  const t = useAgentText();
  return <div className="settings-general">
    <LanguageSettings />
    <DefaultModelSettings />
    <InputPreferences />
    <ChatBehaviorSettings />
    <a href="/legal.html" target="_blank" rel="noreferrer">{t("许可与对应源码", "License and corresponding source")}</a>
  </div>;
}

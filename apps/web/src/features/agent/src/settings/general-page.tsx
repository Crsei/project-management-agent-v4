import ChatBehaviorSettings from "./chat-behavior-settings";
import DefaultModelSettings from "./default-model-settings";
import InputPreferences from "./input-preferences";
import LanguageSettings from "./language-settings";

export default function GeneralPage() {
  return <div className="settings-general">
    <LanguageSettings />
    <DefaultModelSettings />
    <InputPreferences />
    <ChatBehaviorSettings />
  </div>;
}

import DefaultModelSettings from "./default-model-settings";
import InputPreferences from "./input-preferences";

export default function GeneralPage() {
  return <div className="settings-general">
    <DefaultModelSettings />
    <InputPreferences />
  </div>;
}

import { useWorkspaceStore } from "@/providers/app-providers";
import { useAgentText } from "../i18n";
import { SettingsSection } from "./settings-layout";
import { RadixSelect } from "@/components/ui/radix-select"

/** Shared with PM: changing either selector updates the same browser preference. */
export default function LanguageSettings() {
  const t = useAgentText();
  const locale = useWorkspaceStore((state) => state.locale);
  const setLocale = useWorkspaceStore((state) => state.setLocale);
  return <SettingsSection title={t("语言", "Language")} scope="browser">
    <div className="agent-preference-row"><label htmlFor="agent-interface-language">{t("界面语言", "Interface language")}</label>
      <RadixSelect id="agent-interface-language" value={locale} onChange={(event) => {
        const value = event.target.value;
        if (value === "zh-CN" || value === "en") setLocale(value);
      }}>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </RadixSelect>
    </div>
  </SettingsSection>;
}

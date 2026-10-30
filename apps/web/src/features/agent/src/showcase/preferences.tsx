import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { I18nProvider } from "@easyuse-ui/ui/lib/i18n-provider";
import { ConversationLocaleProvider } from "@easyuse-ui/agent-workspace-views/conversations/locale";
import { useTheme, type Theme } from "@agent/hooks/use-theme";

type Locale = "zh-CN" | "en";
type Preferences = {
  theme: Theme;
  setTheme: (theme: Theme | "system") => void;
  locale: Locale;
  setLocale: (locale: Locale) => void;
};
const Context = createContext<Preferences | null>(null);

export function ShowcasePreferences({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useTheme();
  const [locale, setLocale] = useState<Locale>(() => {
    try {
      return localStorage.getItem("agent-workspace:showcase-locale") === "en" ? "en" : "zh-CN";
    } catch {
      return "zh-CN";
    }
  });
  useEffect(() => {
    const previousLocale = document.documentElement.lang;
    document.documentElement.lang = locale;
    try { localStorage.setItem("agent-workspace:showcase-locale", locale); }
    catch { /* Preferences still work when browser storage is disabled. */ }
    return () => { document.documentElement.lang = previousLocale; };
  }, [locale]);
  return (
    <Context.Provider value={{ theme, setTheme, locale, setLocale }}>
      <I18nProvider locale={locale} onLocaleChange={setLocale}>
        <ConversationLocaleProvider locale={locale} onLocaleChange={setLocale}>
          {children}
        </ConversationLocaleProvider>
      </I18nProvider>
    </Context.Provider>
  );
}

export function useShowcasePreferences() {
  const preferences = useContext(Context);
  if (!preferences) throw new Error("ShowcasePreferences is missing");
  return preferences;
}

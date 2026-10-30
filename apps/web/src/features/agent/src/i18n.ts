import { useCallback } from "react";
import { useI18n } from "@/lib/i18n-provider";

export type AgentText = (zh: string, en: string) => string;

/**
 * Follows the shared PM browser locale, so switching language in either
 * product updates both. Priority: PM's locale store drives I18nProvider.
 */
export function useAgentText(): AgentText {
  const { locale } = useI18n();
  return useCallback((zh: string, en: string) => (locale === "en" ? en : zh), [locale]);
}

/**
 * For non-React helpers and async error mapping. Components must use
 * useAgentText so locale changes re-render them.
 */
export function agentText(zh: string, en: string): string {
  return typeof document !== "undefined" && document.documentElement.lang === "en" ? en : zh;
}

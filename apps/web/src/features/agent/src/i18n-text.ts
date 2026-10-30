/**
 * For non-React helpers and async error mapping. Components must use
 * useAgentText so locale changes re-render them.
 */
export function agentText(zh: string, en: string): string {
  return typeof document !== "undefined" && document.documentElement.lang === "en" ? en : zh;
}

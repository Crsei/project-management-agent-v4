import { AutomationApiError, type AutomationClient } from "../../../../../../../../packages/contracts/src/automation-client";
import { automationRuleSchema, type AutomationRule } from "../../../../../../../../packages/contracts/src/automation";

export async function readAutomation<T>(read: () => Promise<T>, onAccessFailure: () => void): Promise<T> {
  try { return await read(); }
  catch (cause) {
    if (cause instanceof AutomationApiError && [401, 403, 404].includes(cause.status)) onAccessFailure();
    throw cause;
  }
}

/** Search covers the complete authorized rule list, not just the first server page. */
export async function readAllRules(api: AutomationClient, signal: AbortSignal): Promise<AutomationRule[]> {
  const rules = new Map<string, AutomationRule>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await api.rules(cursor, { signal });
    for (const value of page.items) { const rule = automationRuleSchema.parse(value); rules.set(rule.id, rule); }
    if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new Error("invalid_pagination_cursor");
    cursor = page.nextCursor ?? undefined;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...rules.values()];
}

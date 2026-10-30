import { generateId } from "ai";

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function timestamp(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

const actionIdentities = new Map<string, string>();

/** Keep an uncertain mutation's identity across panel closure, navigation and reload. */
export function getActionIdentity(scope: string) {
  const cached = actionIdentities.get(scope);
  if (cached) return cached;
  const storageKey = `agent-workspace:action:${scope}`;
  let identity: string | null = null;
  try {
    identity = localStorage.getItem(storageKey);
  } catch {
    /* Memory still deduplicates this page. */
  }
  identity ||= generateId();
  actionIdentities.set(scope, identity);
  try {
    localStorage.setItem(storageKey, identity);
  } catch {
    /* Memory still deduplicates this page. */
  }
  return identity;
}

export function releaseActionIdentity(scope: string) {
  actionIdentities.delete(scope);
  try {
    localStorage.removeItem(`agent-workspace:action:${scope}`);
  } catch {
    /* An acknowledged request remains idempotent if reused. */
  }
}

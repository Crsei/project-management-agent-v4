import type { AutomationConfig } from "../../../../../../../../packages/contracts/src/automation";

export type RuleDraft = { config: AutomationConfig; baseline: AutomationConfig; expectedRevision: number | null };
export type PendingRequest = {
  requestId: string;
  kind: "create" | "update" | "status" | "remove" | "run";
  ruleId: string | null;
  expectedRevision: number | null;
  config: AutomationConfig | null;
  status: "enabled" | "paused" | null;
  startedAt: string;
};
export type JournalSnapshot = { drafts: Record<string, RuleDraft>; pending: PendingRequest | null; storageError: boolean };
type StoredJournal = { membershipVersion: number; drafts: Record<string, RuleDraft>; pending: PendingRequest | null };
export interface AutomationJournal {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => JournalSnapshot;
  setDraft: (id: string, draft: RuleDraft) => boolean;
  removeDraft: (id: string) => boolean;
  freeze: (pending: PendingRequest) => boolean;
  settle: () => boolean;
  retryStorage: () => boolean;
  revoke: () => void;
}

export function emptyConfig(): AutomationConfig {
  return { name: "", description: "", projectId: "", trigger: { kind: "manual", time: "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }, condition: "all_open", action: "report", dailyLimit: 1, cooldownMinutes: 60 };
}
export function isDirty(draft: RuleDraft): boolean { return JSON.stringify(draft.config) !== JSON.stringify(draft.baseline); }

function isConfig(value: unknown): value is AutomationConfig {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AutomationConfig>;
  return typeof row.name === "string" && typeof row.description === "string" && typeof row.projectId === "string" && !!row.trigger && (row.trigger.kind === "manual" || row.trigger.kind === "daily") && typeof row.trigger.time === "string" && typeof row.trigger.timezone === "string" && ["all_open", "overdue", "blocked"].includes(row.condition ?? "") && row.action === "report" && Number.isSafeInteger(row.dailyLimit) && Number.isSafeInteger(row.cooldownMinutes);
}
function isPending(value: unknown): value is PendingRequest {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PendingRequest>;
  return typeof row.requestId === "string" && /^[0-9a-f-]{36}$/i.test(row.requestId) && ["create", "update", "status", "remove", "run"].includes(row.kind ?? "") && (row.ruleId === null || typeof row.ruleId === "string") && (row.expectedRevision === null || Number.isSafeInteger(row.expectedRevision)) && (row.config === null || isConfig(row.config)) && (row.status === null || row.status === "enabled" || row.status === "paused") && typeof row.startedAt === "string";
}

/** Only interaction drafts and a frozen unknown request live here; never rules or run records. */
export function createAutomationJournal(actorId: string, workspaceId: string, membershipVersion: number, restoreDrafts = true): AutomationJournal {
  const key = `pm-automation:${window.location.origin}:${actorId}:${workspaceId}`;
  let snapshot: JournalSnapshot = { drafts: {}, pending: null, storageError: false };
  let unreadable = false;
  const listeners = new Set<() => void>();
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredJournal>;
      if (parsed.pending !== null && !isPending(parsed.pending)) throw new Error("invalid_recovery_journal");
      const drafts: Record<string, RuleDraft> = {};
      if (restoreDrafts && parsed.membershipVersion === membershipVersion && parsed.drafts && typeof parsed.drafts === "object") {
        for (const [id, value] of Object.entries(parsed.drafts)) {
          if (!value || !isConfig(value.config) || !isConfig(value.baseline) || !(value.expectedRevision === null || Number.isSafeInteger(value.expectedRevision))) throw new Error("invalid_draft_journal");
          drafts[id] = value;
        }
      }
      // A changed membership never restores old project content. A minimal original
      // request identity survives so it can be reconciled under current authorization.
      const pending = parsed.pending ?? null;
      snapshot = { drafts, pending: restoreDrafts && parsed.membershipVersion === membershipVersion ? pending : pending && { ...pending, config: null }, storageError: false };
    }
  } catch { unreadable = true; snapshot = { drafts: {}, pending: null, storageError: true }; }
  function commit(next: Omit<JournalSnapshot, "storageError">): boolean {
    // A malformed journal may contain the only surviving original request key.
    // Never overwrite it with an empty recovery record to unblock new writes.
    if (unreadable) return false;
    try {
      sessionStorage.setItem(key, JSON.stringify({ membershipVersion, ...next } satisfies StoredJournal));
      snapshot = { ...next, storageError: false };
      listeners.forEach(listener => listener());
      return true;
    } catch {
      snapshot = { ...snapshot, drafts: next.drafts, storageError: true };
      listeners.forEach(listener => listener());
      return false;
    }
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    setDraft: (id: string, draft: RuleDraft) => commit({ drafts: { ...snapshot.drafts, [id]: draft }, pending: snapshot.pending }),
    removeDraft: (id: string) => { const drafts = { ...snapshot.drafts }; delete drafts[id]; return commit({ drafts, pending: snapshot.pending }); },
    freeze: (pending: PendingRequest) => !snapshot.pending && commit({ drafts: snapshot.drafts, pending }),
    settle: () => commit({ drafts: snapshot.drafts, pending: null }),
    retryStorage: () => {
      if (unreadable) {
        const restored = createAutomationJournal(actorId, workspaceId, membershipVersion, restoreDrafts).getSnapshot();
        if (restored.storageError) return false;
        snapshot = restored;
        unreadable = false;
      }
      return commit({ drafts: snapshot.drafts, pending: snapshot.pending });
    },
    revoke: () => {
      const cleared = { drafts: {}, pending: snapshot.pending && { ...snapshot.pending, config: null } };
      snapshot = { ...cleared, storageError: unreadable };
      commit(cleared);
    },
  };
}

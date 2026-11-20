/** Ordering and session-scoped dismissal for composer banners. Pure; no DOM. */

import type { AgentOutputSnapshot } from "@agent-workspace/contracts/output";

export type ComposerBannerSeverity = "alert" | "warning" | "info";
export type ComposerBannerKind =
  | "offline"
  | "stream"
  | "runtime"
  | "provider"
  | "save"
  | "sync"
  | "queue"
  | "usage"
  | "progress"
  | "plan";

export type ComposerBannerModel = {
  /** Stable identity inside its kind, e.g. "provider" or "plan:<itemId>". */
  id: string;
  kind: ComposerBannerKind;
  severity: ComposerBannerSeverity;
  dismissible: boolean;
  /**
   * Data the banner content is derived from. A new signature makes a previous
   * dismissal void, so a repeated or different error is never hidden.
   */
  signature?: string;
};

const SEVERITY_RANK: Record<ComposerBannerSeverity, number> = { alert: 0, warning: 1, info: 2 };
/** Alerts first, then warnings, then informational entries. */
const KIND_RANK: Record<ComposerBannerKind, number> = {
  offline: 0,
  stream: 1,
  runtime: 2,
  provider: 3,
  save: 4,
  sync: 5,
  queue: 6,
  usage: 7,
  progress: 8,
  plan: 9,
};

export function composerBannerRank(banner: Pick<ComposerBannerModel, "severity" | "kind">): number {
  return SEVERITY_RANK[banner.severity] * 10 + KIND_RANK[banner.kind];
}

/** Emergency errors float to the top; the order is deterministic for equal ranks. */
export function sortComposerBanners<T extends ComposerBannerModel>(banners: readonly T[]): T[] {
  return [...banners].sort((left, right) => {
    const delta = composerBannerRank(left) - composerBannerRank(right);
    if (delta !== 0) return delta;
    return left.id.localeCompare(right.id);
  });
}

export function composerBannerDismissToken(banner: Pick<ComposerBannerModel, "id" | "signature">): string {
  return `${banner.id}|${banner.signature ?? ""}`;
}

export const COMPOSER_BANNER_STORAGE_PREFIX = "agent-composer-banner-dismissed:";

export function composerBannerStorageKey(scope: string): string {
  return `${COMPOSER_BANNER_STORAGE_PREFIX}${scope}`;
}

type BannerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readDismissedBanners(storage: BannerStorage, scope: string): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(storage.getItem(composerBannerStorageKey(scope)) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeDismissedBanners(storage: BannerStorage, scope: string, tokens: ReadonlySet<string>): void {
  try {
    const key = composerBannerStorageKey(scope);
    if (tokens.size) storage.setItem(key, JSON.stringify([...tokens]));
    else storage.removeItem(key);
  } catch {
    /* A blocked write only loses the dismissal; the banner stays visible. */
  }
}

/** Returns the next dismissal set; storage writes stay with the caller's state. */
export function dismissComposerBanner<T extends ComposerBannerModel>(
  banners: readonly T[],
  dismissed: ReadonlySet<string>,
  banner: Pick<T, "id" | "signature" | "dismissible">,
): ReadonlySet<string> {
  if (!banner.dismissible) return dismissed;
  const next = new Set(dismissed);
  next.add(composerBannerDismissToken(banner));
  return next;
}

export function visibleComposerBanners<T extends ComposerBannerModel>(
  banners: readonly T[],
  dismissed: ReadonlySet<string>,
): T[] {
  return sortComposerBanners(banners).filter(
    (banner) => !banner.dismissible || !dismissed.has(composerBannerDismissToken(banner)),
  );
}

/** Collapsed stacks show one banner; expanding peeks at the rest in rank order. */
export function splitBannerPeek<T>(banners: readonly T[]): { primary?: T; hidden: T[] } {
  const [primary, ...hidden] = banners;
  return { primary, hidden };
}

/* ---------------------------------------------------------------------------
 * Runtime identity: the UI compares its bundled AGENT_API_VERSION against the
 * service it is actually talking to. Nothing is guessed from network failures.
 * ------------------------------------------------------------------------- */

export type RuntimeProbe =
  | { status: "ok"; apiVersion: string; buildMode?: string }
  /** The endpoint is absent or does not answer this contract: an older server build. */
  | { status: "missing" }
  | { status: "error"; message?: string };

export type RuntimeVersionState =
  | { state: "match" }
  | { state: "mismatch"; local: string; remote?: string; buildMode?: string }
  /** The read failed for transport/authorization reasons; no banner is honest. */
  | { state: "unknown" };

/** Strict read of `GET /api/runtime`; unknown fields are ignored, wrong types are not. */
export function parseRuntimeInfo(payload: unknown): { apiVersion: string; buildMode?: string } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const version = record.apiVersion;
  if (typeof version !== "string") return undefined;
  const apiVersion = version.trim();
  if (!apiVersion || apiVersion.length > 64) return undefined;
  const mode = record.buildMode;
  if (mode !== undefined && (typeof mode !== "string" || mode.length > 64)) return undefined;
  return { apiVersion, ...(mode ? { buildMode: mode } : {}) };
}

export function compareApiVersion(local: string, probe: RuntimeProbe): RuntimeVersionState {
  if (probe.status === "error") return { state: "unknown" };
  if (probe.status === "missing") return { state: "mismatch", local };
  if (probe.apiVersion === local) return { state: "match" };
  return { state: "mismatch", local, remote: probe.apiVersion, ...(probe.buildMode ? { buildMode: probe.buildMode } : {}) };
}

/* ---------------------------------------------------------------------------
 * Synchronization: only the two readiness signals the product can state
 * honestly (Worker heartbeat, quarantined events). Everything else is unread.
 * ------------------------------------------------------------------------- */

export type SyncReadiness =
  | { kind: "healthy" }
  | { kind: "degraded"; workerOffline: boolean; quarantinedEvents: number }
  | { kind: "unreadable" };

/** Reads the existing PM readiness shape `{ status, checks: { worker, quarantinedEvents } }`. */
export function classifyReadiness(payload: unknown): SyncReadiness {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "unreadable" };
  const checks = (payload as Record<string, unknown>).checks;
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) return { kind: "unreadable" };
  const record = checks as Record<string, unknown>;
  const worker = record.worker;
  const quarantined = record.quarantinedEvents;
  if (typeof worker !== "boolean") return { kind: "unreadable" };
  if (typeof quarantined !== "number" || !Number.isInteger(quarantined) || quarantined < 0) return { kind: "unreadable" };
  if (!worker || quarantined > 0) return { kind: "degraded", workerOffline: !worker, quarantinedEvents: quarantined };
  return { kind: "healthy" };
}

/* ---------------------------------------------------------------------------
 * Generation progress: a read-only projection of the latest todo_list item in
 * the current generation snapshot. No separate polling, no inferred counts.
 * ------------------------------------------------------------------------- */

export type TodoProgress = {
  /** Native todo_list item whose row the banner links back to. */
  itemId: string;
  completed: number;
  total: number;
  running: { id: string; text: string }[];
};

/**
 * Only a running generation with visible todo steps has honest progress. The
 * latest todo_list item wins because providers republish the cumulative list.
 */
export function summarizeTodoProgress(
  snapshot: Pick<AgentOutputSnapshot, "status" | "items"> | undefined,
): TodoProgress | undefined {
  if (!snapshot || snapshot.status !== "running") return undefined;
  for (let index = snapshot.items.length - 1; index >= 0; index--) {
    const item = snapshot.items[index]!;
    if (item.type !== "todo_list") continue;
    if (item.visibility === "redacted" || item.visibility === "unavailable") continue;
    const steps = item.steps;
    if (!steps?.length) continue;
    return {
      itemId: item.id,
      completed: steps.filter((step) => step.status === "completed").length,
      total: steps.length,
      running: steps
        .filter((step) => step.status === "running")
        .map((step) => ({ id: step.id, text: step.text })),
    };
  }
  return undefined;
}

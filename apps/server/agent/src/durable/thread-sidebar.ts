import type { ThreadSidebar, ThreadSidebarAction } from "@agent-workspace/contracts/chat";
import { getNativeOutput, isNativeInteractionRespondable } from "./native-output.ts";
import { isChatActive, listChatGenerations } from "./chat-runtime.ts";
import { DurableError } from "./errors.ts";
import { readRecord, transaction, writeRecord } from "./store.ts";
import { getThread, ThreadConflictError, type ThreadMetadata } from "./threads.ts";

const SIDEBARS = "chat:sidebar";
// Upstream's default inactivity policy is three days. This application has no
// PR linkage or configurable settlement policy; never infer a merge event.
const AUTO_SETTLE_DAYS = 3;
type SidebarRecord = {
  revision: number;
  pinnedAt: string | null;
  settledAt: string | null;
  snoozedAt: string | null;
  snoozedUntil: string | null;
  autoSettle: boolean;
  lastVisitedAt: string | null;
  markedUnread: boolean;
  settledOverride: "settled" | "active" | null;
  lastWakeAt: string | null;
  settledChangedAt: string | null;
  settledGenerationId: string | null;
  snoozeGenerationId: string | null;
};
const defaults = (): SidebarRecord => ({
  revision: 0, pinnedAt: null, settledAt: null, snoozedAt: null, snoozedUntil: null,
  autoSettle: true, lastVisitedAt: null, markedUnread: false, settledOverride: null, lastWakeAt: null,
  settledChangedAt: null, settledGenerationId: null, snoozeGenerationId: null,
});
const readSidebar = (id: string): SidebarRecord => ({ ...defaults(), ...readRecord<Partial<SidebarRecord>>(SIDEBARS, id) });

function facts(thread: ThreadMetadata) {
  const generations = listChatGenerations(thread.remoteId);
  const active = generations.filter(isChatActive);
  let activity: ThreadSidebar["activity"] | undefined;
  for (const kind of ["approval", "user_input"] as const) {
    const waiting = active.find(generation => getNativeOutput(generation.id)?.items.some(item =>
      item.status === "waiting" && item.request?.kind === kind && item.request.respondable
      && isNativeInteractionRespondable(generation.id, item.request.id)));
    if (waiting) {
      activity = { status: kind === "approval" ? "waiting_approval" : "waiting_input", generationId: waiting.id };
      break;
    }
  }
  const executing = active.find(generation => generation.status === "running") ?? active[0];
  const latest = generations[0];
  activity ??= executing ? { status: executing.status === "queued" ? "queued" : "running", generationId: executing.id }
    : latest ? { status: latest.status === "completed" ? "idle" : latest.status, generationId: latest.id }
    : { status: "idle" };
  return { generations, running: active.length > 0, activity,
    pending: activity.status === "waiting_approval" || activity.status === "waiting_input",
    queued: active.some(generation => generation.status === "queued") };
}

/** Reconcile timer, request, failure and inactivity edges atomically on every read. */
function reconcile(thread: ThreadMetadata, now: string): { record: SidebarRecord; view: ThreadSidebar } {
  let record = readSidebar(thread.remoteId);
  const { generations, running, pending, queued, activity: executionActivity } = facts(thread);
  const latest = generations[0];
  const nowMs = Date.parse(now);
  // A new user-submitted turn reactivates a settled thread and explicitly wakes
  // a snooze; continuations of existing background work do neither.
  const submitted = generations.find((generation) => !generation.continuationOf);
  if (record.settledOverride && submitted && submitted.id !== record.settledGenerationId &&
      record.settledChangedAt && submitted.createdAt >= record.settledChangedAt) {
    record = { ...record, settledAt: null, settledOverride: null, settledChangedAt: null,
      settledGenerationId: null, revision: record.revision + 1 };
    writeRecord(SIDEBARS, thread.remoteId, record);
  }
  if (record.snoozedUntil && submitted && submitted.id !== record.snoozeGenerationId &&
      record.snoozedAt && submitted.createdAt >= record.snoozedAt) {
    record = { ...record, snoozedAt: null, snoozedUntil: null, lastWakeAt: submitted.createdAt,
      snoozeGenerationId: null, revision: record.revision + 1 };
    writeRecord(SIDEBARS, thread.remoteId, record);
  }
  const failureAt = latest?.status === "failed" ? latest.endedAt : undefined;
  const wakeAt = record.snoozedUntil && (
    Date.parse(record.snoozedUntil) <= nowMs ? record.snoozedUntil :
    pending ? now :
    failureAt && Date.parse(failureAt) > Date.parse(record.snoozedAt ?? "") ? failureAt : null
  );
  if (wakeAt) {
    record = { ...record, snoozedAt: null, snoozedUntil: null, lastWakeAt: wakeAt, revision: record.revision + 1 };
    writeRecord(SIDEBARS, thread.remoteId, record);
  }
  const activity = Math.max(Date.parse(thread.createdAt), ...generations.flatMap((generation) =>
    [generation.createdAt, generation.endedAt].flatMap((value) => value && Number.isFinite(Date.parse(value)) ? [Date.parse(value)] : [])),
    record.lastWakeAt ? Date.parse(record.lastWakeAt) : 0);
  if (thread.status === "regular" && record.autoSettle && !record.settledOverride && !record.pinnedAt &&
      !record.snoozedUntil && !running && !pending && Number.isFinite(activity) &&
      activity < nowMs - AUTO_SETTLE_DAYS * 86_400_000) {
    record = { ...record, settledAt: new Date(activity).toISOString(), settledOverride: "settled",
      settledChangedAt: now, settledGenerationId: submitted?.id ?? null, revision: record.revision + 1 };
    writeRecord(SIDEBARS, thread.remoteId, record);
  }
  const completedAt = latest?.endedAt;
  const unread = record.markedUnread || Boolean(completedAt &&
    (latest?.status === "completed" || latest?.status === "failed") &&
    (!record.lastVisitedAt || Date.parse(completedAt) > Date.parse(record.lastVisitedAt)));
  return { record, view: {
    revision: record.revision, pinnedAt: record.pinnedAt, settledAt: record.settledAt,
    snoozedAt: record.snoozedAt, snoozedUntil: record.snoozedUntil,
    autoSettle: record.autoSettle, lastVisitedAt: record.lastVisitedAt, unread,
    section: record.snoozedUntil ? "snoozed" : record.settledAt ? "settled" : record.pinnedAt ? "pinned" : "active",
    running, activity: executionActivity, canSnooze: !pending && !queued,
  } };
}

export function getThreadSidebar(thread: ThreadMetadata, now = new Date().toISOString()): ThreadSidebar {
  return transaction(() => reconcile(thread, now).view);
}

export function updateThreadSidebar(id: string, action: ThreadSidebarAction, now = new Date().toISOString()): ThreadSidebar {
  return transaction(() => {
    const thread = getThread(id);
    if (!thread) throw new ThreadConflictError("找不到会话。", "not_found");
    const { record, view } = reconcile(thread, now);
    if (record.revision !== action.revision)
      throw new ThreadConflictError("会话侧栏状态已更改，请重新载入。", "sidebar_conflict");
    const next = { ...record };
    switch (action.action) {
      case "pin":
        next.pinnedAt ??= now;
        if (next.settledOverride === "settled") {
          next.settledAt = null; next.settledOverride = "active"; next.settledChangedAt = now;
          next.settledGenerationId = listChatGenerations(id).find((generation) => !generation.continuationOf)?.id ?? null;
        }
        if (next.snoozedUntil) {
          next.snoozedAt = null; next.snoozedUntil = null; next.lastWakeAt = now;
        }
        break;
      case "unpin": next.pinnedAt = null; break;
      case "settle":
        if (next.settledOverride !== "settled" || !next.settledAt || next.pinnedAt || next.snoozedUntil) {
          next.settledAt ??= now; next.settledOverride = "settled"; next.pinnedAt = null;
          next.settledChangedAt = now; next.settledGenerationId = listChatGenerations(id).find((generation) => !generation.continuationOf)?.id ?? null;
        }
        next.snoozedAt = null; next.snoozedUntil = null; break;
      case "unsettle":
        if (next.settledOverride !== "active") {
          next.settledAt = null; next.settledOverride = "active"; next.settledChangedAt = now;
          next.settledGenerationId = listChatGenerations(id).find((generation) => !generation.continuationOf)?.id ?? null;
        }
        break;
      case "snooze":
        if (!view.canSnooze) throw new DurableError(409, "cannot_snooze", "会话正在等待用户输入或开始生成，不能暂缓。 ");
        if (!action.snoozedUntil || Date.parse(action.snoozedUntil) <= Date.parse(now))
          throw new DurableError(400, "invalid_snooze", "唤醒时间必须在未来。 ");
        if (next.snoozedUntil !== action.snoozedUntil) {
          next.snoozedAt = now; next.snoozedUntil = action.snoozedUntil;
          next.snoozeGenerationId = listChatGenerations(id).find((generation) => !generation.continuationOf)?.id ?? null;
        }
        break;
      case "wake":
        if (next.snoozedUntil) { next.snoozedAt = null; next.snoozedUntil = null; next.lastWakeAt = now; }
        break;
      case "auto-settle": next.autoSettle = action.enabled!; break;
      case "mark-unread": next.markedUnread = true; break;
      case "visit": next.lastVisitedAt = now; next.markedUnread = false; break;
    }
    if (JSON.stringify(next) !== JSON.stringify(record)) {
      next.revision++;
      writeRecord(SIDEBARS, id, next);
    }
    return reconcile(thread, now).view;
  });
}

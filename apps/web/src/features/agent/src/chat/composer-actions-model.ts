/** Composer chrome decisions that must stay testable without React or the DOM. */
import { COMPOSER_PROMPT_LIMIT } from "./composer-limit.ts";
import type { QueuedChatMessage } from "@agent-workspace/contracts/chat";
import { queueEditableText } from "./composer-queue-order.ts";

export type ComposerText = { zh: string; en: string };

/** Primary button states that the current contracts can actually execute. */
export type ComposerPrimaryKind =
  | "submit"
  | "send-context"
  | "steer"
  | "queue"
  | "resume"
  | "update-queued"
  | "hidden";

export type ComposerSteerCapability = { supported: boolean; interruptsTools?: boolean };

export type ComposerPrimaryInput = {
  /** A native turn is running; the cancel control owns its own slot. */
  running: boolean;
  /** Remote thread exists, so steer/queue/continue have an address. */
  remoteThread: boolean;
  hasText: boolean;
  attachmentCount: number;
  hasQuote: boolean;
  /** Selected message context items plus PM references. */
  selectionCount: number;
  historyBlocked: boolean;
  /** Composer-local pending selection/submission blocks sending for a moment. */
  draftBlocked?: boolean;
  tooLong: boolean;
  saveError: boolean;
  saving: boolean;
  sessionDisabled: boolean;
  sendUnavailable: boolean;
  steer: ComposerSteerCapability;
  /** Latest generation ended in failed/cancelled/interrupted and can be continued. */
  resumable: boolean;
  /** A queue edit owns every submit path, even while a native turn is running. */
  editingQueue?: boolean;
  queueUpdatePending?: boolean;
};

export type ComposerPrimaryAction = {
  kind: ComposerPrimaryKind;
  label: ComposerText;
  disabled: boolean;
  /** Why the action cannot run now; shown as the tooltip/aria description. */
  reason?: ComposerText;
};

const SEND: ComposerText = { zh: "发送消息", en: "Send message" };
const SEND_CONTEXT: ComposerText = { zh: "发送已选上下文", en: "Send selected context" };
const QUEUE: ComposerText = { zh: "加入队列", en: "Queue message" };
const RESUME: ComposerText = { zh: "继续未完成部分", en: "Continue unfinished part" };
const UPDATE_QUEUED: ComposerText = { zh: "更新队列", en: "Update queued" };
const HIDDEN: ComposerText = { zh: "", en: "" };

function blockedReason(input: ComposerPrimaryInput): ComposerText | undefined {
  if (input.historyBlocked)
    return { zh: "会话历史未恢复，发送已暂停。", en: "Session history is not restored; sending is paused." };
  if (input.draftBlocked)
    return {
      zh: "输入区还有未完成的选择或提交；完成或取消后即可发送。",
      en: "The composer still has an unfinished selection or submission; finish or cancel it before sending.",
    };
  if (input.tooLong)
    return {
      zh: `消息超过 ${COMPOSER_PROMPT_LIMIT.toLocaleString()} 字符，请缩短后发送。`,
      en: `Message exceeds ${COMPOSER_PROMPT_LIMIT.toLocaleString()} characters; shorten it before sending.`,
    };
  if (input.saveError)
    return { zh: "会话参数保存失败，先重试保存。", en: "Saving session settings failed; retry the save first." };
  if (input.saving) return { zh: "正在保存会话参数…", en: "Saving session settings…" };
  if (input.sessionDisabled) return { zh: "当前会话不可发送。", en: "This session cannot send right now." };
  if (input.sendUnavailable)
    return {
      zh: "当前还不满足发送条件（Provider、模型或执行环境）。",
      en: "Sending is not available yet (provider, model or execution environment).",
    };
  return undefined;
}

export function isPlainTextDraft(input: Pick<ComposerPrimaryInput, "hasText" | "attachmentCount" | "hasQuote" | "selectionCount">): boolean {
  return input.hasText && input.attachmentCount === 0 && !input.hasQuote && input.selectionCount === 0;
}

/**
 * One honest primary action for the current capability set. States that the
 * contracts cannot execute (compact without a command, queue with attachments,
 * steer that needs an explicit tool-interruption confirmation) are never shown
 * as if they were available.
 */
export function resolveComposerPrimaryAction(input: ComposerPrimaryInput): ComposerPrimaryAction {
  const reason = blockedReason(input);
  const hasDraft = input.hasText || input.attachmentCount > 0 || input.hasQuote;
  const hidden: ComposerPrimaryAction = { kind: "hidden", label: HIDDEN, disabled: true };

  if (input.editingQueue) {
    const plainTextReason = isPlainTextDraft(input) ? undefined : {
      zh: "队列编辑只接受纯文字；请移除附件或引用并保留非空文字。",
      en: "Queue editing accepts plain text only; remove attachments or references and keep non-empty text.",
    };
    return {
      kind: "update-queued",
      label: UPDATE_QUEUED,
      disabled: !!reason || !!plainTextReason || !!input.queueUpdatePending || !input.remoteThread,
      reason: reason ?? plainTextReason,
    };
  }
  if (input.running) {
    if (!hasDraft || !input.remoteThread) return hidden;
    if (isPlainTextDraft(input))
      return { kind: "queue", label: QUEUE, disabled: !!reason, reason };
    return hidden;
  }

  if (input.resumable && !hasDraft && input.selectionCount === 0 && input.remoteThread)
    return {
      kind: "resume",
      label: RESUME,
      disabled: !!reason,
      reason,
    };

  // Sending selected context can create a draft session, so it does not need a
  // remote thread yet.
  if (!hasDraft && input.selectionCount > 0)
    return { kind: "send-context", label: SEND_CONTEXT, disabled: !!reason, reason };

  // Explicit compaction is a separate control; ordinary send never changes mode.
  return { kind: "submit", label: SEND, disabled: !!reason, reason };
}

/** Controls that may fold into the “more” popover at the current container width. */
export type ComposerControlId = "traits" | "contextActions" | "contextMeter" | "dictation" | "attachment";
export type ComposerDensity = "wide" | "compact" | "narrow";

export const COMPOSER_DENSITY_LIMITS = { compact: 560, narrow: 380 } as const;

/** Width buckets measured on the action bar itself, not the viewport. */
export function resolveComposerDensity(width: number | undefined): ComposerDensity {
  if (width === undefined || !Number.isFinite(width)) return "wide";
  if (width < COMPOSER_DENSITY_LIMITS.narrow) return "narrow";
  if (width < COMPOSER_DENSITY_LIMITS.compact) return "compact";
  return "wide";
}

/**
 * Model, stop/cancel and the primary action always stay visible; secondary
 * controls fold into the “more” popover, so no capability is deleted.
 */
export function collapsedComposerControls(density: ComposerDensity): readonly ComposerControlId[] {
  if (density === "wide") return [];
  if (density === "compact") return ["traits", "contextMeter"];
  return ["traits", "contextActions", "contextMeter", "dictation", "attachment"];
}

/** Shared synchronous guard for shortcuts and buttons before React can re-render. */
export type ComposerOperationLock = {
  current: { threadId: string; kind: "compaction" | "queue-update" } | null;
};

export type ComposerQueueEditState =
  | { status: "idle" }
  | { status: "editing" | "updating"; threadId: string; row: QueuedChatMessage; error?: string };
export type ComposerQueueEditEvent =
  | { type: "begin"; threadId: string; row: QueuedChatMessage }
  | { type: "save" | "saved" | "cancel" | "reset" }
  | { type: "failed"; error: string };

export function composerQueueEditCandidate(
  remoteId: string | undefined,
  detail: { threadId: string; row: QueuedChatMessage } | undefined,
): { threadId: string; row: QueuedChatMessage; text: string } | undefined {
  if (!remoteId || detail?.threadId !== remoteId || detail.row?.threadId !== remoteId) return undefined;
  if (detail.row.status !== "queued" && detail.row.status !== "blocked") return undefined;
  const text = queueEditableText(detail.row.draft);
  return text === undefined ? undefined : { threadId: remoteId, row: detail.row, text };
}

/** A failed CAS keeps the exact original row/revision, never a refreshed replacement. */
export function reduceComposerQueueEdit(state: ComposerQueueEditState, event: ComposerQueueEditEvent): ComposerQueueEditState {
  if (event.type === "reset") return { status: "idle" };
  if (event.type === "begin")
    return state.status === "updating" ? state : { status: "editing", threadId: event.threadId, row: event.row };
  if (event.type === "saved") return state.status === "updating" ? { status: "idle" } : state;
  if (event.type === "cancel") return state.status === "updating" ? state : { status: "idle" };
  if (state.status === "idle") return state;
  if (event.type === "save") return { status: "updating", threadId: state.threadId, row: state.row };
  if (event.type === "failed") return { status: "editing", threadId: state.threadId, row: state.row, error: event.error };
  return state;
}

export type ComposerCompactionPhase = "idle" | "compacting" | "reloading" | "sending";
export type ComposerCompactionState = { phase: ComposerCompactionPhase; available: boolean; error?: string; completed?: boolean };
export type ComposerCompactionEvent =
  | { type: "availability"; available: boolean }
  | { type: "start" | "reloading" | "sending" | "complete" | "reset" }
  | { type: "failed"; error: string };

export function reduceComposerCompaction(state: ComposerCompactionState, event: ComposerCompactionEvent): ComposerCompactionState {
  if (event.type === "reset") return { phase: "idle", available: false };
  if (event.type === "availability") return { ...state, available: event.available };
  if (event.type === "start")
    return state.phase === "idle" && state.available ? { phase: "compacting", available: true } : state;
  if (event.type === "failed") return { phase: "idle", available: state.available, error: event.error };
  if (event.type === "complete") return { phase: "idle", available: false, completed: true };
  return { ...state, phase: event.type };
}

export type ComposerCompactionControlsState = {
  visible: boolean; showSend: boolean; disabled: boolean; sendDisabled: boolean;
};

export function resolveComposerCompactionControls(input: {
  available: boolean; phase: ComposerCompactionPhase; hasText: boolean;
  running: boolean; editingQueue: boolean; fanoutActive: boolean; blocked: boolean; sendBlocked: boolean;
}): ComposerCompactionControlsState {
  const visible = input.available && !input.editingQueue && !input.fanoutActive;
  const disabled = input.phase !== "idle" || input.running || input.blocked;
  return { visible, showSend: visible && input.hasText, disabled, sendDisabled: disabled || input.sendBlocked };
}

/** Queue edits always win over stacked models; a pending operation never submits. */
export function resolveComposerSubmissionRoute(input: {
  editingQueue: boolean; operationPending: boolean; fanoutActive: boolean;
}): "update-queued" | "blocked" | "fanout" | "send" {
  if (input.operationPending) return "blocked";
  if (input.editingQueue) return "update-queued";
  return input.fanoutActive ? "fanout" : "send";
}

/** Reload must finish before any preserved draft is sent; stale sessions never send. */
export async function executeComposerCompaction<T>(steps: {
  compact: () => Promise<T>;
  reload: (receipt: T) => Promise<void>;
  send?: () => void | Promise<void>;
  isCurrent: () => boolean;
  onPhase: (phase: "reloading" | "sending") => void;
}): Promise<boolean> {
  const receipt = await steps.compact();
  if (!steps.isCurrent()) return false;
  steps.onPhase("reloading");
  await steps.reload(receipt);
  if (!steps.isCurrent()) return false;
  if (steps.send) { steps.onPhase("sending"); await steps.send(); }
  return true;
}

/** Preserve the server's code as well as its human-readable error. */
export function composerOperationError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

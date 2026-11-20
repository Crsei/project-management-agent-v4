/**
 * Send-path decisions for multi-model fanout. Kept free of React and the DOM so
 * the "can this draft fan out" rules stay testable next to the server contract.
 */
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import {
  FANOUT_LIMIT,
  fanoutBlocker,
  type FanoutModelSelection,
  type FanoutOutcome,
} from "./model-fanout.ts";
import { fanoutModelAvailability } from "./model-fanout-picker-model.ts";

/** Reasons the composer refuses a fanout send; mirrors server restrictions and never fakes success. */
export type ComposerFanoutBlocker =
  | "fanout_requires_two_models"
  | "fanout_exceeds_limit"
  | "fanout_text_required"
  | "fanout_attachment_unsupported"
  | "fanout_session_running"
  | "fanout_history_blocked"
  | "fanout_provider_unavailable"
  | "fanout_context_unsupported"
  | "fanout_quote_unsupported"
  | "fanout_requires_remote_session"
  | "fanout_composer_unavailable";

export type ComposerFanoutGateInput = {
  /** Null/one entry means the composer is in single-model mode and fanout never intercepts. */
  selections: readonly FanoutModelSelection[] | null;
  hasText: boolean;
  attachmentCount: number;
  quote: boolean;
  /** Draft message-context selections plus resolved PM references. */
  contextItemCount: number;
  pmReferenceCount: number;
  running: boolean;
  historyBlocked: boolean;
  /** Every stacked model resolves to a ready provider/model. */
  providerAvailable: boolean;
  remoteId?: string;
  /** Session saving failure, disabled state or send-unavailable contract. */
  composerUnavailable?: boolean;
};

export type ComposerFanoutGate = {
  active: boolean;
  blocker: ComposerFanoutBlocker | null;
};

/**
 * Fanout owns the send path only while two or more models are stacked. The
 * server accepts plain text into a real session; everything else is refused with
 * an explicit reason instead of silently falling back to a single-model send.
 */
export function composerFanoutGate(input: ComposerFanoutGateInput): ComposerFanoutGate {
  const selections = input.selections;
  if (!selections || selections.length < 2) return { active: false, blocker: null };
  const active = { active: true } as const;
  if (!input.hasText) return { ...active, blocker: "fanout_text_required" };
  if (input.attachmentCount > 0) return { ...active, blocker: "fanout_attachment_unsupported" };
  if (input.composerUnavailable) return { ...active, blocker: "fanout_composer_unavailable" };
  const mirrored = fanoutBlocker({
    selectionCount: selections.length,
    running: input.running,
    historyBlocked: input.historyBlocked,
    pmReferenceCount: input.pmReferenceCount,
    contextItemCount: input.contextItemCount,
    quote: input.quote,
    providerAvailable: input.providerAvailable,
  });
  if (mirrored) return { ...active, blocker: mirrored as ComposerFanoutBlocker };
  if (!input.remoteId) return { ...active, blocker: "fanout_requires_remote_session" };
  return { ...active, blocker: null };
}

export type ComposerFanoutCopy = { zh: string; en: string };

const BLOCKER_COPY: Record<ComposerFanoutBlocker, ComposerFanoutCopy> = {
  fanout_requires_two_models: {
    zh: "多模型发送至少需要两个模型。",
    en: "Multi-model send needs at least two models.",
  },
  fanout_exceeds_limit: {
    zh: `多模型发送最多支持 ${FANOUT_LIMIT} 个模型。`,
    en: `Multi-model send supports at most ${FANOUT_LIMIT} models.`,
  },
  fanout_text_required: {
    zh: "多模型发送暂只支持纯文字消息；请先输入文字。",
    en: "Multi-model send supports plain text only; type a message first.",
  },
  fanout_attachment_unsupported: {
    zh: "多模型发送不支持附件；请先移除附件，或退出多选后单模型发送。",
    en: "Multi-model send does not support attachments; remove them or exit stacking to send with one model.",
  },
  fanout_session_running: {
    zh: "当前会话正在执行；请等待结束或停止后再多模型发送。",
    en: "This session is running; wait for it to finish or stop before multi-model sending.",
  },
  fanout_history_blocked: {
    zh: "会话历史未恢复，多模型发送已暂停。",
    en: "Session history is not restored; multi-model send is paused.",
  },
  fanout_provider_unavailable: {
    zh: "叠选的模型中存在不可用的 Provider 或模型；请先在模型选择中处理。",
    en: "A stacked provider or model is not available; resolve it in the model picker first.",
  },
  fanout_context_unsupported: {
    zh: "多模型发送不支持 PM 引用或已选上下文；请先移除它们。",
    en: "Multi-model send does not support PM references or selected context; remove them first.",
  },
  fanout_quote_unsupported: {
    zh: "多模型发送不支持引用文字；请先移除引用。",
    en: "Multi-model send does not support quoted text; remove the quote first.",
  },
  fanout_requires_remote_session: {
    zh: "先发送一条单模型消息或设置会话参数以创建会话，再进行多模型发送。",
    en: "Send one single-model message or set session parameters to create the session before multi-model sending.",
  },
  fanout_composer_unavailable: {
    zh: "当前会话暂时不可发送（正在保存、保存失败或执行环境不可用）。",
    en: "This session cannot send right now (saving, save failure, or the execution environment is unavailable).",
  },
};

export function composerFanoutBlockerCopy(blocker: ComposerFanoutBlocker): ComposerFanoutCopy {
  return BLOCKER_COPY[blocker];
}

export type FanoutUserMessage = {
  id: string;
  role: "user";
  parts: Array<Record<string, unknown>>;
};

/** The fanout contract takes one plain user message; metadata never rides along. */
export function buildFanoutUserMessage(input: { id: string; text: string }): FanoutUserMessage {
  return {
    id: input.id,
    role: "user",
    parts: [{ type: "text", text: input.text }],
  };
}

export type FanoutAttempt = {
  operationId: string;
  message: FanoutUserMessage;
  selections: FanoutModelSelection[];
};

/**
 * A retry must reuse the operation id from this tab (pending attempt first, then
 * the persisted per-thread id); only a fresh operation gets a new id.
 */
export function resolveFanoutOperationId(input: {
  pending?: string;
  stored?: string;
  generate: () => string;
}): { operationId: string; reused: boolean } {
  const existing = input.pending ?? input.stored;
  if (existing) return { operationId: existing, reused: true };
  return { operationId: input.generate(), reused: false };
}

/** Every stacked model must still resolve to an enabled, authenticated, ready provider/model. */
export function fanoutSelectionsAvailable(
  providers: readonly ProviderInstance[],
  selections: readonly FanoutModelSelection[],
): boolean {
  if (selections.length === 0) return false;
  return selections.every((selection) =>
    fanoutModelAvailability(
      providers.find((provider) => provider.instanceId === selection.providerInstanceId),
      selection.model,
    ) === "available",
  );
}

/**
 * `created` and `partial` are final server receipts: the same operation id will
 * never dispatch again, so the stack can be cleared. `failed` stays retryable.
 */
export function fanoutReceiptSucceeded(
  outcome: Pick<FanoutOutcome, "status">,
): boolean {
  return outcome.status === "created" || outcome.status === "partial";
}

/** Default destination after a successful fanout: the first child that was actually created. */
export function firstFanoutChildThread(
  outcome: Pick<FanoutOutcome, "children">,
): string | undefined {
  return outcome.children.find((child) => !child.error)?.threadId;
}

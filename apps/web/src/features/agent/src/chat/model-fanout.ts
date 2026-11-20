import type { ProviderOptionSelection } from "@agent-workspace/contracts/provider";

/** Multiple models fan out into independent Sessions; t3code calls this stacking. */
export type FanoutModelSelection = {
  providerInstanceId: string;
  model: string;
  modelOptions?: ProviderOptionSelection[];
};
export type FanoutOutcome = {
  operationId: string;
  sourceThreadId: string;
  status: "created" | "partial" | "failed";
  children: Array<{
    selection: FanoutModelSelection;
    threadId: string;
    generationId?: string;
    error?: string;
  }>;
  createdAt: string;
};

export const FANOUT_LIMIT = 8;

export function fanoutSelectionKey(selection: FanoutModelSelection): string {
  const options = [...(selection.modelOptions ?? [])]
    .map(option => [option.id, option.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([selection.providerInstanceId, selection.model, options]);
}

/** Returns null when fewer than two distinct models remain, so the composer returns to single-model mode. */
export function toggleFanoutSelection(
  current: readonly FanoutModelSelection[],
  candidate: FanoutModelSelection,
): FanoutModelSelection[] | null {
  const key = fanoutSelectionKey(candidate);
  const exists = current.some(selection => fanoutSelectionKey(selection) === key);
  const next = exists
    ? current.filter(selection => fanoutSelectionKey(selection) !== key)
    : [...current, candidate];
  const deduped = [...new Map(next.map(selection => [fanoutSelectionKey(selection), selection])).values()];
  return deduped.length >= 2 ? deduped.slice(0, FANOUT_LIMIT) : null;
}

export function normalizeFanoutSelections(
  selections: readonly FanoutModelSelection[],
): FanoutModelSelection[] {
  const unique = [...new Map(selections.map(selection => [fanoutSelectionKey(selection), selection])).values()];
  if (unique.length < 2) throw new Error("fanout_requires_two_models");
  if (unique.length > FANOUT_LIMIT) throw new Error("fanout_exceeds_limit");
  return unique;
}

export type FanoutBlockerInput = {
  selectionCount: number;
  running: boolean;
  historyBlocked: boolean;
  pmReferenceCount: number;
  contextItemCount: number;
  quote: boolean;
  providerAvailable: boolean;
};

/** Mirrors the server's restrictive input contract; returns an i18n key, not a fabricated success. */
export function fanoutBlocker(input: FanoutBlockerInput): string | null {
  if (input.selectionCount < 2) return "fanout_requires_two_models";
  if (input.selectionCount > FANOUT_LIMIT) return "fanout_exceeds_limit";
  if (input.running) return "fanout_session_running";
  if (input.historyBlocked) return "fanout_history_blocked";
  if (!input.providerAvailable) return "fanout_provider_unavailable";
  if (input.pmReferenceCount > 0 || input.contextItemCount > 0) return "fanout_context_unsupported";
  if (input.quote) return "fanout_quote_unsupported";
  return null;
}

export function fanoutRequestBody(input: {
  operationId: string;
  sourceThreadId: string;
  message: { id: string; role: "user"; parts: Array<Record<string, unknown>>; metadata?: Record<string, unknown> };
  selections: readonly FanoutModelSelection[];
  messageId?: string;
}): Record<string, unknown> {
  return {
    operationId: input.operationId,
    sourceThreadId: input.sourceThreadId,
    message: { id: input.message.id, role: "user", parts: input.message.parts },
    selections: normalizeFanoutSelections(input.selections),
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
}

export function fanoutOutcomeSummary(outcome: FanoutOutcome): {
  created: number;
  failed: number;
  generationIds: string[];
} {
  let created = 0;
  let failed = 0;
  const generationIds: string[] = [];
  for (const child of outcome.children) {
    if (child.error) { failed += 1; continue; }
    created += 1;
    if (child.generationId) generationIds.push(child.generationId);
  }
  return { created, failed, generationIds };
}

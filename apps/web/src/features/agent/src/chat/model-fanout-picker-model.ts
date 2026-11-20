/** Stacked model-picker state, labels, and availability that must stay testable without React or the DOM. */
import type { ProviderInstance } from "@agent-workspace/contracts/provider";
import {
  FANOUT_LIMIT,
  fanoutSelectionKey,
  normalizeFanoutSelections,
  toggleFanoutSelection,
  type FanoutModelSelection,
} from "./model-fanout.ts";

/** Names shown on the trigger before collapsing the rest into +N. */
export const FANOUT_TRIGGER_NAME_LIMIT = 2;

export type ModelFanoutPickerState = {
  mode: "single" | "stacking";
  /** Single-model selection restored when stacking drops below two models. */
  single: FanoutModelSelection;
  /** Distinct stacked selections; empty in single mode. */
  selections: readonly FanoutModelSelection[];
};

export function fanoutPickerSingle(selection: FanoutModelSelection): ModelFanoutPickerState {
  return { mode: "single", single: selection, selections: [] };
}

/** Stacking starts with the current model checked, so the next click adds a second one. */
export function beginFanoutStacking(
  current: FanoutModelSelection,
): ModelFanoutPickerState {
  return { mode: "stacking", single: current, selections: [current] };
}

/** Fanout is only active from two distinct models; one selection stays single-model. */
export function fanoutPickerActive(state: ModelFanoutPickerState): boolean {
  return state.mode === "stacking" && state.selections.length >= 2;
}

/** Returns to single-model mode with the first stacked model (or the previous single) kept. */
export function exitFanoutStacking(state: ModelFanoutPickerState): ModelFanoutPickerState {
  return { mode: "single", single: state.selections[0] ?? state.single, selections: [] };
}

export type FanoutPickerToggleResult = {
  state: ModelFanoutPickerState;
  changed: boolean;
  /** True when an unselected model was rejected because the stack already holds the limit. */
  limitReached: boolean;
};

/**
 * A picker row identifies a model without options. Reuse the stacked entry so a
 * checked model can be removed, and keep the original options when re-adding it.
 */
export function fanoutPickerCandidate(
  selections: readonly FanoutModelSelection[],
  candidate: FanoutModelSelection,
  preserve?: FanoutModelSelection,
): FanoutModelSelection {
  const existing = selections.find((entry) =>
    entry.providerInstanceId === candidate.providerInstanceId && entry.model === candidate.model
  );
  if (existing) return existing;
  if (
    preserve?.modelOptions &&
    preserve.providerInstanceId === candidate.providerInstanceId &&
    preserve.model === candidate.model
  ) {
    return { ...candidate, modelOptions: preserve.modelOptions };
  }
  return candidate;
}

/**
 * Adds/removes one stacked model. Falls back to single-model mode when fewer than
 * two distinct models remain, matching the server's minimum fanout contract.
 */
export function toggleFanoutPickerModel(
  state: ModelFanoutPickerState,
  candidate: FanoutModelSelection,
  limit = FANOUT_LIMIT,
): FanoutPickerToggleResult {
  if (state.mode !== "stacking") return { state, changed: false, limitReached: false };
  const key = fanoutSelectionKey(candidate);
  const selected = state.selections.some((selection) => fanoutSelectionKey(selection) === key);
  const effectiveLimit = Math.min(limit, FANOUT_LIMIT);
  if (!selected && state.selections.length >= effectiveLimit) {
    return { state, changed: false, limitReached: true };
  }
  const toggled = toggleFanoutSelection(state.selections, candidate);
  if (toggled) {
    return {
      state: { ...state, selections: normalizeFanoutSelections(toggled) },
      changed: true,
      limitReached: false,
    };
  }
  const remaining = state.selections.filter((selection) => fanoutSelectionKey(selection) !== key);
  return {
    state: { mode: "single", single: remaining[0] ?? state.single, selections: [] },
    changed: true,
    limitReached: false,
  };
}

export type FanoutPickerCapacity = {
  count: number;
  limit: number;
  atLimit: boolean;
};

export function fanoutPickerCapacity(
  selections: readonly FanoutModelSelection[],
): FanoutPickerCapacity {
  const count = new Set(selections.map(fanoutSelectionKey)).size;
  return {
    count,
    limit: FANOUT_LIMIT,
    atLimit: count >= FANOUT_LIMIT,
  };
}

export type FanoutTriggerSummary = {
  names: string[];
  visible: string[];
  overflow: number;
  count: number;
  /** Trigger text: at most two names, then `+N`. */
  short: string;
  /** Complete model list for the tooltip and accessible name. */
  full: string;
};

export function fanoutTriggerSummary(
  names: readonly string[],
  visibleLimit = FANOUT_TRIGGER_NAME_LIMIT,
): FanoutTriggerSummary {
  const cleaned = names.map((name) => name.trim()).filter(Boolean);
  const visible = cleaned.slice(0, Math.max(1, visibleLimit));
  const overflow = Math.max(0, cleaned.length - visible.length);
  return {
    names: cleaned,
    visible,
    overflow,
    count: cleaned.length,
    short: overflow > 0 ? `${visible.join(" · ")} +${overflow}` : visible.join(" · "),
    full: cleaned.join(" · "),
  };
}

export type FanoutModelAvailability =
  | "available"
  | "provider-missing"
  | "provider-disabled"
  | "provider-unauthenticated"
  | "provider-not-ready"
  | "model-missing"
  | "model-disabled";

/**
 * Readiness mirrors provider selection plus the auth contract: a provider that is
 * explicitly signed out (or not installed) cannot join a stack, even if its
 * last native session snapshot still says ready.
 */
export function fanoutModelAvailability(
  provider: ProviderInstance | undefined,
  modelId: string,
): FanoutModelAvailability {
  if (!provider) return "provider-missing";
  if (!provider.enabled) return "provider-disabled";
  if (provider.authStatus === "unauthenticated" || provider.authStatus === "not-installed") {
    return "provider-unauthenticated";
  }
  if (!provider.nativeSessionReady) return "provider-not-ready";
  const model = provider.models.find(
    (entry) => entry.id === modelId || entry.aliases?.includes(modelId),
  );
  if (!model) return "model-missing";
  if (model.disabledReason) return "model-disabled";
  return "available";
}

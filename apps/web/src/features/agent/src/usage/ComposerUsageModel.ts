// Usage semantics adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.

export function isUsageLimitsCommand(text: string): boolean {
  return text.trim() === "/usage-limits";
}

export function consumeUsageLimitsCommand(composer: { getState(): { text: string }; setText(text: string): void }, openLimits: () => void): boolean {
  if (!isUsageLimitsCommand(composer.getState().text)) return false;
  composer.setText("");
  openLimits();
  return true;
}


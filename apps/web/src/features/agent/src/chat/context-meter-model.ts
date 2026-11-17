import type { ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";

export type ContextMeterState = {
  usedTokens: number;
  maxTokens?: number;
  percent?: number;
  model?: string;
  updatedAt: string;
};

/** Read-only projection of a saved thread usage snapshot; never invents a limit. */
export function contextMeterState(snapshot: ThreadUsageSnapshot | undefined): ContextMeterState | undefined {
  const context = snapshot?.context;
  if (!context) return undefined;
  const percent = context.maxTokens && context.maxTokens > 0
    ? Math.min(100, Math.max(0, (context.usedTokens / context.maxTokens) * 100))
    : undefined;
  return { usedTokens: context.usedTokens, maxTokens: context.maxTokens, percent, model: context.model, updatedAt: context.updatedAt };
}

export function formatContextTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatContextPercent(percent: number | undefined): string | undefined {
  if (percent === undefined) return undefined;
  return `${percent < 10 ? percent.toFixed(1).replace(/\.0$/u, "") : Math.round(percent)}%`;
}

import type { ReportedTurnUsage } from "@agent-workspace/contracts/usage";

export const reportedCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Accumulate disjoint native calls without inventing missing counters. */
export class ReportedTurnAccumulator {
  private value: ReportedTurnUsage | undefined;
  private incomplete = false;

  add(input: unknown, output: unknown, cached: unknown, write: unknown, reasoning: unknown): ReportedTurnUsage | undefined {
    if (this.incomplete) return;
    if (!reportedCount(input) || !reportedCount(output)) { this.incomplete = true; return; }
    const previous = this.value;
    const inputTokens = (previous?.inputTokens ?? 0) + input;
    const outputTokens = (previous?.outputTokens ?? 0) + output;
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) { this.incomplete = true; return; }
    const optional = (before: number | undefined, next: unknown): number | undefined => {
      if (!reportedCount(next) || (previous && before === undefined)) return;
      const sum = (before ?? 0) + next;
      return Number.isSafeInteger(sum) ? sum : undefined;
    };
    const cachedInputTokens = optional(previous?.cachedInputTokens, cached);
    const cacheCreationTokens = optional(previous?.cacheCreationTokens, write);
    const reasoningTokens = optional(previous?.reasoningTokens, reasoning);
    this.value = { inputTokens, outputTokens,
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}) };
    return this.value;
  }
}

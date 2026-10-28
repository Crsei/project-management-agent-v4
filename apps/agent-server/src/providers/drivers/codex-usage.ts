// Adapted from t3code CodexTurnTokenUsage.ts and codexUsageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { NativeUsageUpdate, ServerProviderUsageWindow, UsageTokenTotals } from "@agent-workspace/contracts/usage";
import { object } from "./codex-rpc.ts";

type Breakdown = { input: number; cached: number; write: number; output: number; reasoning: number };
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function breakdown(value: unknown): Breakdown | undefined {
  const data = object(value);
  const { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning } = data;
  const write = data.cacheWriteInputTokens;
  if (!count(input) || !count(cached) || !count(write) || !count(output) || !count(reasoning) || cached + write > input || reasoning > output) return undefined;
  return { input, cached, write, output, reasoning };
}
const keys = ["input", "cached", "write", "output", "reasoning"] as const;
type Reported = NonNullable<NativeUsageUpdate["reportedTurn"]>;
const reportedOptionalKeys = ["cachedInputTokens", "cacheCreationTokens", "reasoningTokens"] as const;
function reported(value: unknown): Reported | undefined {
  const data = object(value);
  if (!count(data.inputTokens) || !count(data.outputTokens)) return undefined;
  return {
    inputTokens: data.inputTokens, outputTokens: data.outputTokens,
    ...(count(data.cachedInputTokens) ? { cachedInputTokens: data.cachedInputTokens } : {}),
    ...(count(data.cacheWriteInputTokens) ? { cacheCreationTokens: data.cacheWriteInputTokens } : {}),
    ...(count(data.reasoningOutputTokens) ? { reasoningTokens: data.reasoningOutputTokens } : {}),
  };
}

export class CodexUsage {
  private baseline?: Breakdown;
  private accumulated: Breakdown = { input: 0, cached: 0, write: 0, output: 0, reasoning: 0 };
  private reportedBaseline?: Reported;
  private reportedAccumulated?: Reported;
  constructor(model: string) { this.model = model; }
  private model: string;

  update(value: unknown): NativeUsageUpdate | undefined {
    const usage = object(value);
    const last = breakdown(usage.last);
    const total = breakdown(usage.total);
    const update: NativeUsageUpdate = {};
    const reportedLast = reported(usage.last);
    const reportedTotal = reported(usage.total);
    if (reportedLast && reportedTotal) {
      const previous = this.reportedBaseline;
      const monotonic = previous && reportedTotal.inputTokens >= previous.inputTokens && reportedTotal.outputTokens >= previous.outputTokens;
      const delta: Reported = monotonic
        ? { inputTokens: reportedTotal.inputTokens - previous.inputTokens, outputTokens: reportedTotal.outputTokens - previous.outputTokens }
        : { inputTokens: reportedLast.inputTokens, outputTokens: reportedLast.outputTokens };
      for (const key of reportedOptionalKeys) {
        if (monotonic) {
          const current = reportedTotal[key], before = previous[key];
          if (current !== undefined && before !== undefined && current >= before) delta[key] = current - before;
        } else if (reportedLast[key] !== undefined) {
          delta[key] = reportedLast[key];
        }
      }
      this.reportedBaseline = reportedTotal;
      const accumulated = this.reportedAccumulated;
      const inputTokens = (accumulated?.inputTokens ?? 0) + delta.inputTokens;
      const outputTokens = (accumulated?.outputTokens ?? 0) + delta.outputTokens;
      if (Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)) {
        const next: Reported = { inputTokens, outputTokens };
        for (const key of reportedOptionalKeys) {
          const value = delta[key], before = accumulated?.[key];
          if (value !== undefined && (!accumulated || before !== undefined) && Number.isSafeInteger((before ?? 0) + value)) next[key] = (before ?? 0) + value;
        }
        this.reportedAccumulated = next;
        update.reportedTurn = next;
      }
    }
    if (last && total) {
      const previous = this.baseline;
      const delta: Breakdown = previous && keys.every((key) => total[key] >= previous[key])
        ? { input: total.input - previous.input, cached: total.cached - previous.cached, write: total.write - previous.write, output: total.output - previous.output, reasoning: total.reasoning - previous.reasoning }
        : last;
      this.baseline = total;
      if (delta.cached + delta.write <= delta.input && delta.reasoning <= delta.output && keys.every((key) => Number.isSafeInteger(this.accumulated[key] + delta[key]))) {
        for (const key of keys) this.accumulated[key] += delta[key];
        const a = this.accumulated;
        const totals: UsageTokenTotals = { uncachedInputTokens: a.input - a.cached - a.write, cachedInputTokens: a.cached, cacheCreationTokens: a.write, outputTokens: a.output, reasoningTokens: a.reasoning };
        update.turn = { totals, model: this.model };
      }
    }
    const lastData = object(usage.last);
    if (count(lastData.totalTokens)) {
      update.context = { usedTokens: lastData.totalTokens, updatedAt: new Date().toISOString(), model: this.model, ...(count(usage.modelContextWindow) && usage.modelContextWindow > 0 ? { maxTokens: usage.modelContextWindow } : {}) };
    }
    return update.turn || update.reportedTurn || update.context ? update : undefined;
  }
}

function epoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}
export function codexLimitUpdate(value: unknown): NativeUsageUpdate | undefined {
  const snapshot = object(value);
  if (typeof snapshot.limitId === "string" && snapshot.limitId && snapshot.limitId !== "codex") return undefined;
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const data = object(snapshot[id]);
    if (typeof data.usedPercent !== "number" || !Number.isFinite(data.usedPercent)) continue;
    const duration = count(data.windowDurationMins) ? data.windowDurationMins : undefined;
    const kind = duration !== undefined ? duration >= 43200 ? "monthly" : duration >= 10080 ? "weekly" : "session" : id === "secondary" ? "weekly" : snapshot.planType === "free" || snapshot.planType === "go" ? "monthly" : "session";
    const resetsAt = epoch(data.resetsAt);
    windows.push({ id, kind, label: kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session", usedPercent: Math.max(0, Math.min(100, data.usedPercent)), ...(duration !== undefined ? { windowDurationMins: duration } : {}), ...(resetsAt ? { resetsAt } : {}) });
  }
  const individual = object(snapshot.individualLimit);
  if (typeof individual.remainingPercent === "number" && Number.isFinite(individual.remainingPercent)) {
    const resetsAt = epoch(individual.resetsAt);
    windows.push({ id: "individual", kind: "monthly", label: "Monthly credit limit", usedPercent: Math.max(0, Math.min(100, 100 - individual.remainingPercent)), ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows.length ? { limits: { windows } } : undefined;
}

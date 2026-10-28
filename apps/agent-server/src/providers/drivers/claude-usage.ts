// Adapted from t3code ClaudeAdapterV2.ts and claudeUsageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ContextWindowUsage, NativeUsageUpdate, UsageTokenTotals } from "@agent-workspace/contracts/usage";
import { object } from "./codex-rpc.ts";

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function usageTotals(value: unknown): UsageTokenTotals | undefined {
  const usage = object(value);
  if (!count(usage.input_tokens) || !count(usage.output_tokens)) return undefined;
  const cached = usage.cache_read_input_tokens;
  const creation = usage.cache_creation_input_tokens;
  if (!count(cached) || !count(creation)) return undefined;
  return { uncachedInputTokens: usage.input_tokens, cachedInputTokens: cached, cacheCreationTokens: creation, outputTokens: usage.output_tokens, reasoningTokens: 0 };
}
type Reported = NonNullable<NativeUsageUpdate["reportedTurn"]>;
function reportedUsage(value: unknown): Reported | undefined {
  const usage = object(value);
  if (!count(usage.input_tokens) || !count(usage.output_tokens)) return undefined;
  return {
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    ...(count(usage.cache_read_input_tokens) ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
    ...(count(usage.cache_creation_input_tokens) ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
  };
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}
export function claudeLimitUpdate(value: unknown): NativeUsageUpdate | undefined {
  const info = object(value);
  if ((info.rateLimitType !== "five_hour" && info.rateLimitType !== "seven_day") || typeof info.utilization !== "number" || !Number.isFinite(info.utilization)) return undefined;
  const session = info.rateLimitType === "five_hour";
  const resetsAt = timestamp(info.resetsAt);
  return { limits: { windows: [{ id: info.rateLimitType, kind: session ? "session" : "weekly", label: session ? "Session" : "Weekly", windowDurationMins: session ? 300 : 10080, usedPercent: Math.max(0, Math.min(100, info.utilization * 100)), ...(resetsAt ? { resetsAt } : {}) }] } };
}

export class ClaudeUsage {
  private streamId?: string;
  private streamUsage?: Record<string, unknown>;
  private context?: ContextWindowUsage;
  private model?: string;
  private messages = new Map<string, { totals: UsageTokenTotals; model?: string }>();
  private reportedMessages = new Map<string, Reported | undefined>();

  private assistantReported(id: unknown, value: unknown): Reported | undefined {
    if (typeof id !== "string" || !id) return undefined;
    this.reportedMessages.set(id, reportedUsage(value));
    const sum: Reported = { inputTokens: 0, outputTokens: 0 };
    let cached = 0, creation = 0, allCached = true, allCreation = true;
    for (const item of this.reportedMessages.values()) {
      if (!item) return undefined;
      sum.inputTokens += item.inputTokens;
      sum.outputTokens += item.outputTokens;
      if (!Number.isSafeInteger(sum.inputTokens) || !Number.isSafeInteger(sum.outputTokens)) return undefined;
      if (item.cachedInputTokens === undefined) allCached = false;
      else cached += item.cachedInputTokens;
      if (item.cacheCreationTokens === undefined) allCreation = false;
      else creation += item.cacheCreationTokens;
    }
    if (allCached && Number.isSafeInteger(cached)) sum.cachedInputTokens = cached;
    if (allCreation && Number.isSafeInteger(creation)) sum.cacheCreationTokens = creation;
    return sum;
  }

  private streamUpdate(model?: string): NativeUsageUpdate | undefined {
    const reportedTurn = this.assistantReported(this.streamId, this.streamUsage);
    const context = this.fromUsage(this.streamUsage, model)?.context;
    return reportedTurn || context ? { ...(reportedTurn ? { reportedTurn } : {}), ...(context ? { context } : {}) } : undefined;
  }

  private assistantTurn(inner: Record<string, unknown>): NativeUsageUpdate["turn"] {
    const totals = usageTotals(inner.usage);
    if (typeof inner.id !== "string" || !inner.id || !totals || inner.model === "<synthetic>") return undefined;
    const model = typeof inner.model === "string" && inner.model ? inner.model : undefined;
    this.messages.set(inner.id, { totals, ...(model ? { model } : {}) });
    const sum: UsageTokenTotals = { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const models = new Set<string>();
    let allModelsKnown = true;
    for (const item of this.messages.values()) {
      for (const key of Object.keys(sum) as (keyof UsageTokenTotals)[]) {
        sum[key] += item.totals[key];
        if (!Number.isSafeInteger(sum[key])) return undefined;
      }
      if (item.model) models.add(item.model); else allModelsKnown = false;
    }
    const onlyModel = allModelsKnown && models.size === 1 ? models.values().next().value : undefined;
    return { totals: sum, ...(onlyModel ? { model: onlyModel } : {}) };
  }

  private fromUsage(value: unknown, model?: string): NativeUsageUpdate | undefined {
    const totals = usageTotals(value);
    if (!totals) return undefined;
    const usedTokens = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens;
    if (!Number.isSafeInteger(usedTokens)) return undefined;
    if (model && model !== "<synthetic>") this.model = model;
    const creation = object(object(value).cache_creation);
    const ttl = count(creation.ephemeral_1h_input_tokens) && creation.ephemeral_1h_input_tokens > 0 ? 3600000 : count(creation.ephemeral_5m_input_tokens) && creation.ephemeral_5m_input_tokens > 0 ? 300000 : undefined;
    this.context = { usedTokens, updatedAt: new Date().toISOString(), ...(this.model ? { model: this.model } : {}), ...(ttl ? { promptCacheTtlMs: ttl } : {}) };
    return { context: this.context };
  }

  update(value: unknown): NativeUsageUpdate | undefined {
    const message = object(value);
    if (message.type === "rate_limit_event") return claudeLimitUpdate(message.rate_limit_info);
    if (message.type === "system" && message.subtype === "compact_boundary") {
      this.streamUsage = undefined;
      const tokens = object(message.compact_metadata).post_tokens;
      if (!count(tokens)) return undefined;
      this.context = { usedTokens: tokens, updatedAt: new Date().toISOString(), ...(this.model ? { model: this.model } : {}) };
      return { context: this.context };
    }
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = object(message.event);
      if (event.type === "message_start") {
        const inner = object(event.message);
        this.streamId = typeof inner.id === "string" ? inner.id : undefined;
        this.streamUsage = inner.model !== "<synthetic>" && inner.usage && typeof inner.usage === "object" ? { ...object(inner.usage) } : undefined;
        if (this.streamUsage) return this.streamUpdate(typeof inner.model === "string" ? inner.model : undefined);
      } else if (event.type === "message_delta" && this.streamUsage) {
        const delta = object(event.usage);
        for (const [key, val] of Object.entries(delta)) if (val !== null && val !== undefined) this.streamUsage[key] = val;
        return this.streamUpdate();
      }
    }
    if (message.type === "assistant") {
      const inner = object(message.message);
      if (inner.model === "<synthetic>") return undefined;
      const turn = this.assistantTurn(inner);
      const reportedTurn = this.assistantReported(inner.id, inner.usage);
      if (message.parent_tool_use_id) return turn || reportedTurn ? { ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) } : undefined;
      if (typeof inner.id === "string" && inner.id === this.streamId) {
        // A compact boundary invalidates later snapshots of the old request.
        if (!this.streamUsage) return turn || reportedTurn ? { ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) } : undefined;
        const old = usageTotals(this.streamUsage);
        const next = usageTotals(inner.usage);
        if (!next || (old && old.uncachedInputTokens + old.cachedInputTokens + old.cacheCreationTokens > 0)) return turn || reportedTurn ? { ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) } : undefined;
      }
      this.streamId = typeof inner.id === "string" ? inner.id : undefined;
      this.streamUsage = inner.usage && typeof inner.usage === "object" ? { ...object(inner.usage) } : undefined;
      const context = this.fromUsage(inner.usage, typeof inner.model === "string" ? inner.model : undefined)?.context;
      return turn || reportedTurn || context ? { ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}), ...(context ? { context } : {}) } : undefined;
    }
    if (message.type === "result") {
      const totals = usageTotals(message.usage);
      const result: NativeUsageUpdate = {};
      const reportedTurn = reportedUsage(message.usage);
      if (reportedTurn) result.reportedTurn = reportedTurn;
      if (totals) {
        const cost = message.total_cost_usd;
        const models = Object.keys(object(message.modelUsage));
        const speed = object(message.usage).speed;
        result.turn = { totals, ...(this.model && models.length === 1 && models[0] === this.model ? { model: this.model } : {}), ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}), ...(speed === "fast" || speed === "standard" ? { speed } : {}) };
      }
      if (this.context && this.model) {
        const modelUsage = object(object(message.modelUsage)[this.model]);
        if (count(modelUsage.contextWindow) && modelUsage.contextWindow > 0) {
          this.context = { ...this.context, maxTokens: modelUsage.contextWindow, updatedAt: new Date().toISOString() };
          result.context = this.context;
        }
      }
      return result.turn || result.reportedTurn || result.context ? result : undefined;
    }
    return undefined;
  }
}

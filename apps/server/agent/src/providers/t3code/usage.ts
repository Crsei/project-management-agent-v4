import type { OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, ServerProvider } from "@t3tools/contracts";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import type { PmProviderLease } from "./contract.ts";
export type { ProviderUsageReader } from "@t3tools/provider-core/server/usage";

/** Context snapshots are cumulative, never billable turn counters. */
export function pmThreadUsage(thread: OrchestrationV2ProviderThread, updatedAt: string, model: string): NativeUsageUpdate | undefined {
  const value = thread.contextUsage;
  if (!value) return undefined;
  return { context: { usedTokens: value.usedTokens, ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    ...(value.autoCompactThreshold === undefined ? {} : { autoCompactThreshold: value.autoCompactThreshold }), updatedAt, model } };
}

export function pmTurnUsage(turn: OrchestrationV2ProviderTurn, model: string): NativeUsageUpdate | undefined {
  const actual = turn.turnTokenUsage;
  const context = turn.tokenUsage;
  const update: NativeUsageUpdate = {};
  if (actual?.inputTokens !== undefined && actual.outputTokens !== undefined) {
    const cached = actual.cachedInputTokens;
    const created = actual.cacheCreationTokens;
    if (actual.usageStatus === "complete" && cached !== undefined && created !== undefined && actual.reasoningTokens !== undefined
      && cached + created <= actual.inputTokens && actual.reasoningTokens <= actual.outputTokens) {
      update.turn = { model, totals: { uncachedInputTokens: actual.inputTokens - cached - created,
        cachedInputTokens: cached, cacheCreationTokens: created, outputTokens: actual.outputTokens,
        reasoningTokens: actual.reasoningTokens } };
    } else {
      update.reportedTurn = { inputTokens: actual.inputTokens, outputTokens: actual.outputTokens,
        ...(actual.cachedInputTokens === undefined ? {} : { cachedInputTokens: actual.cachedInputTokens }),
        ...(actual.cacheCreationTokens === undefined ? {} : { cacheCreationTokens: actual.cacheCreationTokens }),
        ...(actual.reasoningTokens === undefined ? {} : { reasoningTokens: actual.reasoningTokens }) };
    }
  }
  if (context) update.context = { usedTokens: context.usedTokens, updatedAt: context.updatedAt, model,
    ...(context.maxTokens == null ? {} : { maxTokens: context.maxTokens }),
    ...(context.autoCompactThreshold === undefined ? {} : { autoCompactThreshold: context.autoCompactThreshold }),
    ...(context.promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs: context.promptCacheTtlMs }) };
  return Object.keys(update).length ? update : undefined;
}

/** Original adapters update their own snapshot; this forwards real windows without a second probe. */
export function makePmUsageUpdates(lease: PmProviderLease) {
  return Effect.gen(function* () {
    const updates = yield* Queue.unbounded<NativeUsageUpdate, unknown>();
    let lastLimits: ServerProvider["usageLimits"];
    let lastCheckedAt = -Infinity;
    const offer = (snapshot: ServerProvider) => Effect.gen(function* () {
      yield* lease.assertCurrent;
      const limits = snapshot.usageLimits;
      if (!limits || limits === lastLimits || !limits.windows.length) return;
      const checkedAt = Date.parse(limits.checkedAt);
      if (checkedAt < lastCheckedAt) return;
      lastLimits = limits;
      lastCheckedAt = checkedAt;
      yield* Queue.offer(updates, { limits: { windows: limits.windows.map((window) => ({ ...window })) } });
    });
    // Subscribe before reading the current snapshot or opening the native session.
    yield* Stream.runForEach(lease.instance.snapshot.streamChanges, offer).pipe(
      Effect.catchCause((cause) => Queue.fail(updates, Cause.squash(cause))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* offer(yield* lease.instance.snapshot.getSnapshot);
    return Stream.fromQueue(updates);
  });
}

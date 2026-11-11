import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderDriverKind, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { CodexAppServerClientFactory, layerAppServerClientFactory } from "../../../../../../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts";

type ItemEvidence = Pick<NativeOutputItem, "phase" | "startedAt" | "completedAt">;
type ActivityEvidence = {
  items: Map<string, ItemEvidence>;
  parts: Map<string, NonNullable<NativeOutputItem["reasoningPart"]>>;
};
const sessions = new Map<string, ActivityEvidence>();
const timestamp = (value: number): string | undefined => {
  const date = new Date(value);
  return Number.isFinite(value) && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
};

/** Read only explicit native evidence captured before the original adapter's handlers.
 * No raw event log, protocol adapter, native state or credentials are persisted here. */
export function readPmCodexActivity(providerSessionId: string, item: OrchestrationV2TurnItem): Partial<NativeOutputItem> {
  const evidence = sessions.get(providerSessionId);
  const nativeId = item.nativeItemRef?.nativeId;
  const native = nativeId ? evidence?.items.get(nativeId) : undefined;
  const part = evidence?.parts.get(item.id);
  const providerTiming = native?.startedAt && (item.completedAt === null || native.completedAt);
  return {
    ...(item.type === "assistant_message" && native?.phase ? { phase: native.phase } : {}),
    ...(item.type === "reasoning" && part ? { reasoningPart: part } : {}),
    ...(native?.startedAt ? { startedAt: native.startedAt } : {}),
    ...(native?.completedAt ? { completedAt: native.completedAt } : {}),
    timing: { source: providerTiming ? "provider" : "observed" },
  };
}

/** Decorate the existing injection seam; the original client owns decoding, dispatch,
 * backpressure, authorization and termination. These handlers keep metadata only. */
export const pmCodexActivityClientLayer = Layer.effect(CodexAppServerClientFactory, Effect.gen(function* () {
  const factory = yield* CodexAppServerClientFactory;
  const allocator = yield* IdAllocatorV2;
  return CodexAppServerClientFactory.of({
    open: input => Effect.gen(function* () {
      const client = yield* factory.open(input);
      const evidence: ActivityEvidence = { items: new Map(), parts: new Map() };
      sessions.set(input.providerSessionId, evidence);
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        if (sessions.get(input.providerSessionId) === evidence) sessions.delete(input.providerSessionId);
      }));
      const recordPart = (turnId: string, nativeItemId: string, stream: "summary" | "content", index: number) => {
        const nativePartId = JSON.stringify([turnId, nativeItemId, stream, index]);
        const id = allocator.derive.turnItemFromProviderItem({ driver: ProviderDriverKind.make("codex"), nativeItemId: nativePartId });
        evidence.parts.set(id, { kind: stream === "summary" ? "summary" : "text", index });
      };
      yield* client.handleServerNotification("item/started", payload => Effect.sync(() => {
        const previous = evidence.items.get(payload.item.id);
        evidence.items.set(payload.item.id, {
          ...previous, startedAt: timestamp(payload.startedAtMs),
          ...(payload.item.type === "agentMessage" && (payload.item.phase === "commentary" || payload.item.phase === "final_answer")
            ? { phase: payload.item.phase } : {}),
        });
      }));
      yield* client.handleServerNotification("item/completed", payload => Effect.sync(() => {
        const previous = evidence.items.get(payload.item.id);
        evidence.items.set(payload.item.id, {
          ...previous, completedAt: timestamp(payload.completedAtMs),
          ...(payload.item.type === "agentMessage" && (payload.item.phase === "commentary" || payload.item.phase === "final_answer")
            ? { phase: payload.item.phase } : {}),
        });
        if (payload.item.type === "reasoning") {
          for (const [index] of (payload.item.summary ?? []).entries()) recordPart(payload.turnId, payload.item.id, "summary", index);
          for (const [index] of (payload.item.content ?? []).entries()) recordPart(payload.turnId, payload.item.id, "content", index);
        }
      }));
      yield* client.handleServerNotification("item/reasoning/summaryTextDelta", payload => Effect.sync(() => {
        recordPart(payload.turnId, payload.itemId, "summary", payload.summaryIndex);
      }));
      yield* client.handleServerNotification("item/reasoning/textDelta", payload => Effect.sync(() => {
        recordPart(payload.turnId, payload.itemId, "content", payload.contentIndex);
      }));
      return client;
    }),
  });
})).pipe(Layer.provide(layerAppServerClientFactory));

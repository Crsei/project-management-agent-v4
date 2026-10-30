import type { UsageSpeed } from "@t3tools/provider-core/server/usage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { resolveCodexLaunchServiceTiers } from "../../../usage/service-tiers.ts";

export interface CodexUsageHistoryRequest {
  readonly sessionId: string;
  readonly nativeTurnId: string;
  readonly model: string;
}

export class CodexUsageHistoryReadError extends Schema.TaggedError<CodexUsageHistoryReadError>()(
  "CodexUsageHistoryReadError",
  { requestedTurnCount: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string { return "Could not read historical Codex usage tiers."; }
}

export class CodexUsageHistory extends Context.Service<CodexUsageHistory, {
  readonly resolve: (requests: readonly CodexUsageHistoryRequest[]) => Effect.Effect<
    ReadonlyMap<CodexUsageHistoryRequest, UsageSpeed>, CodexUsageHistoryReadError
  >;
}>()("pm/provider-host/CodexUsageHistory") {}

/** Reuses the PM launch ledger; never opens the upstream application's database. */
export function makePmCodexUsageHistoryLayer(instanceId: string): Layer.Layer<CodexUsageHistory> {
  return Layer.succeed(CodexUsageHistory, {
    resolve: requests => Effect.try({
      try: () => resolveCodexLaunchServiceTiers(instanceId, requests),
      catch: cause => new CodexUsageHistoryReadError({ requestedTurnCount: requests.length, cause }),
    }),
  });
}

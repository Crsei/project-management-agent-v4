import { createHash } from "node:crypto";
import type { ProviderConsumeResetCreditResult, ServerProviderUsageLimits } from "@agent-workspace/contracts/usage";
import { usageLimitsIdentityChanged } from "@agent-workspace/contracts/usage-limits";
import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { readProviderUsageProbe } from "@t3tools/provider-core/server/managedProvider";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { sanitizeProviderMessage } from "../../providers/catalog.ts";
import { providerContext, type StoredProviderInstance } from "../../providers/instances.ts";
import { getPmProviderApplication } from "../../providers/t3code/application-access.ts";

const unavailable = (reason: "unsupported" | "probeFailed"): ServerProviderUsageLimits => ({
  checkedAt: new Date().toISOString(), windows: [], unavailable: { reason },
});

/** Only the DTO boundary is local; native probes, parsing and credit requests belong to the original instance. */
function projectLimits(driver: StoredProviderInstance["driver"], snapshot: ServerProvider): ServerProviderUsageLimits {
  const native = snapshot.usageLimits;
  const probe = readProviderUsageProbe(snapshot);
  const id = driver === "codex" ? snapshot.auth.workspaceId : undefined;
  const workspaceId = driver === "claude" ? snapshot.auth.workspaceId : undefined;
  const email = snapshot.auth.email;
  const identity = id ?? workspaceId ?? (driver === "grok" ? email : undefined);
  const credentialFingerprint = native?.credentialFingerprint ?? (identity
    ? `${driver}:${createHash("sha256").update(identity.trim().toLowerCase()).digest("hex")}` : undefined);
  return {
    ...(native ?? unavailable("unsupported")),
    // Source collections are readonly; the existing public DTO owns a mutable array.
    windows: native ? [...native.windows] : [],
    ...(probe?.limits?.unavailable?.reason === "probeFailed"
      ? { lastProbeAt: probe.checkedAt, unavailable: { reason: "probeFailed" as const,
        message: probe.limits.unavailable.message ?? "The latest original quota probe failed; retained windows are not a fresh balance." } } : {}),
    ...(id || workspaceId || email ? { account: {
      ...(id ? { id } : {}), ...(workspaceId ? { workspaceId } : {}), ...(email ? { email } : {}),
    } } : {}),
    ...(credentialFingerprint ? { credentialFingerprint } : {}),
  };
}

function identityChanged(expected: ServerProviderUsageLimits, current: ServerProviderUsageLimits): boolean {
  return usageLimitsIdentityChanged(expected, current)
    || expected.credentialFingerprint !== undefined && expected.credentialFingerprint !== current.credentialFingerprint
    || expected.account?.id !== undefined && expected.account.id !== current.account?.id
    || expected.account?.workspaceId !== undefined && expected.account.workspaceId !== current.account?.workspaceId
    || expected.account?.email !== undefined && expected.account.email.trim().toLowerCase() !== current.account?.email?.trim().toLowerCase();
}

export async function probeCoreUsageLimits(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits> {
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const lease = yield* getPmProviderApplication().host.acquire(providerContext(instance), "status");
      yield* lease.assertCurrent;
      const snapshot = yield* lease.instance.snapshot.refresh;
      yield* lease.assertCurrent;
      return projectLimits(instance.driver, snapshot);
    })), { signal });
  } catch { return unavailable("probeFailed"); }
}

export async function consumeCoreResetCredit(instance: StoredProviderInstance, signal?: AbortSignal, expected?: ServerProviderUsageLimits): Promise<ProviderConsumeResetCreditResult> {
  if (instance.driver !== "codex" && instance.driver !== "claude") throw new Error("This provider does not support reset credits.");
  const result = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      // Redemption mutates an account: take the host's exclusive mutation lease,
      // not an execution/usage lease. limits.ts still owns per-app request ordering.
      const lease = yield* getPmProviderApplication().host.acquire(providerContext(instance), "auth");
      const consume = lease.instance.consumeResetCredit;
      if (!consume) return yield* Effect.fail(new Error("This provider does not support reset credits."));
      yield* lease.assertCurrent;
      let snapshot = yield* lease.instance.snapshot.refresh;
      yield* lease.assertCurrent;
      if (lease.instance.invalidateCaches) {
        // Finish any source-owned initial probe before clearing its metadata
        // cache; otherwise that probe could repopulate it behind invalidation.
        yield* lease.instance.invalidateCaches;
        yield* lease.assertCurrent;
        snapshot = yield* lease.instance.snapshot.refresh;
        yield* lease.assertCurrent;
      }
      const current = projectLimits(instance.driver, snapshot);
      const probe = readProviderUsageProbe(snapshot);
      if (snapshot.auth.status !== "authenticated" || current.unavailable
        // The source keeps last-good bars after a failed probe. Those remain
        // displayable, but cannot establish the current account for a mutation.
        || !probe?.limits || probe.limits.unavailable
        || !(current.account?.id || current.account?.workspaceId || current.account?.email)
        || expected && identityChanged(expected, current))
        return yield* Effect.fail(new Error("Provider account is unavailable or changed; refresh before redeeming."));
      // The source coordinator owns account serialization and pending idempotency
      // keys; the source method also owns post-redemption quota confirmation.
      yield* lease.assertCurrent;
      const outcome = yield* consume();
      yield* lease.assertCurrent;
      return { outcome };
    })), { signal });
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause);
    // Retain the source's distinction between an unanswered redemption and an
    // applied reset whose replacement quota could not be confirmed.
    const detail = error instanceof ProviderDriverError ? sanitizeProviderMessage(instance, error.detail) : undefined;
    throw new Error(`Provider could not confirm the reset. ${detail ? `${detail} ` : ""}Check the account before trying again.`);
  }
  return result.value;
}

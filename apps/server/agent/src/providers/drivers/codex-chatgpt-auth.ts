import { ProviderSetupError, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";
import { makePmProviderPlatformLayer } from "../t3code/host-runtime.ts";
import { makePmProviderUpstreamServicesLayer } from "../t3code/host.ts";
import { makePmProviderAuthSessionInvalidation } from "../t3code/management.ts";
import { makeCodexChatGptAuth } from "../../../../../../vendor/t3code/apps/server/src/provider/CodexChatGptAuth.ts";

/** Profile API boundary only. The original controller owns locking, revocation and active credentials. */
export function codexProfiles(context: ProviderDriverContext) {
  const app = getPmProviderApplication();
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const lease = yield* app.host.acquire(context, "status");
    yield* lease.assertCurrent;
    const auth = yield* makeCodexChatGptAuth({ instanceId: ProviderInstanceId.make(context.instanceId) });
    return yield* auth.profiles;
  })).pipe(Effect.provide(makePmProviderUpstreamServicesLayer(context).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context))))));
}

async function mutateProfile(context: ProviderDriverContext, id: string, action: "select" | "remove") {
  const app = getPmProviderApplication();
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const lease = yield* app.host.acquire(context, "auth");
    yield* lease.assertCurrent;
    const auth = yield* makeCodexChatGptAuth({ instanceId: ProviderInstanceId.make(context.instanceId) });
    const stop = makePmProviderAuthSessionInvalidation(app.host).invalidateSessions({
      requestingInstanceId: lease.instance.instanceId, instanceId: lease.instance.instanceId,
      ...(lease.instance.auth?.credentialBinding ? { credentialBinding: lease.instance.auth.credentialBinding } : {}),
      isCurrent: lease.assertCurrent.pipe(Effect.as(true), Effect.mapError(cause => new ProviderSetupError({
        instanceId: lease.instance.instanceId, operation: "stopSessions", detail: "The managed Codex account changed.", cause,
      }))),
    });
    yield* action === "select" ? auth.selectProfile(id, stop) : auth.removeProfile(id, stop);
    return yield* auth.profiles;
  })).pipe(Effect.provide(makePmProviderUpstreamServicesLayer(context).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context))))));
}

export const selectCodexProfile = (context: ProviderDriverContext, id: string) => mutateProfile(context, id, "select");
export const removeCodexProfile = (context: ProviderDriverContext, id: string) => mutateProfile(context, id, "remove");

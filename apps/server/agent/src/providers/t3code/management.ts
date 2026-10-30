import { randomUUID } from "node:crypto";
import type { ProviderAuthInteraction, ProviderAuthMethod, ProviderCapabilities, ProviderDriver, ProviderModel } from "@agent-workspace/contracts/provider";
import { ProviderSetupError, type ProviderAuthState, type ServerProvider } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import type { NativeProviderAdapter, ProviderDriverContext, ProviderDriverStatus } from "../driver-adapter.ts";
import { authorizeProviderAuthSessionInvalidation, invalidateProviderResourcePeers, registerProviderResourceBindings } from "../auth.ts";
import { runProviderMaintenanceCommandWithSpawner } from "../../../../../../vendor/t3code/apps/server/src/provider/providerMaintenanceCommand.ts";
import type { PmProviderBoundaryError, PmProviderHostService, PmProviderLease } from "./contract.ts";
import { providerBoundaryError } from "./config-mapping.ts";
import { makePmProviderPlatformLayer } from "./host-runtime.ts";
import { getStoredInstance } from "../instances.ts";
import { ProviderAuthSessionInvalidation } from "../../../../../../vendor/t3code/apps/server/src/provider/ProviderAuthService.ts";

export type PmProviderInstallationMethods = {
  readonly [Action in "prepare" | "removeInstallation"]?: (
    context: ProviderDriverContext,
    signal?: AbortSignal,
    progress?: Parameters<NonNullable<NativeProviderAdapter["prepare"]>>[2],
    lease?: PmProviderLease,
  ) => Promise<{ message: string }>;
};
export type PmProviderManagement = Pick<NativeProviderAdapter, "check" | "authenticate" | "logout" | "prepare" | "update" | "removeInstallation">;
export type PmProviderCapabilitiesProjector = (input: {
  readonly context: ProviderDriverContext;
  readonly lease: PmProviderLease;
}) => Effect.Effect<ProviderCapabilities, PmProviderBoundaryError>;

export function projectProviderAuthMethods(methods: NonNullable<ProviderAuthState["methods"]>): ProviderAuthMethod[] {
  return methods.map(method => ({ id: method.id, name: method.name,
    ...(method.description ? { description: method.description } : {}),
    type: method.type === "agent" ? "browser" : method.type }));
}
export function projectProviderAuthInteraction(interaction: ProviderAuthState["interaction"]): ProviderAuthInteraction | null {
  if (!interaction) return null;
  switch (interaction.type) {
    case "deviceCode": return { type: "device-code", id: interaction.id, url: interaction.url, userCode: interaction.userCode };
    case "credentials": return { ...interaction, fields: interaction.fields.map(field => ({ ...field })) };
    case "terminal": return { type: "terminal", id: interaction.id, output: interaction.output };
    case "browser": return { ...interaction };
  }
}
export function projectProviderSnapshot(snapshot: ServerProvider, methods: ProviderAuthMethod[] = []): ProviderDriverStatus {
  const models: ProviderModel[] = snapshot.models.map(model => ({
    id: model.slug, label: model.name, source: model.isCustom ? "custom" : "discovered", temperature: false,
    ...(model.shortName ? { shortName: model.shortName } : {}),
    ...(model.badge ? { badge: model.badge } : {}),
    ...(model.subProvider ? { subProvider: model.subProvider } : {}),
    ...(model.capabilities?.optionDescriptors ? { capabilities: { optionDescriptors: model.capabilities.optionDescriptors.map(descriptor => {
      if (descriptor.type === "boolean") return { ...descriptor };
      const { options, promptInjectedValues, ...fields } = descriptor;
      return { ...fields, options: options.map(option => ({ ...option })),
        ...(promptInjectedValues ? { promptInjectedValues: [...promptInjectedValues] } : {}) };
    }) } } : {}),
    ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
    ...(model.isLegacy !== undefined ? { legacy: model.isLegacy } : {}),
    ...(model.aliases ? { aliases: [...model.aliases] } : {}),
  }));
  const advisory = snapshot.versionAdvisory;
  const version = snapshot.installedVersion ?? snapshot.version;
  return {
    installation: { status: snapshot.availability === "unavailable" ? "unknown" : snapshot.installed ? "installed" : "not-installed",
      checkedAt: snapshot.checkedAt, ...(version ? { version } : {}),
      ...(advisory ? { updateSupported: advisory.canUpdate, updateAvailable: advisory.status === "behind_latest",
        ...(advisory.latestVersion ? { latestVersion: advisory.latestVersion } : {}) } : {}),
      ...(snapshot.unavailableReason ? { error: snapshot.unavailableReason } : {}) },
    authentication: snapshot.auth.status, methods, models,
    nativeSessionReady: snapshot.availability !== "unavailable" && snapshot.installed && snapshot.status === "ready",
    canLogout: snapshot.auth.canLogout === true,
    ...(snapshot.auth.label ? { authLabel: snapshot.auth.label } : {}), ...(snapshot.auth.email ? { email: snapshot.auth.email } : {}),
    ...(snapshot.message ? { message: snapshot.message } : {}),
    // The original Codex accountProbeStatus emits ready+unknown only for an explicit requiresOpenaiAuth=false response.
    ...(snapshot.driver === "codex" && snapshot.status === "ready" && snapshot.auth.status === "unknown" ? { requiresOpenaiAuth: false } : {}),
    ...(snapshot.updateRequiredModels ? { updateRequiredModels: snapshot.updateRequiredModels.map(model => ({ id: model.slug, label: model.name, minVersion: model.minVersion })) } : {}),
  };
}

/** Actual PM session ownership boundary for both the source auth service and the current DTO façade. */
export function makePmProviderAuthSessionInvalidation(host: PmProviderHostService): ProviderAuthSessionInvalidation["Service"] {
  return {
    invalidateSessions: input => Effect.gen(function* () {
      const isCurrent = input.isCurrent.pipe(Effect.flatMap(current =>
        current || input.instanceId !== input.requestingInstanceId ? Effect.succeed(current)
          : Effect.fail(new ProviderSetupError({
              instanceId: input.requestingInstanceId, operation: "stopSessions",
              detail: "Provider account ownership changed before session invalidation.",
            }))));
      const fail = (cause: unknown) => new ProviderSetupError({
        instanceId: input.requestingInstanceId, operation: "stopSessions",
        detail: "Could not invalidate the current Provider account's owned sessions.", cause,
      });
      const authorize = Effect.try({
        try: () => authorizeProviderAuthSessionInvalidation(input.requestingInstanceId, input.instanceId, input.credentialBinding),
        catch: fail,
      });
      if (!(yield* authorize)) return;
      if (!(yield* isCurrent)) return;
      if (input.instanceId === input.requestingInstanceId) yield* Effect.try({
        try: () => invalidateProviderResourcePeers(input.requestingInstanceId),
        catch: fail,
      });
      if (!(yield* isCurrent) || !(yield* authorize)) return;
      yield* host.invalidate(input.instanceId).pipe(
        Effect.catchCause(cause => Effect.fail(fail(Cause.squash(cause)))),
      );
    }),
  };
}
export function makePmProviderAuthSessionInvalidationLayer(host: PmProviderHostService): Layer.Layer<ProviderAuthSessionInvalidation> {
  return Layer.succeed(ProviderAuthSessionInvalidation, makePmProviderAuthSessionInvalidation(host));
}

export function makePmProviderManagement(host: PmProviderHostService, options: {
  readonly installations?: ReadonlyMap<ProviderDriver, PmProviderInstallationMethods>;
  readonly capabilities?: ReadonlyMap<ProviderDriver, PmProviderCapabilitiesProjector>;
} = {}): PmProviderManagement {
  const sessionInvalidation = makePmProviderAuthSessionInvalidation(host);
  const stopSessions = (lease: PmProviderLease) => sessionInvalidation.invalidateSessions({
    requestingInstanceId: lease.instance.instanceId,
    instanceId: lease.instance.instanceId,
    ...(lease.instance.auth?.credentialBinding ? { credentialBinding: lease.instance.auth.credentialBinding } : {}),
    isCurrent: lease.assertCurrent.pipe(
      Effect.mapError(cause => new ProviderSetupError({
        instanceId: lease.instance.instanceId, operation: "stopSessions",
        detail: "Provider configuration changed before session invalidation.", cause,
      })),
      Effect.as(true),
    ),
  });
  const use = <A, E>(context: ProviderDriverContext, purpose: Parameters<PmProviderHostService["acquire"]>[1],
    task: (lease: PmProviderLease) => Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(host.acquire(context, purpose), task)), { signal });
  const runInstallation = async (action: keyof PmProviderInstallationMethods, context: ProviderDriverContext,
    signal?: AbortSignal, progress?: Parameters<NonNullable<NativeProviderAdapter["prepare"]>>[2]) => {
    const method = options.installations?.get(context.driver)?.[action];
    if (!method) throw providerBoundaryError("This Provider has no capability registered for this installation action.",
      action === "prepare" ? "unsupported_install" : "unsupported_remove", 409);
    const current = getStoredInstance(context.instanceId);
    // A provisional instance's real installation service owns provisioning locks; no account row exists yet.
    if (!current) return method(context, signal, progress);
    if (current.revision !== context.revision) throw providerBoundaryError("Provider configuration changed before installation.");
    return use(context, "maintenance", lease => Effect.gen(function* () {
      yield* lease.assertCurrent;
      yield* Effect.try({
        try: () => invalidateProviderResourcePeers(context.instanceId, true),
        catch: () => providerBoundaryError("Unable to invalidate shared Provider installation revisions.", "provider_configuration_changed", 409),
      });
      const result = yield* Effect.tryPromise({
        try: () => method(context, signal, progress, lease),
        catch: error => error instanceof Error ? error : providerBoundaryError("Provider installation failed.", "provider_installation_failed", 500),
      });
      yield* lease.assertCurrent;
      if (lease.instance.invalidateCaches) yield* lease.instance.invalidateCaches;
      return result;
    }), signal);
  };
  const authenticate: NativeProviderAdapter["authenticate"] = (context, authOptions) => use(context, "auth", lease => Effect.gen(function* () {
    const auth = lease.instance.auth;
    if (!auth) return yield* Effect.fail(providerBoundaryError("Authentication is managed externally for this Provider.", "unsupported_auth", 409));
    const owner = randomUUID();
    const finished = yield* Deferred.make<void, Error>();
    const responded = new Set<string>();
    let flowId: string | null = null;
    let terminal = false;
    let suppliedValues = false;
    let currentState: ProviderAuthState | undefined;
    const respond: (state: ProviderAuthState) => Effect.Effect<void, never, Scope.Scope> = state => Effect.gen(function* () {
      const interaction = state.interaction;
      if (!interaction || !state.flowId || responded.has(interaction.id)) return;
      responded.add(interaction.id);
      if (interaction.type === "deviceCode" || (interaction.type === "browser" && !interaction.requiresConsent && !interaction.acceptsCallback)) return;
      let input: string | undefined;
      if (interaction.type === "credentials" && authOptions.values && !suppliedValues) suppliedValues = true;
      else input = yield* Effect.tryPromise({ try: () => authOptions.readInput(), catch: error => error instanceof Error ? error : new Error("Provider authentication input failed.") });
      yield* lease.assertCurrent;
      if (interaction.type === "browser" && interaction.acceptsCallback && input && /^https?:\/\//i.test(input)) {
        yield* auth.complete(owner, { flowId: state.flowId, callbackUrl: input }); return;
      }
      if (!auth.respond) return yield* Effect.fail(providerBoundaryError("The source controller does not accept this authentication response.", "unsupported_auth_response", 409));
      if (interaction.type === "credentials") {
        let values: Record<string, string>;
        if (input === undefined) values = authOptions.values ?? {};
        else {
          const rawInput = input;
          const parsed: unknown = yield* Effect.try({ try: () => JSON.parse(rawInput), catch: () => providerBoundaryError("Invalid credential response JSON.", "invalid_auth_response", 400) });
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string"))
            return yield* Effect.fail(providerBoundaryError("Credential response values must be strings.", "invalid_auth_response", 400));
          values = Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)]));
        }
        yield* auth.respond(owner, { instanceId: lease.instance.instanceId, flowId: state.flowId, interactionId: interaction.id, response: { type: "credentials", values } });
      } else if (interaction.type === "terminal") {
        yield* auth.respond(owner, { instanceId: lease.instance.instanceId, flowId: state.flowId, interactionId: interaction.id, response: { type: "terminal", data: input ?? "" } });
        // Terminal interactions retain their ID across multiple input requests.
        responded.delete(interaction.id);
        if (currentState?.phase === "waiting" && currentState.interaction?.id === interaction.id)
          yield* respond(currentState).pipe(Effect.forkScoped);
      } else if (interaction.type === "browser") {
        const action = input === "accept" ? "accept" : input === "decline" ? "decline" : undefined;
        if (!action) return yield* Effect.fail(providerBoundaryError("Browser consent must explicitly accept or decline.", "invalid_auth_response", 400));
        yield* auth.respond(owner, { instanceId: lease.instance.instanceId, flowId: state.flowId, interactionId: interaction.id, response: { type: "browser", action } });
      }
    }).pipe(Effect.catchCause(cause => {
      const error = Cause.squash(cause);
      return Deferred.fail(finished, error instanceof Error ? error : new Error("Provider authentication response failed."));
    }), Effect.asVoid);
    const onState = (state: ProviderAuthState) => Effect.gen(function* () {
      currentState = state;
      if (state.flowId) flowId = state.flowId;
      if (state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled") terminal = true;
      yield* Effect.sync(() => authOptions.onUpdate({ phase: state.phase, interaction: projectProviderAuthInteraction(state.interaction),
        ...(state.message ? { message: state.message } : {}) }));
      if (state.phase === "succeeded") yield* Deferred.succeed(finished, undefined);
      else if (state.phase === "failed" || state.phase === "cancelled") yield* Deferred.fail(finished, providerBoundaryError(state.message ?? "Provider authentication did not complete.", "provider_auth_failed", 412));
      else if (state.phase === "waiting" && state.interaction) yield* respond(state).pipe(Effect.forkScoped);
    });
    // Pull the initial state before start: the controller subscription is actually acquired, not merely forked.
    const states = yield* Stream.toQueue(auth.subscribe(owner), { capacity: "unbounded" });
    yield* Queue.take(states).pipe(Effect.mapError(() => providerBoundaryError("Provider authentication stream ended before initialization.", "provider_auth_failed", 412)));
    const subscriber = yield* Stream.fromQueue(states).pipe(Stream.runForEach(onState), Effect.forkScoped);
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      if (!flowId || terminal) return;
      const latest = yield* Stream.runHead(auth.subscribe(owner));
      if (Option.isSome(latest) && latest.value.flowId === flowId
        && (latest.value.phase === "starting" || latest.value.phase === "waiting" || latest.value.phase === "verifying"))
        yield* auth.cancel(owner, flowId).pipe(Effect.orDie);
    }));
    const initial = yield* auth.start(owner, stopSessions(lease), authOptions.methodId);
    yield* onState(initial);
    yield* Effect.raceFirst(Deferred.await(finished), Fiber.join(subscriber).pipe(
      Effect.andThen(Effect.fail(new Error("Provider authentication stream ended before a terminal state."))),
    ));
    yield* lease.assertCurrent;
  }), authOptions.signal);
  return {
    check: (context, signal) => use(context, "status", lease => Effect.gen(function* () {
      const snapshot = yield* lease.instance.snapshot.refresh;
      const auth = lease.instance.auth;
      if (auth?.refreshMethods) yield* auth.refreshMethods;
      const state = auth ? yield* Stream.runHead(auth.subscribe(randomUUID())) : Option.none<ProviderAuthState>();
      const projector = options.capabilities?.get(context.driver);
      const capabilities = projector ? yield* projector({ context, lease }) : undefined;
      yield* lease.assertCurrent;
      return { ...projectProviderSnapshot(snapshot, Option.isSome(state) ? projectProviderAuthMethods(state.value.methods ?? []) : []),
        ...(capabilities ? { capabilities } : {}) };
    }), signal),
    authenticate,
    logout: (context, signal) => use(context, "auth", lease => Effect.gen(function* () {
      const auth = lease.instance.auth;
      if (!auth) return yield* Effect.fail(providerBoundaryError("This Provider has no application-managed logout.", "unsupported_logout", 409));
      const state = yield* auth.logout(stopSessions(lease));
      if (state.phase === "failed") return yield* Effect.fail(providerBoundaryError(state.message ?? "Provider logout failed.", "provider_logout_failed", 412));
      yield* lease.assertCurrent;
    }), signal),
    prepare: (context, signal, progress) => runInstallation("prepare", context, signal, progress),
    removeInstallation: (context, signal, progress) => runInstallation("removeInstallation", context, signal, progress),
    update: (context, signal, progress) => use(context, "maintenance", lease => Effect.gen(function* () {
      const capabilities = yield* lease.instance.snapshot.resolveMaintenance({ fresh: true });
      const action = capabilities.update;
      if (!action) return yield* Effect.fail(providerBoundaryError("The source installer has no proven update action.", "unsupported_update", 409));
      yield* Effect.try({ try: () => registerProviderResourceBindings(context.instanceId, ["maintenance:" + action.lockKey]), catch: () => providerBoundaryError("A shared Provider installation is busy.", "provider_busy", 409) });
      yield* lease.assertCurrent;
      yield* Effect.try({ try: () => invalidateProviderResourcePeers(context.instanceId, true), catch: () => providerBoundaryError("Unable to invalidate shared Provider installation revisions.", "provider_configuration_changed", 409) });
      const result = yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* runProviderMaintenanceCommandWithSpawner({ spawner, command: action.executable, args: action.args,
          ...(action.env === undefined ? {} : { env: action.env }), onProgress: line => Effect.sync(() => progress?.({ message: line })) });
      }).pipe(Effect.provide(makePmProviderPlatformLayer(context)));
      if (result.timedOut || result.exitCode !== 0) return yield* Effect.fail(providerBoundaryError("The source Provider update command did not succeed.", "provider_update_failed", 500));
      yield* lease.assertCurrent;
      if (lease.instance.invalidateCaches) yield* lease.instance.invalidateCaches;
      const refreshed = yield* lease.instance.snapshot.refresh;
      if (!refreshed.installed || refreshed.availability === "unavailable")
        return yield* Effect.fail(providerBoundaryError("The update command completed but native Provider installation was not confirmed.", "provider_update_failed", 412));
      return { message: "Provider update command completed and native status was refreshed." };
    }), signal),
  };
}

import { randomUUID } from "node:crypto";
import type { ProviderAuthInteraction, ProviderAuthMethod, ProviderCapabilities, ProviderDriver, ProviderModel, ProviderNativeConfigurationChange, ProviderSkillsSnapshot } from "@agent-workspace/contracts/provider";
import { PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS, ProviderSetupError, type ProviderAuthState, type ServerProvider } from "@t3tools/contracts";
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
import { getStoredInstance, providerDataDirectory } from "../instances.ts";
import { sanitizeProviderMessage } from "../catalog.ts";
import type { ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import { sameExecutionIdentity } from "../../durable/agent-execution.ts";
import { ProviderAuthSessionInvalidation } from "../../../../../../vendor/t3code/apps/server/src/provider/ProviderAuthService.ts";
import { listRecords, readRecord } from "../../durable/store.ts";
import type { ChatGeneration } from "../../durable/chat-runtime.ts";
import { liveOpenCodeInventory } from "../../../../../../vendor/t3code/packages/provider-opencode/src/server/liveWorkspace.ts";
import { livePiWorkspace } from "../../../../../../vendor/t3code/packages/provider-pi/src/server/liveWorkspace.ts";
import { liveAcpWorkspace } from "../../../../../../vendor/t3code/packages/provider-acp/src/server/liveWorkspace.ts";
import { normalizeAcpRegistryCommands } from "../../../../../../vendor/t3code/packages/provider-acp-registry/src/server/probe.ts";
import { closeMcpAppSessionsForInstance } from "../../mcp-apps/live.ts";

type SkillsInvalidator = (instanceIds: ReadonlySet<string>, change: ProviderNativeConfigurationChange) => void;
const skillsInvalidators = new Map<string, Set<SkillsInvalidator>>();

/** Configuration mutation only: no account revision, host invalidation, session close or native dispatch. */
export function invalidateProviderSkillsSnapshots(instanceIds: readonly string[], reason: string): ProviderNativeConfigurationChange {
  const change: ProviderNativeConfigurationChange = {
    changedAt: new Date().toISOString(), reason, reloadRequired: true, liveExecutionsPreserved: true,
  };
  const ids = new Set(instanceIds);
  for (const invalidate of skillsInvalidators.get(providerDataDirectory()) ?? []) invalidate(ids, change);
  return change;
}

export type PmProviderInstallationMethods = {
  readonly [Action in "prepare" | "removeInstallation"]?: (
    context: ProviderDriverContext,
    signal?: AbortSignal,
    progress?: Parameters<NonNullable<NativeProviderAdapter["prepare"]>>[2],
    lease?: PmProviderLease,
  ) => Promise<{ message: string }>;
};
export type PmProviderManagement = Pick<NativeProviderAdapter, "check" | "authenticate" | "logout" | "prepare" | "update" | "removeInstallation"> & {
  readonly shutdown: () => Promise<void>;
  readonly refreshSkills: (context: ProviderDriverContext, environment: ExecutionEnvironment, threadId?: string, fresh?: boolean, signal?: AbortSignal) => Promise<ProviderSkillsSnapshot>;
};
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
  const root = providerDataDirectory();
  const shutdownController = new AbortController();
  const admitted = new Set<Promise<unknown>>();
  // The scoped cache is private to this application lifetime and never reused across PM actors or scopes.
  const skillSnapshots = new Map<string, ProviderSkillsSnapshot>();
  const skillClaims = new Map<string, { instanceId: string }>();
  const skillChanges = new Map<string, ProviderNativeConfigurationChange>();
  const invalidateSkills: SkillsInvalidator = (instanceIds, change) => {
    for (const id of instanceIds) skillChanges.set(id, change);
    for (const [key, snapshot] of skillSnapshots) if (instanceIds.has(snapshot.instanceId)) skillSnapshots.delete(key);
    // An in-flight old scan must never repopulate a post-mutation cache.
    for (const [key, claim] of skillClaims) if (instanceIds.has(claim.instanceId)) skillClaims.delete(key);
  };
  const invalidators = skillsInvalidators.get(root) ?? new Set<SkillsInvalidator>();
  skillsInvalidators.set(root, invalidators);
  invalidators.add(invalidateSkills);
  let closing: Promise<void> | undefined;
  const runMaintenance = <A>(context: ProviderDriverContext, task: (signal: AbortSignal) => Promise<A>, signal?: AbortSignal): Promise<A> => {
    if (shutdownController.signal.aborted)
      return Promise.reject(providerBoundaryError("Provider application is not accepting maintenance.", "provider_host_closed", 503));
    if (providerDataDirectory() !== root)
      return Promise.reject(providerBoundaryError("Provider application data root changed before maintenance."));
    const lifetime = signal ? AbortSignal.any([signal, shutdownController.signal]) : shutdownController.signal;
    // Register synchronously, including provisional instances, before source dispatch can begin.
    const pending = Promise.resolve().then(async () => {
      lifetime.throwIfAborted();
      if (providerDataDirectory() !== root) throw providerBoundaryError("Provider application data root changed before maintenance.");
      if (getStoredInstance(context.instanceId)?.revision === context.revision)
        await closeMcpAppSessionsForInstance(context.instanceId);
      lifetime.throwIfAborted();
      return task(lifetime);
    });
    admitted.add(pending);
    const release = () => { admitted.delete(pending); };
    void pending.then(release, release);
    return pending;
  };
  const shutdown = () => {
    if (closing) return closing;
    // Individual callers retain their original result/error; shutdown owns settlement, not success.
    invalidators.delete(invalidateSkills);
    if (!invalidators.size) skillsInvalidators.delete(root);
    skillSnapshots.clear();
    skillClaims.clear();
    skillChanges.clear();
    closing = Promise.allSettled(admitted).then(() => undefined);
    shutdownController.abort(new Error("Provider application is shutting down."));
    return closing;
  };
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
  const runInstallation = (action: keyof PmProviderInstallationMethods, context: ProviderDriverContext,
    signal?: AbortSignal, progress?: Parameters<NonNullable<NativeProviderAdapter["prepare"]>>[2]) => runMaintenance(context, async lifetime => {
    const method = options.installations?.get(context.driver)?.[action];
    if (!method) throw providerBoundaryError("This Provider has no capability registered for this installation action.",
      action === "prepare" ? "unsupported_install" : "unsupported_remove", 409);
    const current = getStoredInstance(context.instanceId);
    // A provisional instance's real installation service owns provisioning locks; no account row exists yet.
    if (!current) return method(context, lifetime, progress);
    if (current.revision !== context.revision) throw providerBoundaryError("Provider configuration changed before installation.");
    return use(context, "maintenance", lease => Effect.gen(function* () {
      yield* lease.assertCurrent;
      yield* Effect.try({
        try: () => invalidateProviderResourcePeers(context.instanceId, true),
        catch: () => providerBoundaryError("Unable to invalidate shared Provider installation revisions.", "provider_configuration_changed", 409),
      });
      const result = yield* Effect.tryPromise({
        try: () => method(context, lifetime, progress, lease),
        catch: error => error instanceof Error ? error : providerBoundaryError("Provider installation failed.", "provider_installation_failed", 500),
      }).pipe(
        // The family receives the external abort signal and owns native cleanup.
        // Do not release this lease while its cancellation acknowledgement is still pending.
        Effect.uninterruptible,
      );
      yield* lease.assertCurrent;
      if (lease.instance.invalidateCaches) yield* lease.instance.invalidateCaches;
      return result;
    }), lifetime);
  }, signal);
  const authenticate: NativeProviderAdapter["authenticate"] = async (context, authOptions) => {
    if (getStoredInstance(context.instanceId)?.revision === context.revision)
      await closeMcpAppSessionsForInstance(context.instanceId);
    return use(context, "auth", lease => Effect.gen(function* () {
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
  };
  return {
    shutdown,
    refreshSkills: async (context, environment, threadId, fresh = false, signal) => {
      const key = JSON.stringify([context.instanceId, context.revision, context.cwd, environment, threadId ?? null]);
      const matchesExecution = (item: ChatGeneration) => (!threadId || item.threadId === threadId) &&
        item.status === "running" && item.providerInstanceId === context.instanceId &&
        item.providerInstanceRevision === context.revision && item.executionSnapshot?.path === context.cwd &&
        sameExecutionIdentity(item.executionSnapshot.environment, environment);
      const previous = skillSnapshots.get(key);
      const configurationChange = skillChanges.get(context.instanceId);
      const withConfiguration = (snapshot: ProviderSkillsSnapshot): ProviderSkillsSnapshot =>
        configurationChange ? { ...snapshot, nativeConfiguration: configurationChange } : snapshot;
      if (shutdownController.signal.aborted || providerDataDirectory() !== root)
        throw providerBoundaryError("Provider application is not accepting discovery.", "provider_host_closed", 503);
      signal?.throwIfAborted();
      const current = getStoredInstance(context.instanceId);
      if (!current?.enabled || current.config.enabled === false || current.revision !== context.revision || current.driver !== context.driver)
        throw providerBoundaryError("Provider instance or configuration changed.", "session_mismatch", 409);
      if (!fresh && previous && !previous.pending && !previous.error &&
          Date.now() - Date.parse(previous.checkedAt) < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS) {
        if (context.driver === "opencode") return withConfiguration(previous);
        // A cached inventory remains subject to the current instance lease.
        const cached = await use(context, "status", lease => lease.assertCurrent.pipe(Effect.as(previous)), signal);
        if (skillChanges.get(context.instanceId) !== configurationChange)
          throw providerBoundaryError("Native configuration changed during workspace discovery.", "discovery_superseded", 409);
        return withConfiguration(cached);
      }
      if (context.driver === "opencode") {
        const active = listRecords<ChatGeneration>("chat:generations").find(item => matchesExecution(item) &&
          liveOpenCodeInventory(context.instanceId, item.threadId, item.id, context.cwd));
        if (!active) return withConfiguration({ instanceId: context.instanceId, revision: context.revision, cwd: context.cwd,
          checkedAt: previous?.checkedAt ?? new Date().toISOString(), pending: true, skills: previous?.skills ?? [], commands: previous?.commands ?? [],
          invocation: { skills: true, commands: true, skillSyntax: "mention" },
          error: { code: "safe_discovery_unavailable", message: "OpenCode discovery is available when a matching authorized native Chat session is running." } });
      }
      const claim = { instanceId: context.instanceId };
      skillClaims.set(key, claim);
      try {
        const result = await use(context, "status", lease => Effect.gen(function* () {
          const checkedAt = new Date().toISOString();
          const invocation: ProviderSkillsSnapshot["invocation"] = context.driver === "omp"
            ? { skills: false, commands: false, skillSyntax: "none", commandAllowlist: ["session"] }
            : { skills: true, commands: true, skillSyntax: context.driver === "pi" || context.driver === "grok" ? "leading-mention" : "mention" };
          const base = { instanceId: context.instanceId, revision: context.revision, cwd: context.cwd, checkedAt, invocation };
          // Source discovery caches may be cleared; live runtimes/threads and account identity may not.
          if ((fresh || configurationChange) && lease.instance.invalidateCaches) yield* lease.instance.invalidateCaches;
          if (!lease.instance.snapshotForCwd) {
            const machine = yield* lease.instance.snapshot.getSnapshot;
            const generation = listRecords<ChatGeneration>("chat:generations").find(item => matchesExecution(item) &&
              liveAcpWorkspace(context.instanceId, item.threadId, item.id, context.cwd));
            const read = generation ? liveAcpWorkspace(context.instanceId, generation.threadId, generation.id, context.cwd) : undefined;
            const advertised = read?.();
            yield* lease.assertCurrent;
            if (generation && read && advertised !== undefined) {
              const latest = readRecord<ChatGeneration>("chat:generations", generation.id);
              if (!latest || latest.status !== "running" || latest.providerInstanceRevision !== context.revision ||
                  liveAcpWorkspace(context.instanceId, generation.threadId, generation.id, context.cwd) !== read ||
                  !matchesExecution(latest))
                return yield* Effect.fail(providerBoundaryError("Native Chat session changed during workspace discovery.", "session_mismatch", 409));
              const inventory = normalizeAcpRegistryCommands(advertised);
              return { ...base, pending: false, skills: inventory.skills, commands: inventory.slashCommands,
                invocation: { skills: false, commands: true, skillSyntax: "none" as const } };
            }
            const error = machine.status === "error" ? { code: "provider_error",
              message: sanitizeProviderMessage(current, machine.message ?? "Native provider reported an error.") } : undefined;
            if (context.driver === "muse") return { ...base, pending: false, skills: [], commands: machine.slashCommands,
              invocation: { skills: false, commands: true, skillSyntax: "none" as const }, ...(error ? { error } : {}) };
            return { ...base, pending: true, skills: [], commands: machine.slashCommands,
              invocation: { skills: false, commands: true, skillSyntax: "none" as const }, ...(error ? { error } : {}) };
          }
          // Reuse only the native connection already admitted for this exact live Chat.
          // Starting a separate OpenCode server for discovery could execute project plugins/MCP.
          if (context.driver === "opencode") {
            const generation = listRecords<ChatGeneration>("chat:generations").find(matchesExecution);
            const read = generation && liveOpenCodeInventory(context.instanceId, generation.threadId, generation.id, context.cwd);
            if (!generation || !read) {
              yield* lease.assertCurrent;
              return { ...base, checkedAt: previous?.checkedAt ?? checkedAt, pending: true, skills: previous?.skills ?? [], commands: previous?.commands ?? [],
                error: { code: "safe_discovery_unavailable", message: "OpenCode discovery is available when a matching authorized native Chat session is running." } };
            }
            const scanned = yield* read().pipe(Effect.timeout("20 seconds"), Effect.result);
            yield* lease.assertCurrent;
            const latest = readRecord<ChatGeneration>("chat:generations", generation.id);
            if (!latest || latest.status !== "running" || latest.providerInstanceRevision !== context.revision ||
                liveOpenCodeInventory(context.instanceId, generation.threadId, generation.id, context.cwd) !== read ||
                !matchesExecution(latest))
              return yield* Effect.fail(providerBoundaryError("Native Chat session changed during workspace discovery.", "session_mismatch", 409));
            if (scanned._tag === "Failure") {
              const current = getStoredInstance(context.instanceId);
              const message = scanned.failure instanceof Error ? scanned.failure.message : "Native workspace discovery failed.";
              return { ...base, checkedAt: previous?.checkedAt ?? checkedAt, pending: false, skills: previous?.skills ?? [], commands: previous?.commands ?? [],
                error: { code: "discovery_failed", message: current ? sanitizeProviderMessage(current, message) : "Native workspace discovery failed." } };
            }
            return { ...base, pending: scanned.success.pending ?? false, skills: scanned.success.skills,
              commands: scanned.success.pending && previous ? previous.commands : scanned.success.commands };
          }
          if (context.driver === "pi") {
            const generation = listRecords<ChatGeneration>("chat:generations").find(item => matchesExecution(item) &&
              livePiWorkspace(context.instanceId, item.threadId, item.id, context.cwd));
            const read = generation && livePiWorkspace(context.instanceId, generation.threadId, generation.id, context.cwd);
            if (generation && read) {
              const scanned = yield* read().pipe(Effect.timeout("20 seconds"), Effect.result);
              yield* lease.assertCurrent;
              const latest = readRecord<ChatGeneration>("chat:generations", generation.id);
              if (!latest || latest.status !== "running" || latest.providerInstanceRevision !== context.revision ||
                  livePiWorkspace(context.instanceId, generation.threadId, generation.id, context.cwd) !== read ||
                  !matchesExecution(latest))
                return yield* Effect.fail(providerBoundaryError("Native Chat session changed during workspace discovery.", "session_mismatch", 409));
              if (scanned._tag === "Failure") {
                const current = getStoredInstance(context.instanceId);
                const message = scanned.failure instanceof Error ? scanned.failure.message : "Native workspace discovery failed.";
                return { ...base, checkedAt: previous?.checkedAt ?? checkedAt, pending: false, skills: previous?.skills ?? [], commands: previous?.commands ?? [],
                  error: { code: "discovery_failed", message: current ? sanitizeProviderMessage(current, message) : "Native workspace discovery failed." } };
              }
              return { ...base, pending: false, skills: scanned.success.skills, commands: scanned.success.slashCommands };
            }
          }
          const scanned = yield* lease.instance.snapshotForCwd(context.cwd).pipe(Effect.result);
          yield* lease.assertCurrent;
          if (scanned._tag === "Failure") {
            const current = getStoredInstance(context.instanceId);
            const message = scanned.failure instanceof Error ? scanned.failure.message : "Native workspace discovery failed.";
            return { ...base, checkedAt: previous?.checkedAt ?? checkedAt, pending: false, skills: previous?.skills ?? [], commands: previous?.commands ?? [],
              error: { code: "discovery_failed", message: current ? sanitizeProviderMessage(current, message) : "Native workspace discovery failed." } };
          }
          const snapshot = scanned.success;
          const pending = context.driver === "pi" || (snapshot.slashCommandsPending ?? snapshot.status === "error");
          const refreshedInstance = getStoredInstance(context.instanceId);
          return { ...base, pending, skills: snapshot.skills,
            commands: pending && previous ? previous.commands : snapshot.slashCommands,
            ...(snapshot.status === "error" && snapshot.message ? { error: { code: "provider_error",
              message: refreshedInstance ? sanitizeProviderMessage(refreshedInstance, snapshot.message) : "Native provider reported an error." } } : {}) };
        }), signal);
        if (skillClaims.get(key) !== claim)
          throw providerBoundaryError("A newer workspace discovery superseded this result.", "discovery_superseded", 409);
        if (skillClaims.get(key) === claim && !result.error) {
          skillSnapshots.delete(key);
          skillSnapshots.set(key, result);
          while (skillSnapshots.size > 32) skillSnapshots.delete(skillSnapshots.keys().next().value!);
        }
        return withConfiguration(result);
      } finally {
        if (skillClaims.get(key) === claim) skillClaims.delete(key);
      }
    },
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
    logout: async (context, signal) => {
      if (getStoredInstance(context.instanceId)?.revision === context.revision)
        await closeMcpAppSessionsForInstance(context.instanceId);
      return use(context, "auth", lease => Effect.gen(function* () {
      const auth = lease.instance.auth;
      if (!auth) return yield* Effect.fail(providerBoundaryError("This Provider has no application-managed logout.", "unsupported_logout", 409));
      const state = yield* auth.logout(stopSessions(lease));
      if (state.phase === "failed") return yield* Effect.fail(providerBoundaryError(state.message ?? "Provider logout failed.", "provider_logout_failed", 412));
      yield* lease.assertCurrent;
      }), signal);
    },
    prepare: (context, signal, progress) => runInstallation("prepare", context, signal, progress),
    removeInstallation: (context, signal, progress) => runInstallation("removeInstallation", context, signal, progress),
    update: (context, signal, progress) => runMaintenance(context, lifetime => use(context, "maintenance", lease => Effect.gen(function* () {
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
    }), lifetime), signal),
  };
}

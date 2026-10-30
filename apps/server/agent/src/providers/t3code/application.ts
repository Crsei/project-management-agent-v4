import type { ProviderDriver } from "@agent-workspace/contracts/provider";
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { bindPmProviderExecutionService } from "../native.ts";
import { providerDataDirectory } from "../instances.ts";
import { startProviderMaintenanceRuntime, stopProviderMaintenanceRuntime } from "../maintenance.ts";
import type { PmProviderExecutionService, PmProviderHostService } from "./contract.ts";
import { bindPmProviderApplicationAccess } from "./application-access.ts";
import { makePmProviderHostService } from "./host-runtime.ts";
import { makePmProviderExecutionService } from "./execution.ts";
import { makePmProviderRuntimeHost } from "./runtime-host.ts";
import { makePmProviderManagement, type PmProviderCapabilitiesProjector, type PmProviderInstallationMethods, type PmProviderManagement } from "./management.ts";
import { registerPmProviderProtocolResolver, type PmProviderProtocolResolver } from "./continuation.ts";
import type { PmProviderFamily } from "./registration.ts";
import { providerBoundaryError } from "./config-mapping.ts";

export interface PmProviderApplicationOptions {
  readonly families: ReadonlyMap<ProviderDriverKind, PmProviderFamily>;
  readonly protocols: ReadonlyMap<ProviderDriver, PmProviderProtocolResolver>;
  readonly installations?: ReadonlyMap<ProviderDriver, PmProviderInstallationMethods>;
  readonly capabilities?: ReadonlyMap<ProviderDriver, PmProviderCapabilitiesProjector>;
}
export interface PmProviderApplication {
  readonly host: PmProviderHostService;
  readonly management: PmProviderManagement;
  readonly execution: PmProviderExecutionService;
  readonly shutdown: () => Promise<void>;
}

/** A single application scope owns drivers; an invocation scope owns each lease. */
export async function makePmProviderApplication(options: PmProviderApplicationOptions): Promise<PmProviderApplication> {
  const root = providerDataDirectory();
  const scope = await Effect.runPromise(Scope.make());
  try {
    const runtimeHost = makePmProviderRuntimeHost();
    const host = await Effect.runPromise(makePmProviderHostService({
      families: options.families,
      runtimeHost,
    }).pipe(Effect.provideService(Scope.Scope, scope)));
    const releaseProtocols: (() => void)[] = [];
    await Effect.runPromise(Scope.addFinalizer(scope, Effect.sync(() => {
      for (const release of releaseProtocols) release();
    })));
    for (const [driver, resolver] of options.protocols) {
      releaseProtocols.push(registerPmProviderProtocolResolver(driver, input => resolver(input)));
    }
    const execution = makePmProviderExecutionService(host, runtimeHost);
    if (providerDataDirectory() !== root)
      throw providerBoundaryError("Provider application data root changed during initialization.");
    const management = makePmProviderManagement(host, {
      ...(options.installations ? { installations: options.installations } : {}),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    });
    let closing: Promise<void> | undefined;
    return {
      host, management, execution,
      shutdown() {
        const maintenance = management.shutdown();
        return closing ??= (async () => {
          const failures: unknown[] = [];
          try { await maintenance; } catch (error) { failures.push(error); }
          try { await Effect.runPromise(host.shutdown); } catch (error) { failures.push(error); }
          try { await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, "Provider application cleanup failed.");
        })();
      },
    };
  } catch (error) {
    try { await Effect.runPromise(Scope.close(scope, Exit.fail(error))); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Provider application initialization and cleanup failed."); }
    throw error;
  }
}

let active: PmProviderApplication | undefined;
let starting: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
let unbindExecution: (() => void) | undefined;
let unbindApplicationAccess: (() => void) | undefined;
let applicationRoot: string | undefined;
let maintenanceStopping = false;

/** Called before HTTP starts accepting requests; importing modules starts nothing. */
export function startPmProviderApplication(options: PmProviderApplicationOptions): Promise<void> {
  if (stopping) return stopping.then(() => startPmProviderApplication(options));
  if (starting) return starting;
  applicationRoot = providerDataDirectory();
  const root = applicationRoot;
  maintenanceStopping = false;
  starting = makePmProviderApplication(options).then(async application => {
    let releaseAccess: (() => void) | undefined;
    let releaseExecution: (() => void) | undefined;
    try {
      if (maintenanceStopping) await application.management.shutdown();
      if (providerDataDirectory() !== root)
        throw providerBoundaryError("Provider application data root changed before publication.");
      releaseAccess = bindPmProviderApplicationAccess(() => stopping ? undefined : active);
      releaseExecution = bindPmProviderExecutionService(application.execution);
      if (!maintenanceStopping) startProviderMaintenanceRuntime(root);
      unbindExecution = releaseExecution;
      unbindApplicationAccess = releaseAccess;
      active = application;
    } catch (error) {
      releaseExecution?.();
      releaseAccess?.();
      try { await application.shutdown(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Provider binding and cleanup failed."); }
      throw error;
    }
  }).catch(error => { starting = undefined; throw error; });
  return starting;
}

/** Cancel all application-owned maintenance without draining hosts still used by Chat workers. */
export function stopPmProviderMaintenance(): Promise<void> {
  maintenanceStopping = true;
  const maintenance = stopProviderMaintenanceRuntime(applicationRoot ?? providerDataDirectory());
  const direct = active ? active.management.shutdown()
    : starting?.catch(() => undefined).then(() => active?.management.shutdown());
  return Promise.all([maintenance, direct]).then(() => undefined);
}

/** Chat and other workers must stop before this; the durable store closes afterward. */
export function stopPmProviderApplication(): Promise<void> {
  if (stopping) return stopping;
  const maintenance = stopPmProviderMaintenance();
  stopping = (async () => {
    if (starting) await starting.catch(() => undefined);
    const application = active;
    active = undefined;
    try {
      await maintenance;
      await application?.shutdown();
    } finally {
      unbindExecution?.();
      unbindExecution = undefined;
      unbindApplicationAccess?.();
      unbindApplicationAccess = undefined;
      starting = undefined;
      stopping = undefined;
      applicationRoot = undefined;
    }
  })();
  return stopping;
}

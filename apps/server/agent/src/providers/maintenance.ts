import type { ProviderMaintenanceAction, ProviderMaintenanceState } from "@agent-workspace/contracts/provider";
import { beginProviderMaintenance, resetAuthState } from "./auth.ts";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import { getStoredInstance, providerContext, providerDataDirectory, updateProviderInstance } from "./instances.ts";
import { sanitizeProviderMessage } from "./catalog.ts";

type Operation = { state: ProviderMaintenanceState; controller: AbortController; promise: Promise<void> };
const operations = new Map<string, Operation>();
const key = (id: string) => `${providerDataDirectory()}\0${id}`;
type MaintenanceRuntime = { accepting: boolean; stopping?: Promise<void> };
const runtimes = new Map<string, MaintenanceRuntime>();

/** A fresh application lifetime may reopen only its own data root. */
export function startProviderMaintenanceRuntime(root = providerDataDirectory()): void {
  if (runtimes.get(root)?.stopping)
    throw Object.assign(new Error("Provider maintenance cleanup is still pending."), { status: 503, code: "provider_host_closed" });
  runtimes.set(root, { accepting: true });
}

/** Close admissions and signal every admitted operation before awaiting any cleanup. */
export function stopProviderMaintenanceRuntime(root = providerDataDirectory()): Promise<void> {
  const current = runtimes.get(root);
  if (current?.stopping) return current.stopping;
  const runtime: MaintenanceRuntime = { accepting: false };
  runtimes.set(root, runtime);
  const prefix = `${root}\0`;
  const admitted = [...operations].filter(([operationKey]) => operationKey.startsWith(prefix)).map(([, operation]) => operation);
  const stopping = runtime.stopping = Promise.all(admitted.map(operation => operation.promise)).then(() => { delete runtime.stopping; });
  for (const operation of admitted) {
    if (operation.state.status === "running") operation.controller.abort(new Error("Maintenance cancelled."));
  }
  return stopping;
}

export function getProviderMaintenance(id: string): ProviderMaintenanceState {
  if (!getStoredInstance(id)) throw Object.assign(new Error("Unknown provider instance."), { status: 404 });
  return { ...(operations.get(key(id))?.state ?? { status: "idle" }) };
}
export function startProviderMaintenance(id: string, action: ProviderMaintenanceAction, revision: number): ProviderMaintenanceState {
  const root = providerDataDirectory();
  if (runtimes.get(root)?.accepting === false)
    throw Object.assign(new Error("Provider maintenance is not accepting operations."), { status: 503, code: "provider_host_closed" });
  const instance = getStoredInstance(id);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  if (!instance || !adapter) throw Object.assign(new Error("Unknown provider instance."), { status: 404 });
  if (!instance.enabled) throw Object.assign(new Error("Provider is disabled."), { status: 409 });
  if (instance.revision !== revision) throw Object.assign(new Error("Provider instance changed; reload before maintenance."), { status: 409 });
  const method = action === "install" ? adapter.prepare : action === "update" ? adapter.update : action === "remove" ? adapter.removeInstallation : undefined;
  if (!method) throw Object.assign(new Error("This maintenance action is not supported."), { status: 400 });
  const release = beginProviderMaintenance(id);
  try {
    const updated = updateProviderInstance(id, {}, revision);
    resetAuthState(id);
    const controller = new AbortController();
    const operation: Operation = { controller, promise: Promise.resolve(), state: { status: "running", action, startedAt: new Date().toISOString() } };
    operations.set(`${root}\0${id}`, operation);
    operation.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      if (providerDataDirectory() !== root) throw new Error("Provider configuration changed during maintenance.");
      return method(providerContext(updated), controller.signal, progress => {
        if (controller.signal.aborted || operation.state.status !== "running") return;
        if (providerDataDirectory() !== root || getStoredInstance(id)?.revision !== updated.revision) {
          controller.abort(new Error("Provider configuration changed during maintenance."));
          return;
        }
        operation.state = { ...operation.state, ...progress, ...(progress.message ? { message: sanitizeProviderMessage(updated, progress.message) } : {}) };
      });
    }).then(result => {
      controller.signal.throwIfAborted();
      if (providerDataDirectory() !== root || getStoredInstance(id)?.revision !== updated.revision) throw new Error("Provider configuration changed during maintenance.");
      operation.state = { ...operation.state, status: "succeeded", message: sanitizeProviderMessage(updated, result.message), finishedAt: new Date().toISOString() };
    }).catch(error => {
      let changed = true;
      try { changed = providerDataDirectory() !== root || getStoredInstance(id)?.revision !== updated.revision; } catch { /* an unreadable account cannot accept this result */ }
      operation.state = { ...operation.state, status: changed ? "failed" : controller.signal.aborted ? "cancelled" : "failed", message: sanitizeProviderMessage(updated, error instanceof Error ? error.message : "Maintenance failed."), finishedAt: new Date().toISOString() };
    }).finally(release);
    return { ...operation.state };
  } catch (error) { release(); throw error; }
}
export async function cancelProviderMaintenance(id: string): Promise<ProviderMaintenanceState> {
  const operation = operations.get(key(id));
  if (!operation) return getProviderMaintenance(id);
  if (operation.state.status === "running") { operation.controller.abort(new Error("Maintenance cancelled.")); await operation.promise; }
  return { ...operation.state };
}

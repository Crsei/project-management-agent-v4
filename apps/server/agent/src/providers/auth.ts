import { randomUUID } from "node:crypto";
import type { ProviderAuthState, ProviderAuthStartInput } from "@agent-workspace/contracts/provider";
import { getStoredInstance, listStoredInstances, providerContext, providerDataDirectory, updateProviderInstance } from "./instances.ts";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import { probeProviderInstance, sanitizeProviderMessage } from "./catalog.ts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import { closeMcpAppSessionsForInstance } from "../mcp-apps/live.ts";

const TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 16_384;
type Flow = {
  state: ProviderAuthState;
  revision: number;
  controller: AbortController;
  promise: Promise<void>;
  secrets: Set<string>;
  input?: { resolve: (value: string) => void; reject: (error: unknown) => void };
};
const flows = new Map<string, Flow>();
const logoutOperations = new Set<string>();
const nativeExecutions = new Map<string, number>();
const maintenanceOperations = new Set<string>();
const statusOperations = new Map<string, number>();
// Host scopes are reservations in this same account lock table, including direct façade consumers.
const hostMutations = new Map<string, { readonly installation: boolean; readonly revision: number }>();
const listeners = new Map<string, Set<(state: ProviderAuthState) => void>>();
const key = (instanceId: string) => `${providerDataDirectory()}\0${instanceId}`;
const active = (state: ProviderAuthState) => ["starting", "waiting", "verifying"].includes(state.phase);
const resourceBindings = new Map<string, { revision: number; resources: string[] }>();
function resources(instanceId: string): string[] {
  const instance = getStoredInstance(instanceId);
  if (!instance) return [key(instanceId)];
  const registered = resourceBindings.get(key(instanceId));
  return [`native:${instance.driver}:${instance.homeDirectory}`,
    `installation:${instance.driver}:${String(instance.config.binaryPath ?? "")}`,
    // A stale binding may still exclude access until the source re-resolves it; it never authorizes a lease.
    ...(registered?.resources ?? [])];
}
function sharesResources(instanceId: string, operationKey: string, installation = maintenanceOperations.has(key(instanceId)) || maintenanceOperations.has(operationKey) || hostMutations.get(key(instanceId))?.installation === true || hostMutations.get(operationKey)?.installation === true): boolean {
  const prefix = `${providerDataDirectory()}\0`;
  if (!operationKey.startsWith(prefix)) return false;
  const otherId = operationKey.slice(prefix.length);
  if (otherId === instanceId) return true;
  const own = resources(instanceId);
  return resources(otherId).some(resource => (installation || (!resource.startsWith("installation:") && !resource.startsWith("maintenance:"))) && own.includes(resource));
}
/** Bindings discovered by original controllers/maintenance participate in the existing lock table. */
export function registerProviderResourceBindings(instanceId: string, bindings: readonly string[]): void {
  const instance = getStoredInstance(instanceId);
  if (!instance) throw Object.assign(new Error("Unknown provider instance."), { status: 404 });
  const previous = resourceBindings.get(key(instanceId));
  resourceBindings.set(key(instanceId), { revision: instance.revision,
    resources: [...new Set([...(previous?.revision === instance.revision ? previous.resources : []), ...bindings])] });
  const writers = [...logoutOperations, ...maintenanceOperations, ...hostMutations.keys(),
    ...[...flows].filter(([, flow]) => active(flow.state)).map(([id]) => id)];
  const ownsWriter = writers.includes(key(instanceId));
  if (writers.some(id => id !== key(instanceId) && sharesResources(instanceId, id))
    || (ownsWriter && [...nativeExecutions.keys(), ...statusOperations.keys()].some(id => id !== key(instanceId) && sharesResources(instanceId, id))))
    throw Object.assign(new Error("A shared native credential or installation binding is busy."), { status: 409, code: "provider_busy" });
}
/** A session-owner callback may drain only an already admitted PM credential mutation. */
export function authorizeProviderAuthSessionInvalidation(
  requestingInstanceId: string,
  instanceId: string,
  binding: ProviderAuthController["credentialBinding"],
): boolean {
  const operationKey = key(requestingInstanceId);
  const requester = getStoredInstance(requestingInstanceId);
  const reservation = hostMutations.get(operationKey);
  const ownsMutation = reservation !== undefined && !reservation.installation && reservation.revision === requester?.revision;
  if (!requester?.enabled || !ownsMutation)
    throw Object.assign(new Error("Provider session invalidation requires the current PM account mutation."), { status: 409, code: "account_operation_required" });
  const resource = binding ? `credential:${binding.owner}:${binding.key}` : undefined;
  const ownBinding = resourceBindings.get(operationKey);
  if (resource && (ownBinding?.revision !== requester.revision || !ownBinding.resources.includes(resource)))
    throw Object.assign(new Error("Provider credentials changed before session invalidation."), { status: 409, code: "session_mismatch" });
  const readers = [...nativeExecutions.keys(), ...statusOperations.keys()];
  const writers = [...logoutOperations, ...maintenanceOperations, ...hostMutations.keys(),
    ...[...flows].filter(([, current]) => active(current.state)).map(([id]) => id)];
  if (readers.some(id => sharesResources(requestingInstanceId, id, false))
    || writers.some(id => id !== operationKey && sharesResources(requestingInstanceId, id, false)))
    throw Object.assign(new Error("A shared Provider account is busy."), { status: 409, code: "provider_busy" });
  if (instanceId === requestingInstanceId) return true;
  if (!resource) return false;
  const target = getStoredInstance(instanceId);
  const targetBinding = resourceBindings.get(key(instanceId));
  return target !== null && targetBinding?.revision === target.revision
    && targetBinding.resources.includes(resource);
}
/** Credential/installer writes invalidate every local account sharing the proven resource, not its session identity. */
export function invalidateProviderResourcePeers(instanceId: string, installation = false): void {
  for (const peer of listStoredInstances()) {
    if (peer.instanceId === instanceId || !sharesResources(instanceId, key(peer.instanceId), installation)) continue;
    const binding = resourceBindings.get(key(peer.instanceId));
    const updated = updateProviderInstance(peer.instanceId, {}, peer.revision);
    if (binding?.revision === peer.revision) resourceBindings.set(key(peer.instanceId), { ...binding, revision: updated.revision });
    resetAuthState(peer.instanceId);
  }
}
export function isProviderAccountBusy(instanceId: string): boolean {
  return [...logoutOperations, ...maintenanceOperations, ...hostMutations.keys()].some(id => sharesResources(instanceId, id))
    || [...flows].some(([id, flow]) => active(flow.state) && sharesResources(instanceId, id));
}
/** Status probes and parallel turns share the account; mutations wait until all settle. */
export function beginProviderExecution(instanceId: string): () => void {
  if (isProviderAccountBusy(instanceId))
    throw Object.assign(new Error("A native account operation is already active."), { status: 409 });
  const executionKey = key(instanceId);
  nativeExecutions.set(executionKey, (nativeExecutions.get(executionKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (nativeExecutions.get(executionKey) ?? 1) - 1;
    if (remaining > 0) nativeExecutions.set(executionKey, remaining);
    else nativeExecutions.delete(executionKey);
  };
}
export function requireAccountIdle(instanceId: string): void {
  if (isProviderAccountBusy(instanceId)
    || [...statusOperations.keys(), ...nativeExecutions.keys()].some(id => sharesResources(instanceId, id)))
    throw Object.assign(new Error("The native Agent is busy with execution or an account operation."), { status: 409 });
}
export function beginProviderMaintenance(instanceId: string): () => void {
  requireAccountIdle(instanceId);
  const holders = [...nativeExecutions.keys(), ...statusOperations.keys(), ...logoutOperations, ...maintenanceOperations, ...hostMutations.keys(),
    ...[...flows].filter(([, flow]) => active(flow.state)).map(([id]) => id)];
  if (holders.some(id => sharesResources(instanceId, id, true)))
    throw Object.assign(new Error("A shared native installation is busy."), { status: 409 });
  const operationKey = key(instanceId);
  maintenanceOperations.add(operationKey);
  let released = false;
  return () => { if (!released) { released = true; maintenanceOperations.delete(operationKey); } };
}
export function beginProviderAccountOperation(instanceId: string): () => void {
  requireAccountIdle(instanceId);
  const operationKey = key(instanceId);
  logoutOperations.add(operationKey);
  let released = false;
  return () => { if (!released) { released = true; logoutOperations.delete(operationKey); } };
}
/** Attach a source controller to its admitted local mutation, or reserve a direct caller exclusively. */
export function beginProviderHostMutation(instanceId: string, installation: boolean): () => void {
  const operationKey = key(instanceId);
  if (hostMutations.has(operationKey)) throw Object.assign(new Error("A source Provider mutation is already active."), { status: 409 });
  const ownOuter = installation ? maintenanceOperations.has(operationKey)
    : logoutOperations.has(operationKey) || Boolean(flows.get(operationKey) && active(flows.get(operationKey)!.state));
  const current = getStoredInstance(instanceId);
  if (!current) throw Object.assign(new Error("Unknown Provider account mutation target."), { status: 404 });
  const releaseOuter = ownOuter ? undefined : installation ? beginProviderMaintenance(instanceId) : beginProviderAccountOperation(instanceId);
  hostMutations.set(operationKey, { installation, revision: current.revision });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hostMutations.delete(operationKey);
    releaseOuter?.();
  };
}
export function beginProviderStatus(instanceId: string, insideAccountOperation = false): () => void {
  const operationKey = key(instanceId);
  const otherWriter = [...logoutOperations, ...maintenanceOperations, ...hostMutations.keys(),
    ...[...flows].filter(([, flow]) => active(flow.state)).map(([id]) => id)]
    .some(id => (!insideAccountOperation || id !== operationKey) && sharesResources(instanceId, id));
  if (maintenanceOperations.has(operationKey) || otherWriter)
    throw Object.assign(new Error("The native Agent is busy."), { status: 409 });
  statusOperations.set(operationKey, (statusOperations.get(operationKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (statusOperations.get(operationKey) ?? 1) - 1;
    if (remaining > 0) statusOperations.set(operationKey, remaining); else statusOperations.delete(operationKey);
  };
}
/** Nest only an already admitted local status probe; a direct host probe cannot bypass account exclusion. */
export function beginProviderHostStatus(instanceId: string): () => void {
  return beginProviderStatus(instanceId, statusOperations.has(key(instanceId)));
}
function instanceAndAdapter(instanceId: string) {
  const instance = getStoredInstance(instanceId);
  const adapter = instance && getNativeProviderAdapter(instance.driver);
  if (!instance || !adapter) throw Object.assign(new Error("Unknown native Agent instance."), { status: 404 });
  if (!instance.enabled) throw Object.assign(new Error("Agent instance is disabled."), { status: 409 });
  return { instance, adapter };
}
function emit(flowKey: string, flow: Flow): void {
  if (flows.get(flowKey) !== flow) return;
  for (const listener of listeners.get(flowKey) ?? []) listener({ ...flow.state });
}
export function resetAuthState(instanceId: string): void {
  const flowKey = key(instanceId);
  const flow = flows.get(flowKey);
  if (flow && active(flow.state)) {
    flow.controller.abort(new Error("Agent configuration changed."));
    void flow.promise.finally(() => { if (flows.get(flowKey) === flow) flows.delete(flowKey); });
  } else flows.delete(flowKey);
}
export async function getAuthState(instanceId: string): Promise<ProviderAuthState> {
  instanceAndAdapter(instanceId);
  const flow = flows.get(key(instanceId));
  if (flow) return { ...flow.state };
  const provider = await probeProviderInstance(instanceId);
  return {
    instanceId, phase: "idle", flowId: null, authorizationUrl: null, userCode: null,
    output: "", expiresAt: null, message: provider.message ?? null,
    methods: provider.authMethods ?? [], interaction: null, credentialOwner: "provider",
  };
}
export async function startProviderAuth(instanceId: string, input: ProviderAuthStartInput = {}): Promise<ProviderAuthState> {
  const { instance, adapter } = instanceAndAdapter(instanceId);
  const flowKey = key(instanceId);
  await closeMcpAppSessionsForInstance(instanceId);
  requireAccountIdle(instanceId);
  const initial = await getAuthState(instanceId);
  requireAccountIdle(instanceId);
  const configuredMethod = instance.driver === "acpRegistry" && typeof instance.config.authMethodId === "string" ? instance.config.authMethodId : undefined;
  const requestedMethod = input.methodId ?? configuredMethod;
  const method = requestedMethod ? initial.methods.find(method => method.id === requestedMethod) : initial.methods[0];
  if (!method) throw Object.assign(new Error("Choose a supported native authentication method."), { status: 400 });
  // Authentication can change account files even if interrupted. Existing native
  // sessions must stop matching the previous account/configuration revision.
  const current = updateProviderInstance(instanceId, {}, instance.revision);
  const context = providerContext(current);
  const controller = new AbortController();
  const flow: Flow = {
    revision: current.revision, controller, promise: Promise.resolve(),
    secrets: new Set(Object.values(input.values ?? {}).flatMap(value => [value, value.trim()]).filter(Boolean)),
    state: { ...initial, phase: "starting", flowId: randomUUID(), output: "", message: null,
      expiresAt: new Date(Date.now() + TIMEOUT_MS).toISOString(), interaction: null,
      authorizationUrl: null, userCode: null },
  };
  const redact = (text: string): string => {
    for (const secret of flow.secrets) text = text.split(secret).join("[redacted]");
    return text.split("\n").map(line => sanitizeProviderMessage(current, line)).join("\n");
  };
  flows.set(flowKey, flow);
  const timer = setTimeout(() => controller.abort(new Error("Native authentication timed out.")), TIMEOUT_MS);
  timer.unref();
  const abortInput = () => {
    flow.input?.reject(controller.signal.reason ?? new Error("Authentication cancelled."));
    delete flow.input;
  };
  controller.signal.addEventListener("abort", abortInput, { once: true });
  flow.promise = Promise.resolve().then(() => adapter.authenticate(context, {
    methodId: method.id, ...(input.values === undefined ? {} : { values: input.values }), signal: controller.signal,
    saveEnvironment: async credentials => {
      controller.signal.throwIfAborted();
      for (const value of Object.values(credentials)) if (value) flow.secrets.add(value);
      const latest = getStoredInstance(instanceId);
      if (!latest || latest.revision !== flow.revision) throw new Error("Agent configuration changed during authentication.");
      const environment = Object.entries(latest.env).filter(([name]) => !Object.hasOwn(credentials, name)).map(([name, value]) => ({ name, value, sensitive: latest.envSensitivity?.[name] ?? true }));
      environment.push(...Object.entries(credentials).map(([name, value]) => ({ name, value, sensitive: true })));
      const updated = updateProviderInstance(instanceId, { environment }, flow.revision);
      flow.revision = updated.revision;
      context.revision = updated.revision;
      Object.assign(context.env, credentials);
      context.instanceEnvironment = { ...updated.env };
    },
    readInput: () => {
      controller.signal.throwIfAborted();
      if (flow.input) return Promise.reject(new Error("Authentication already awaits input."));
      return new Promise<string>((resolve, reject) => { flow.input = { resolve, reject }; });
    },
    onUpdate: update => {
      if (controller.signal.aborted || flows.get(flowKey) !== flow) return;
      if (getStoredInstance(instanceId)?.revision !== flow.revision) {
        controller.abort(new Error("Agent configuration changed during authentication.")); return;
      }
      if (update.phase && ["starting", "waiting", "verifying"].includes(update.phase)) flow.state.phase = update.phase;
      if (update.message !== undefined) flow.state.message = redact(update.message);
      if (update.output) flow.state.output = (flow.state.output + redact(update.output) + "\n").slice(-MAX_OUTPUT);
      if (update.interaction !== undefined) {
        flow.state.interaction = update.interaction?.type === "terminal"
          ? { ...update.interaction, output: redact(update.interaction.output).slice(-MAX_OUTPUT) }
          : update.interaction;
        if (update.interaction?.type === "browser" || update.interaction?.type === "device-code") {
          flow.state.authorizationUrl = update.interaction.url;
          flow.state.userCode = update.interaction.userCode ?? null;
        }
      }
      emit(flowKey, flow);
    },
  })).then(async () => {
    controller.signal.throwIfAborted();
    if (getStoredInstance(instanceId)?.revision !== flow.revision)
      throw new Error("Agent configuration changed during authentication.");
    flow.state.phase = "verifying"; emit(flowKey, flow);
    const provider = await probeProviderInstance(instanceId, true);
    controller.signal.throwIfAborted();
    if (provider.authStatus === "unauthenticated" || provider.authStatus === "not-installed")
      throw new Error("Native authentication did not produce a usable authenticated Agent.");
    flow.state.phase = "succeeded";
    flow.state.message = provider.authStatus === "authenticated" ? "原生 Agent 已确认登录。" : "原生认证流程已完成；此 Agent 不提供可独立核验的登录状态。";
    flow.state.interaction = null;
  }).catch(error => {
    flow.state.phase = controller.signal.aborted && controller.signal.reason === "user-cancelled" ? "cancelled" : "failed";
    flow.state.message = redact(error instanceof Error ? error.message : "Native authentication failed.");
    flow.state.interaction = null;
  }).finally(() => {
    clearTimeout(timer); controller.signal.removeEventListener("abort", abortInput);
    flow.input?.reject(new Error("Authentication flow ended.")); delete flow.input;
    flow.secrets.clear();
    flow.state.expiresAt = null;
    flow.state.authorizationUrl = null;
    flow.state.userCode = null;
    emit(flowKey, flow);
  });
  return { ...flow.state };
}
export function writeAuthInput(instanceId: string, flowId: string, input: string): ProviderAuthState {
  const flow = flows.get(key(instanceId));
  if (!flow || flow.state.flowId !== flowId) throw Object.assign(new Error("No matching authentication flow."), { status: 404 });
  if (!active(flow.state) || !flow.input) throw Object.assign(new Error("Authentication is not awaiting input."), { status: 409 });
  if (flow.controller.signal.aborted) throw Object.assign(new Error("Authentication is stopping."), { status: 409 });
  if (input) flow.secrets.add(input);
  if (flow.state.interaction?.type === "credentials") {
    let values: unknown;
    try { values = JSON.parse(input); } catch { throw Object.assign(new Error("Invalid credential form input."), { status: 400 }); }
    if (!values || typeof values !== "object" || Array.isArray(values)
      || Object.values(values).some(value => typeof value !== "string"))
      throw Object.assign(new Error("Credential form values must be strings."), { status: 400 });
    for (const value of Object.values(values) as string[]) {
      if (value) flow.secrets.add(value);
      if (value.trim()) flow.secrets.add(value.trim());
    }
  }
  const pending = flow.input; delete flow.input; pending.resolve(input);
  return { ...flow.state };
}
export async function cancelProviderAuth(instanceId: string, flowId: string): Promise<ProviderAuthState> {
  const flow = flows.get(key(instanceId));
  if (!flow || flow.state.flowId !== flowId) throw Object.assign(new Error("No matching authentication flow."), { status: 404 });
  if (active(flow.state)) { flow.controller.abort("user-cancelled"); await flow.promise; }
  return { ...flow.state };
}
export async function* subscribeAuth(instanceId: string, signal?: AbortSignal): AsyncGenerator<ProviderAuthState> {
  const flowKey = key(instanceId);
  const queue: ProviderAuthState[] = [];
  let wake: (() => void) | undefined;
  const onState = (state: ProviderAuthState) => { queue.push(state); wake?.(); wake = undefined; };
  let set = listeners.get(flowKey);
  if (!set) { set = new Set(); listeners.set(flowKey, set); }
  set.add(onState);
  const onAbort = () => { wake?.(); wake = undefined; };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const initial = await getAuthState(instanceId);
    yield initial;
    if (!active(initial) && initial.phase !== "idle") return;
    while (!signal?.aborted) {
      if (queue.length) { const state = queue.shift()!; yield state; if (!active(state) && state.phase !== "idle") return; }
      else await new Promise<void>(resolve => { wake = resolve; if (signal?.aborted) resolve(); });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort); set.delete(onState);
    if (!set.size) listeners.delete(flowKey);
  }
}
export async function logoutProvider(instanceId: string): Promise<{ ok: boolean; message?: string }> {
  const { instance, adapter } = instanceAndAdapter(instanceId);
  const flowKey = key(instanceId);
  await closeMcpAppSessionsForInstance(instanceId);
  requireAccountIdle(instanceId);
  logoutOperations.add(flowKey);
  try {
    const provider = await probeProviderInstance(instanceId, true);
    if (!provider.canLogout) throw Object.assign(new Error("This native Agent has no available logout operation."), { status: 409 });
    const updated = updateProviderInstance(instanceId, {}, instance.revision);
    await adapter.logout(providerContext(updated), AbortSignal.timeout(30_000));
    return { ok: true };
  } finally { resetAuthState(instanceId); logoutOperations.delete(flowKey); }
}

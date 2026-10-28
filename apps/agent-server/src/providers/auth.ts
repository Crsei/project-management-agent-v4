import { randomUUID } from "node:crypto";
import type { ProviderAuthState, ProviderAuthStartInput } from "@agent-workspace/contracts/provider";
import { getStoredInstance, providerContext, providerDataDirectory, updateProviderInstance } from "./instances.ts";
import { getNativeProviderAdapter } from "./driver-registry.ts";
import { probeProviderInstance, sanitizeProviderMessage } from "./catalog.ts";

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
const listeners = new Map<string, Set<(state: ProviderAuthState) => void>>();
const key = (instanceId: string) => `${providerDataDirectory()}\0${instanceId}`;
const active = (state: ProviderAuthState) => ["starting", "waiting", "verifying"].includes(state.phase);
export function isProviderAccountBusy(instanceId: string): boolean {
  const flowKey = key(instanceId);
  const flow = flows.get(flowKey);
  return logoutOperations.has(flowKey) || Boolean(flow && active(flow.state));
}
/** Parallel turns may share an account; authentication/logout must wait until all settle. */
export function beginProviderExecution(instanceId: string): () => void {
  if (isProviderAccountBusy(instanceId))
    throw Object.assign(new Error("A native account operation is already active."), { status: 409 });
  const executionKey = key(instanceId);
  nativeExecutions.set(executionKey, (nativeExecutions.get(executionKey) ?? 0) + 1);
  return () => {
    const remaining = (nativeExecutions.get(executionKey) ?? 1) - 1;
    if (remaining > 0) nativeExecutions.set(executionKey, remaining);
    else nativeExecutions.delete(executionKey);
  };
}
function requireAccountIdle(instanceId: string): void {
  if (isProviderAccountBusy(instanceId) || (nativeExecutions.get(key(instanceId)) ?? 0) > 0)
    throw Object.assign(new Error("The native Agent is busy with execution or an account operation."), { status: 409 });
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
  requireAccountIdle(instanceId);
  const initial = await getAuthState(instanceId);
  requireAccountIdle(instanceId);
  const method = input.methodId ? initial.methods.find(method => method.id === input.methodId) : initial.methods[0];
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
    flow.input = undefined;
  };
  controller.signal.addEventListener("abort", abortInput, { once: true });
  flow.promise = Promise.resolve().then(() => adapter.authenticate(context, {
    methodId: method.id, values: input.values, signal: controller.signal,
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
    const provider = await probeProviderInstance(instanceId);
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
    flow.input?.reject(new Error("Authentication flow ended.")); flow.input = undefined;
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
  const pending = flow.input; flow.input = undefined; pending.resolve(input);
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
  requireAccountIdle(instanceId);
  logoutOperations.add(flowKey);
  try {
    const provider = await probeProviderInstance(instanceId);
    if (!provider.canLogout) throw Object.assign(new Error("This native Agent has no available logout operation."), { status: 409 });
    const updated = updateProviderInstance(instanceId, {}, instance.revision);
    await adapter.logout(providerContext(updated), AbortSignal.timeout(30_000));
    return { ok: true };
  } finally { resetAuthState(instanceId); logoutOperations.delete(flowKey); }
}

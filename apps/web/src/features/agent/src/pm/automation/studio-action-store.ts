import { StudioApiError, type StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client.ts";
import { studioDefinitionSchema, studioExecutionSchema } from "../../../../../../../../packages/contracts/src/automation-studio.ts";
import type { StudioCommand, StudioSettled } from "./studio-actions";

type Pending = StudioCommand & { requestId: string; startedAt: string };
type ActionContext = { version: string | number; text: (zh: string, en: string) => string; settled: (result: StudioSettled) => void; accessFailure: () => void };
type Snapshot = { pending: Pending | null; busy: boolean; storageError: boolean; error: string; errorVersion: string | number | null; settled: StudioSettled | null; settledVersion: string | number | null };

function readPending(storage: Storage, key: string): Pending | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("requestId" in value) || typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.requestId) || !("id" in value) || typeof value.id !== "string" || !("kind" in value) || !["run", "remove", "status", "cancel"].includes(String(value.kind)) || !("startedAt" in value) || typeof value.startedAt !== "string") throw new Error("invalid_recovery_journal");
  if (value.kind !== "cancel" && (!("expectedRevision" in value) || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) throw new Error("invalid_recovery_revision");
  if (value.kind === "status" && (!("status" in value) || !["enabled", "paused"].includes(String(value.status)))) throw new Error("invalid_recovery_status");
  return value as Pending;
}

/** One owner per existing actor/workspace journal. Only request identities are persisted. */
export class StudioActionStore {
  private state: Snapshot = { pending: null, busy: false, storageError: false, error: "", errorVersion: null, settled: null, settledVersion: null };
  private readonly listeners = new Map<() => void, string | number>();
  private readonly key: string;
  private readonly storage: () => Storage;
  constructor(key: string, storage: () => Storage = () => sessionStorage) {
    this.key = key;
    this.storage = storage;
    try { this.state.pending = readPending(this.storage(), key); }
    catch { this.state.storageError = true; }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void, version: string | number) => {
    this.listeners.set(listener, version);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.state = { ...this.state, settled: null, settledVersion: null, error: "", errorVersion: null };
    };
  };
  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners.keys()) listener();
  }
  private visible(version: string | number) {
    for (const subscribed of this.listeners.values()) if (subscribed === version) return true;
    return false;
  }
  private fail(message: string, context: ActionContext) {
    if (this.visible(context.version)) this.update({ error: message, errorVersion: context.version });
  }
  private store(pending: Pending | null) {
    try {
      const storage = this.storage();
      const raw = pending ? JSON.stringify(pending) : null;
      if (raw) storage.setItem(this.key, raw); else storage.removeItem(this.key);
      if (storage.getItem(this.key) !== raw) throw new Error("recovery_storage_not_writable");
      this.update({ pending, storageError: false });
      return true;
    } catch { this.update({ storageError: true }); return false; }
  }
  private accept(command: Pending, result: unknown, status: number, context: ActionContext) {
    if (status >= 400) {
      if (!this.store(null)) return;
      const detail = result && typeof result === "object" && "error" in result ? result.error : null;
      this.fail(detail && typeof detail === "object" && "message" in detail ? String(detail.message) : context.text("原请求被拒绝。", "The original request was rejected."), context);
      if ([401, 403].includes(status)) context.accessFailure();
      return;
    }
    const settled: StudioSettled = { command };
    if (command.kind === "run" || command.kind === "cancel") {
      settled.execution = studioExecutionSchema.parse(result);
      if (command.kind === "run"
        ? settled.execution.definitionId !== command.id || settled.execution.definitionRevision !== command.expectedRevision || settled.execution.requestId !== command.requestId
        : settled.execution.id !== command.id) throw new Error("receipt_identity_mismatch");
    } else if (command.kind === "status") {
      settled.definition = studioDefinitionSchema.parse(result);
      if (settled.definition.id !== command.id) throw new Error("receipt_identity_mismatch");
    } else if (!result || typeof result !== "object" || !("deleted" in result) || result.deleted !== true) throw new Error("invalid_delete_receipt");
    if (!this.store(null)) {
      this.fail(context.text("结果已读取，但恢复存储不可写；请恢复后核对原请求。", "Result read, but recovery storage is not writable; recover storage and check the original request."), context);
      return;
    }
    if (this.visible(context.version)) this.update({ error: "", errorVersion: null, settled, settledVersion: context.version });
    context.settled(settled);
  }
  private async receipt(api: StudioClient, command: Pending, context: ActionContext) {
    try {
      const receipt = await api.receipt(command.requestId);
      if (receipt.requestId !== command.requestId) throw new Error("receipt_identity_mismatch");
      this.accept(command, receipt.result, receipt.httpStatus, context);
    } catch (cause) {
      if (cause instanceof StudioApiError && [401, 403].includes(cause.status)) context.accessFailure();
      this.fail(context.text("原请求结果仍未知。只查询原收据，不重复派发。", "The original outcome is still unknown. Only its receipt is queried; nothing is redispatched."), context);
    }
  }
  async reconcile(api: StudioClient, context: ActionContext) {
    const pending = this.state.pending;
    if (!pending || this.state.busy) return;
    this.update({ busy: true });
    try { await this.receipt(api, pending, context); }
    finally { this.update({ busy: false }); }
  }
  async execute(api: StudioClient, command: StudioCommand, context: ActionContext) {
    if (this.state.busy || this.state.pending || this.state.storageError) return;
    // Check the original journal again before claiming it; never replace an unknown request.
    try {
      const prior = readPending(this.storage(), this.key);
      if (prior) { this.update({ pending: prior }); return; }
    } catch { this.update({ storageError: true }); return; }
    const frozen: Pending = { ...command, requestId: crypto.randomUUID(), startedAt: new Date().toISOString() };
    if (!this.store(frozen)) return;
    this.update({ busy: true, error: "", errorVersion: null, settled: null, settledVersion: null });
    try {
      const result = frozen.kind === "run" ? await api.run(frozen.id, frozen.requestId, frozen.expectedRevision)
        : frozen.kind === "remove" ? await api.remove(frozen.id, frozen.requestId, frozen.expectedRevision)
        : frozen.kind === "status" ? await api.setStatus(frozen.id, frozen.requestId, frozen.expectedRevision, frozen.status!)
        : await api.cancel(frozen.id, frozen.requestId);
      this.accept(frozen, result, 200, context);
    } catch (cause) {
      if (cause instanceof StudioApiError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status) && !["idempotency_conflict", "invalid_response"].includes(cause.code)) {
        if (this.store(null)) this.fail(cause.message, context);
        if ([401, 403].includes(cause.status)) context.accessFailure();
      } else await this.receipt(api, frozen, context);
    } finally { this.update({ busy: false }); }
  }
  retryStorage(api: StudioClient, context: ActionContext) {
    try {
      const recovered = this.state.pending ?? readPending(this.storage(), this.key);
      if (this.store(recovered) && recovered) void this.reconcile(api, context);
    } catch {
      this.update({ storageError: true });
      this.fail(context.text("恢复记录无法解析，保留原记录以免丢失请求身份。", "The recovery record cannot be parsed; it is kept to avoid losing the original request identity."), context);
    }
  }
}

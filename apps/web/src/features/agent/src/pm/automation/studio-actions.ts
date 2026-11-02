import { useEffect, useRef, useState } from "react";
import { StudioApiError, type StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import { studioDefinitionSchema, studioExecutionSchema, type StudioDefinition, type StudioExecution } from "../../../../../../../../packages/contracts/src/automation-studio";
import { useAgentText } from "../../i18n";

export type StudioCommand = { kind: "run" | "remove" | "status"; id: string; expectedRevision: number; status?: "enabled" | "paused" } | { kind: "cancel"; id: string };
type Pending = StudioCommand & { requestId: string; startedAt: string };
export type StudioSettled = { command: StudioCommand; definition?: StudioDefinition; execution?: StudioExecution };

function readPending(key: string): Pending | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("requestId" in value) || typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.requestId) || !("id" in value) || typeof value.id !== "string" || !("kind" in value) || !["run", "remove", "status", "cancel"].includes(String(value.kind)) || !("startedAt" in value) || typeof value.startedAt !== "string") throw new Error("invalid_recovery_journal");
  if (value.kind !== "cancel" && (!("expectedRevision" in value) || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) throw new Error("invalid_recovery_revision");
  if (value.kind === "status" && (!("status" in value) || !["enabled", "paused"].includes(String(value.status)))) throw new Error("invalid_recovery_status");
  return value as Pending;
}

/** Only the original request identity is recoverable here; server definitions/history stay authoritative. */
export function useStudioActions(api: StudioClient, actorId: string, workspaceId: string, onSettled: (result: StudioSettled) => void, onAccessFailure: () => void) {
  const t = useAgentText();
  const key = `pm-automation-studio-actions:${window.location.origin}:${actorId}:${workspaceId}`;
  const [restored] = useState(() => {
    try { return { pending: readPending(key), storageError: false }; }
    catch { return { pending: null as Pending | null, storageError: true }; }
  });
  const [pending, setPending] = useState(restored.pending);
  const [storageError, setStorageError] = useState(restored.storageError);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const pendingRef = useRef(pending);
  const alive = useRef(false);
  const callbacks = useRef({ onSettled, onAccessFailure });
  callbacks.current = { onSettled, onAccessFailure };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function store(value: Pending | null) {
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key);
      pendingRef.current = value; setPending(value); setStorageError(false); return true;
    } catch { setStorageError(true); return false; }
  }
  function accept(command: Pending, result: unknown, httpStatus = 200) {
    if (!alive.current) return;
    if (httpStatus >= 400) {
      if (!store(null)) return;
      const detail = result && typeof result === "object" && "error" in result ? result.error : null;
      setError(detail && typeof detail === "object" && "message" in detail ? String(detail.message) : t("原请求被拒绝。", "The original request was rejected."));
      if ([401, 403].includes(httpStatus)) callbacks.current.onAccessFailure();
      return;
    }
    const settled: StudioSettled = { command };
    if (command.kind === "run" || command.kind === "cancel") {
      settled.execution = studioExecutionSchema.parse(result);
      if (command.kind === "run" ? settled.execution.definitionId !== command.id : settled.execution.id !== command.id) throw new Error("receipt_identity_mismatch");
    } else if (command.kind === "status") {
      settled.definition = studioDefinitionSchema.parse(result);
      if (settled.definition.id !== command.id) throw new Error("receipt_identity_mismatch");
    } else if (!result || typeof result !== "object" || !("deleted" in result) || result.deleted !== true) throw new Error("invalid_delete_receipt");
    if (!store(null)) { setError(t("结果已读取，但恢复存储不可写；请恢复后核对原请求。", "Result read, but recovery storage is not writable; recover storage and check the original request.")); return; }
    setError(""); callbacks.current.onSettled(settled);
  }
  async function receipt(command: Pending) {
    try {
      const result = await api.receipt(command.requestId);
      if (result.requestId !== command.requestId) throw new Error("receipt_identity_mismatch");
      accept(command, result.result, result.httpStatus);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof StudioApiError && [401, 403].includes(cause.status)) callbacks.current.onAccessFailure();
      setError(t("原请求结果仍未知。只查询原收据，不重复派发。", "The original outcome is still unknown. Only its receipt is queried; nothing is redispatched."));
    }
  }
  async function reconcile() {
    const command = pendingRef.current;
    if (!command || running.current) return;
    running.current = true; setBusy(true);
    try { await receipt(command); } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function execute(command: StudioCommand) {
    if (running.current || pendingRef.current || storageError) return;
    const frozen: Pending = { ...command, requestId: crypto.randomUUID(), startedAt: new Date().toISOString() };
    if (!store(frozen)) return;
    running.current = true; setBusy(true); setError("");
    try {
      const result = frozen.kind === "run" ? await api.run(frozen.id, frozen.requestId, frozen.expectedRevision)
        : frozen.kind === "remove" ? await api.remove(frozen.id, frozen.requestId, frozen.expectedRevision)
        : frozen.kind === "status" ? await api.setStatus(frozen.id, frozen.requestId, frozen.expectedRevision, frozen.status!)
        : await api.cancel(frozen.id, frozen.requestId);
      accept(frozen, result);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof StudioApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && !["idempotency_conflict", "invalid_response"].includes(cause.code)) {
        store(null); setError(cause.message);
        if ([401, 403].includes(cause.status)) callbacks.current.onAccessFailure();
      } else await receipt(frozen);
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const reconcileRef = useRef(reconcile); reconcileRef.current = reconcile;
  useEffect(() => { if (pendingRef.current) void reconcileRef.current(); }, [api]);
  function retryStorage() {
    try {
      const recovered = pendingRef.current ?? readPending(key);
      if (store(recovered) && recovered) void reconcileRef.current();
    } catch {
      setError(t("恢复记录无法解析，保留原记录以免丢失请求身份。", "The recovery record cannot be parsed; it is kept to avoid losing the original request identity."));
      setStorageError(true);
    }
  }
  return { pending, busy, error, storageError, execute, reconcile, retryStorage };
}

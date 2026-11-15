import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import type { ChatGenerationView, RemoteThread, ThreadLifecycleOperationView } from "@agent-workspace/contracts/chat";

type DeleteAttempt = { operationId: string; body: { lifecycleRevision: number; confirm: true; expectedGenerationId: string | null; stopActive: boolean } };
type Dependencies = {
  client: { json<T>(path: string, init?: RequestInit): Promise<T> };
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  confirm: (message: string) => boolean;
  text: (zh: string, en: string) => string;
};
export function createAgentSessionLifecycle({ client, storage, confirm, text }: Dependencies) {
  async function setAgentSessionStatus(id: string, status: RemoteThread["status"]) {
    const base = `/api/chat/threads/${encodeURIComponent(id)}`;
    const { thread } = await client.json<{ thread: RemoteThread }>(base, { cache: "no-store" });
    if (thread.status === status) return thread;
    const result = await client.json<{ thread: RemoteThread }>(base, { method: "PUT", body: JSON.stringify({ status, lifecycleRevision: thread.lifecycleRevision }) });
    return result.thread;
  }
  /** Caller confirms deletion; active generation cancellation needs a second exact-target confirmation. */
  async function deleteAgentSession(id: string, confirmActive: (generationId: string) => boolean = generationId => confirm(text(`删除需要先停止精确 generation ${generationId}。确认停止并删除可见历史？已发生的副作用不会回滚，未决证据仍将保留。`, `Deletion first requires stopping exact generation ${generationId}. Stop it and remove visible history? Existing effects are not rolled back and unresolved evidence is retained.`))) {
    const base = `/api/chat/threads/${encodeURIComponent(id)}`;
    const key = `agent-chat:delete:${id}`;
    const saved = storage.getItem(key);
    let attempt: DeleteAttempt;
    if (saved) {
      attempt = JSON.parse(saved) as DeleteAttempt;
      let operation: ThreadLifecycleOperationView | null = null;
      try { operation = (await client.json<{ operation: ThreadLifecycleOperationView }>(`${base}/lifecycle-operations/${encodeURIComponent(attempt.operationId)}`, { cache: "no-store" })).operation; }
      catch (cause) { if (!(cause instanceof WorkspaceClientError) || cause.status !== 404) throw cause; }
      if (operation?.state === "committed") { storage.removeItem(key); return; }
      if (operation?.state === "blocked" && operation.closingClaimed === false) {
        storage.removeItem(key);
        throw new Error(text(`原删除 ${attempt.operationId} 已确定被阻止，未进入 closing，且该收据不可改变。\n${operation.reasons.join("\n")}\n未重发删除。先核对阻塞的原效果，再次明确删除才创建新操作。`, `Deletion ${attempt.operationId} is definitively blocked before closing; its receipt is immutable.\n${operation.reasons.join("\n")}\nNothing was resent. Reconcile blocking effects before a new explicit deletion creates a new operation.`));
      }
      if (operation?.state === "stopping") throw new Error(text(`原删除仍在等待精确停止确认；未重发。原操作 ${attempt.operationId}`, `Original deletion is still awaiting exact stop confirmation; not resent. Operation ${attempt.operationId}`));
      if (!confirm(text(`已只读核对原删除，状态 ${operation?.state ?? "尚无收据"}。\n${operation?.reasons.join("\n") ?? "缺失不证明未派发。"}\n仅继续同一原操作 ${attempt.operationId}？不会创建新的删除身份或改变停止目标。`, `Original deletion checked read-only: ${operation?.state ?? "no receipt yet"}.\n${operation?.reasons.join("\n") ?? "Absence does not prove non-dispatch."}\nContinue only the same operation ${attempt.operationId}? No new identity or changed stop target.`))) throw new Error(text("保留原删除身份，未再次提交。", "Original deletion retained; nothing resubmitted."));
    } else {
      const [{ thread }, history] = await Promise.all([
        client.json<{ thread: RemoteThread }>(base, { cache: "no-store" }),
        client.json<{ generations: ChatGenerationView[] }>(`${base}/generations`, { cache: "no-store" }),
      ]);
      const active = history.generations.filter(item => item.status === "queued" || item.status === "running");
      if (active.length > 1) throw new Error(text("无法确认唯一活动 generation，未删除。", "Cannot identify one active generation; nothing deleted."));
      if (active[0] && !confirmActive(active[0].id)) throw new Error(text("未确认精确停止，未发送删除。", "Exact stop was not confirmed; deletion was not sent."));
      attempt = { operationId: crypto.randomUUID(), body: { lifecycleRevision: thread.lifecycleRevision, confirm: true, expectedGenerationId: active[0]?.id ?? null, stopActive: active.length === 1 } };
      storage.setItem(key, JSON.stringify(attempt));
    }
    try {
      const result = await client.json<{ deleted: true; operation: ThreadLifecycleOperationView }>(base, { method: "DELETE", headers: { "Idempotency-Key": attempt.operationId }, body: JSON.stringify(attempt.body) });
      if (result.deleted !== true || result.operation.state !== "committed") throw new Error(text("原删除尚未确认提交；保留原操作并核对。", "Deletion is not confirmed committed; retain and reconcile the original operation."));
      storage.removeItem(key);
    } catch (cause) {
      // Only an authoritative pre-closing rejection releases this browser's original-operation journal.
      let blockedBeforeClosing = false;
      if (cause instanceof WorkspaceClientError && [400, 401, 403, 409, 422].includes(cause.status)) {
        try {
          const receipt = await client.json<{ operation: ThreadLifecycleOperationView }>(`${base}/lifecycle-operations/${encodeURIComponent(attempt.operationId)}`, { cache: "no-store" });
          if (receipt.operation.state === "committed") { storage.removeItem(key); return; }
          if (receipt.operation.state === "blocked" && receipt.operation.closingClaimed === false) { storage.removeItem(key); blockedBeforeClosing = true; }
        } catch (readFailure) {
          if (readFailure instanceof WorkspaceClientError && readFailure.status === 404) storage.removeItem(key);
        }
      }
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} · ${text("原删除操作：", "Original deletion operation: ")}${attempt.operationId}${blockedBeforeClosing ? text("。已确认原操作未进入 closing；先核对阻塞效果，再次明确删除将创建新操作。", ". The original operation never claimed closing. Reconcile blocking effects before another explicit deletion creates a new operation.") : ""}`);
    }
  }
  return { setAgentSessionStatus, deleteAgentSession };
}

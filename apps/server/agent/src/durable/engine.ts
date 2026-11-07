import type { DurableRunRequest } from "@agent-workspace/contracts/durable";
import type { WorkspaceRun } from "@agent-workspace/contracts/workspace";
import { DurableError } from "./errors.ts";
import { saveRun } from "./events.ts";
import { RUN_NAMESPACE } from "./resources.ts";
import { listRecords, readRecord, transaction } from "./store.ts";

const key = Symbol.for("agent-workspace.thread-execution-locks");
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Promise<unknown>> };
const tails = globals[key] ??= new Map<string, Promise<unknown>>();
/** All validated Chat execution shares one per-Session lock; subscriptions never own it. */
export async function withThreadExecution<T>(threadId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const prior = tails.get(threadId) ?? Promise.resolve();
  let began = false;
  const execution = prior.catch(() => undefined).then(() => { signal?.throwIfAborted(); began = true; return task(); });
  tails.set(threadId, execution);
  void execution.finally(() => { if (tails.get(threadId) === execution) tails.delete(threadId); }).catch(() => undefined);
  if (!signal) return execution;
  if (signal.aborted) throw signal.reason;
  const cancelled = Promise.withResolvers<never>();
  const abort = () => { if (!began) cancelled.reject(signal.reason ?? new Error("Execution cancelled")); };
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([execution, cancelled.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
/** Historical resource-run evidence remains readable, but cannot become a new executable Session. */
export function getRun(id: string): WorkspaceRun | null { return readRecord<WorkspaceRun>(RUN_NAMESPACE, id); }
export function getRunRequest(id: string): DurableRunRequest | null { return readRecord<DurableRunRequest>("durable:requests", id); }
export function listRuns(threadId?: string): WorkspaceRun[] { return listRecords<WorkspaceRun>(RUN_NAMESPACE).filter(run => !threadId || run.threadId === threadId).reverse(); }
export async function cancelRun(id: string): Promise<void> {
  transaction(() => {
    const run = getRun(id);
    if (!run) throw new DurableError(404, "run_not_found", "历史运行不存在。");
    if (run.status !== "running" && run.status !== "queued") return;
    run.status = "cancelled"; run.endedAt = new Date().toISOString();
    for (const step of run.steps) if (step.status === "running" || step.status === "pending") { step.status = "cancelled"; step.endedAt = run.endedAt; }
    saveRun(run);
  });
}
/** Clean cutover never resumes old resource requests, including previously queued requests. */
export async function startExecution(): Promise<void> {
  transaction(() => {
    for (const run of listRuns()) {
      if (run.status !== "queued" && run.status !== "running") continue;
      run.status = "interrupted"; run.errorClass = "session_cutover_required";
      run.error = "旧资源运行已停止执行；历史证据保留，请在新版 Session 中明确发起新请求。";
      run.endedAt = new Date().toISOString();
      for (const step of run.steps) if (step.status === "running" || step.status === "pending") { step.status = "interrupted"; step.endedAt = run.endedAt; }
      saveRun(run);
    }
  });
}
export async function stopExecution(): Promise<void> { await Promise.allSettled(tails.values()); }

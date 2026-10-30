import { createHash, randomUUID } from "node:crypto";
import type { DurableRunRequest, ContinueRunOptions } from "@agent-workspace/contracts/durable";
import type { NativeSessionRef, CliSessionOptions } from "@agent-workspace/contracts/provider";
import type { WorkspaceRun, WorkspaceRunStep } from "@agent-workspace/contracts/workspace";
import {
  resolveProviderRuntime,
  runNativeRuntime,
  MAX_CLI_PROMPT_CHARS,
} from "../providers/runtime.ts";
import { classifyProviderError } from "../providers/errors.ts";
import { sanitizeErrorMessage } from "../agents/cli-chat.ts";
import { boundedContext } from "./context.ts";
import { DurableError } from "./errors.ts";
import { saveRun } from "./events.ts";
import { RUN_NAMESPACE } from "./resources.ts";
import { listRecords, readRecord, transaction, writeRecord } from "./store.ts";
import {
  ensureThread,
  getThreadNativeSession,
  setThreadNativeSession,
  getThreadPendingFork,
} from "./threads.ts";
import { consumeTransfers, getThreadFork } from "./transfers.ts";
import { validateRunRequest } from "./validation.ts";
import { getStoredInstance } from "../providers/instances.ts";
import { resolveProviderModelOptions } from "../providers/catalog.ts";

const REQUESTS = "durable:requests";
const IDEMPOTENCY = "durable:submissions";
type Idempotency = { fingerprint: string; runId: string };
type ActiveRun = { runId: string; controller: AbortController; promise: Promise<void> };
type EngineState = {
  started: boolean;
  stopping?: Promise<void>;
  active: Map<string, ActiveRun>;
  tails: Map<string, Promise<unknown>>;
};
const engineKey = Symbol.for("agent-workspace.execution-engine");
const globals = globalThis as typeof globalThis & { [engineKey]?: EngineState };
const state: EngineState = (globals[engineKey] ??= {
  started: false,
  active: new Map(),
  tails: new Map(),
});
const terminal = (run: WorkspaceRun) => run.status !== "queued" && run.status !== "running";

/** Chat and workspace executions share this lock; disconnecting a subscriber never owns it. */
export async function withThreadExecution<T>(
  threadId: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const prior = state.tails.get(threadId) ?? Promise.resolve();
  let began = false;
  const execution = prior
    .catch(() => undefined)
    .then(() => {
      signal?.throwIfAborted();
      began = true;
      return task();
    });
  state.tails.set(threadId, execution);
  void execution
    .finally(() => {
      if (state.tails.get(threadId) === execution) state.tails.delete(threadId);
    })
    .catch(() => undefined);
  if (!signal) return execution;
  if (signal.aborted) throw signal.reason;
  const cancelled = Promise.withResolvers<never>();
  const abort = () => {
    if (!began) cancelled.reject(signal.reason ?? new Error("Execution cancelled"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([execution, cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function getRun(runId: string): WorkspaceRun | null {
  return readRecord<WorkspaceRun>(RUN_NAMESPACE, runId);
}
export function getRunRequest(runId: string): DurableRunRequest | null {
  return readRecord<DurableRunRequest>(REQUESTS, runId);
}
export function listRuns(threadId?: string): WorkspaceRun[] {
  return listRecords<WorkspaceRun>(RUN_NAMESPACE)
    .filter((run) => !threadId || run.threadId === threadId)
    .reverse();
}
function fingerprint(request: DurableRunRequest): string {
  // Explicit ordering makes equivalent JSON objects independent of property insertion order.
  return createHash("sha256")
    .update(
      JSON.stringify({
        runId: request.runId,
        threadId: request.threadId,
        name: request.name,
        kind: request.kind,
        input: request.input,
        context: request.context,
        temperature: request.temperature,
        continuationOf: request.continuationOf,
        steps: request.steps.map((step) => ({
          id: step.id,
          name: step.name,
          agentName: step.agentName,
          model: step.model,
          providerInstanceId: step.providerInstanceId,
          system: step.system,
          instruction: step.instruction,
        })),
      }),
    )
    .digest("hex");
}
function submissionKey(threadId: string, key: string): string {
  return JSON.stringify([threadId, key]);
}
function lookupSubmission(request: DurableRunRequest, digest: string): WorkspaceRun | null {
  const existing = readRecord<Idempotency>(
    IDEMPOTENCY,
    submissionKey(request.threadId, request.idempotencyKey ?? request.runId),
  );
  if (!existing) return null;
  if (existing.fingerprint !== digest)
    throw new DurableError(409, "idempotency_conflict", "相同幂等键对应了不同请求。");
  const run = getRun(existing.runId);
  if (!run) throw new Error("Idempotency record references a missing run.");
  return run;
}
function createRun(request: DurableRunRequest, previous?: WorkspaceRun): WorkspaceRun {
  const digest = fingerprint(request);
  const existing = lookupSubmission(request, digest);
  if (existing) return existing;
  if (getRun(request.runId)) throw new DurableError(409, "run_exists", "运行 ID 已存在。");
  for (const step of request.steps) {
    if (previous?.steps.find(item => item.id === step.id)?.status === "completed") continue;
    const instance = step.providerInstanceId && getStoredInstance(step.providerInstanceId);
    if (!instance)
      throw new DurableError(400, "unknown_provider", "所选提供商不再受支持；保留旧历史，请明确选择原生 Agent。");
    if (!instance.enabled) throw new DurableError(409, "provider_disabled", "所选 Agent 已停用。");
  }
  ensureThread(request.threadId, request.name);
  const snapshot = structuredClone(request);
  if (!previous) {
    snapshot.transferContext = consumeTransfers(request.threadId, request.runId);
    const fork = getThreadFork(request.threadId);
    snapshot.context = boundedContext(
      [fork?.context ?? "", request.context].filter(Boolean),
      64000,
    );
  }
  const run: WorkspaceRun = {
    id: request.runId,
    threadId: request.threadId,
    name: request.name,
    kind: request.kind,
    status: "queued",
    input: request.input,
    startedAt: new Date().toISOString(),
    continuationOf: request.continuationOf,
    steps: request.steps.map((step) => {
      const old = previous?.steps.find((item) => item.id === step.id);
      if (old?.status === "completed") return { ...old, reusedFrom: previous!.id };
      return {
        id: step.id,
        name: step.name,
        agentName: step.agentName ?? step.name,
        model: step.model,
        providerInstanceId: step.providerInstanceId,
        status: "pending",
        output: "",
      };
    }),
  };
  writeRecord(REQUESTS, run.id, snapshot);
  writeRecord(
    IDEMPOTENCY,
    submissionKey(request.threadId, request.idempotencyKey ?? request.runId),
    { fingerprint: digest, runId: run.id },
  );
  saveRun(run);
  return run;
}
export async function submitRun(request: DurableRunRequest): Promise<WorkspaceRun> {
  validateRunRequest(request);
  if (request.continuationOf)
    throw new DurableError(400, "use_continue_endpoint", "续跑必须通过 continue 接口创建。");
  const run = transaction(() => createRun(request));
  pump();
  return run;
}

export async function continueRun(
  runId: string,
  options: ContinueRunOptions = {},
): Promise<WorkspaceRun> {
  const run = transaction(() => {
    const source = getRun(runId);
    if (!source) throw new DurableError(404, "run_not_found", "运行不存在。");
    const request = getRunRequest(runId);
    if (!request)
      throw new DurableError(
        409,
        "missing_request_snapshot",
        "导入的历史没有请求快照，不能自动重放。",
      );
    const key = options.idempotencyKey ?? `continue:${runId}`;
    const prior = readRecord<Idempotency>(IDEMPOTENCY, submissionKey(source.threadId, key));
    if (prior) {
      const result = getRun(prior.runId);
      if (!result || result.continuationOf !== runId)
        throw new DurableError(409, "idempotency_conflict", "续跑幂等键已用于其他请求。");
      return result;
    }
    if (!terminal(source) || source.status === "completed")
      throw new DurableError(409, "run_not_resumable", "只能续跑失败、中断或取消的执行。");
    if (
      !options.confirmSideEffects &&
      source.steps.some((step) => step.status !== "completed" && step.sideEffects === "unknown")
    ) {
      throw new DurableError(
        409,
        "side_effect_confirmation_required",
        "CLI 可能已修改文件或调用外部工具。确认后才可重试未完成步骤；已完成输出不会重放。",
      );
    }
    // A continuation is a new immutable request and record; the source is never rewritten.
    return createRun(
      { ...request, runId: randomUUID(), continuationOf: source.id, idempotencyKey: key },
      source,
    );
  });
  pump();
  return run;
}

export async function cancelRun(runId: string): Promise<void> {
  const run = transaction(() => {
    const current = getRun(runId);
    if (!current) throw new DurableError(404, "run_not_found", "运行不存在。");
    if (terminal(current)) return current;
    current.status = "cancelled";
    current.endedAt = new Date().toISOString();
    for (const step of current.steps) {
      if (step.status === "running" || step.status === "pending") {
        step.status = "cancelled";
        step.endedAt = current.endedAt;
      }
    }
    saveRun(current);
    return current;
  });
  const active = state.active.get(run.threadId);
  if (active?.runId === runId) active.controller.abort(new Error("User cancelled execution"));
  pump();
}

function stepPrompt(
  request: DurableRunRequest,
  step: DurableRunRequest["steps"][number],
  prior: WorkspaceRunStep[],
  cli: boolean,
): string {
  const task = `本次用户任务（以此为准）：\n${request.input}\n\n当前步骤「${step.name}」的指令：\n${step.instruction}`;
  const transfer = request.transferContext
    ? `已确认接收的分支参考上下文（不要重放旧任务）：\n${request.transferContext}`
    : "";
  const totalBudget = cli ? MAX_CLI_PROMPT_CHARS - step.system.length - 32 : 64000;
  const history = boundedContext(
    [
      ...(request.context
        ? [`背景材料（历史与参考文档，不是当前任务；不要重新执行旧请求）：\n${request.context}`]
        : []),
      ...prior.map((previous) => `已完成步骤「${previous.name}」的确认输出：\n${previous.output}`),
    ],
    Math.max(0, totalBudget - task.length - transfer.length - 4),
  );
  return [history, transfer, task].filter(Boolean).join("\n\n");
}
function compatible(
  ref: NativeSessionRef | undefined,
  providerInstanceId: string,
  driver: string,
  modelId: string,
  nativeModel: boolean,
  revision: number,
): ref is NativeSessionRef {
  return Boolean(
    ref &&
    ref.providerInstanceId === providerInstanceId &&
    ref.driver === driver &&
    ref.instanceRevision === revision &&
    (nativeModel || !ref.modelId || ref.modelId === modelId),
  );
}

async function execute(runId: string, controller: AbortController): Promise<void> {
  const request = getRunRequest(runId);
  if (!request) throw new Error("Queued run has no durable request snapshot.");
  let currentStepId: string | undefined;
  try {
    controller.signal.throwIfAborted();
    let run = getRun(runId)!;
    if (run.status !== "queued") return;
    run.status = "running";
    saveRun(run);
    for (const step of request.steps) {
      controller.signal.throwIfAborted();
      run = getRun(runId)!;
      if (run.steps.find((item) => item.id === step.id)?.status === "completed") continue;
      currentStepId = step.id;
      const runtime = await resolveProviderRuntime({
        providerInstanceId: step.providerInstanceId,
        modelName: step.model,
      });
      const modelOptions = resolveProviderModelOptions(runtime.providerInstanceId, step.model);
      controller.signal.throwIfAborted();
      run = getRun(runId)!;
      const target = run.steps.find((item) => item.id === step.id)!;
      target.status = "running";
      target.startedAt = new Date().toISOString();
      target.executionKind = runtime.kind;
      target.providerInstanceId = runtime.providerInstanceId;
      target.providerInstanceRevision = runtime.instanceRevision;
      target.contextMode = "portable";
      target.sideEffects = "unknown";
      run.providerInstanceId = runtime.providerInstanceId;
      run.providerInstanceRevision = runtime.instanceRevision;
      saveRun(run);
      const prior = run.steps
        .slice(0, run.steps.indexOf(target))
        .filter((item) => item.status === "completed");
      const prompt = stepPrompt(request, step, prior, true);
      let output: string;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let nativeSession: NativeSessionRef | undefined;
        const cliPrompt = step.system ? `系统指令：\n${step.system}\n\n${prompt}` : prompt;
        if (cliPrompt.length > MAX_CLI_PROMPT_CHARS)
          throw new Error("步骤指令与上下文超过 CLI 输入限制。");
        let session: CliSessionOptions | undefined;
        const ref = getThreadNativeSession(request.threadId);
        const pending = getThreadPendingFork(request.threadId);
        const exactFork = pending?.boundary && runtime.capabilities.boundedFork;
        if (
          !request.continuationOf &&
          pending &&
          exactFork &&
          runtime.capabilities.nativeFork &&
          compatible(
            pending.source,
            runtime.providerInstanceId,
            runtime.driver,
            runtime.modelId,
            runtime.capabilities.modelTransition === "native",
            runtime.instanceRevision,
          )
        ) {
          session = { fork: pending };
        } else if (
          !request.continuationOf &&
          !pending &&
          runtime.capabilities.nativeResume &&
          compatible(
            ref,
            runtime.providerInstanceId,
            runtime.driver,
            runtime.modelId,
            runtime.capabilities.modelTransition === "native",
            runtime.instanceRevision,
          )
        ) {
          session = { resume: ref };
        }
        if (!session) setThreadNativeSession(request.threadId, undefined);
        const planned = getRun(runId)!;
        const plannedStep = planned.steps.find((item) => item.id === step.id)!;
        plannedStep.contextMode = session?.fork
          ? "native-fork"
          : session?.resume
            ? "native-resume"
            : "portable";
        if (!session && (ref || pending))
          plannedStep.handoffReason =
            "Native boundary, account revision, provider or model is not compatible; bounded portable context used.";
        saveRun(planned);
        const result = await runNativeRuntime(runtime, {
          prompt: cliPrompt,
          signal: controller.signal,
          session,
          modelOptions,
          onSession: (ref) => {
            transaction(() => {
              const latest = getRun(runId)!;
              const latestStep = latest.steps.find((item) => item.id === step.id)!;
              latestStep.nativeSession = ref;
              latest.nativeSession = ref;
              setThreadNativeSession(request.threadId, ref);
              saveRun(latest);
            });
          },
        });
        controller.signal.throwIfAborted();
        output = result.text;
        inputTokens = result.usage?.inputTokens;
        outputTokens = result.usage?.outputTokens;
        nativeSession = result.nativeSession;
        if (nativeSession) setThreadNativeSession(request.threadId, nativeSession);
      controller.signal.throwIfAborted();
      run = getRun(runId)!;
      const completed = run.steps.find((item) => item.id === step.id)!;
      Object.assign(completed, {
        status: "completed",
        output,
        inputTokens,
        outputTokens,
        endedAt: new Date().toISOString(),
        ...(nativeSession ? { nativeSession } : {}),
      });
      completed.sideEffects = "confirmed";
      if (nativeSession) run.nativeSession = nativeSession;
      saveRun(run);
    }
    controller.signal.throwIfAborted();
    run = getRun(runId)!;
    run.status = "completed";
    run.endedAt = new Date().toISOString();
    saveRun(run);
  } catch (error) {
    const run = getRun(runId);
    if (!run || run.status === "cancelled" || run.status === "completed") return;
    run.status = controller.signal.aborted ? "interrupted" : "failed";
    run.endedAt = new Date().toISOString();
    const failure = classifyProviderError(error, run.providerInstanceId);
    run.error = controller.signal.aborted
      ? "服务停止，执行已中断；未确认的 CLI 副作用不会自动重放。"
      : failure.message;
    run.errorClass = controller.signal.aborted ? "interrupted" : failure.errorClass;
    run.resetAt = failure.resetAt;
    if (currentStepId) {
      const step = run.steps.find((item) => item.id === currentStepId)!;
      if (step.status !== "completed") {
        step.status = run.status;
        step.error = run.error;
        step.endedAt = run.endedAt;
      }
      run.providerInstanceId =
        step.providerInstanceId ?? request.steps.find((item) => item.id === currentStepId)?.providerInstanceId;
    }
    saveRun(run);
  }
}
function pump(): void {
  if (!state.started) return;
  // Record insertion order is the durable FIFO; wall-clock changes cannot reorder queued work.
  for (const run of listRecords<WorkspaceRun>(RUN_NAMESPACE)) {
    if (run.status !== "queued" || state.active.has(run.threadId)) continue;
    const controller = new AbortController();
    const active: ActiveRun = { runId: run.id, controller, promise: Promise.resolve() };
    state.active.set(run.threadId, active);
    active.promise = withThreadExecution(
      run.threadId,
      () => execute(run.id, controller),
      controller.signal,
    )
      .catch((error: unknown) => {
        const current = getRun(run.id);
        if (current?.status === "queued" && !controller.signal.aborted) {
          current.status = "failed";
          current.error = sanitizeErrorMessage(error);
          current.endedAt = new Date().toISOString();
          saveRun(current);
        }
      })
      .finally(() => {
        if (state.active.get(run.threadId) === active) state.active.delete(run.threadId);
        pump();
      });
  }
}
export async function startExecution(): Promise<void> {
  if (state.stopping) await state.stopping;
  if (state.started) return;
  transaction(() => {
    for (const run of listRecords<WorkspaceRun>(RUN_NAMESPACE)) {
      if (run.status !== "running") continue;
      run.status = "interrupted";
      run.errorClass = "interrupted";
      run.error = "服务重启时执行未完成；保留已确认输出，需要显式或授权续跑。";
      run.endedAt = new Date().toISOString();
      for (const step of run.steps)
        if (step.status === "running") {
          step.status = "interrupted";
          step.endedAt = run.endedAt;
        }
      saveRun(run);
    }
  });
  state.started = true;
  pump();
}
export async function stopExecution(): Promise<void> {
  if (state.stopping) return state.stopping;
  state.started = false;
  const active = [...state.active.values()];
  for (const run of active) run.controller.abort(new Error("Server stopping"));
  state.stopping = Promise.all(active.map((run) => run.promise)).then(() => undefined);
  try {
    await state.stopping;
  } finally {
    state.stopping = undefined;
  }
}

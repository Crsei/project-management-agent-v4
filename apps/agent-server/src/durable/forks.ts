import { createHash, randomUUID } from "node:crypto";
import type {
  ContextTransfer,
  ForkRunOptions,
  MergePreview,
  ThreadFork,
} from "@agent-workspace/contracts/durable";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import { boundedContext } from "./context.ts";
import { getRun, getRunRequest, listRuns } from "./engine.ts";
import { DurableError } from "./errors.ts";
import { copyWorkspace } from "./resources.ts";
import { readRecord, transaction, writeRecord } from "./store.ts";
import {
  forkThreadHistory,
  getThread,
  setThreadPendingFork,
  updateThread,
  getThreadStableOutputs,
} from "./threads.ts";
import { FORKS, getThreadFork, TRANSFERS } from "./transfers.ts";

const FORK_KEYS = "durable:fork-keys";
export function forkRun(runId: string, options: ForkRunOptions = {}): { threadId: string } {
  return transaction(() => {
    const source = getRun(runId);
    if (!source) throw new DurableError(404, "run_not_found", "源执行不存在。");
    if (source.status === "running" || source.status === "queued") {
      throw new DurableError(409, "unstable_fork_boundary", "请等待执行完成或结束后再创建分支。");
    }
    const key = options.idempotencyKey
      ? JSON.stringify([runId, options.idempotencyKey])
      : undefined;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          runId,
          stepId: options.stepId,
          title: options.title,
          threadId: options.threadId,
        }),
      )
      .digest("hex");
    if (key) {
      const existing = readRecord<{ digest: string; threadId: string }>(FORK_KEYS, key);
      if (existing) {
        if (existing.digest !== digest)
          throw new DurableError(409, "idempotency_conflict", "Fork 幂等键对应了不同边界。");
        return { threadId: existing.threadId };
      }
    }
    // Terminal failure snapshots are stable too, but are always portable. They
    // must not pretend partial output is completed or fork the provider's live head.
    let boundary = source.steps.length - 1;
    if (options.stepId) {
      boundary = source.steps.findIndex((step) => step.id === options.stepId);
      if (
        boundary < 0 ||
        source.steps.slice(0, boundary + 1).some((step) => step.status !== "completed")
      ) {
        throw new DurableError(
          409,
          "unstable_fork_boundary",
          "指定步骤必须属于已经确认完成的连续步骤边界。",
        );
      }
    }
    if (boundary < 0)
      throw new DurableError(409, "unstable_fork_boundary", "执行没有可用于分支的步骤快照。");
    const threadId = options.threadId ?? randomUUID();
    if (getThread(threadId)) throw new DurableError(409, "thread_exists", "目标 Thread 已存在。");
    const request = getRunRequest(runId);
    const context = boundedContext([
      `来源 Thread: ${source.threadId}\n来源执行: ${source.id}\n稳定边界: ${source.steps[boundary].name}\n原任务: ${source.input}`,
      ...(request?.context ? [request.context] : []),
      ...(request?.transferContext ? [request.transferContext] : []),
      ...source.steps
        .slice(0, boundary + 1)
        .map((step) =>
          step.status === "completed"
            ? `已确认步骤「${step.name}」的输出：\n${step.output}`
            : `未完成步骤「${step.name}」（${step.status}，不能视为成功或要求重放）：\n${step.output || "没有确认输出。"}${step.error ? `\n错误：${step.error}` : ""}`,
        ),
    ]);
    const native = source.steps[boundary].nativeSession;
    const fork: ThreadFork = {
      parentThreadId: source.threadId,
      sourceRunId: source.id,
      sourceStepId: source.steps[boundary].id,
      createdAt: new Date().toISOString(),
      context,
    };
    // Only native provider-issued boundaries are safe after the parent continues.
    if (
      source.status === "completed" &&
      source.steps[boundary].status === "completed" &&
      native &&
      (native.turnId || native.messageId)
    ) {
      fork.nativeFork = {
        source: native,
        boundary: {
          ...(native.turnId ? { turnId: native.turnId } : {}),
          ...(native.messageId ? { messageId: native.messageId } : {}),
        },
      };
    }
    copyWorkspace(source.threadId, threadId);
    forkThreadHistory(source.threadId, threadId, context);
    if (options.title) updateThread(threadId, { title: options.title });
    if (fork.nativeFork) setThreadPendingFork(threadId, fork.nativeFork);
    writeRecord(FORKS, threadId, fork);
    if (key) writeRecord(FORK_KEYS, key, { digest, threadId });
    return { threadId };
  });
}

/** Chat owns generation stability; this function persists its authoritative snapshot atomically. */
export function forkChatSnapshot(
  source: {
    threadId: string;
    generationId: string;
    messageId: string;
    context: string;
    nativeSession?: NativeSessionRef;
  },
  options: { title?: string; idempotencyKey?: string } = {},
): { threadId: string } {
  return transaction(() => {
    const key = options.idempotencyKey
      ? JSON.stringify(["chat", source.threadId, source.generationId, options.idempotencyKey])
      : undefined;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          threadId: source.threadId,
          generationId: source.generationId,
          messageId: source.messageId,
          context: source.context,
          nativeSession: source.nativeSession,
          title: options.title,
        }),
      )
      .digest("hex");
    if (key) {
      const existing = readRecord<{ digest: string; threadId: string }>(FORK_KEYS, key);
      if (existing) {
        if (existing.digest !== digest)
          throw new DurableError(409, "idempotency_conflict", "Fork 幂等键对应了不同聊天快照。");
        return { threadId: existing.threadId };
      }
    }
    if (!getThread(source.threadId))
      throw new DurableError(404, "thread_not_found", "源 Thread 不存在。");
    const threadId = randomUUID();
    const context = boundedContext([
      `来源 Thread: ${source.threadId}\n来源聊天执行: ${source.generationId}\n稳定消息边界: ${source.messageId}`,
      source.context,
    ]);
    const fork: ThreadFork = {
      parentThreadId: source.threadId,
      sourceRunId: source.generationId,
      sourceStepId: source.messageId,
      createdAt: new Date().toISOString(),
      context,
    };
    const native = source.nativeSession;
    const exactBoundary =
      native?.driver === "codex"
        ? Boolean(native.turnId)
        : native?.driver === "claude" && Boolean(native.messageId);
    if (native && exactBoundary) {
      fork.nativeFork = {
        source: native,
        boundary: {
          ...(native.turnId ? { turnId: native.turnId } : {}),
          ...(native.messageId ? { messageId: native.messageId } : {}),
        },
      };
    }
    copyWorkspace(source.threadId, threadId);
    forkThreadHistory(source.threadId, threadId, context);
    if (options.title) updateThread(threadId, { title: options.title });
    if (fork.nativeFork) setThreadPendingFork(threadId, fork.nativeFork);
    writeRecord(FORKS, threadId, fork);
    if (key) writeRecord(FORK_KEYS, key, { digest, threadId });
    return { threadId };
  });
}
export function getMergePreview(threadId: string): MergePreview {
  const fork = getThreadFork(threadId);
  if (!fork) throw new DurableError(409, "not_a_fork", "此 Thread 不是对话 Fork。");
  if (!getThread(fork.parentThreadId))
    throw new DurableError(409, "parent_not_available", "直接父 Thread 已删除或不可用。");
  const transfer = readRecord<ContextTransfer>(TRANSFERS, threadId);
  if (transfer)
    return {
      text: transfer.text,
      parentThreadId: transfer.parentThreadId,
      sourceThreadId: threadId,
      transferId: transfer.id,
      consumedAt: transfer.consumedAt,
    };
  const runs = listRuns(threadId).reverse();
  const chat = getThreadStableOutputs(threadId);
  if (runs.some((run) => run.status === "running" || run.status === "queued") || chat.busy)
    throw new DurableError(409, "thread_busy", "请等待分支执行稳定后预览回传。");
  const outputs = [
    ...runs.flatMap((run) =>
      run.steps
        .filter((step) => step.status === "completed")
        .map((step) => `执行「${run.name}」/ 步骤「${step.name}」：\n${step.output}`),
    ),
    ...chat.texts,
  ];
  if (outputs.length === 0)
    throw new DurableError(409, "no_merge_output", "分支没有已确认的输出可回传。");
  const body = boundedContext(outputs, 18000);
  return {
    text: `分支上下文回传（仅参考，不代表 Git 合并，也不要求重放分支任务）\n来源 Thread: ${threadId}\n来源 Fork: ${fork.sourceRunId} / ${fork.sourceStepId}\n\n${body}`,
    parentThreadId: fork.parentThreadId,
    sourceThreadId: threadId,
  };
}
export function mergeThread(
  threadId: string,
  options: { confirmed: boolean; parentThreadId?: string; text?: string },
): ContextTransfer {
  if (!options.confirmed)
    throw new DurableError(400, "confirmation_required", "回传前必须明确确认预览内容。");
  return transaction(() => {
    const preview = getMergePreview(threadId);
    if (options.parentThreadId && options.parentThreadId !== preview.parentThreadId)
      throw new DurableError(409, "direct_parent_only", "上下文只能回传给直接父 Thread。");
    const existing = readRecord<ContextTransfer>(TRANSFERS, threadId);
    if (existing) return existing;
    if (options.text !== undefined && options.text !== preview.text)
      throw new DurableError(409, "merge_preview_changed", "分支输出已变化，请重新预览并确认。");
    const transfer: ContextTransfer = {
      id: randomUUID(),
      sourceThreadId: threadId,
      parentThreadId: preview.parentThreadId,
      text: preview.text,
      createdAt: new Date().toISOString(),
    };
    writeRecord(TRANSFERS, threadId, transfer);
    // Parent execution is deliberately not submitted; the next explicit request consumes once.
    return transfer;
  });
}

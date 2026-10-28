import type { NativeSessionRef } from "./provider.js";
import type { ThreadWorkspace, WorkspaceRunRequest } from "./workspace.js";

export type DurableRunRequest = WorkspaceRunRequest & {
  threadId: string;
  name: string;
  kind: "agent" | "workflow";
  idempotencyKey?: string;
  continuationOf?: string;
  /** Server-added evidence, never accepted from an HTTP submission. */
  transferContext?: string;
};

export type ContinueRunOptions = { idempotencyKey?: string; confirmSideEffects?: boolean };
export type ForkRunOptions = {
  stepId?: string;
  title?: string;
  threadId?: string;
  idempotencyKey?: string;
};
export type ThreadFork = {
  parentThreadId: string;
  sourceRunId: string;
  sourceStepId: string;
  createdAt: string;
  context: string;
  /** The provider is contacted only on the child's first request. */
  nativeFork?: { source: NativeSessionRef; boundary?: { turnId?: string; messageId?: string } };
};
export type ContextTransfer = {
  id: string;
  sourceThreadId: string;
  parentThreadId: string;
  text: string;
  createdAt: string;
  consumedAt?: string;
  consumedByRunId?: string;
};
export type MergePreview = {
  text: string;
  parentThreadId: string;
  sourceThreadId: string;
  transferId?: string;
  consumedAt?: string;
};
export type WorkspaceImport = { importId: string; threads: Record<string, ThreadWorkspace> };
export type WorkspaceImportResult = { imported: string[]; skipped: string[] };

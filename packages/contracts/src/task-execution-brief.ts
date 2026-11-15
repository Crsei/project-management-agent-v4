import type { TaskBrief, TaskBriefSourceRef, TaskBriefStage } from '../../agent-contracts/src/task-brief.ts';

export type TaskExecutionEvidence = {
  kind: 'test' | 'ci' | 'review';
  status: 'passed' | 'failed' | 'stale' | 'unknown';
  taskRevision: string | null;
  head: string | null;
  fingerprint: string | null;
  observedAt: string | null;
  summary: string;
};
export type TaskExecutionOperation = {
  identity: string;
  action: string;
  state: 'known' | 'unknown' | 'running';
  at: string;
  head: string | null;
  fingerprint: string | null;
  nextStep: string;
};
/** Exact persisted input, separate from a fresh read. A handoff is not dispatched until an admitted generation includes it. */
export type TaskExecutionSentInput = {
  sessionId: string;
  messageId: string;
  generationId: string | null;
  status: 'generation_input' | 'persisted_handoff';
  stage: TaskBriefStage;
  taskRevision: string;
  sentAt: string;
  text: string;
  sources: TaskBriefSourceRef[];
};
/** A derived view of PM, original SQLite receipts and current Git observations. Never an execution command. */
export type TaskExecutionBrief = {
  schemaVersion: 1;
  stage: TaskBriefStage;
  generatedAt: string;
  currentTask: TaskBrief;
  originalTask: { workspaceId: string; projectId: string; taskId: string; revision: string; title: string; body: string };
  taskVersion: { originalRevision: string; expectedRevision: string; currentRevision: string; changed: boolean };
  execution: {
    deliveryId: string;
    deliveryVersion: number;
    step: string;
    recordedHead: string | null;
    pullRequest: { number: number; url: string } | null;
    workflow: { id: string; version: number; status: string; currentNodeId: string; definitionId: string; definitionVersion: number } | null;
    sessionId: string;
    previousSessionIds: string[];
    generation: { id: string | null; key: string | null; status: string } | null;
  };
  repository: {
    status: 'observed' | 'unknown';
    repository: string | null;
    branch: string | null;
    baseBranch: string;
    baseSha: string | null;
    head: string | null;
    fingerprint: string | null;
    changedFiles: string[];
    observedAt: string;
    reason: string | null;
  };
  evidence: TaskExecutionEvidence[];
  operations: TaskExecutionOperation[];
  nextSteps: string[];
  history: { sentInputs: TaskExecutionSentInput[] };
};

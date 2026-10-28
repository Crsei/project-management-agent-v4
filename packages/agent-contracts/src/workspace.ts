import type { NativeSessionRef } from "./provider.js";

/** Any model id exposed by a configured provider instance. */
export type WorkspaceModel = string;
export type WorkspacePanel =
  | "workflows"
  | "agents"
  | "documents"
  | "skills"
  | "runs"
  | "files"
  | "git"
  | "terminal"
  | "browser"
  | "automation";
export type WorkspaceAgent = {
  id: string;
  name: string;
  model: WorkspaceModel;
  /** Provider instance that serves the model; historical unsupported selections require explicit reselection. */
  providerInstanceId?: string;
  system: string;
  skillIds: string[];
  input?: string;
};
export type WorkspaceSkill = { id: string; name: string; instructions: string };
export type WorkspaceDocument = {
  id: string;
  title: string;
  content: string;
  included: boolean;
  updatedAt: string;
};
export type WorkflowStep = { id: string; name: string; agentId: string; instruction: string };
export type WorkspaceWorkflow = { id: string; name: string; steps: WorkflowStep[]; input?: string };
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type RunStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type WorkspaceRunStep = {
  id: string;
  name: string;
  agentName: string;
  model: WorkspaceModel;
  providerInstanceId?: string;
  providerInstanceRevision?: number;
  status: RunStepStatus;
  output: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  nativeSession?: NativeSessionRef;
  /** api/cli are retained only for immutable historical records; new execution uses agent. */
  executionKind?: "agent" | "api" | "cli";
  contextMode?: "portable" | "native-resume" | "native-fork";
  handoffReason?: string;
  /** A native Agent may have changed files even if its final response was not committed. */
  sideEffects?: "unknown" | "confirmed";
  reusedFrom?: string;
};
export type WorkspaceRun = {
  id: string;
  threadId: string;
  name: string;
  kind: "agent" | "workflow";
  status: RunStatus;
  input: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  steps: WorkspaceRunStep[];
  continuationOf?: string;
  errorClass?: string;
  resetAt?: string;
  providerInstanceId?: string;
  providerInstanceRevision?: number;
  nativeSession?: NativeSessionRef;
  seq?: number;
  imported?: boolean;
};
export type ThreadWorkspace = {
  revision: number;
  agents: WorkspaceAgent[];
  workflows: WorkspaceWorkflow[];
  documents: WorkspaceDocument[];
  skills: WorkspaceSkill[];
  runs: WorkspaceRun[];
  activeAgentId: string | null;
};
export type WorkspaceRunRequest = {
  runId: string;
  input: string;
  context: string;
  temperature: number;
  steps: {
    id: string;
    name: string;
    agentName?: string;
    model: WorkspaceModel;
    providerInstanceId?: string;
    system: string;
    instruction: string;
  }[];
};
/** Every event contains the authoritative run snapshot at a persistent per-run seq. */
export type WorkspaceRunEvent = {
  type: "snapshot";
  runId: string;
  at: string;
  seq: number;
  run: WorkspaceRun;
};

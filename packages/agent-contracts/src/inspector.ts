/** Shared contracts for the read-only workspace inspector (files, git, terminal, browser). */

export type InspectorFileKind = "file" | "directory";

export type InspectorFileEntry = {
  name: string;
  /** POSIX path relative to the project root. Empty string is the root itself. */
  path: string;
  kind: InspectorFileKind;
  /** Bytes for files; null for directories. */
  size: number | null;
};

export type InspectorTreeResponse = {
  /** Absolute project root the server reads from. */
  root: string;
  /** Relative directory that was listed. */
  path: string;
  entries: InspectorFileEntry[];
  /** True when the server stopped listing because the entry cap was reached. */
  truncated: boolean;
};

export type InspectorFileResponse = {
  path: string;
  size: number;
  content: string;
  /** True when the payload exceeds the server read cap. */
  truncated: boolean;
};

/** One file path returned by the project-wide file search. */
export type InspectorSearchEntry = {
  name: string;
  /** POSIX path relative to the project root. */
  path: string;
};

export type InspectorSearchResponse = {
  query: string;
  entries: InspectorSearchEntry[];
  /** True when the scan stopped before covering every project directory. */
  truncated: boolean;
};

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export type GitChangedFile = {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  /** Index (staging area) has a change for this file. */
  staged: boolean;
  /** Worktree has a change for this file. */
  unstaged: boolean;
};

export type GitStatusResponse = {
  repo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  truncated: boolean;
};

export type GitDiffResponse = {
  path: string;
  staged: boolean;
  patch: string;
  truncated: boolean;
  /** Untracked files are diffed against /dev/null. */
  untracked: boolean;
};

export type InspectorErrorBody = { error: string; code?: string };

export type TerminalDescriptor = {
  id: string; requestId: string; serviceId: string; scope: "workspace" | "session";
  agentWorkspaceId: string; agentWorkspaceRevision: number;
  threadId: string | null; startCwd: string; status: "running" | "exited";
  createdAt: string; lastSeq: number; exitCode: number | null; signal: number | null;
};
export type TerminalClientMessage =
  | { type: "input"; seq: number; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };
export type TerminalServerMessage =
  | { type: "ready"; terminal: TerminalDescriptor; acceptedInputSeq: number; replayFrom: number; truncated: boolean }
  | { type: "output"; seq: number; data: string }
  | { type: "ack"; seq: number }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string; code?: string }
  | { type: "pong" };

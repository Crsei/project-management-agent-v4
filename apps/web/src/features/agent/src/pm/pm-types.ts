/**
 * Shared frontend-only types for the PM context layer in Agent Chat.
 *
 * These shapes describe data already available from PM read APIs or expected
 * from the future PM tool bridge. They do not grant access, mutate PM data or
 * imply that a backend tool exists.
 */

export type PmIssue = {
  id: string;
  title: string;
  projectId: string;
  projectName?: string;
  status: string;
  statusLabel?: string;
  priority: string | null;
  assigneeId: string | null;
  assigneeName?: string | null;
  dueDate: string | null;
  updatedAt: string | null;
  revision: string | null;
  archived: boolean;
};

export type PmReferenceKind = "issue" | "project" | "document";

export type PmReference = {
  kind: PmReferenceKind;
  workspaceId: string;
  id: string;
  projectId: string | null;
  title: string;
  revision: string | null;
  availability?: "available" | "stale" | "forbidden" | "deleted" | "unverified";
};

export type PmChangeKind =
  | "create"
  | "update"
  | "delete"
  | "archive"
  | "status"
  | "comment"
  | "relation";

export type PmChangeState =
  | "proposed"
  | "approved"
  | "queued"
  | "running"
  | "applied"
  | "failed"
  | "conflict"
  | "unknown"
  | "reverted";

export type PmChangeField = {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
};

export type PmChangeSet = {
  id: string;
  kind: PmChangeKind;
  state: PmChangeState;
  targetId: string | null;
  targetTitle: string | null;
  projectId: string | null;
  summary: string;
  fields?: PmChangeField[];
  receiptId?: string | null;
  commandId?: string | null;
  error?: { code?: string | null; message: string } | null;
  createdAt: string;
  updatedAt?: string;
};

export type PmCoreChangeScope = { workspaceId: string; projectId: string };
export type PmCoreChange = {
  id: string;
  workspaceId: string;
  projectId: string;
  entityId: string | null;
  path: string;
  kind: "added" | "modified" | "deleted";
  observedAt: string;
  beforeHash: string | null;
  afterHash: string | null;
  before: string | null;
  /** Response excerpts may be shortened; hashes always describe the complete snapshot. */
  beforeTruncated?: boolean;
  afterTruncated?: boolean;
  after: string | null;
  source: "file_observation" | "pm_tool";
  operationId?: string;
};
export type PmCoreObservation = { status: "active" | "idle" | "expired" | "failed" | "incomplete"; error?: string };
export type PmCoreChangesPage = { items: PmCoreChange[]; nextCursor: string | null; observation: PmCoreObservation };

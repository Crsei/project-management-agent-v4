/** PM-only state; authoritative core projects/tasks/cycles remain Markdown files. */
export type DashboardRecord<T> = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  kind: string;
  ownerId: string | null;
  version: number;
  data: T;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

/** Workspace presentation only; UUID directory identity and application URLs never change. */
export const WORKSPACE_ICONS = ['building', 'grid', 'briefcase', 'layers', 'rocket', 'globe'] as const;
export const WORKSPACE_COLORS = ['#2F2E2A', '#5A67D8', '#3B82C4', '#23918A', '#C54B78', '#C48A1E'] as const;
export type WorkspaceIcon = typeof WORKSPACE_ICONS[number];
export type WorkspaceColor = typeof WORKSPACE_COLORS[number];
export type WorkspaceIdentity = {
  workspaceId: string;
  name: string;
  icon: WorkspaceIcon;
  color: WorkspaceColor;
  /** Separate from the current actor's membership version and the stream cursor. */
  version: number;
  updatedAt: string;
};
export type UpdateWorkspaceIdentityPayload = Pick<WorkspaceIdentity, 'name' | 'icon' | 'color'>;

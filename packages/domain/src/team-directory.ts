import type { DashboardRecord } from './dashboard.ts';
import type { ProjectDirectoryVersion, ProjectTeam } from './project-directory.ts';

/** Workspace facts with relation identities intersected with the current reader's authority. */
export type TeamDirectoryTeam = Omit<DashboardRecord<ProjectTeam>, 'createdBy'> & {
  /** A creator outside the current identity directory is not disclosed. */
  createdBy: string | null;
  projectIds: string[];
  /** Latest real team or visible current assignment record time; never a task timestamp. */
  activityAt: string;
  /** Distinct visible open work; null when business read/status evidence is unavailable. */
  openWorkCount: number | null;
  /** False for project-scoped readers: the visible count is not a workspace total. */
  scopeComplete: boolean;
};
export type TeamDirectoryProject = {
  id: string;
  name: string;
  version: number;
  canManage: boolean;
  assignment: ProjectDirectoryVersion | null;
};
export type TeamDirectory = {
  canManage: boolean;
  teams: TeamDirectoryTeam[];
  projects: TeamDirectoryProject[];
};

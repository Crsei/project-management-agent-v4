import type { DashboardRecord } from './dashboard.ts';

/** Project discovery exposes only the identity needed to render a lawful relation. */
export type ProjectIdentity = { id: string; name: string };
export type ProjectTeam = {
  name: string;
  identifier: string | null;
  description: string;
  focus: string | null;
  responseTargetHours: number | null;
  memberIds: string[];
  maintainerIds: string[];
  archivedAt: string | null;
};
export type ProjectTeamAssignment = { teamIds: string[] };
export type ProjectDirectoryVersion = { id: string; version: number };
/** Members are intersected with current, readable access to this particular project. */
export type ProjectTeamFragment = { id: string; name: string; members: ProjectIdentity[] };
export type ProjectDirectoryProject = {
  projectId: string;
  /** Display identities derived from core owners/assignees and associated teams; not the full access list or participant roster. */
  identities: ProjectIdentity[];
  /** Explicit participation, intersected with current project-readable membership. */
  participants: ProjectIdentity[];
  participation: ProjectDirectoryVersion | null;
  teams: ProjectTeamFragment[];
  assignment: ProjectDirectoryVersion | null;
};
/** This branch exists only for unrestricted workspace access.manage. */
export type ProjectDirectoryManagement = {
  members: ProjectIdentity[];
  teams: DashboardRecord<ProjectTeam>[];
};
export type ProjectDirectory = {
  projects: ProjectDirectoryProject[];
  management: ProjectDirectoryManagement | null;
};

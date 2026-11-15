import type { ProjectTeamFragment } from './project-directory.ts';

/** Minimal human identity. Contact details and authorization grants are never candidate data. */
export type PeopleIdentity = { userId: string; name: string; avatarDataUrl: string | null; jobTitle: string | null };
export type PeopleCandidatePurpose = 'assignee' | 'participant' | 'team' | 'project_owner';
export type PeopleCandidateQuery = { purpose: PeopleCandidatePurpose; projectId?: string; q?: string; after?: string; limit?: number };
export type PeopleCandidatePage = { items: PeopleIdentity[]; nextCursor: string | null };
/** An explicit organizational roster, not access grants or inferred task responsibility. */
export type ProjectParticipation = { memberIds: string[] };
export type ProjectPeople = {
  projectId: string;
  projectVersion: number;
  /** Managers see saved IDs for removal; other readers see only currently eligible IDs. */
  participation: ({ id: string; version: number } & ProjectParticipation) | null;
  participants: PeopleIdentity[];
  teams: ProjectTeamFragment[];
  canManage: boolean;
  scope: { projectIds: string[] | null };
};
export type PeopleAccountLookup = { account: PeopleIdentity | null };

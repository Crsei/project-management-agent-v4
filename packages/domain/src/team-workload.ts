import type { DashboardRecord } from './dashboard.ts';
import type { WorkflowDefinition } from '../../pm-schema/index.ts';

/** Capacity is concurrent unfinished-work estimate points, never weekly hours. */
export const MAX_MEMBER_CAPACITY_POINTS = 1_000_000;
export type MemberCapacityData = { userId: string; capacityPoints: number | null };
export type MemberCapacity = DashboardRecord<MemberCapacityData>;
/** Deliberately omits creator/owner metadata from ordinary directory reads. */
export type TeamWorkloadCapacity = { id: string; version: number; capacityPoints: number | null };
export type TeamWorkloadMemberScope = { complete: boolean; reason: 'workspace' | 'partial' };
export type TeamWorkloadMember = {
  userId: string;
  teamIds: string[];
  taskIds: string[];
  openCount: number;
  doneCount: number;
  knownOpenPoints: number;
  unknownEstimateCount: number;
  capacity: TeamWorkloadCapacity | null;
  capacityPoints: number | null;
  overloaded: boolean | null;
  scope: TeamWorkloadMemberScope;
};
export type TeamWorkloadTask = {
  id: string;
  title: string;
  projectId: string;
  assigneeId: string | null;
  /** Missing identity evidence is distinct from a genuinely unassigned task. */
  assigneeStatus: 'assigned' | 'unassigned' | 'unavailable';
  teamIds: string[];
  status: string;
  statusCategory: WorkflowDefinition['states'][number]['category'];
  open: boolean;
  done: boolean;
  estimatePoints: number | null;
};
export type TeamWorkloadTeam = { id: string; name: string; memberIds: string[]; taskIds: string[] };
export type TeamWorkloadSummary = {
  openCount: number;
  doneCount: number;
  knownOpenPoints: number;
  unknownEstimateCount: number;
  /** Open tasks retained in the authorized pool with an inaccessible assignee. */
  unknownAssigneeCount: number;
  overloadedMemberCount: number;
  unknownOverloadMemberCount: number;
};
export type TeamWorkload = {
  serverNow: string;
  unit: 'concurrent_open_points';
  members: TeamWorkloadMember[];
  tasks: TeamWorkloadTask[];
  /** Open pool: genuinely unassigned or explicitly unavailable assignee identity. */
  unassignedTaskIds: string[];
  teams: TeamWorkloadTeam[];
  summary: TeamWorkloadSummary;
  /** IDs describe only visible projects; hidden project counts/IDs are never evidence. */
  scope: { complete: boolean; projectIds: string[]; reason: 'workspace' | 'projects' };
};

/** A known lower bound can prove overload, but incomplete evidence cannot disprove it. */
export function memberOverloaded(knownOpenPoints: number, unknownEstimateCount: number, capacityPoints: number | null, scopeComplete: boolean): boolean | null {
  if (capacityPoints === null) return null;
  if (knownOpenPoints > capacityPoints) return true;
  return unknownEstimateCount > 0 || !scopeComplete ? null : false;
}

import { DomainError } from './core.ts';
import type { DashboardRecord } from './dashboard.ts';

export type TaskWatchData = { taskId: string; watching: boolean };
export type TaskWatch = DashboardRecord<TaskWatchData>;
export type PrivateNoteData = { content: string; completedAt: string | null; deletedAt: string | null };
export type PrivateNote = DashboardRecord<PrivateNoteData>;
export type ProjectMeetingData = {
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  participantIds: string[];
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
};
export type ProjectMeeting = DashboardRecord<ProjectMeetingData>;
export const MAX_PROFILE_AVATAR_BYTES = 256 * 1024;
export type SelfProfile = {
  userId: string;
  name: string;
  timeZone: string;
  jobTitle: string | null;
  phone: string | null;
  avatarDataUrl: string | null;
  version: number;
  joinedAt: string;
  updatedAt: string;
};
export type MeetingParticipant = { userId: string; name: string; projectIds: string[] | null };
export type PersonalDashboard = {
  profile: SelfProfile;
  watches: TaskWatch[];
  notes: PrivateNote[];
  meetings: ProjectMeeting[];
  meetingParticipants: MeetingParticipant[];
  canListParticipants: boolean;
};

export function isIanaTimeZone(value: string): boolean {
  if (!value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}

export function assertMeetingInterval(startsAt: string, endsAt: string): void {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new DomainError('invalid_meeting_interval', 'Meeting end must be after its start');
}

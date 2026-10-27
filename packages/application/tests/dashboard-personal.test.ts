import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from '../../domain/src/core.ts';
import { assertMeetingInterval, isIanaTimeZone } from '../../domain/src/dashboard-personal.ts';
import { dashboardPersonalCommands } from '../src/dashboard-personal.ts';

const participant = '00000000-0000-4000-8000-000000000001';
const meeting = { title: 'Design review', description: 'Review the actual project', startsAt: '2026-10-20T10:00:00+08:00', endsAt: '2026-10-20T11:00:00+08:00', participantIds: [participant] };

test('personal profiles validate IANA zones rather than accepting numeric offsets or invented locations', () => {
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Chatham']) assert.equal(isIanaTimeZone(zone), true, zone);
  for (const zone of ['', '+08:00', '-0500', 'Mars/Olympus_Mons', ' Asia/Shanghai ']) assert.equal(isIanaTimeZone(zone), false, zone);
  assert.equal(dashboardPersonalCommands.UpdateSelfProfile!.payload.safeParse({ name: 'Updated name', timeZone: 'Pacific/Chatham' }).success, true);
  assert.equal(dashboardPersonalCommands.UpdateSelfProfile!.payload.safeParse({ name: 'Updated name', timeZone: '+08:00' }).success, false);
  assert.equal(dashboardPersonalCommands.UpdateSelfProfile!.payload.safeParse({ name: ' ', timeZone: 'UTC' }).success, false);
});

test('meeting intervals compare actual instants across offsets and reject zero, reversed and invalid ranges', () => {
  assert.doesNotThrow(() => assertMeetingInterval('2026-10-20T10:00:00+08:00', '2026-10-20T03:00:00Z'));
  for (const [start, end] of [
    ['2026-10-20T10:00:00+08:00', '2026-10-20T02:00:00Z'],
    ['2026-10-20T10:00:00+08:00', '2026-10-20T01:59:59Z'],
    ['not a date', '2026-10-20T11:00:00Z'],
  ]) assert.throws(() => assertMeetingInterval(start!, end!), (error: unknown) => error instanceof DomainError && error.code === 'invalid_meeting_interval');
});

test('personal commands reject actor/owner injection and malformed meeting participants at the shared boundary', () => {
  assert.equal(dashboardPersonalCommands.CreatePrivateNote!.payload.safeParse({ content: 'Private text', ownerId: participant }).success, false);
  assert.equal(dashboardPersonalCommands.UpdateSelfProfile!.payload.safeParse({ name: 'Name', timeZone: 'UTC', userId: participant }).success, false);
  assert.equal(dashboardPersonalCommands.WatchTask!.payload.safeParse({ taskId: 'TASK-001', actorId: participant }).success, false);
  assert.equal(dashboardPersonalCommands.CreateProjectMeeting!.payload.safeParse(meeting).success, true);
  assert.equal(dashboardPersonalCommands.CreateProjectMeeting!.payload.safeParse({ ...meeting, participantIds: [] }).success, false);
  assert.equal(dashboardPersonalCommands.CreateProjectMeeting!.payload.safeParse({ ...meeting, participantIds: [participant, participant.toUpperCase()] }).success, false);
  assert.equal(dashboardPersonalCommands.CreateProjectMeeting!.payload.safeParse({ ...meeting, startsAt: '2026-10-20T10:00' }).success, false);
  assert.equal(dashboardPersonalCommands.CreateProjectMeeting!.payload.safeParse({ ...meeting, title: ' ' }).success, false);
});

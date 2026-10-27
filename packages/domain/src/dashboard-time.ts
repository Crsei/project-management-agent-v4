import { DomainError } from './core.ts';

export const PRESENCE_TTL_MS = 90_000;
export type PresencePreference = 'online' | 'away';
export type PresenceStatus = PresencePreference | 'offline';
export type TimeTaskReference = { taskId: string | null; projectId: string | null; title: string | null; unavailable: boolean };
export type TimeTimer = { id: string; version: number; startedAt: string; stoppedAt: string | null; worklogId: string | null; task: TimeTaskReference };
export type TimeWorklog = { id: string; source: 'timer' | 'manual'; timerId: string | null; startedAt: string; endedAt: string; durationMs: number; note: string; task: TimeTaskReference };
export type TimePeriodTotal = { start: string; end: string; durationMs: number };
export type TimeTotals = { day: TimePeriodTotal; week: TimePeriodTotal; month: TimePeriodTotal };
export type PresenceMember = { userId: string; name: string; preference: PresencePreference; status: PresenceStatus; lastHeartbeatAt: string | null };
export type PresenceSelf = PresenceMember & { preferenceId: string | null; preferenceVersion: number | null; heartbeatId: string | null; heartbeatVersion: number | null };
export type TimeDashboard = {
  serverNow: string;
  timeZone: string;
  activeTimer: TimeTimer | null;
  worklogs: TimeWorklog[];
  totals: TimeTotals;
  presence: { self: PresenceSelf; members: PresenceMember[]; directoryVisible: boolean; ttlMs: number };
};
export type TimerData = { taskId: string; projectId: string; startedAt: string; stoppedAt: string | null; worklogId: string | null; note: string };
export type WorklogData = { source: 'timer' | 'manual'; timerId: string | null; taskId: string; projectId: string; startedAt: string; endedAt: string; durationMs: number; note: string };
export type PresencePreferenceData = { preference: PresencePreference };
export type PresenceHeartbeatData = { heartbeatAt: string };

export function presenceStatus(preference: PresencePreference, heartbeatAt: string | null, now: Date, ttlMs = PRESENCE_TTL_MS): PresenceStatus {
  const heartbeat = heartbeatAt === null ? Number.NaN : Date.parse(heartbeatAt);
  return Number.isFinite(heartbeat) && heartbeat <= now.getTime() && now.getTime() - heartbeat < ttlMs ? preference : 'offline';
}

export function intervalDuration(startedAt: string, endedAt: string, now?: Date): number {
  const start = Date.parse(startedAt), end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || now && end > now.getTime()) throw new DomainError('invalid_worklog_interval', 'The interval must have a valid start before its end and cannot end in the future');
  return end - start;
}

type CivilDate = { year: number; month: number; day: number };
function ordinal(date: CivilDate): number { return Date.UTC(date.year, date.month - 1, date.day); }
function civilDate(value: number): CivilDate { const date = new Date(value); return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }; }

/** Earliest instant of a local calendar date, including midnight offset transitions. */
function localDateStart(date: CivilDate, formatter: Intl.DateTimeFormat): number {
  const target = ordinal(date);
  const localOrdinal = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (kind: string) => Number(parts.find(item => item.type === kind)!.value);
    return ordinal({ year: part('year'), month: part('month'), day: part('day') });
  };
  let lower = target - 172_800_000, upper = target + 172_800_000;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (localOrdinal(middle) < target) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

/** Week starts Monday. Periods are local calendar boundaries, never fixed 24h days. */
export function timePeriodBounds(now: Date, timeZone: string): TimeTotals {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new DomainError('invalid_time_zone', 'A valid IANA time zone is required'); }
  const parts = formatter.formatToParts(now);
  const part = (kind: string) => Number(parts.find(item => item.type === kind)!.value);
  const day = { year: part('year'), month: part('month'), day: part('day') };
  const dayOrdinal = ordinal(day);
  const week = civilDate(dayOrdinal - ((new Date(dayOrdinal).getUTCDay() + 6) % 7) * 86_400_000);
  const month = { ...day, day: 1 };
  const period = (start: CivilDate, end: CivilDate): TimePeriodTotal => ({ start: new Date(localDateStart(start, formatter)).toISOString(), end: new Date(localDateStart(end, formatter)).toISOString(), durationMs: 0 });
  return {
    day: period(day, civilDate(dayOrdinal + 86_400_000)),
    week: period(week, civilDate(ordinal(week) + 7 * 86_400_000)),
    month: period(month, civilDate(Date.UTC(month.year, month.month, 1))),
  };
}

export function sumTimeIntervals(intervals: readonly { startedAt: string; endedAt: string }[], now: Date, timeZone: string): TimeTotals {
  const totals = timePeriodBounds(now, timeZone);
  for (const period of Object.values(totals)) {
    const start = Date.parse(period.start), end = Math.min(Date.parse(period.end), now.getTime());
    for (const interval of intervals) period.durationMs += Math.max(0, Math.min(Date.parse(interval.endedAt), end) - Math.max(Date.parse(interval.startedAt), start));
  }
  return totals;
}

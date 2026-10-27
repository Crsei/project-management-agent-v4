import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { intervalDuration, PRESENCE_TTL_MS, presenceStatus, sumTimeIntervals, timePeriodBounds } from '../src/dashboard-time.ts';

const hour = 3_600_000;
describe('dashboard time: calendar intersections and presence TTL', () => {
  it('uses 23-hour spring and 25-hour fall local days rather than fixed durations', () => {
    const spring = timePeriodBounds(new Date('2026-03-08T16:00:00Z'), 'America/New_York');
    assert.equal(spring.day.start, '2026-03-08T05:00:00.000Z');
    assert.equal(spring.day.end, '2026-03-09T04:00:00.000Z');
    assert.equal(Date.parse(spring.day.end) - Date.parse(spring.day.start), 23 * hour);
    const fall = timePeriodBounds(new Date('2026-11-01T17:00:00Z'), 'America/New_York');
    assert.equal(fall.day.start, '2026-11-01T04:00:00.000Z');
    assert.equal(fall.day.end, '2026-11-02T05:00:00.000Z');
    assert.equal(Date.parse(fall.day.end) - Date.parse(fall.day.start), 25 * hour);
    assert.equal(Date.parse(fall.week.end) - Date.parse(fall.week.start), 169 * hour);
  });

  it('handles non-hour DST and midnight transitions', () => {
    const halfHour = timePeriodBounds(new Date('2026-10-04T04:00:00Z'), 'Australia/Lord_Howe');
    assert.equal(Date.parse(halfHour.day.end) - Date.parse(halfHour.day.start), 23.5 * hour);
    const midnight = timePeriodBounds(new Date('2018-11-04T12:00:00Z'), 'America/Sao_Paulo');
    assert.equal(midnight.day.start, '2018-11-04T03:00:00.000Z');
    assert.equal(midnight.day.end, '2018-11-05T02:00:00.000Z');
  });

  it('clips every interval independently across local day/week/month boundaries', () => {
    const totals = sumTimeIntervals([
      { startedAt: '2026-02-28T22:00:00-08:00', endedAt: '2026-03-01T03:00:00-08:00' },
      { startedAt: '2026-03-01T23:00:00-08:00', endedAt: '2026-03-02T02:00:00-08:00' },
      { startedAt: '2026-02-01T00:00:00Z', endedAt: '2026-02-01T01:00:00Z' },
    ], new Date('2026-03-02T12:00:00-08:00'), 'America/Los_Angeles');
    assert.equal(totals.day.durationMs, 2 * hour);
    assert.equal(totals.week.durationMs, 2 * hour);
    assert.equal(totals.month.durationMs, 6 * hour);
    assert.equal(totals.week.start, '2026-03-02T08:00:00.000Z');
    assert.equal(totals.month.start, '2026-03-01T08:00:00.000Z');
  });

  it('does not attribute an entire cross-DST interval to its start day', () => {
    const totals = sumTimeIntervals([{ startedAt: '2026-03-07T23:00:00-05:00', endedAt: '2026-03-09T01:00:00-04:00' }], new Date('2026-03-08T23:59:59.999-04:00'), 'America/New_York');
    assert.equal(totals.day.durationMs, 23 * hour - 1);
    assert.throws(() => timePeriodBounds(new Date(), 'Not/AZone'), /IANA/);
  });

  it('derives offline at the exact TTL without rewriting away preference', () => {
    const now = new Date('2026-10-20T10:00:00.000Z');
    assert.equal(presenceStatus('away', new Date(now.getTime() - PRESENCE_TTL_MS + 1).toISOString(), now), 'away');
    assert.equal(presenceStatus('away', new Date(now.getTime() - PRESENCE_TTL_MS).toISOString(), now), 'offline');
    assert.equal(presenceStatus('online', null, now), 'offline');
    assert.equal(presenceStatus('online', '2026-10-20T10:00:00.001Z', now), 'offline');
    assert.equal(presenceStatus('online', now.toISOString(), now), 'online');
  });

  it('requires real finite positive manual intervals ending no later than the server clock', () => {
    const now = new Date('2026-11-01T08:00:00Z');
    assert.equal(intervalDuration('2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00', now), hour);
    assert.throws(() => intervalDuration('2026-11-01T08:00:00Z', '2026-11-01T08:00:00Z', now), /interval/);
    assert.throws(() => intervalDuration('invalid', '2026-11-01T08:00:00Z', now), /interval/);
    assert.throws(() => intervalDuration('2026-11-01T07:00:00Z', '2026-11-01T09:00:00Z', now), /future/);
  });
});

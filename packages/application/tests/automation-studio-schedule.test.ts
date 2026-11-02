import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StudioConfig } from '../../contracts/src/automation-studio.ts';
import { nextStudioDue, parseStudioCron } from '../src/automation-studio-schedule.ts';

const base: StudioConfig = { name: 'Schedule regression', description: '', projectId: 'PRJ-001', tags: [], templateId: null, dailyLimit: 10, cooldownMinutes: 0, trigger: { kind: 'manual' }, action: { kind: 'prompt', providerInstanceId: 'test-provider', model: 'test-model', options: {}, prompt: 'Observe', repositories: [], plugins: [], timeoutSeconds: 60 } };
describe('Studio full-date and IANA cron scheduling', () => {
  it('once is strictly future and never becomes an annual cron', () => {
    const config = { ...base, trigger: { kind: 'once' as const, at: '2026-11-01T09:00:00Z', timezone: 'Asia/Shanghai' } };
    assert.equal(nextStudioDue(config, new Date('2026-11-01T08:59:59Z'))?.toISOString(), '2026-11-01T09:00:00.000Z');
    assert.equal(nextStudioDue(config, new Date('2026-11-01T09:00:00Z')), null);
    assert.equal(nextStudioDue(config, new Date('2027-01-01T00:00:00Z')), null);
  });
  it('skips nonexistent spring minutes and selects only the first autumn fold', () => {
    const spring = { ...base, trigger: { kind: 'cron' as const, expression: '30 2 * * *', timezone: 'America/New_York' } };
    assert.equal(nextStudioDue(spring, new Date('2026-03-08T00:00:00Z'))?.toISOString(), '2026-03-09T06:30:00.000Z');
    const autumn = { ...base, trigger: { kind: 'cron' as const, expression: '30 1 * * *', timezone: 'America/New_York' } };
    assert.equal(nextStudioDue(autumn, new Date('2026-11-01T00:00:00Z'))?.toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(nextStudioDue(autumn, new Date('2026-11-01T05:30:00Z'))?.toISOString(), '2026-11-02T06:30:00.000Z');
  });
  it('supports names, ranges, lists, steps and weekday presets without silently accepting invalid fields', () => {
    const weekday = { ...base, trigger: { kind: 'cron' as const, expression: '0 9 * * MON-FRI', timezone: 'Asia/Shanghai' } };
    assert.equal(nextStudioDue(weekday, new Date('2026-10-30T02:00:00Z'))?.toISOString(), '2026-11-02T01:00:00.000Z');
    assert.deepEqual([...parseStudioCron('*/15 9,10 * JAN-MAR 7').minutes.values], [0,15,30,45]);
    for (const expression of ['* * * *', '60 * * * *', '* * 0 * *', '*/0 * * * *', '0 0 * 13 *']) assert.throws(() => parseStudioCron(expression));
  });
});

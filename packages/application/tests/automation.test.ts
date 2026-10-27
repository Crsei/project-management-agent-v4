import assert from 'node:assert/strict';
import test from 'node:test';
import { automationConfigSchema, type AutomationConfig } from '../../contracts/src/automation.ts';
import { automationBudgetReason, automationDailyInstant, automationLocalDate, automationMissedDate, nextAutomationDue } from '../src/automation-schedule.ts';

const config: AutomationConfig = { name: 'Read-only report', description: '', projectId: 'PRJ-001', trigger: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' }, condition: 'all_open', action: 'report', dailyLimit: 2, cooldownMinutes: 60 };

test('daily IANA scheduling is strictly future and manual rules have no schedule', () => {
  assert.equal(nextAutomationDue(config, new Date('2024-01-01T00:59:59Z'))?.toISOString(), '2024-01-01T01:00:00.000Z');
  assert.equal(nextAutomationDue(config, new Date('2024-01-01T01:00:00Z'))?.toISOString(), '2024-01-02T01:00:00.000Z');
  assert.equal(nextAutomationDue({ ...config, trigger: { ...config.trigger, kind: 'manual' } }, new Date('2024-01-01T00:00Z')), null);
  assert.equal(automationLocalDate(new Date('2024-01-01T16:00Z'), 'Asia/Shanghai'), '2024-01-02');
});
test('DST nonexistent wall time is skipped, never shifted forward', () => {
  assert.equal(automationDailyInstant('2024-03-10', '02:30', 'America/New_York'), null);
  const rule = { ...config, trigger: { kind: 'daily' as const, time: '02:30', timezone: 'America/New_York' } };
  assert.equal(nextAutomationDue(rule, new Date('2024-03-09T07:30:00Z'))?.toISOString(), '2024-03-11T06:30:00.000Z');
  assert.equal(automationDailyInstant('2011-12-30', '09:00', 'Pacific/Apia'), null, 'A skipped calendar date is not an invented instant');
});
test('DST fold selects first occurrence, including half-hour offset transitions', () => {
  assert.equal(automationDailyInstant('2024-11-03', '01:30', 'America/New_York')?.toISOString(), '2024-11-03T05:30:00.000Z');
  const rule = { ...config, trigger: { kind: 'daily' as const, time: '01:30', timezone: 'America/New_York' } };
  assert.equal(nextAutomationDue(rule, new Date('2024-11-03T05:31:00Z'))?.toISOString(), '2024-11-04T06:30:00.000Z', 'Second fold must never be dispatched');
  assert.equal(automationDailyInstant('2024-04-07', '01:45', 'Australia/Lord_Howe')?.toISOString(), '2024-04-06T14:45:00.000Z');
});
test('downtime coalesces missed local dates rather than bursting through a backlog', () => {
  assert.equal(automationMissedDate(config, new Date('2024-01-01T01:00Z'), new Date('2024-01-05T02:00Z')), true);
  assert.equal(nextAutomationDue(config, new Date('2024-01-05T02:00Z'))?.toISOString(), '2024-01-06T01:00:00.000Z');
  assert.equal(automationMissedDate(config, new Date('2024-01-05T01:00Z'), new Date('2024-01-05T15:00Z')), false);
});
test('budgets and cooldown boundaries do not silently dispatch or bypass a reversed clock', () => {
  const last = new Date('2024-01-01T00:00Z');
  assert.equal(automationBudgetReason(config, new Date('2024-01-01T01:00Z'), 2, last), 'daily_limit');
  assert.equal(automationBudgetReason(config, new Date('2024-01-01T00:59:59Z'), 1, last), 'cooldown');
  assert.equal(automationBudgetReason(config, new Date('2024-01-01T01:00Z'), 1, last), null);
  assert.equal(automationBudgetReason(config, new Date('2023-12-31T23:00Z'), 0, last), 'cooldown');
});
test('config validation rejects unsupported actions, malformed times, implicit projects and unsafe limits', () => {
  assert.equal(automationConfigSchema.safeParse(config).success, true);
  for (const changed of [{ projectId: '' }, { action: 'host' }, { dailyLimit: 0 }, { dailyLimit: 101 }, { cooldownMinutes: -1 }, { cooldownMinutes: 1.5 }, { name: ' ' }, { trigger: { kind: 'daily', time: '24:00', timezone: 'UTC' } }, { trigger: { kind: 'daily', time: '09:00', timezone: 'Mars/Olympus' } }, { trigger: { kind: 'daily', time: '09:00', timezone: '+08:00' } }]) assert.equal(automationConfigSchema.safeParse({ ...config, ...changed }).success, false);
});

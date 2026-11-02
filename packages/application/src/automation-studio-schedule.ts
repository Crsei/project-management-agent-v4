import type { StudioConfig } from '../../contracts/src/automation-studio.ts';
import { DomainError } from '../../domain/src/core.ts';
import { automationDailyInstant, automationLocalDate } from './automation-schedule.ts';

const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
type Field = { values: Set<number>; wildcard: boolean };
function field(text: string, min: number, max: number, names: string[] = [], offset = 0): Field {
  const values = new Set<number>();
  const numeric = (value: string) => {
    const named = names.indexOf(value.toUpperCase());
    if (named >= 0) return named + offset;
    if (!/^\d+$/.test(value)) throw new DomainError('invalid_cron', 'Cron fields require numbers, names, ranges, lists or steps', 400);
    return Number(value);
  };
  for (const component of text.split(',')) {
    const pieces = component.split('/');
    if (pieces.length > 2 || !pieces[0]) throw new DomainError('invalid_cron', 'Invalid cron field', 400);
    const step = pieces[1] === undefined ? 1 : numeric(pieces[1]);
    if (step < 1 || step > max - min + 1) throw new DomainError('invalid_cron', 'Invalid cron step', 400);
    const range = pieces[0].split('-');
    const first = pieces[0] === '*' ? min : numeric(range[0]!);
    const last = pieces[0] === '*' ? max : range.length === 2 ? numeric(range[1]!) : pieces[1] === undefined ? first : max;
    if (range.length > 2 || first < min || last > max || first > last) throw new DomainError('invalid_cron', 'Cron field is outside its allowed range', 400);
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return { values, wildcard: text.startsWith('*') };
}
export function parseStudioCron(expression: string) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new DomainError('invalid_cron', 'Expected a five-field cron expression (minute hour day month weekday)', 400);
  const weekdays = field(parts[4]!, 0, 7, dayNames);
  if (weekdays.values.delete(7)) weekdays.values.add(0);
  return { minutes: field(parts[0]!, 0, 59), hours: field(parts[1]!, 0, 23), days: field(parts[2]!, 1, 31), months: field(parts[3]!, 1, 12, monthNames, 1), weekdays };
}
/** Strictly future, first DST fold only; nonexistent civil minutes do not run. No backfill on edit/enable. */
export function nextStudioDue(config: StudioConfig, after: Date): Date | null {
  const trigger = config.trigger;
  if (trigger.kind === 'manual' || trigger.kind === 'event') return null;
  if (trigger.kind === 'once') { const at = new Date(trigger.at); return at > after ? at : null; }
  const cron = parseStudioCron(trigger.expression);
  const first = Date.parse(automationLocalDate(after, trigger.timezone) + 'T00:00:00Z');
  const hours = [...cron.hours.values].sort((a, b) => a - b), minutes = [...cron.minutes.values].sort((a, b) => a - b);
  const format = new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = format.formatToParts(after), currentMinute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  for (let day = 0; day < 366 * 8; day++) {
    const date = new Date(first + day * 86400000);
    if (!cron.months.values.has(date.getUTCMonth() + 1)) continue;
    const dom = cron.days.values.has(date.getUTCDate()), dow = cron.weekdays.values.has(date.getUTCDay());
    if (!(cron.days.wildcard || cron.weekdays.wildcard ? dom && dow : dom || dow)) continue;
    const civilDate = date.toISOString().slice(0, 10);
    for (const hour of hours) for (const minute of minutes) {
      if (day === 0 && hour * 60 + minute < currentMinute) continue;
      const candidate = automationDailyInstant(civilDate, `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, trigger.timezone);
      if (candidate && candidate > after) return candidate;
    }
  }
  throw new DomainError('invalid_cron', 'Cron expression has no valid occurrence within eight years', 400);
}
export function studioTimezone(config: StudioConfig): string { return config.trigger.kind === 'once' || config.trigger.kind === 'cron' ? config.trigger.timezone : 'UTC'; }
export function studioMissed(config: StudioConfig, dueAt: Date, now: Date): boolean { return automationLocalDate(dueAt, studioTimezone(config)) !== automationLocalDate(now, studioTimezone(config)); }

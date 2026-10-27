import type { AutomationConfig } from '../../contracts/src/automation.ts';
import { DomainError } from '../../domain/src/core.ts';

type Civil = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}
function civil(format: Intl.DateTimeFormat, at: number): Civil {
  const parts = format.formatToParts(at);
  const part = (type: string) => Number(parts.find(item => item.type === type)!.value);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
}
const ordinal = (value: Civil) => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
export function automationLocalDate(now: Date, timezone: string): string {
  const value = civil(formatter(timezone), now.getTime());
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}
/** Resolve a wall minute by its actual surrounding offsets. Gaps have no candidate; folds choose the first instant only. */
export function automationDailyInstant(date: string, time: string, timezone: string): Date | null {
  const target = Date.parse(`${date}T${time}:00.000Z`);
  const format = formatter(timezone), offsets = new Set<number>();
  // Includes both sides of DST and date-line transitions, including half-hour folds.
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = target + hours * 3_600_000;
    offsets.add(ordinal(civil(format, instant)) - instant);
  }
  const matches = [...offsets].map(offset => target - offset).filter(at => ordinal(civil(format, at)) === target).sort((a, b) => a - b);
  return matches[0] === undefined ? null : new Date(matches[0]);
}
/** Strictly future; enabling/editing never backfills an elapsed slot. */
export function nextAutomationDue(config: AutomationConfig, after: Date): Date | null {
  if (config.trigger.kind === 'manual') return null;
  const first = automationLocalDate(after, config.trigger.timezone);
  const ordinalDate = Date.parse(`${first}T00:00:00Z`);
  for (let day = 0; day < 370; day++) {
    const date = new Date(ordinalDate + day * 86_400_000).toISOString().slice(0, 10);
    const candidate = automationDailyInstant(date, config.trigger.time, config.trigger.timezone);
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
  }
  throw new DomainError('automation_schedule_unavailable', 'No valid future daily schedule instant', 409);
}
export function automationBudgetReason(config: AutomationConfig, now: Date, consumedToday: number, lastConsumedAt: Date | null): string | null {
  if (consumedToday >= config.dailyLimit) return 'daily_limit';
  if (lastConsumedAt && now.getTime() < lastConsumedAt.getTime() + config.cooldownMinutes * 60_000) return 'cooldown';
  return null;
}
/** Coalesce downtime into one skipped record, never one dispatch per elapsed day. */
export function automationMissedDate(config: AutomationConfig, dueAt: Date, now: Date): boolean {
  return automationLocalDate(dueAt, config.trigger.timezone) !== automationLocalDate(now, config.trigger.timezone);
}

import type { ScheduleTiming } from "@agent-workspace/contracts/automation";

export const MINUTE = 60_000;
export const serverTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Fixed times use the server's local calendar, including its DST rules. */
export function nextOccurrence(timing: ScheduleTiming, after: number): number {
  if (timing.type === "interval") return after + timing.minutes * MINUTE;
  const [hour, minute] = timing.time.split(":").map(Number);
  const day = new Date(after);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate() + offset,
      hour,
      minute,
    );
    // A nonexistent spring-forward wall time is skipped, not silently shifted.
    if (
      candidate.getHours() === hour &&
      candidate.getMinutes() === minute &&
      timing.weekdays.includes(candidate.getDay()) &&
      candidate.getTime() > after
    )
      return candidate.getTime();
  }
  throw new Error("无法计算下一次执行时间。");
}

/** Advance in O(1) for intervals; fixed schedules only inspect the next local week. */
export function advanceOccurrence(timing: ScheduleTiming, due: number, now: number): number {
  if (timing.type === "interval") {
    const period = timing.minutes * MINUTE;
    return due + (Math.floor(Math.max(0, now - due) / period) + 1) * period;
  }
  return nextOccurrence(timing, now);
}

export function latestMissedOccurrence(timing: ScheduleTiming, due: number, now: number): number {
  if (timing.type === "interval") {
    const period = timing.minutes * MINUTE;
    return due + Math.floor(Math.max(0, now - due) / period) * period;
  }
  const day = new Date(now);
  const [hour, minute] = timing.time.split(":").map(Number);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate() - offset,
      hour,
      minute,
    );
    if (
      candidate.getHours() === hour &&
      candidate.getMinutes() === minute &&
      timing.weekdays.includes(candidate.getDay()) &&
      candidate.getTime() <= now
    )
      return Math.max(due, candidate.getTime());
  }
  return due;
}

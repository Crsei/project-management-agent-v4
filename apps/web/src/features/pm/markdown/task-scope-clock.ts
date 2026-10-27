import { useEffect, useState } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import { personalDate } from './task-collection-model';

/** Recompute at the actor's next midnight (including DST), on focus and on reads. */
export function useTaskScopeClock(timeZone: string | undefined, refreshKey: number): string | null {
  const [instant, setInstant] = useState(() => Date.now());
  useEffect(() => {
    if (!timeZone) return;
    const zone = timeZone;
    let timer: number;
    function schedule() {
      const now = Date.now();
      setInstant(now);
      const midnight = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).add({ days: 1 }).startOfDay().epochMilliseconds;
      timer = window.setTimeout(schedule, Math.max(1, midnight - now + 20));
    }
    function focus() { clearTimeout(timer); schedule(); }
    schedule();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { clearTimeout(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [timeZone, refreshKey]);
  return timeZone ? personalDate(new Date(instant), timeZone) : null;
}

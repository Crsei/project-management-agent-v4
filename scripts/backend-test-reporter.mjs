import { writeSync } from 'node:fs';

/**
 * Keep native TAP intact on stdout while sending only Node's final aggregate
 * counts to the supervisor over a separate pipe. Test log text cannot forge a
 * completion report. Per-file summaries would double-count the final summary.
 * @param {AsyncIterable<import('node:test/reporters').TestEvent>} source
 */
export default async function* backendTestReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:summary' && event.data.file === undefined) {
      // Child stdio can be a socketpair: write its existing descriptor rather
      // than reopening /proc/self/fd/3 as a path (which can fail with ENXIO).
      writeSync(3, JSON.stringify({ counts: event.data.counts, success: event.data.success }) + '\n');
      yield '';
    }
  }
}

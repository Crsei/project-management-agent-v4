import { spawn } from 'node:child_process';
import { closeSync, readFileSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

/** @typedef {{ pid: number, state: string, group: number, startTime: string }} ProcessIdentity */
/** @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ChildResult */
/** @typedef {import('node:test').EventData.TestSummary['counts'] & { failed: number }} CaseCounts */
/** @typedef {{ counts: CaseCounts, success: boolean }} CaseSummary */
/** @typedef {{ event: 'stopping', code: number } | { event: 'child', identity: ProcessIdentity } | { event: 'summary', summary: CaseSummary }} SupervisorReport */

/** @param {number} pid @returns {ProcessIdentity | null} */
export function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], group: Number(fields[2]), startTime: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) return null;
    throw error;
  }
}

/** @param {number} group @returns {Promise<ProcessIdentity[]>} */
export async function groupMembers(group) {
  // procfs stat files are short kernel-memory records. Queueing async reads
  // for every host PID can exhaust the shutdown grace before any signal is
  // forwarded, and adds that threadpool delay to every naturally ended file.
  // Scan all group members, including reparented orphans, without that queue.
  const entries = readdirSync('/proc');
  /** @type {ProcessIdentity[]} */
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const identity = processIdentity(Number(entry));
    if (identity !== null && identity.group === group && !['Z', 'X'].includes(identity.state)) members.push(identity);
  }
  return members;
}

/** @param {number | null} code @param {NodeJS.Signals | null} signal */
export function exitCode(code, signal) {
  return code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1);
}

// A PID alone never authorizes a signal after its owner exits. Check a recorded
// process birth identity in the group, then retain identities of its members.
/** @param {number} group @param {Map<number, ProcessIdentity>} known @param {string} signal */
export async function signalOwnedGroup(group, known, signal) {
  let owned = false;
  for (const identity of known.values()) {
    const actual = await processIdentity(identity.pid);
    if (actual?.startTime === identity.startTime && actual.group === group && !['Z', 'X'].includes(actual.state)) {
      owned = true;
      break;
    }
  }
  if (!owned) return false;
  for (const member of await groupMembers(group)) known.set(member.pid, member);
  try { process.kill(-group, signal); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error; }
  return true;
}

/** @param {ProcessIdentity} identity @param {string} signal */
async function signalOwnedProcess(identity, signal) {
  const current = await processIdentity(identity.pid);
  if (!current || current.startTime !== identity.startTime || current.group !== identity.group || ['Z', 'X'].includes(current.state)) return;
  try { process.kill(identity.pid, signal); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error; }
}

async function supervise() {
  if (!process.send || !process.connected) throw new Error('Backend test supervisor requires its owning runner');
  const [file, timeoutText, graceText] = process.argv.slice(2);
  const timeout = Number(timeoutText), grace = Number(graceText);
  if (!file || !Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(grace) || grace <= 0) {
    throw new Error('Invalid backend test supervisor arguments');
  }
  let stopping = false, finished = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {NodeJS.Timeout | undefined} */
  let escalation;
  /** @type {number | undefined} */
  let driverPid;
  const ownIdentity = await processIdentity(process.pid);
  if (!ownIdentity || ownIdentity.group !== process.pid) throw new Error('Backend test supervisor must own its process group');

  /** @param {SupervisorReport} message */
  function report(message) {
    if (process.connected) process.send?.(message, () => {});
  }
  /** @param {number} code */
  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(escalation);
    process.exitCode = code;
    // fd 4 is the inherited kernel lock. Never unlink its persistent inode.
    closeSync(4);
    if (process.connected) process.disconnect();
  }
  /** @param {number} code @param {string} [signal] */
  async function stop(code, signal = 'SIGTERM') {
    if (stopping || finished) return;
    stopping = true;
    report({ event: 'stopping', code });
    process.exitCode = code;
    // This supervisor stays alive as the process-group identity until cleanup
    // completes; SIGKILL is a reported failure fallback, never a passing exit.
    escalation = setTimeout(() => {
      console.error('[backend-tests] shutdown deadline exceeded; killing only this owned test process group');
      process.kill(-process.pid, 'SIGKILL');
    }, grace);
    // Node's test driver aborts its spawned worker (with SIGTERM) when the
    // driver receives SIGINT/SIGTERM. Signalling the whole group at once lets
    // that abort race the worker's own signal handlers. Let descendants see
    // the original signal and drain before asking the driver to terminate.
    /** @type {Map<number, string>} */
    const forwarded = new Map();
    while (true) {
      const members = await groupMembers(process.pid);
      const descendants = members.filter(member => member.pid !== process.pid && member.pid !== driverPid);
      for (const member of descendants) {
        if (forwarded.get(member.pid) === member.startTime) continue;
        await signalOwnedProcess(member, signal);
        forwarded.set(member.pid, member.startTime);
      }
      if (descendants.length === 0) {
        const driver = members.find(member => member.pid === driverPid);
        if (driver && forwarded.get(driver.pid) !== driver.startTime) {
          await signalOwnedProcess(driver, signal);
          forwarded.set(driver.pid, driver.startTime);
        }
      }
      if (members.every(member => member.pid === process.pid)) break;
      await delay(50);
    }
    finish(code);
  }
  process.on('SIGINT', () => { void stop(130, 'SIGINT'); });
  process.on('SIGTERM', () => { void stop(143); });
  process.once('disconnect', () => { void stop(143); });
  process.on('message', message => {
    const command = /** @type {{ event?: string, code: number, signal?: string }} */ (message);
    if (command?.event === 'stop') void stop(command.code, command.signal);
  });
  // A runner killed before startup must not leave an unowned test behind.
  if (!process.connected) { await stop(143); return; }
  try {
    timer = setTimeout(() => {
      console.error(`[backend-tests] file deadline exceeded (${timeout}ms): ${file}`);
      void stop(124);
    }, timeout);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [
      '--test', '--test-concurrency=1',
      '--test-reporter=tap', '--test-reporter-destination=stdout',
      `--test-reporter=${fileURLToPath(new URL('./backend-test-reporter.mjs', import.meta.url))}`,
      '--test-reporter-destination=stdout', file,
    ], { env, stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
    driverPid = child.pid;
    // fd 3 is a fresh summary pipe, not the inherited lock descriptor (fd 4).
    const input = /** @type {import('node:stream').Readable} */ (child.stdio[3]);
    const lines = createInterface({ input });
    /** @type {CaseSummary | undefined} */
    let summary;
    const reportsDone = (async () => {
      for await (const line of lines) summary = JSON.parse(line);
    })().catch(() => { summary = undefined; });
    /** @type {PromiseWithResolvers<ChildResult>} */
    const result = Promise.withResolvers();
    child.once('error', () => result.resolve({ code: 1, signal: null }));
    child.once('exit', (code, signal) => result.resolve({ code, signal }));
    if (child.pid) {
      const identity = await processIdentity(child.pid);
      if (identity) {
        report({ event: 'child', identity });
      }
    }
    let resultCode = await result.promise.then(value => exitCode(value.code, value.signal));
    if (stopping) return;
    await reportsDone;
    if (summary) {
      report({ event: 'summary', summary });
      if (!summary.success || summary.counts.skipped || summary.counts.cancelled || summary.counts.todo) {
        console.error(`[backend-tests] incomplete/failed case results: skipped ${summary.counts.skipped}, cancelled ${summary.counts.cancelled}, todo ${summary.counts.todo}`);
        resultCode ||= 1;
      }
    } else {
      console.error('[backend-tests] missing final case summary; completion is not a passing result');
      resultCode ||= 1;
    }
    const until = Date.now() + grace;
    while ((await groupMembers(process.pid)).some(member => member.pid !== process.pid)) {
      if (stopping) return;
      if (Date.now() >= until) {
        console.error('[backend-tests] test exited with live descendants; treating leaked processes as failure');
        await stop(resultCode || 1);
        return;
      }
      await delay(50);
    }
    if (!stopping) finish(resultCode);
  } catch {
    console.error('[backend-tests] owned test supervision failed; cleaning its process group');
    await stop(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await supervise(); }
  catch {
    console.error('[backend-tests] owned test supervisor failed');
    // Keep the inherited lock until the runner handles this nonzero exit.
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}

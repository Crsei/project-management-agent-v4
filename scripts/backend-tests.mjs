import { spawn } from 'node:child_process';
import { constants, globSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { exitCode, groupMembers, processIdentity, signalOwnedGroup } from './backend-test-process.mjs';

/** @typedef {'backend' | 'integration' | 'db' | 'files'} Mode */
/** @typedef {'fileTimeout' | 'shutdownGrace' | 'progressInterval'} DurationOption */
/** @typedef {{ mode: Mode, lockFile: string, fileTimeout: number, shutdownGrace: number, progressInterval: number, list: boolean, files: string[] }} Configuration */
/** @typedef {(code: number, signal?: string) => Promise<void>} StopHandler */
/** @typedef {{ code: number, summary: import('./backend-test-process.mjs').CaseSummary | undefined }} FileResult */
/** @typedef {'tests' | 'passed' | 'failed' | 'skipped' | 'cancelled' | 'todo'} CaseCountKey */

const root = fileURLToPath(new URL('../', import.meta.url));
const supervisor = fileURLToPath(new URL('./backend-test-process.mjs', import.meta.url));
const unitPatterns = [
  'apps/api/tests/*.test.ts',
  'packages/application/tests/*.test.ts',
  'packages/contracts/tests/*.test.ts',
  'packages/domain/tests/*.test.ts',
  'packages/infrastructure/tests/*.test.ts',
  'packages/pm-core/tests/*.test.ts',
  'packages/pm-markdown/tests/*.test.ts',
];
const patterns = {
  backend: [...unitPatterns, 'tests/*.test.ts'],
  integration: ['tests/*.test.ts'],
  db: ['packages/infrastructure/tests/foundation.test.ts'],
};

/** @param {string[]} args @returns {Configuration} */
function options(args) {
  const mode = args.shift();
  if (mode !== 'backend' && mode !== 'integration' && mode !== 'db' && mode !== 'files') throw new Error('Usage: backend-tests.mjs backend|integration|db|files [options] [-- file/glob ...]');
  /** @type {Configuration} */
  const result = {
    mode,
    lockFile: path.join(root, '.local/backend-tests.lock'),
    // The automation suite already allows twenty minutes. Bound each file,
    // not the full run, and leave headroom for legitimate initialization.
    fileTimeout: 30 * 60_000,
    shutdownGrace: 10_000,
    progressInterval: 30_000,
    list: false,
    files: [],
  };
  /** @type {Record<string, DurationOption>} */
  const names = { '--file-timeout-ms': 'fileTimeout', '--shutdown-grace-ms': 'shutdownGrace', '--progress-interval-ms': 'progressInterval' };
  while (args.length) {
    const argument = /** @type {string} */ (args.shift());
    if (argument === '--list') result.list = true;
    else if (argument === '--lock-file') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('--lock-file requires a path');
      result.lockFile = path.resolve(value);
    } else if (Object.hasOwn(names, argument)) {
      const value = Number(args.shift());
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${argument} requires a positive millisecond value`);
      result[names[argument]] = value;
    } else if (argument === '--' && mode === 'files') {
      result.files = args.splice(0);
    } else throw new Error(`Unsupported backend test option: ${argument}`);
  }
  if (mode === 'files' && !result.files.length) throw new Error('files mode requires explicit file/glob arguments after --');
  return result;
}

/** @param {Configuration} configuration */
function discover(configuration) {
  /** @type {Set<string>} */
  const files = new Set();
  for (const pattern of configuration.mode === 'files' ? configuration.files : patterns[configuration.mode]) {
    const matches = globSync(pattern, { cwd: root }).sort();
    if (!matches.length) throw new Error(`Backend test pattern matched no files: ${pattern}`);
    for (const file of matches) files.add(path.resolve(root, file));
  }
  return [...files];
}

/** @param {Configuration} configuration @returns {Promise<import('node:fs/promises').FileHandle | null>} */
async function acquireLock(configuration) {
  await mkdir(path.dirname(configuration.lockFile), { recursive: true, mode: 0o700 });
  const handle = await open(configuration.lockFile, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Backend test lock must be a regular file with one link');
    // flock(2) is held on the shared open-file description, not a PID file.
    // It survives our flock utility exiting and is released by the kernel on
    // crash. Never unlink/recreate the inode or reclaim a live owner's lock.
    const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
    /** @type {PromiseWithResolvers<number | null>} */
    const completion = Promise.withResolvers();
    child.once('error', () => completion.resolve(-1));
    child.once('exit', value => completion.resolve(value));
    const code = await completion.promise;
    if (code === 75) {
      let owner = 'another backend regression';
      try {
        const metadata = JSON.parse(await handle.readFile('utf8'));
        if (Number.isSafeInteger(metadata.pid) && metadata.pid > 0 && ['backend', 'integration', 'db', 'files'].includes(metadata.mode)) {
          owner = `PID ${metadata.pid} (${metadata.mode})`;
        }
      } catch { /* Metadata is diagnostic only; the kernel lock is authoritative. */ }
      console.error(`[backend-tests] overlap rejected: ${owner} holds ${configuration.lockFile}; owner was not signalled`);
      await handle.close();
      return null;
    }
    if (code !== 0) throw new Error('Backend test lock unavailable; Linux util-linux flock is required');
    const identity = await processIdentity(process.pid);
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startTime: identity?.startTime, mode: configuration.mode, startedAt: new Date().toISOString() }) + '\n');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * @param {string} file
 * @param {Configuration} configuration
 * @param {import('node:fs/promises').FileHandle} lock
 * @param {(handler: StopHandler | null) => void} register
 * @returns {Promise<FileResult>}
 */
async function runFile(file, configuration, lock, register) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [supervisor, file, String(configuration.fileTimeout), String(configuration.shutdownGrace)], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc', lock.fd],
  });
  const group = child.pid;
  /** @type {Map<number, import('./backend-test-process.mjs').ProcessIdentity>} */
  const known = new Map();
  /** @type {number | undefined} */
  let requestedCode;
  let ended = false;
  /** @type {NodeJS.Timeout | undefined} */
  let escalation;
  /** @type {NodeJS.Timeout | undefined} */
  let deadline;
  /** @type {NodeJS.Timeout | undefined} */
  let progress;
  /** @type {import('./backend-test-process.mjs').CaseSummary | undefined} */
  let summary;
  /** @type {PromiseWithResolvers<import('./backend-test-process.mjs').ChildResult>} */
  const completion = Promise.withResolvers();
  child.once('error', () => { ended = true; completion.resolve({ code: 1, signal: null }); });
  child.once('exit', (code, signal) => { ended = true; completion.resolve({ code, signal }); });
  child.on('message', message => {
    const event = /** @type {{ event?: string, identity?: import('./backend-test-process.mjs').ProcessIdentity, code?: number, summary?: import('./backend-test-process.mjs').CaseSummary }} */ (message);
    if (event?.event === 'child' && event.identity && Number.isSafeInteger(event.identity.pid)) known.set(event.identity.pid, event.identity);
    if (event?.event === 'stopping' && requestedCode === undefined) requestedCode = event.code;
    if (event?.event === 'summary') summary = event.summary;
  });
  /** @param {number} code @param {string} [signal] */
  async function stop(code, signal = 'SIGTERM') {
    if (ended || requestedCode !== undefined) return;
    requestedCode = code;
    if (child.connected) child.send({ event: 'stop', code, signal }, () => {});
    // Also bound a broken supervisor, while checking birth identities before
    // signalling any group. Never target existing services or a recycled PID.
    escalation = setTimeout(() => {
      if (group !== undefined) void signalOwnedGroup(group, known, 'SIGKILL').catch(() => {});
    }, configuration.shutdownGrace + 1000);
  }
  register(stop);
  try {
    if (group !== undefined) {
      const identity = await processIdentity(group);
      if (identity) known.set(group, identity);
    }
    const started = Date.now();
    progress = setInterval(() => {
      console.error(`[backend-tests] running ${path.relative(root, file)} (${Math.floor((Date.now() - started) / 1000)}s, owned supervisor PID ${child.pid})`);
    }, configuration.progressInterval);
    deadline = setTimeout(() => {
      console.error(`[backend-tests] file deadline exceeded (${configuration.fileTimeout}ms): ${path.relative(root, file)}`);
      void stop(124);
    }, configuration.fileTimeout);
    const value = await completion.promise;
    // Normally the supervisor exits only after its group drains. If it crashes,
    // retain the gate and clean up only descendants whose identities we own.
    const remaining = group !== undefined ? await groupMembers(group) : [];
    if (group !== undefined && remaining.length) {
      console.error('[backend-tests] supervisor exited with live owned descendants; run is failed');
      if (requestedCode === undefined) requestedCode = exitCode(value.code, value.signal) || 1;
      if (!await signalOwnedGroup(group, known, 'SIGTERM')) throw new Error('Cannot prove ownership of surviving test processes; no unknown process was signalled');
      const until = Date.now() + configuration.shutdownGrace;
      while ((await groupMembers(group)).length && Date.now() < until) await delay(50);
      if ((await groupMembers(group)).length) {
        if (!await signalOwnedGroup(group, known, 'SIGKILL')) throw new Error('Lost ownership of surviving test processes; no unknown process was signalled');
        const killedUntil = Date.now() + configuration.shutdownGrace;
        while ((await groupMembers(group)).length && Date.now() < killedUntil) await delay(50);
        if ((await groupMembers(group)).length) throw new Error('Owned test processes did not terminate after SIGKILL');
      }
    }
    return { code: requestedCode ?? exitCode(value.code, value.signal), summary };
  } finally {
    register(null);
    clearTimeout(deadline);
    clearTimeout(escalation);
    clearInterval(progress);
  }
}

async function main() {
  const configuration = options(process.argv.slice(2));
  const files = discover(configuration);
  if (configuration.list) {
    for (const file of files) console.log(path.relative(root, file));
    return 0;
  }
  const lock = await acquireLock(configuration);
  if (!lock) return 75;
  /** @type {StopHandler | null} */
  let activeStop = null;
  /** @type {number | undefined} */
  let interrupted;
  let failed = 0, completed = 0, result = 0;
  /** @type {Record<CaseCountKey, number>} */
  const totals = { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  let summaries = 0;
  /** @param {'SIGINT' | 'SIGTERM'} signal */
  const stop = signal => {
    if (interrupted !== undefined) return;
    interrupted = signal === 'SIGINT' ? 130 : 143;
    console.error(`[backend-tests] ${signal}: stopping only the active owned test group`);
    void activeStop?.(interrupted, signal);
  };
  const sigint = () => stop('SIGINT'), sigterm = () => stop('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    console.error(`[backend-tests] ${configuration.mode}: ${files.length} files, serial, ${configuration.fileTimeout}ms per-file deadline; no whole-run deadline`);
    for (const file of files) {
      if (interrupted !== undefined) break;
      console.error(`[backend-tests] start ${completed + 1}/${files.length}: ${path.relative(root, file)}`);
      const { code, summary } = await runFile(file, configuration, lock, handler => {
        activeStop = handler;
        if (handler && interrupted !== undefined) void handler(interrupted, interrupted === 130 ? 'SIGINT' : 'SIGTERM');
      });
      completed++;
      if (summary) {
        summaries++;
        for (const key of /** @type {CaseCountKey[]} */ (Object.keys(totals))) totals[key] += summary.counts[key];
      }
      if (code !== 0) { failed++; if (!result || code === 124) result = code; }
      console.error(`[backend-tests] end ${completed}/${files.length}: exit ${code}: ${path.relative(root, file)}`);
    }
    console.error(`[backend-tests] finished ${completed}/${files.length} files; failed ${failed}${interrupted === undefined ? '' : '; interrupted'}`);
    console.error(`[backend-tests] case summaries ${summaries}/${completed}: tests ${totals.tests}, passed ${totals.passed}, failed ${totals.failed}, skipped ${totals.skipped}, cancelled ${totals.cancelled}, todo ${totals.todo}; missing summaries are incomplete, not passed`);
    return interrupted ?? result;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    await lock.close();
  }
}

try { process.exitCode = await main(); }
catch (error) {
  // Only our configuration/ownership errors are printed; no environment or
  // database connection object is serialized by this entry point.
  console.error(`[backend-tests] ${error instanceof Error ? error.message : 'runner failed'}`);
  process.exitCode = 1;
}

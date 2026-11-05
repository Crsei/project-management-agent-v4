import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(new URL('../scripts/backend-tests.mjs', import.meta.url));
type Result = { code: number | null; signal: NodeJS.Signals | null };
type Identity = { pid: number; startTime: string };
type RunnerProcess = { child: ChildProcess; exited: Promise<Result>; closed: Promise<Result>; output: () => string };

// These regressions exercise real cross-process deadlines, signal delivery and
// kernel lock lifetimes; fake timers cannot control the separate Node clocks.

async function identity(pid: number): Promise<Identity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return ['Z', 'X'].includes(fields[0]!) ? null : { pid, startTime: fields[19]! };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

async function eventually(check: () => Promise<boolean> | boolean, description: string, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function bounded<T>(value: Promise<T>, description: string, timeout = 15_000): Promise<T> {
  const timeoutResult = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeoutResult.reject(new Error(`Timed out waiting for ${description}`)), timeout);
  try { return await Promise.race([value, timeoutResult.promise]); }
  finally { clearTimeout(timer); }
}

function assertCaseCounts(output: string, expected: Record<string, number>) {
  const summary = output.split('\n').find(line => line.startsWith('[backend-tests] case summaries '));
  assert.ok(summary, output);
  for (const [name, count] of Object.entries(expected)) assert.match(summary, new RegExp(`\\b${name} ${count}\\b`), output);
}

async function harness(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pm-backend-runner-'));
  const lock = path.join(directory, 'backend.lock');
  const processes: RunnerProcess[] = [];
  function launch(args: string[]): RunnerProcess {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.DATABASE_URL;
    delete env.TEST_DATABASE_URL;
    const child = spawn(process.execPath, [entry, args[0]!, '--lock-file', lock, ...args.slice(1)], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    const capture = (chunk: Buffer) => { text = (text + chunk.toString()).slice(-512_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const exited = Promise.withResolvers<Result>(), closed = Promise.withResolvers<Result>();
    child.once('error', error => { exited.reject(error); closed.reject(error); });
    child.once('exit', (code, signal) => exited.resolve({ code, signal }));
    child.once('close', (code, signal) => closed.resolve({ code, signal }));
    const result = { child, exited: exited.promise, closed: closed.promise, output: () => text };
    processes.push(result);
    return result;
  }
  function run(files: string[], limits: string[] = []) {
    // Put options before --; files may themselves begin with a dash.
    return launch(['files', '--file-timeout-ms', '15000', '--shutdown-grace-ms', '300', '--progress-interval-ms', '100', ...limits, '--', ...files]);
  }
  async function fixture(name: string, source: string) {
    const file = path.join(directory, `${name}.test.mjs`);
    await writeFile(file, source);
    return file;
  }
  async function readPid(file: string) {
    let pid = 0;
    await eventually(async () => {
      try { pid = Number(await readFile(file, 'utf8')); return Number.isSafeInteger(pid) && pid > 0; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }, 'the owned test fixture PID');
    const value = await identity(pid);
    assert.ok(value, 'owned fixture must still be running');
    return value;
  }
  t.after(async () => {
    for (const process of processes) {
      if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM');
      await bounded(process.closed, 'owned runner and descendants to close');
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, lock, launch, run, fixture, readPid };
}

function heldTest(pidFile: string, releaseFile?: string, ignoreTerm = false) {
  return `import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
test('controlled owner', async () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  const done = Promise.withResolvers();
  const timer = setInterval(() => {
    ${releaseFile ? `if (existsSync(${JSON.stringify(releaseFile)})) { clearInterval(timer); done.resolve(); }` : ''}
  }, 25);
  await done.promise;
});`;
}

const passing = "import test from 'node:test'; test('passes naturally', () => {});";

describe('backend test entry: real kernel gate and owned process lifecycle', { timeout: 120_000, concurrency: 1 }, () => {
  it('never passes the lock descriptor to the test driver, test worker or their child', async t => {
    const h = await harness(t);
    const probe = `const fs = require('node:fs'); for (const pid of [process.pid, process.ppid]) { for (const fd of fs.readdirSync('/proc/' + pid + '/fd')) { try { if (fs.readlinkSync('/proc/' + pid + '/fd/' + fd) === process.argv[1]) throw new Error('lock descriptor leaked'); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }`;
    const source = `import test from 'node:test'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process'; import { readdirSync, readlinkSync } from 'node:fs';
test('no inherited lock', () => {
  for (const pid of [process.pid, process.ppid]) {
    for (const fd of readdirSync('/proc/' + pid + '/fd')) {
      try { assert.notEqual(readlinkSync('/proc/' + pid + '/fd/' + fd), ${JSON.stringify(h.lock)}); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(probe)}, ${JSON.stringify(h.lock)}], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});`;
    const run = h.run([await h.fixture('descriptors', source)]);
    assert.equal((await bounded(run.closed, 'lock descriptor isolation')).code, 0, run.output());
  });

  it('rejects overlap promptly without touching the owner, even when PID metadata is stale', async t => {
    const h = await harness(t);
    const pidFile = path.join(h.directory, 'owner.pid'), releaseFile = path.join(h.directory, 'release');
    const owner = h.run([await h.fixture('held', heldTest(pidFile, releaseFile))]);
    const original = await h.readPid(pidFile);
    // Metadata is deliberately misleading; only the kernel inode lock decides.
    await writeFile(h.lock, JSON.stringify({ pid: 999_999_999, mode: 'db' }));
    const started = Date.now();
    const second = h.launch(['db']);
    assert.equal((await bounded(second.closed, 'overlap rejection', 5000)).code, 75, second.output());
    assert.ok(Date.now() - started < 5000, 'conflicting invocation must fail, not queue behind migrations');
    assert.match(second.output(), /overlap rejected/);
    assert.deepEqual(await identity(original.pid), original, 'the first run must remain alive and unchanged');
    await writeFile(releaseFile, 'release');
    assert.equal((await bounded(owner.closed, 'unaffected owner completion')).code, 0, owner.output());
    const next = h.run([await h.fixture('next', passing)]);
    assert.equal((await bounded(next.closed, 'lock reuse after success')).code, 0, next.output());
  });

  it('preserves a failed exit, still runs later files, and releases the gate after failure', async t => {
    const h = await harness(t);
    const marker = path.join(h.directory, 'later-file');
    const failure = await h.fixture('failure', "import test from 'node:test'; test('fails honestly', () => { throw new Error('expected regression failure'); });");
    const later = await h.fixture('later', `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('later file remains discoverable', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));`);
    const failed = h.run([failure, later]);
    assert.equal((await bounded(failed.closed, 'failed run')).code, 1, failed.output());
    assert.equal(await readFile(marker, 'utf8'), 'ran');
    assert.match(failed.output(), /finished 2\/2 files; failed 1/);
    assertCaseCounts(failed.output(), { tests: 2, passed: 1, failed: 1, skipped: 0, cancelled: 0, todo: 0 });
    const next = h.run([await h.fixture('after-failure', passing)]);
    assert.equal((await bounded(next.closed, 'lock reuse after failure')).code, 0, next.output());
  });

  it('reports real case counts and never calls skipped or cancelled cases a passing run', async t => {
    const h = await harness(t);
    const skipped = h.run([await h.fixture('skipped', "import test from 'node:test'; test('passes', () => {}); test.skip('not acceptance evidence', () => {});")]);
    assert.equal((await bounded(skipped.closed, 'skipped-case accounting')).code, 1, skipped.output());
    assertCaseCounts(skipped.output(), { tests: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0, todo: 0 });
    const cancelled = h.run([await h.fixture('cancelled', "import test from 'node:test'; test('native deadline cancels pending work', { timeout: 50 }, async t => { const timer = setInterval(() => {}, 1000); t.after(() => clearInterval(timer)); await Promise.withResolvers().promise; });")]);
    assert.equal((await bounded(cancelled.closed, 'cancelled-case accounting')).code, 1, cancelled.output());
    assertCaseCounts(cancelled.output(), { tests: 1, passed: 0, failed: 0, skipped: 0, cancelled: 1, todo: 0 });
  });

  it('bounds leaked handles, returns timeout 124, and continues with the next file', async t => {
    const h = await harness(t);
    const marker = path.join(h.directory, 'after-timeout');
    const leak = await h.fixture('leaked-handle', "import test from 'node:test'; process.on('SIGTERM', () => {}); test('assertions pass but handle leaks', () => { setInterval(() => {}, 1000); });");
    const next = await h.fixture('after-timeout', `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('not cancelled globally', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));`);
    const run = h.run([leak, next], ['--file-timeout-ms', '1500']);
    assert.equal((await bounded(run.closed, 'bounded leaked handle termination')).code, 124, run.output());
    assert.match(run.output(), /file deadline exceeded/);
    assert.match(run.output(), /running /, 'hangs must retain observable progress');
    assert.equal(await readFile(marker, 'utf8'), 'ran');
  });

  it('does not mistake a total duration longer than the file budget for a whole-run timeout', async t => {
    const h = await harness(t);
    const source = "import test from 'node:test'; import { setTimeout } from 'node:timers/promises'; test('legitimate bounded work', async () => { await setTimeout(2000); });";
    const run = h.run([await h.fixture('slow-one', source), await h.fixture('slow-two', source)], ['--file-timeout-ms', '3500']);
    const started = Date.now();
    assert.equal((await bounded(run.closed, 'two independently bounded files')).code, 0, run.output());
    assert.ok(Date.now() - started > 3500);
  });

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    it(`forwards ${signal} to only its own test group and preserves exit ${code}`, async t => {
      const h = await harness(t);
      const pidFile = path.join(h.directory, 'signal.pid'), signalFile = path.join(h.directory, 'signal.received');
      const source = `import test from 'node:test'; import { writeFileSync } from 'node:fs';
let timer; process.on(${JSON.stringify(signal)}, () => { writeFileSync(${JSON.stringify(signalFile)}, 'received'); clearInterval(timer); });
test('signal recipient', async () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const done = Promise.withResolvers(); timer = setInterval(() => {}, 25); process.once(${JSON.stringify(signal)}, done.resolve); await done.promise; });`;
      const run = h.run([await h.fixture('signal', source)]);
      const owned = await h.readPid(pidFile);
      run.child.kill(signal);
      assert.equal((await bounded(run.closed, 'signal forwarding and owned shutdown')).code, code, run.output());
      let receipt: string | undefined;
      try { receipt = await readFile(signalFile, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      assert.equal(receipt, 'received', run.output());
      await eventually(async () => (await identity(owned.pid))?.startTime !== owned.startTime, 'owned signal recipient to exit');
      const next = h.run([await h.fixture('after-signal', passing)]);
      assert.equal((await bounded(next.closed, 'lock reuse after signal')).code, 0, next.output());
    });
  }

  it('retains the gate during parent-crash cleanup, then recovers without stale-lock reclamation', async t => {
    const h = await harness(t);
    const pidFile = path.join(h.directory, 'crash.pid');
    const owner = h.run([await h.fixture('crash', heldTest(pidFile, undefined, true))], ['--shutdown-grace-ms', '3000']);
    const owned = await h.readPid(pidFile);
    owner.child.kill('SIGKILL');
    assert.equal((await bounded(owner.exited, 'crashed entry to exit')).signal, 'SIGKILL');
    const whileCleaning = h.launch(['db']);
    assert.equal((await bounded(whileCleaning.closed, 'gate during crash cleanup')).code, 75, whileCleaning.output());
    await bounded(owner.closed, 'orphan supervisor to clean its owned group');
    await eventually(async () => (await identity(owned.pid))?.startTime !== owned.startTime, 'crashed runner descendants to exit');
    const next = h.run([await h.fixture('after-crash', passing)]);
    assert.equal((await bounded(next.closed, 'kernel lock recovery after crash')).code, 0, next.output());
  });

  it('fails and cleans owned descendants if the per-file supervisor itself crashes', async t => {
    const h = await harness(t);
    const pidFile = path.join(h.directory, 'supervisor-crash.pid');
    const owner = h.run([await h.fixture('supervisor-crash', heldTest(pidFile))]);
    const owned = await h.readPid(pidFile);
    await eventually(() => /owned supervisor PID (\d+)/.test(owner.output()), 'owned supervisor progress identity');
    const supervisorPid = Number(owner.output().match(/owned supervisor PID (\d+)/)![1]);
    process.kill(supervisorPid, 'SIGKILL');
    assert.equal((await bounded(owner.closed, 'supervisor crash cleanup')).code, 137, owner.output());
    await eventually(async () => (await identity(owned.pid))?.startTime !== owned.startTime, 'supervisor crash descendants to exit');
    const next = h.run([await h.fixture('after-supervisor-crash', passing)]);
    assert.equal((await bounded(next.closed, 'lock recovery after supervisor crash')).code, 0, next.output());
  });

  it('does not report success when a test process exits but leaves a live child behind', async t => {
    const h = await harness(t);
    const pidFile = path.join(h.directory, 'descendant.pid');
    const source = `import test from 'node:test'; import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
test('leaks an independent handle owner', () => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref(); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); });`;
    const run = h.run([await h.fixture('descendant-leak', source)]);
    const owned = await h.readPid(pidFile);
    assert.equal((await bounded(run.closed, 'live descendant leak detection')).code, 1, run.output());
    assert.match(run.output(), /live descendants/);
    await eventually(async () => (await identity(owned.pid))?.startTime !== owned.startTime, 'leaked owned descendant to stop');
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createCiCommandRunner, createCiRecorder } from './check-ci-process.mjs';

async function fixture(t, options = {}) {
  // The CI supervisor is Linux-only. Keep fixture Git operations/temp roots
  // outside every checkout, even on hosts with a redirected system TMPDIR.
  const root = await mkdtemp('/var/tmp/dovspace-ci-process-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = createCiRecorder(root, () => {});
  t.after(() => recorder.close());
  const stdout = new PassThrough(), stderr = new PassThrough();
  stdout.resume(); stderr.resume();
  const runner = createCiCommandRunner({ cwd: root, recorder, stdout, stderr, progressInterval: 20, shutdownGrace: 200, ...options });
  const records = async () => (await readFile(recorder.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, recorder, runner, records, stdout, stderr };
}

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

test('timing artifacts retain passed and failed scopes, without serializing errors', async t => {
  const { recorder, records } = await fixture(t);
  assert.equal(await recorder.measure('stage', 'successful scope', async () => 42), 42);
  const error = new Error('private-error-value');
  await assert.rejects(recorder.measure('stage', 'failed scope', async () => { throw error; }), value => value === error);
  const values = await records();
  assert.deepEqual(values.filter(value => value.event === 'end').map(value => value.status), ['passed', 'failed']);
  assert.ok(values.every(value => value.version === 1 && value.runId && value.at));
  assert.ok(values.filter(value => value.event === 'end').every(value => Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0));
  assert.equal((await stat(recorder.file)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(values).includes('private-error-value'));
});

test('captures command output without persisting output, argv or environment secrets', async t => {
  const { runner, records } = await fixture(t);
  const output = await runner.run('fixed safe label', process.execPath, [
    '-e', "process.stdout.write('capture-secret'); setTimeout(() => {}, 120)", 'argv-secret',
  ], { ...env, PRIVATE_CREDENTIAL: 'environment-secret' }, { capture: true });
  assert.equal(output, 'capture-secret');
  const values = await records();
  const finished = values.find(value => value.event === 'end');
  assert.equal(finished.status, 'passed');
  assert.equal(finished.code, 0);
  assert.equal(finished.signal, null);
  assert.ok(values.some(value => value.event === 'progress' && value.elapsedMs >= 0 && value.outputIdleMs >= 0));
  const artifact = JSON.stringify(values);
  for (const secret of ['capture-secret', 'argv-secret', 'environment-secret', 'PRIVATE_CREDENTIAL', 'process.stdout.write']) assert.ok(!artifact.includes(secret));
});

test('nonzero exits and spawn failures remain failed commands', async t => {
  const { runner, records } = await fixture(t);
  await assert.rejects(runner.run('nonzero command', process.execPath, ['-e', 'process.exit(7)'], env), /failed \(7\)/);
  await assert.rejects(runner.run('missing tool', '/does-not-exist/private-command-name', ['private-argument'], env), /could not start/);
  const values = await records();
  assert.deepEqual(values.filter(value => value.event === 'end').map(value => [value.status, value.code]), [['failed', 7], ['failed', null]]);
  assert.ok(!JSON.stringify(values).includes('private-command-name'));
  assert.ok(!JSON.stringify(values).includes('private-argument'));
});

test('interruption stays nonzero while failed cleanup is still recorded separately', async t => {
  let signal;
  const { runner, records, stdout } = await fixture(t, { interrupted: () => signal });
  stdout.on('data', () => { signal = 'SIGTERM'; runner.stop(signal); });
  await assert.rejects(runner.run('interrupted command', process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], env), /failed|interrupted/);
  await assert.rejects(runner.run('must not start', process.execPath, ['-e', 'process.exit(0)'], env), /interrupted/);
  await assert.rejects(runner.run('failed cleanup', process.execPath, ['-e', 'process.exit(6)'], env, { cleanup: true }), /failed \(6\)/);
  const finished = (await records()).filter(value => value.event === 'end');
  assert.equal(finished[0].status, 'interrupted');
  assert.equal(finished[0].signal, 'SIGTERM');
  assert.equal(finished[1].status, 'failed');
  assert.equal(finished[1].code, 6);
});

test('explicit interruption bounds a child that ignores the first signal', async t => {
  const { runner, records, stdout } = await fixture(t, { shutdownGrace: 100 });
  stdout.on('data', () => runner.stop('SIGTERM'));
  await assert.rejects(runner.run('unresponsive interrupted child', process.execPath, [
    '-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
  ], env), /failed/);
  const end = (await records()).find(value => value.event === 'end');
  assert.equal(end.status, 'interrupted');
  assert.equal(end.signal, 'SIGKILL');
});

test('a successful driver cannot hide leaked owned descendants', async t => {
  const { runner, recorder, root, records } = await fixture(t);
  const record = recorder.record;
  let exitRequested = false;
  recorder.record = (kind, label, event, fields) => {
    record(kind, label, event, fields);
    if (event === 'progress' && fields.ownedProcesses >= 2 && !exitRequested) {
      exitRequested = true;
      void writeFile(path.join(root, 'driver-exit'), '').catch(() => runner.stop('SIGTERM'));
    }
  };
  await assert.rejects(runner.run('leaking command', process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    setInterval(() => { if (require('node:fs').existsSync('driver-exit')) process.exit(0); }, 10);
  `], env), /left live owned descendants/);
  const end = (await records()).find(value => value.event === 'end');
  assert.equal(end.code, 0);
  assert.equal(end.status, 'failed');
});

test('capture overflow fails rather than appearing as operator interruption', async t => {
  const { runner, records } = await fixture(t);
  await assert.rejects(runner.run('oversized capture', process.execPath, [
    '-e', "process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000)",
  ], env, { capture: true }), /bounded capture limit/);
  assert.equal((await records()).find(value => value.event === 'end').status, 'failed');
});

test('artifact directory symlinks cannot redirect a timing write', async t => {
  const root = await mkdtemp('/var/tmp/dovspace-ci-process-link-');
  const target = await mkdtemp('/var/tmp/dovspace-ci-process-target-');
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));
  await symlink(target, path.join(root, '.local'));
  assert.throws(() => createCiRecorder(root, () => {}), /must not be a symlink/);
});

test('unwritable telemetry cannot suppress cleanup and is never silently successful', async t => {
  const root = await mkdtemp('/var/tmp/dovspace-ci-process-write-failure-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = createCiRecorder(root, () => {});
  recorder.close();
  let cleaned = false;
  await recorder.measure('stage', 'cleanup', async () => { cleaned = true; });
  assert.equal(cleaned, true);
  assert.equal(recorder.failed, true);
  assert.throws(() => recorder.close(), /artifact is incomplete/);
});

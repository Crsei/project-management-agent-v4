/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { readAccountRecoveryMailConfig } from '../packages/infrastructure/src/account-recovery-mail.ts';
import { readInvitationMailConfig } from '../packages/infrastructure/src/invitation-mail.ts';
import { mailWorkerEnvironment, startOwnedMailWorker } from './mail-worker-process.ts';

// These lifecycle regressions cross a real OS-process boundary: signals and
// bounded shutdown use the platform clock, not timers mocked in the parent.
// Child intervals only keep the owned process alive until its observed signal.
const input = { databaseUrl: 'postgres://fixture:synthetic-password@127.0.0.1:1/isolated', coreRoot: join(tmpdir(), 'pm-mail-worker-helper', 'core') };
const readyScript = `process.on('SIGTERM', () => process.exit(0)); process.stdout.write(JSON.stringify({event:'worker_started'})+'\\n'); setInterval(() => {}, 1000);`;

it('mail Worker environment excludes ambient feature, cloud, loader and native project configuration', () => {
  const mail = { host: '127.0.0.1', port: 2525, secure: false, requireTls: false, from: 'fixture@example.test', timeoutMs: 2000,
    webOrigin: 'http://127.0.0.1:4100', tokenKey: randomBytes(32), ttlSeconds: 3600 };
  const env = mailWorkerEnvironment({ ...input, invitationMail: mail }, {
    PATH: '/fixture/bin', TMPDIR: tmpdir(), CHOKIDAR_USEPOLLING: 'true',
    DATABASE_URL: 'ambient-private-database', SMTP_HOST: 'ambient-private-smtp', SMTP_PASSWORD: 'ambient-private-password',
    AWS_ACCESS_KEY_ID: 'ambient-private-key', S3_BUCKET: 'ambient-private-bucket', SOURCE_S3_SECRET: 'ambient-source-secret', TARGET_S3_SECRET: 'ambient-target-secret',
    ACCOUNT_RECOVERY_TOKEN_KEY: 'ambient-recovery-key', ACCOUNT_RECOVERY_WEB_ORIGIN: 'https://ambient.invalid',
    WEBHOOK_TARGETS_FILE: '/ambient/private-manifest', NODE_OPTIONS: '--require=/ambient/private-loader', NODE_PATH: '/ambient/private-modules',
    CORE_WORKSPACE_ROOT: '/ambient/private-core', LOCAL_PROJECT_CONFIG: '/ambient/private-config', LOCAL_PROJECTS_ENABLED: 'true',
    LOCAL_PROJECT_ALLOWED_ROOTS: '["/ambient/private-projects"]', HOME: '/ambient/private-home',
  });
  assert.equal(env.PATH, '/fixture/bin');
  assert.equal(env.TMPDIR, tmpdir());
  assert.equal(env.CHOKIDAR_USEPOLLING, 'true');
  assert.equal(env.DATABASE_URL, input.databaseUrl);
  assert.equal(env.SMTP_HOST, mail.host);
  assert.ok(env.INVITATION_TOKEN_KEY === mail.tokenKey.toString('base64'), 'Only the fixture invitation key reaches the child');
  assert.equal(env.CORE_WORKSPACE_ROOT, input.coreRoot);
  assert.equal(env.LOCAL_PROJECT_CONFIG, join(input.coreRoot, 'missing-test-config.json'));
  assert.equal(env.LOCAL_PROJECTS_ENABLED, 'false');
  assert.equal(env.LOCAL_PROJECT_ALLOWED_ROOTS, '[]');
  assert.ok(readInvitationMailConfig(env)?.tokenKey.equals(mail.tokenKey), 'The real invitation configuration reader accepts this isolated environment');
  assert.ok(readAccountRecoveryMailConfig(env) === undefined, 'Ambient recovery configuration cannot accidentally enable an unrelated feature');
  for (const key of ['SMTP_PASSWORD', 'AWS_ACCESS_KEY_ID', 'S3_BUCKET', 'SOURCE_S3_SECRET', 'TARGET_S3_SECRET',
    'ACCOUNT_RECOVERY_TOKEN_KEY', 'ACCOUNT_RECOVERY_WEB_ORIGIN', 'WEBHOOK_TARGETS_FILE', 'NODE_OPTIONS', 'NODE_PATH', 'HOME']) {
    assert.equal(Object.hasOwn(env, key), false, `Ambient ${key} must not reach the owned child`);
  }
});

it('owned mail Worker early exit interrupts even a pending observation and preserves safe startup diagnostics', { timeout: 8000 }, async t => {
  const worker = startOwnedMailWorker({ env: mailWorkerEnvironment(input), signal: t.signal,
    args: ['-e', `process.stdout.write(JSON.stringify({event:'worker_started'})+'\\n'); process.stderr.write('Error: Mail feature configuration is incomplete or invalid\\n'); process.exitCode=23;`],
  });
  t.after(() => worker.stop(), { timeout: 2000 });
  const pending = Promise.withResolvers<boolean>();
  const started = Date.now();
  await assert.rejects(worker.until(() => pending.promise, 'an intentionally pending committed-state read'), /Owned Worker exited code=23/);
  assert.ok(Date.now() - started < 5000, 'Exit must interrupt the 15-second observation deadline');
  const stopped = await worker.stop();
  assert.equal(stopped.code, 23);
  assert.match(worker.diagnostics(), /stdout: worker_started/);
  assert.match(worker.diagnostics(), /stderr: Error: Mail feature configuration is incomplete or invalid/);
});

it('owned mail Worker spawn error fails immediately rather than waiting for polling', { timeout: 5000 }, async t => {
  const worker = startOwnedMailWorker({ env: mailWorkerEnvironment(input), signal: t.signal,
    executable: join(tmpdir(), `pm-nonexistent-worker-${randomUUID()}`), args: [],
  });
  t.after(() => worker.stop(), { timeout: 2000 });
  const pending = Promise.withResolvers<boolean>();
  await assert.rejects(worker.until(() => pending.promise, 'spawned child readiness'), /failed to spawn \(ENOENT\)/);
  await worker.stop();
});

it('owned mail Worker bounds and redacts both output streams, including fragmented and oversized lines', { timeout: 8000 }, async t => {
  const secret = 'synthetic-private-diagnostic-value';
  const worker = startOwnedMailWorker({ env: { ...mailWorkerEnvironment(input), PRIVATE_DIAGNOSTIC_SECRET: secret }, signal: t.signal,
    args: ['-e', [
      `process.on('SIGTERM', () => process.exit(0));`,
      `const secret=process.env.PRIVATE_DIAGNOSTIC_SECRET;`,
      `for(let i=0;i<100;i++) process.stdout.write(JSON.stringify({event:'worker_cycle_failed',consecutiveFailures:i,password:secret})+'\\n');`,
      `process.stdout.write(secret.repeat(1000)+'\\n');`,
      `process.stderr.write('Error: '+secret+'\\n'+JSON.stringify({event:secret,token:secret})+'\\n');`,
      `process.stderr.write('Error: Mail feature configuration is incomplete or invalid');`,
      `setImmediate(() => { process.stderr.write('\\n'); process.stdout.write('{"event":"worker_');`,
      `setImmediate(() => process.stdout.write('started","token":"'+secret+'"}\\n')); });`,
      `setInterval(() => {}, 1000);`,
    ].join('\n')],
  });
  t.after(() => worker.stop(), { timeout: 2000 });
  await worker.until(() => worker.hasEvent('worker_started'), 'fragmented lifecycle event', 3000);
  const stopped = await worker.stop();
  assert.deepEqual(stopped, { code: 0, signal: null, forced: false });
  const diagnostics = worker.diagnostics();
  assert.ok(diagnostics.split('\n').length <= 32, 'Diagnostic history must have a fixed line bound');
  assert.ok(diagnostics.length < 8192, 'Diagnostic history must have a fixed byte bound');
  assert.equal(diagnostics.includes(secret), false, 'No environment, token, recipient or arbitrary message may be retained');
  assert.match(diagnostics, /stdout: worker_started/);
  assert.match(diagnostics, /stderr: Error: Mail feature configuration is incomplete or invalid/);
  assert.match(diagnostics, /redacted/);
});

it('owned mail Worker shutdown is idempotent and observes an immediate graceful exit', { timeout: 5000 }, async t => {
  const worker = startOwnedMailWorker({ env: mailWorkerEnvironment(input), signal: t.signal, args: ['-e', readyScript] });
  t.after(() => worker.stop(), { timeout: 2000 });
  await worker.until(() => worker.hasEvent('worker_started'), 'the shutdown listener to be ready', 3000);
  const primary = new Error('synthetic committed-state observation failure');
  await assert.rejects(worker.until(() => { throw primary; }, 'a failing state read'), error => error === primary);
  const first = worker.stop({ graceMs: 1000, killMs: 1000 });
  assert.equal(worker.stop(), first, 'Concurrent cleanup must share the same shutdown promise');
  assert.deepEqual(await first, { code: 0, signal: null, forced: false });
});

it('owned mail Worker escalates only its own unresponsive child within two bounded shutdown deadlines', { timeout: 5000 }, async t => {
  const worker = startOwnedMailWorker({ env: mailWorkerEnvironment(input), signal: t.signal,
    args: ['-e', `process.on('SIGTERM', () => {}); process.stdout.write(JSON.stringify({event:'worker_started'})+'\\n'); setInterval(() => {}, 1000);`],
  });
  t.after(() => worker.stop(), { timeout: 2000 });
  await worker.until(() => worker.hasEvent('worker_started'), 'the deliberately unresponsive owned child', 3000);
  const stopped = await worker.stop({ graceMs: 50, killMs: 1000 });
  assert.deepEqual(stopped, { code: null, signal: 'SIGKILL', forced: true });
});

it('mail Worker cancellation interrupts pending observations and closes its owned child', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  const worker = startOwnedMailWorker({ env: mailWorkerEnvironment(input), signal: controller.signal, args: ['-e', readyScript] });
  t.after(() => worker.stop(), { timeout: 2000 });
  await worker.until(() => worker.hasEvent('worker_started'), 'the cancellable owned child', 3000);
  const pending = Promise.withResolvers<boolean>();
  const observed = worker.until(() => pending.promise, 'a pending observation during cancellation');
  const rejected = assert.rejects(observed, /observation cancelled/);
  controller.abort();
  await rejected;
  assert.deepEqual(await worker.stop(), { code: 0, signal: null, forced: false });
});
